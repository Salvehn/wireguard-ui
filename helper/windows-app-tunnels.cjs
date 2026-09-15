const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn: nodeSpawn } = require("node:child_process");
const { compileGroup, validateApps } = require("./app-tunneling.cjs");
const { parseConfig } = require("./config.cjs");

async function atomicWrite(file, text) {
  const temporary = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

class WindowsAppTunnels {
  constructor({
    base,
    configDirectory,
    run,
    environment = async () => ({ routes: [], occupied: [], endpoints: [] }),
    spawn = nodeSpawn,
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    Object.assign(this, {
      base,
      configDirectory,
      run,
      environment,
      spawn,
      delay,
    });
    this.marker = path.join(configDirectory, "applications.json");
    this.config = path.join(configDirectory, "applications-engine.json");
    this.log = path.join(configDirectory, "applications.log");
    this.errors = new Map();
    this.child = null;
    this.paused = false;
  }
  async record() {
    let record;
    try {
      record = JSON.parse(await fs.readFile(this.marker, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (
      record?.schema !== 3 ||
      !Array.isArray(record.sessions) ||
      !record.sessions.length ||
      record.sessions.length > 32 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 4
    )
      throw Error("Invalid app tunnel journal");
    const ids = new Set();
    for (const session of record.sessions) {
      if (
        !/^wg[a-f0-9]{10}$/.test(session.id) ||
        ids.has(session.id) ||
        typeof session.config !== "string" ||
        Buffer.byteLength(session.config) > 65536
      )
        throw Error("Invalid app tunnel journal");
      ids.add(session.id);
      parseConfig(session.config);
      validateApps(session.settings, "win32");
    }
    return record;
  }
  running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }
  async killPid(pid) {
    try {
      await this.run(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
      );
    } catch (error) {
      const output = String(error.stdout || "") + String(error.stderr || "");
      if (!/not found|not running|no running instance/i.test(output))
        throw error;
    }
  }
  async stopJob() {
    const record = await this.record().catch(() => null);
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        this.delay(5000),
      ]);
      if (child.exitCode === null) await this.killPid(child.pid);
    } else if (record?.pid) await this.killPid(record.pid);
    this.child = null;
  }
  async cleanup() {
    for (const file of [this.config, this.log, this.marker])
      await fs.rm(file, { force: true });
  }
  async stop() {
    await this.stopJob();
    await this.cleanup();
    this.paused = false;
  }
  async recover() {
    const record = await this.record().catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!record) return;
    await this.stop();
    for (const { id } of record.sessions)
      this.errors.set(
        id,
        "Движок приложений перезапущен. Подключите соединение заново.",
      );
  }
  async snapshots() {
    const record = await this.record();
    if (!record) return [];
    const active = this.running();
    const stat = await fs.stat(this.log).catch(() => null);
    if (stat?.size > 1024 * 1024) await fs.truncate(this.log, 0);
    if (!active && !this.paused)
      for (const { id } of record.sessions)
        this.errors.set(
          id,
          "Движок приложений остановлен. Подключите соединение заново.",
        );
    return record.sessions.map(({ id }) => ({
      id,
      active,
      statusUnknown: false,
      interfaceName: null,
      stats: null,
      appRouting: true,
      smartError: this.errors.get(id) || "",
    }));
  }
  async prepare(sessions) {
    const config = compileGroup(sessions, {
      ...(await this.environment()),
      platform: "win32",
    });
    const binary = path.join(this.base, "bin", "sing-box.exe");
    await fs.access(binary);
    await fs.mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    const candidate = this.config + ".check";
    try {
      await atomicWrite(candidate, JSON.stringify(config));
      await this.run(binary, ["check", "-c", candidate]);
    } finally {
      await fs.rm(candidate, { force: true });
    }
    return config;
  }
  async launch(sessions, compiled) {
    await atomicWrite(this.config, JSON.stringify(compiled));
    await atomicWrite(this.log, "");
    const binary = path.join(this.base, "bin", "sing-box.exe");
    const child = this.spawn(binary, ["run", "-c", this.config], {
      cwd: this.configDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    });
    this.child = child;
    let output = "";
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-65536);
      void fs.appendFile(this.log, text).catch(() => {});
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await atomicWrite(
      this.marker,
      JSON.stringify({ schema: 3, pid: child.pid, sessions }),
    );
    for (let i = 0; i < 150; i++) {
      if (output.includes("sing-box started") && this.running()) {
        for (const { id } of sessions) this.errors.delete(id);
        return;
      }
      if (child.exitCode !== null || output.includes("FATAL")) break;
      await this.delay(100);
    }
    throw Error("Движок приложений не подтвердил запуск");
  }
  async replace(next) {
    const record = await this.record();
    const previous = record && this.running() ? record.sessions : [];
    let compiled = null;
    if (next.length) compiled = await this.prepare(next);
    await this.stopJob();
    this.paused = true;
    try {
      if (!next.length) {
        await this.cleanup();
        return;
      }
      await this.launch(next, compiled || (await this.prepare(next)));
    } catch (error) {
      await this.stopJob();
      if (previous.length) {
        try {
          await this.launch(previous, await this.prepare(previous));
        } catch {
          await this.stopJob();
          for (const { id } of previous)
            this.errors.set(
              id,
              "Не удалось восстановить правила приложений после ошибки",
            );
        }
      } else await this.cleanup();
      throw error;
    } finally {
      this.paused = false;
    }
  }
  async start(id, config, settings) {
    const record = await this.record();
    const previous = record && this.running() ? record.sessions : [];
    await this.replace([
      ...previous.filter((session) => session.id !== id),
      { id, config, settings: validateApps(settings, "win32") },
    ]);
  }
  async remove(id) {
    const record = await this.record();
    if (!record?.sessions.some((session) => session.id === id)) return;
    const next = record.sessions.filter((session) => session.id !== id);
    if (this.running()) await this.replace(next);
    else if (next.length)
      await atomicWrite(
        this.marker,
        JSON.stringify({ ...record, sessions: next }),
      );
    else await this.stop();
    this.errors.delete(id);
  }
  async pause() {
    if (!(await this.record()) || !this.running()) return false;
    await this.stopJob();
    this.paused = true;
    return true;
  }
  async resume() {
    if (!this.paused) return;
    const record = await this.record();
    try {
      if (record)
        await this.launch(record.sessions, await this.prepare(record.sessions));
    } catch (error) {
      await this.stopJob();
      for (const { id } of record?.sessions || [])
        this.errors.set(
          id,
          "Не удалось обновить совместные маршруты приложений",
        );
      throw error;
    } finally {
      this.paused = false;
    }
  }
  async withNativeChange(task) {
    const resume = await this.pause();
    try {
      return await task();
    } finally {
      if (resume) await this.resume();
    }
  }
  async shutdown() {
    await this.stopJob();
  }
}

module.exports = { WindowsAppTunnels, atomicWrite };
