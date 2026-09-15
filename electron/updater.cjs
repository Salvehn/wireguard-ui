const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const UPDATE_MANIFEST_URL =
  "https://github.com/Salvehn/wireguard-ui/releases/latest/download/update-arm64.json";
const MAX_UPDATE_SIZE = 1024 * 1024 * 1024;

function manifestPayload(manifest) {
  return JSON.stringify({
    schema: manifest.schema,
    version: manifest.version,
    url: manifest.url,
    size: manifest.size,
    sha512: manifest.sha512,
  });
}

function parseVersion(value) {
  const match = String(value)
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw Error("Некорректная версия обновления");
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || "" };
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate),
    installed = parseVersion(current);
  for (let index = 0; index < 3; index += 1)
    if (next.numbers[index] !== installed.numbers[index])
      return next.numbers[index] > installed.numbers[index];
  if (next.prerelease === installed.prerelease) return false;
  if (!next.prerelease) return true;
  if (!installed.prerelease) return false;
  return (
    next.prerelease.localeCompare(installed.prerelease, "en", {
      numeric: true,
    }) > 0
  );
}

function validateManifest(value, publicKey) {
  if (!value || typeof value !== "object")
    throw Error("Некорректный manifest обновления");
  const manifest = value;
  if (manifest.schema !== 1 || typeof manifest.version !== "string")
    throw Error("Неподдерживаемый manifest обновления");
  parseVersion(manifest.version);
  const url = new URL(manifest.url);
  if (url.protocol !== "https:") throw Error("Небезопасный адрес обновления");
  if (
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > MAX_UPDATE_SIZE
  )
    throw Error("Некорректный размер обновления");
  if (
    typeof manifest.sha512 !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(manifest.sha512)
  )
    throw Error("Некорректная контрольная сумма обновления");
  if (typeof manifest.signature !== "string")
    throw Error("Обновление не подписано");
  if (
    !crypto.verify(
      null,
      Buffer.from(manifestPayload(manifest)),
      publicKey,
      Buffer.from(manifest.signature, "base64"),
    )
  )
    throw Error("Не удалось проверить подпись обновления");
  return {
    schema: 1,
    version: manifest.version.replace(/^v/, ""),
    url: url.toString(),
    size: manifest.size,
    sha512: manifest.sha512,
    signature: manifest.signature,
  };
}

async function fileSha512(file) {
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

function createAppUpdater({
  app,
  fetch,
  publicKey,
  publish = () => {},
  installUpdate = async () => {},
  manifestUrl = UPDATE_MANIFEST_URL,
  startupError = "",
  platform = process.platform,
  architecture = process.arch,
}) {
  let operation = null,
    available = null,
    archivePath = "";
  let state = {
    status: startupError ? "error" : "idle",
    currentVersion: app.getVersion(),
    availableVersion: null,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    error: startupError,
    supported:
      app.isPackaged && platform === "darwin" && architecture === "arm64",
  };
  const snapshot = () => ({ ...state });
  const update = (patch) => {
    state = { ...state, ...patch };
    publish(snapshot());
    return snapshot();
  };
  const fail = (error) =>
    update({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  async function run(task) {
    if (operation) return operation;
    operation = Promise.resolve()
      .then(task)
      .catch((error) => {
        fail(error);
        return snapshot();
      })
      .finally(() => {
        operation = null;
      });
    return operation;
  }
  return {
    getState: snapshot,
    check() {
      if (!state.supported) return Promise.resolve(snapshot());
      return run(async () => {
        update({ status: "checking", error: "" });
        const requestUrl = new URL(manifestUrl);
        // GitHub can briefly cache the previous `releases/latest` redirect after
        // publication. A unique query makes every manual check reach the current
        // release instead of waiting for that CDN entry to expire.
        requestUrl.searchParams.set("current", app.getVersion());
        requestUrl.searchParams.set("check", Date.now().toString());
        const response = await fetch(requestUrl.toString(), {
          cache: "no-store",
          redirect: "follow",
          headers: {
            Accept: "application/json",
            "User-Agent": `WireGuard-Desktop/${app.getVersion()}`,
          },
        });
        if (response.status === 404)
          return update({
            status: "up-to-date",
            availableVersion: null,
            error: "",
          });
        if (!response.ok) throw Error("Сервер обновлений недоступен");
        available = validateManifest(await response.json(), publicKey);
        if (!isNewerVersion(available.version, app.getVersion())) {
          available = null;
          return update({
            status: "up-to-date",
            availableVersion: null,
            error: "",
          });
        }
        archivePath = "";
        return update({
          status: "available",
          availableVersion: available.version,
          percent: 0,
          transferred: 0,
          total: available.size,
          bytesPerSecond: 0,
          error: "",
        });
      });
    },
    download() {
      if (!state.supported || state.status !== "available" || !available)
        return Promise.resolve(snapshot());
      return run(async () => {
        const directory = path.join(app.getPath("userData"), "updates");
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        const finalPath = path.join(
            directory,
            `WireGuard-Desktop-${available.version}-arm64.zip`,
          ),
          partialPath = finalPath + ".part";
        await fsp.rm(partialPath, { force: true });
        update({
          status: "downloading",
          percent: 0,
          transferred: 0,
          total: available.size,
          bytesPerSecond: 0,
          error: "",
        });
        const response = await fetch(available.url, {
          cache: "no-store",
          redirect: "follow",
        });
        if (!response.ok || !response.body)
          throw Error("Не удалось скачать обновление");
        const handle = await fsp.open(partialPath, "wx", 0o600),
          hash = crypto.createHash("sha512");
        let transferred = 0,
          lastTransferred = 0,
          lastPublished = Date.now();
        try {
          for await (const value of response.body) {
            const chunk = Buffer.from(value);
            transferred += chunk.length;
            if (transferred > available.size)
              throw Error("Размер обновления не совпадает с manifest");
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset);
              if (!bytesWritten) throw Error("Не удалось записать обновление");
              offset += bytesWritten;
            }
            const now = Date.now();
            if (now - lastPublished >= 150 || transferred === available.size) {
              update({
                status: "downloading",
                percent: Math.min(100, (transferred / available.size) * 100),
                transferred,
                total: available.size,
                bytesPerSecond:
                  (transferred - lastTransferred) /
                  Math.max(0.001, (now - lastPublished) / 1000),
              });
              lastTransferred = transferred;
              lastPublished = now;
            }
          }
        } finally {
          await handle.close();
        }
        if (transferred !== available.size)
          throw Error("Загружен неполный архив обновления");
        const digest = hash.digest("base64");
        if (
          !crypto.timingSafeEqual(
            Buffer.from(digest),
            Buffer.from(available.sha512),
          )
        )
          throw Error("Контрольная сумма обновления не совпадает");
        await fsp.rename(partialPath, finalPath);
        archivePath = finalPath;
        return update({
          status: "downloaded",
          percent: 100,
          transferred,
          total: available.size,
          bytesPerSecond: 0,
          error: "",
        });
      });
    },
    install() {
      if (
        !state.supported ||
        state.status !== "downloaded" ||
        !available ||
        !archivePath
      )
        return Promise.resolve(snapshot());
      return run(async () => {
        if ((await fileSha512(archivePath)) !== available.sha512)
          throw Error("Архив обновления был изменён после загрузки");
        update({ status: "installing", error: "" });
        await installUpdate({
          archivePath,
          version: available.version,
          sha512: available.sha512,
        });
        return snapshot();
      });
    },
  };
}

module.exports = {
  UPDATE_MANIFEST_URL,
  createAppUpdater,
  fileSha512,
  isNewerVersion,
  manifestPayload,
  validateManifest,
};
