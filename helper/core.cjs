const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { parseConfig, redact } = require("./config.cjs");
const { SmartDns, parseRouteTable } = require("./smart-dns.cjs");
const { hasWildcard, validateSettings } = require("./smart-tunneling.cjs");
const { AppTunnels } = require("./app-tunnels.cjs");
const { validateApps, enabled: appsEnabled } = require("./app-tunneling.cjs");
const exec = promisify(execFile);
const VERSION = 11;
const validId = (id) => typeof id === "string" && /^wg[a-f0-9]{10}$/.test(id);
function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw Error("Invalid request");
  const fields = {
    ping: ["op"],
    snapshot: ["op", "ids"],
    forget: ["op", "id"],
    setActive: [
      "op",
      "id",
      "active",
      "config",
      "smartTunneling",
      "applications",
    ],
  };
  if (
    !Object.hasOwn(fields, request.op) ||
    Object.keys(request).some((key) => !fields[request.op].includes(key))
  )
    throw Error("Unsupported request");
  if (
    request.op === "snapshot" &&
    (!Array.isArray(request.ids) ||
      request.ids.length > 256 ||
      !request.ids.every(validId))
  )
    throw Error("Invalid tunnel IDs");
  if (request.op === "forget" && !validId(request.id))
    throw Error("Invalid tunnel ID");
  if (request.op === "setActive") {
    if (
      !validId(request.id) ||
      typeof request.active !== "boolean" ||
      typeof request.config !== "string" ||
      Buffer.byteLength(request.config) > 65536 ||
      request.config.includes("\0")
    )
      throw Error("Invalid tunnel configuration");
    parseConfig(request.config);
    if (request.applications !== undefined) {
      const settings = validateApps(request.applications);
      if (
        !request.active ||
        !appsEnabled(settings) ||
        request.smartTunneling !== undefined
      )
        throw Error("Invalid app routing settings");
    }
    if (request.smartTunneling !== undefined) {
      const settings = validateSettings(request.smartTunneling);
      if (!request.active || !hasWildcard(settings))
        throw Error("Invalid dynamic tunneling settings");
    }
  }
  return request;
}
function sanitizedStats(text, validInterface = /^utun\d+$/) {
  const interfaces = {};
  for (const line of text.trim().split(/[\r\n]+/)) {
    const f = line.split("\t");
    if (f.length === 5 && validInterface.test(f[0]))
      interfaces[f[0]] = {
        publicKey: f[2],
        listenPort: Number(f[3]),
        fwmark: f[4],
        updatedAt: Date.now(),
        peers: [],
      };
    if (f.length === 9 && interfaces[f[0]])
      interfaces[f[0]].peers.push({
        publicKey: f[1],
        endpoint: f[3],
        allowedIPs: f[4],
        lastHandshake: Number(f[5]),
        rx: Number(f[6]),
        tx: Number(f[7]),
        keepalive: f[8],
      });
  }
  return interfaces;
}
function createCore({
  base,
  configDirectory,
  run = exec,
  runtimeDirectory = "/var/run/wireguard",
  userId = process.getuid(),
  smartOptions = {},
}) {
  const bin = path.join(base, "bin");
  const env = {
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${bin}`,
    HOME: "/var/root",
    LANG: "C",
    LC_ALL: "C",
    WG_QUICK_USERSPACE_IMPLEMENTATION: path.join(bin, "wireguard-go"),
  };
  const command = (name, args) =>
    run(path.join(bin, name), args, {
      env,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
  let tail = Promise.resolve();
  const serialize = (task) => {
    const job = tail.then(task);
    tail = job.catch(() => {});
    return job;
  };
  const systemRun = (file, args) =>
    run(file, args, { env, timeout: 15000, maxBuffer: 1024 * 1024 });
  const smart = new SmartDns({
    configDirectory,
    userId,
    command,
    run: systemRun,
    serialize,
    stopTunnel: async (id) => {
      const current = (await snapshot([id])).profiles[id];
      if (current.statusUnknown)
        throw Error("Не удалось безопасно остановить туннель после ошибки DNS");
      if (current.active)
        await command("bash", [
          path.join(bin, "wg-quick"),
          "down",
          path.join(configDirectory, id + ".conf"),
        ]);
    },
    withRoutesChange: (task) => applications.withNativeChange(task),
    ...smartOptions,
  });
  const applications = new AppTunnels({
    base,
    configDirectory,
    userId,
    run: systemRun,
    environment: async () => {
      const [dump, v4, v6] = await Promise.all([
        command("wg", ["show", "all", "dump"]),
        systemRun("/usr/sbin/netstat", ["-rn", "-f", "inet"]),
        systemRun("/usr/sbin/netstat", ["-rn", "-f", "inet6"]),
      ]);
      const interfaces = sanitizedStats(dump.stdout);
      const occupied = [
        ...parseRouteTable(v4.stdout, "inet"),
        ...parseRouteTable(v6.stdout, "inet6"),
      ];
      const endpoints = Object.values(interfaces).flatMap((iface) =>
        iface.peers.flatMap((peer) => {
          const match = peer.endpoint.match(/^(?:\[([^\]]+)\]|([^:]+)):\d+$/);
          return match ? [match[1] || match[2]] : [];
        }),
      );
      return {
        occupied,
        transportPaths: [path.join(bin, "wireguard-go")],
        routes: occupied
          .filter((r) => /^utun\d+$/.test(r.interfaceName))
          .map((r) => ({
            ...r,
            external: !interfaces[r.interfaceName],
          })),
        endpoints,
      };
    },
  });
  let initialization;
  const initialize = () =>
    (initialization ||= (async () => {
      await applications.recover();
      await smart.recover();
    })());
  async function snapshot(ids) {
    const { stdout } = await command("wg", ["show", "all", "dump"]);
    const interfaces = sanitizedStats(stdout);
    const profiles = {};
    for (const id of ids) {
      let iface = null,
        active = false,
        statusUnknown = false;
      try {
        iface = (
          await fs.readFile(path.join(runtimeDirectory, id + ".name"), "utf8")
        ).trim();
        if (/^utun\d+$/.test(iface) && interfaces[iface]) {
          const [name, sock] = await Promise.all([
            fs.stat(path.join(runtimeDirectory, id + ".name")),
            fs.stat(path.join(runtimeDirectory, iface + ".sock")),
          ]);
          active =
            sock.isSocket() && Math.abs(sock.mtimeMs - name.mtimeMs) < 2000;
        }
        statusUnknown = !active;
      } catch (e) {
        statusUnknown = e.code !== "ENOENT";
      }
      profiles[id] = {
        active,
        statusUnknown,
        interfaceName: active ? iface : null,
        stats: active ? interfaces[iface] : null,
        smartError: smart.errors.get(id) || "",
      };
    }
    for (const appState of await applications.snapshots())
      if (ids.includes(appState.id)) profiles[appState.id] = appState;
    for (const id of ids)
      if (applications.errors.has(id))
        profiles[id].smartError = applications.errors.get(id);
    return { profiles, updatedAt: Date.now() };
  }
  async function handle(input) {
    const req = validateRequest(input);
    if (req.op === "ping") return { version: VERSION };
    if (req.op === "snapshot") return snapshot(req.ids);
    if (req.op === "forget") {
      const current = (await snapshot([req.id])).profiles[req.id];
      if (current.active || current.statusUnknown)
        throw Error("Сначала отключите туннель");
      await fs.rm(path.join(configDirectory, req.id + ".conf"), {
        force: true,
      });
      await applications.remove(req.id);
      applications.errors.delete(req.id);
      smart.errors.delete(req.id);
      return { removed: true };
    }
    const appState = (await applications.snapshots()).find(
      (s) => s.id === req.id,
    );
    if (!req.active && appState) {
      await applications.remove(req.id);
      return { ...(await snapshot([req.id])), output: "Отключено" };
    }
    if (req.applications) {
      const current = (await snapshot([req.id])).profiles[req.id];
      if (current.statusUnknown)
        throw Error(
          "Обнаружено устаревшее системное состояние туннеля. Требуется восстановление, автоматическое изменение остановлено.",
        );
      if (current.active)
        return { ...(await snapshot([req.id])), output: "Уже подключено" };
      await applications.start(req.id, req.config, req.applications);
      return {
        ...(await snapshot([req.id])),
        output: "Маршрутизация по приложениям включена",
      };
    }
    const current = (await snapshot([req.id])).profiles[req.id];
    if (!current.statusUnknown && current.active === req.active)
      return {
        ...(await snapshot([req.id])),
        output: "Состояние уже соответствует запросу",
      };
    return applications.withNativeChange(() => nativeChange(req));
  }
  async function nativeChange(req) {
    const before = await snapshot([req.id]);
    const current = before.profiles[req.id];
    if (!current.statusUnknown && current.active === req.active)
      return { ...before, output: "Состояние уже соответствует запросу" };
    if (current.statusUnknown)
      throw Error(
        "Обнаружено устаревшее системное состояние туннеля. Требуется восстановление, автоматическое изменение остановлено.",
      );
    await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(configDirectory, req.id + ".conf");
    // Retain the configuration used for UP, so DOWN restores its routes and DNS.
    const exists = await fs.access(target).then(
      () => true,
      () => false,
    );
    const session = req.smartTunneling
      ? await smart.prepare(req.id, req.config, req.smartTunneling)
      : null;
    const hasMarker = await fs.access(smart.marker(req.id)).then(
      () => true,
      () => false,
    );
    if (!req.active && hasMarker) await smart.deactivate(req.id);
    if (req.active || !exists) {
      const tmp = target + "." + crypto.randomBytes(8).toString("hex");
      try {
        await fs.writeFile(tmp, session?.compiled || req.config, {
          flag: "wx",
          mode: 0o600,
        });
        await fs.rename(tmp, target);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    }
    try {
      const { stdout, stderr } = await command("bash", [
        path.join(bin, "wg-quick"),
        req.active ? "up" : "down",
        target,
      ]);
      applications.errors.delete(req.id);
      const after = await snapshot([req.id]);
      if (session) {
        if (!after.profiles[req.id].active)
          throw Error("Не удалось определить интерфейс Smart tunneling");
        await smart.activate(session, after.profiles[req.id].interfaceName);
      }
      if (!req.active && hasMarker) await smart.finish(req.id);
      return {
        ...after,
        output: redact([stdout, stderr].filter(Boolean).join("\n")),
      };
    } catch (error) {
      if (session) {
        await smart.deactivate(req.id);
        const current = (await snapshot([req.id])).profiles[req.id];
        if (current.active)
          await command("bash", [path.join(bin, "wg-quick"), "down", target]);
        if (current.statusUnknown)
          throw Error(
            "Не удалось безопасно остановить туннель после ошибки DNS",
          );
        await smart.finish(req.id);
      }
      throw Error(redact(error.stderr || error.message));
    }
  }
  return {
    initialize,
    handle: (input) =>
      serialize(async () => {
        await initialize();
        return handle(input);
      }),
  };
}
module.exports = { VERSION, validateRequest, sanitizedStats, createCore };
