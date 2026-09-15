const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { compileGroup, validateApps } = require("./app-tunneling.cjs");
const { parseConfig } = require("./config.cjs");
const xml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
async function atomicWrite(file, text) {
  const temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
// A single launchd process owns all application routes. Native tunnel changes
// run with this process paused, preventing either owner from deleting the other's routes.
class AppTunnels {
  constructor({
    base,
    configDirectory,
    userId,
    run,
    environment = async () => ({ routes: [], occupied: [], endpoints: [] }),
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
    processAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if (e.code === "ESRCH") return false;
        throw e;
      }
    },
  }) {
    Object.assign(this, {
      base,
      configDirectory,
      run,
      environment,
      delay,
      processAlive,
    });
    this.label = `local.wireguard.desktop.apps.${userId}`;
    this.job = "system/" + this.label;
    this.marker = path.join(configDirectory, "applications.json");
    this.config = path.join(configDirectory, "applications-engine.json");
    this.plist = path.join(configDirectory, "applications.plist");
    this.log = path.join(configDirectory, "applications.log");
    this.errors = new Map();
    this.paused = false;
  }
  async record() {
    let r;
    try {
      r = JSON.parse(await fs.readFile(this.marker, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    // Recover the previous helper's single-connection journal too.
    if (/^wg[a-f0-9]{10}$/.test(r?.id))
      return { schema: 1, sessions: [{ id: r.id }] };
    if (
      r?.schema !== 2 ||
      !Array.isArray(r.sessions) ||
      !r.sessions.length ||
      r.sessions.length > 32
    )
      throw Error("Invalid app tunnel journal");
    const ids = new Set();
    for (const session of r.sessions) {
      if (
        !/^wg[a-f0-9]{10}$/.test(session.id) ||
        ids.has(session.id) ||
        typeof session.config !== "string" ||
        Buffer.byteLength(session.config) > 65536
      )
        throw Error("Invalid app tunnel journal");
      ids.add(session.id);
      parseConfig(session.config);
      validateApps(session.settings);
    }
    return r;
  }
  async running() {
    try {
      const { stdout } = await this.run("/bin/launchctl", ["print", this.job]);
      return /\bstate = running\b/.test(stdout);
    } catch (e) {
      if (e.code === 113 || e.code === 3) return false;
      throw Error("Не удалось проверить движок приложений");
    }
  }
  async stopJob() {
    let pid;
    try {
      const { stdout } = await this.run("/bin/launchctl", ["print", this.job]);
      const match = stdout.match(/\bpid = (\d+)\b/);
      if (match) pid = Number(match[1]);
      if (
        /\bstate = running\b/.test(stdout) &&
        (!Number.isSafeInteger(pid) || pid < 2)
      )
        throw Error("Не удалось определить процесс движка приложений");
    } catch (e) {
      if (e.code !== 113 && e.code !== 3) throw e;
    }
    try {
      await this.run("/bin/launchctl", ["bootout", this.job]);
    } catch (e) {
      if (e.code !== 113 && e.code !== 3)
        throw Error("Не удалось остановить движок приложений");
    }
    // launchd may unregister a service before its process has finished cleaning
    // up TUN routes. Observe that specific PID's exit before changing any routes.
    for (let i = 0; i < 100; i++) {
      if (!(pid && this.processAlive(pid)) && !(await this.running())) return;
      await this.delay(100);
    }
    throw Error("Не удалось остановить движок приложений");
  }
  async cleanup() {
    for (const file of [this.config, this.plist, this.log, this.marker])
      await fs.rm(file, { force: true });
  }
  async stop() {
    await this.stopJob();
    await this.cleanup();
    this.paused = false;
  }
  async recover() {
    const record = await this.record();
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
    const active = await this.running();
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
  async snapshot() {
    return (await this.snapshots())[0] || null;
  }
  async prepare(sessions, preflight = false) {
    const environment = await this.environment();
    const config = compileGroup(
      sessions,
      preflight
        ? {
            ...environment,
            occupied: [],
            // A running application engine also owns an untracked utun.
            // Ignore untracked interfaces until that engine has stopped and
            // route discovery can distinguish it from third-party VPNs.
            routes: environment.routes.filter((route) => !route.external),
          }
        : environment,
    );
    const binary = path.join(this.base, "bin/sing-box");
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
    const binary = path.join(this.base, "bin/sing-box");
    const args = [binary, "run", "-c", this.config]
      .map((a) => `<string>${xml(a)}</string>`)
      .join("");
    const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${this.label}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ExitTimeOut</key><integer>5</integer><key>StandardOutPath</key><string>${xml(this.log)}</string><key>StandardErrorPath</key><string>${xml(this.log)}</string></dict></plist>`;
    await atomicWrite(this.plist, plist);
    await this.run("/bin/launchctl", ["bootstrap", "system", this.plist]);
    for (let i = 0; i < 100; i++) {
      const log = await fs.readFile(this.log, "utf8");
      if (log.includes("sing-box started") && (await this.running())) {
        for (const { id } of sessions) this.errors.delete(id);
        return;
      }
      if (log.includes("FATAL"))
        throw Error("Не удалось запустить движок приложений");
      await this.delay(100);
    }
    throw Error("Движок приложений не подтвердил запуск");
  }
  async replace(next) {
    const record = await this.record();
    const previous = record?.schema === 2 ? record.sessions : [];
    // Validate before stopping a working engine. A failed addition restores all previous sessions.
    if (next.length) await this.prepare(next, true);
    const wasRunning = record && (await this.running());
    await this.stopJob();
    this.paused = true;
    try {
      if (!next.length) {
        await this.cleanup();
        return;
      }
      await atomicWrite(
        this.marker,
        JSON.stringify({ schema: 2, sessions: next }),
      );
      // Re-read routes after stopping the old TUN; its own routes are not conflicts.
      await this.launch(next, await this.prepare(next));
    } catch (error) {
      await this.stopJob();
      if (previous.length) {
        await atomicWrite(
          this.marker,
          JSON.stringify({ schema: 2, sessions: previous }),
        );
        if (wasRunning) {
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
        }
      } else await this.cleanup();
      throw error;
    } finally {
      this.paused = false;
    }
  }
  async start(id, config, settings) {
    const record = await this.record();
    const previous =
      record?.schema === 2 && (await this.running()) ? record.sessions : [];
    await this.replace([
      ...previous.filter((s) => s.id !== id),
      { id, config, settings: validateApps(settings) },
    ]);
  }
  async remove(id) {
    const record = await this.record();
    if (!record?.sessions.some((s) => s.id === id)) return;
    const next = record.sessions.filter((s) => s.id !== id);
    if (await this.running()) await this.replace(next);
    else if (next.length)
      await atomicWrite(
        this.marker,
        JSON.stringify({ schema: 2, sessions: next }),
      );
    else await this.stop();
    this.errors.delete(id);
  }
  async pause() {
    if (!(await this.record()) || !(await this.running())) return false;
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
}
module.exports = { AppTunnels };
