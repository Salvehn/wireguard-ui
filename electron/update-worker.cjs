const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const exists = (file) =>
  fsp.access(file).then(
    () => true,
    () => false,
  );
const removeTree = (directory) =>
  fsp.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });

async function sha512(file) {
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

function cleanEnvironment() {
  const {
    ELECTRON_RUN_AS_NODE: _electron,
    WG_UPDATE_WORKER: _worker,
    ...environment
  } = process.env;
  return environment;
}

async function waitForExit(pid, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await wait(200);
  }
  throw Error("Приложение не завершилось перед обновлением");
}

async function safeArchiveEntries(archive, appName) {
  const { stdout } = await run("/usr/bin/unzip", ["-Z1", archive], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = stdout.split("\n").filter(Boolean);
  if (!entries.length) throw Error("Архив обновления пуст");
  for (const entry of entries) {
    const components = entry.split("/");
    if (
      components[0] !== appName ||
      components.includes("..") ||
      path.isAbsolute(entry)
    )
      throw Error("Архив обновления содержит недопустимый путь");
  }
}

function appExecutable(appPath) {
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(appPath, ".app"),
  );
}

function launch(appPath, argument) {
  const child = spawn(appExecutable(appPath), argument ? [argument] : [], {
    detached: false,
    stdio: "ignore",
    env: cleanEnvironment(),
  });
  child.on("error", () => {});
  return child;
}

async function worker(config) {
  const appName = path.basename(config.currentApp),
    parent = path.dirname(config.currentApp);
  if (
    !appName.endsWith(".app") ||
    parent === "/" ||
    !Number.isSafeInteger(config.parentPid) ||
    !/^[a-f0-9]{32}$/.test(config.token)
  )
    throw Error("Некорректные параметры установщика");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(config.sha512))
    throw Error("Некорректная контрольная сумма установщика");
  if ((await sha512(config.archivePath)) !== config.sha512)
    throw Error("Контрольная сумма архива не совпадает");
  await safeArchiveEntries(config.archivePath, appName);
  if (config.readyPath)
    await fsp.writeFile(config.readyPath, config.token, { mode: 0o600 });
  await waitForExit(config.parentPid);

  const stage = path.join(parent, `.${appName}.stage-${config.token}`);
  const backup = path.join(parent, `.${appName}.backup-${config.token}`);
  const failed = path.join(parent, `.${appName}.failed-${config.token}`);
  const health = path.join(
    config.userData,
    `update-health-${config.token}.json`,
  );
  await fsp.rm(health, { force: true });
  await fsp.mkdir(stage, { mode: 0o700 });
  let swapped = false;
  let launched = null;
  try {
    await run("/usr/bin/ditto", ["-x", "-k", config.archivePath, stage], {
      timeout: 180000,
    });
    const stagedApp = path.join(stage, appName);
    const info = path.join(stagedApp, "Contents", "Info.plist");
    const { stdout } = await run("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      info,
    ]);
    if (stdout.trim() !== config.version)
      throw Error("Версия распакованного приложения не совпадает с manifest");

    await fsp.rename(config.currentApp, backup);
    try {
      await fsp.rename(stagedApp, config.currentApp);
    } catch (error) {
      await fsp.rename(backup, config.currentApp);
      throw error;
    }
    swapped = true;
    await fsp.rm(stage, { recursive: true, force: true });
    launched = launch(config.currentApp, `--update-token=${config.token}`);
    launched.unref();
    const deadline = Date.now() + (config.healthTimeout || 30000);
    while (Date.now() < deadline) {
      if (await exists(health)) {
        const result = JSON.parse(await fsp.readFile(health, "utf8"));
        if (
          result.token === config.token &&
          result.version === config.version
        ) {
          swapped = false;
          await removeTree(backup);
          await fsp.rm(config.archivePath, { force: true });
          await fsp.rm(health, { force: true });
          return;
        }
      }
      if (launched.exitCode !== null) break;
      await wait(250);
    }
    throw Error("Новая версия не подтвердила успешный запуск");
  } catch (error) {
    if (swapped && (await exists(backup))) {
      launched?.kill("SIGTERM");
      await wait(500);
      if (await exists(config.currentApp))
        await fsp.rename(config.currentApp, failed);
      await fsp.rename(backup, config.currentApp);
      launch(config.currentApp, "--update-rollback").unref();
      await removeTree(failed);
    }
    throw error;
  } finally {
    await removeTree(stage).catch(() => {});
  }
}

async function launchUpdateWorker({
  app,
  archivePath,
  version,
  sha512: digest,
}) {
  const currentApp = path.resolve(path.dirname(process.execPath), "../..");
  if (
    !app.isPackaged ||
    process.platform !== "darwin" ||
    !currentApp.endsWith(".app")
  )
    throw Error("Установка доступна только из установленного приложения");
  await fsp.access(path.dirname(currentApp), fs.constants.W_OK).catch(() => {
    throw Error("Нет доступа для замены приложения в текущей папке");
  });
  const token = crypto.randomBytes(16).toString("hex");
  const workerDirectory = path.join(app.getPath("userData"), "updates");
  const workerPath = path.join(workerDirectory, `update-worker-${token}.cjs`);
  const readyPath = path.join(workerDirectory, `update-worker-ready-${token}`);
  await fsp.mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  await fsp.copyFile(__filename, workerPath);
  await fsp.chmod(workerPath, 0o700);
  const config = {
    parentPid: process.pid,
    archivePath,
    currentApp,
    version,
    sha512: digest,
    userData: app.getPath("userData"),
    token,
    readyPath,
  };
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
  const child = spawn(process.execPath, [workerPath, encoded], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WG_UPDATE_WORKER: "1" },
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await exists(readyPath)) {
      const ready = await fsp.readFile(readyPath, "utf8");
      if (ready === token) {
        await fsp.rm(readyPath, { force: true });
        child.unref();
        return;
      }
    }
    if (child.exitCode !== null) break;
    await wait(100);
  }
  child.kill("SIGTERM");
  await fsp.rm(readyPath, { force: true }).catch(() => {});
  await fsp.rm(workerPath, { force: true }).catch(() => {});
  throw Error("Не удалось запустить установщик обновления");
}

async function markUpdateHealthy(app) {
  const argument = process.argv.find((value) =>
    value.startsWith("--update-token="),
  );
  const token = argument?.slice("--update-token=".length);
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return;
  const health = path.join(
    app.getPath("userData"),
    `update-health-${token}.json`,
  );
  const temporary = health + ".tmp";
  await fsp.writeFile(
    temporary,
    JSON.stringify({ token, version: app.getVersion() }),
    { mode: 0o600 },
  );
  await fsp.rename(temporary, health);
}

if (process.env.WG_UPDATE_WORKER === "1") {
  const workerFile = process.argv[1];
  const log = path.join(path.dirname(process.argv[1]), "update-worker.log");
  Promise.resolve()
    .then(() => fsp.rm(log, { force: true }).catch(() => {}))
    .then(() =>
      worker(
        JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8")),
      ),
    )
    .catch(async (error) => {
      await fsp
        .writeFile(
          log,
          `${new Date().toISOString()} ${error.stack || error.message}\n`,
          { mode: 0o600 },
        )
        .catch(() => {});
      process.exitCode = 1;
    })
    .finally(() => fsp.rm(workerFile, { force: true }).catch(() => {}));
}

module.exports = { launchUpdateWorker, markUpdateHealthy, worker };
