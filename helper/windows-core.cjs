const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { VERSION, validateRequest, sanitizedStats } = require("./core.cjs");
const { redact } = require("./config.cjs");
const { hasWildcard } = require("./smart-tunneling.cjs");
const { WindowsSmartDns, asArray } = require("./windows-smart-dns.cjs");
const { WindowsAppTunnels } = require("./windows-app-tunnels.cjs");
const { network, cidr } = require("./smart-tunneling.cjs");
const exec = promisify(execFile);

const absentService = (error) =>
  /(?:1060|does not exist|specified service does not exist)/i.test(
    String(error.stdout || "") + String(error.stderr || "") + error.message,
  );
const validId = (id) => /^wg[a-f0-9]{10}$/.test(id);
function avoidWindowsKillSwitch(config) {
  return config
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*AllowedIPs\s*=\s*)([^#]*)(.*)$/i);
      if (!match) return line;
      const routes = match[2]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .flatMap((value) =>
          value === "0.0.0.0/0"
            ? ["0.0.0.0/1", "128.0.0.0/1"]
            : value === "::/0"
              ? ["::/1", "8000::/1"]
              : [value],
        );
      return (
        match[1] +
        routes.join(", ") +
        (match[3] ? " " + match[3].trimStart() : "")
      );
    })
    .join("\n");
}
async function atomicWrite(file, content) {
  const temporary = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function createWindowsCore({
  base,
  configDirectory,
  run = exec,
  environment = process.env,
  smartOptions = {},
  appOptions = {},
}) {
  const systemRoot = environment.SystemRoot || "C:\\Windows";
  const programFiles = environment.ProgramFiles || "C:\\Program Files";
  const wireguardDirectory = path.join(programFiles, "WireGuard");
  const binaries = {
    wireguard: path.join(wireguardDirectory, "wireguard.exe"),
    wg: path.join(wireguardDirectory, "wg.exe"),
    powershell: path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    sc: path.join(systemRoot, "System32", "sc.exe"),
  };
  const options = {
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: {
      SystemRoot: systemRoot,
      ProgramFiles: programFiles,
      PATH: environment.PATH || "",
      LANG: "C",
    },
  };
  const command = (name, args) => run(binaries[name], args, options);
  const systemRun = (file, args) => run(file, args, options);
  const powershell = (script) =>
    command("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]);
  let tail = Promise.resolve();
  const serialize = (task) => {
    const job = tail.then(task);
    tail = job.catch(() => {});
    return job;
  };
  async function serviceState(id) {
    try {
      const { stdout } = await command("sc", [
        "query",
        `WireGuardTunnel$${id}`,
      ]);
      return /STATE\s*:\s*4\s+RUNNING/i.test(stdout) ? "running" : "stopped";
    } catch (error) {
      if (absentService(error)) return "absent";
      throw error;
    }
  }
  async function routeEnvironment() {
    const script = [
      "$adapters=@{}; Get-NetAdapter -IncludeHidden | ForEach-Object {",
      "$adapters[$_.ifIndex]=@{ alias=$_.Name; virtual=(-not $_.HardwareInterface); up=($_.Status -eq 'Up') } };",
      "$items=Get-NetRoute -AddressFamily IPv4,IPv6 | ForEach-Object {",
      "$a=$adapters[$_.InterfaceIndex]; if($a){ [pscustomobject]@{ route=$_.DestinationPrefix; interfaceName=$a.alias; virtual=$a.virtual; up=$a.up } } };",
      "@($items) | ConvertTo-Json -Compress",
    ].join(" ");
    const routes = asArray(
      JSON.parse(String((await powershell(script)).stdout || "[]")),
    ).flatMap((item) => {
      try {
        return [
          {
            route: cidr(network(String(item.route))),
            interfaceName: String(item.interfaceName),
            virtual: item.virtual === true,
            up: item.up === true,
          },
        ];
      } catch {
        return [];
      }
    });
    let dump = "";
    try {
      dump = (await command("wg", ["show", "all", "dump"])).stdout;
    } catch {}
    const interfaces = sanitizedStats(dump, /^wg[a-f0-9]{10}$/);
    const endpoints = Object.values(interfaces).flatMap((iface) =>
      iface.peers.flatMap((peer) => {
        const match = peer.endpoint.match(/^(?:\[([^\]]+)\]|([^:]+)):\d+$/);
        return match ? [match[1] || match[2]] : [];
      }),
    );
    return {
      occupied: routes,
      routes: routes
        .filter(
          (route) =>
            route.up &&
            route.virtual &&
            !/^sing-tun/i.test(route.interfaceName),
        )
        .map((route) => ({
          route: route.route,
          interfaceName: route.interfaceName,
          external: !interfaces[route.interfaceName],
        })),
      endpoints,
      transportPaths: [binaries.wireguard, binaries.wg],
    };
  }
  const applications = new WindowsAppTunnels({
    base,
    configDirectory,
    run: systemRun,
    environment: routeEnvironment,
    ...appOptions,
  });
  const smart = new WindowsSmartDns({
    configDirectory,
    command,
    powershell,
    serialize,
    stopTunnel: async (id) => {
      if ((await serviceState(id)) !== "absent")
        await command("wireguard", ["/uninstalltunnelservice", id]);
    },
    withRoutesChange: (task) => applications.withNativeChange(task),
    ...smartOptions,
  });
  let initialization;
  const initialize = () =>
    (initialization ||= (async () => {
      await Promise.all([
        fs.access(binaries.wireguard),
        fs.access(binaries.wg),
      ]).catch(() => {
        throw Error("WireGuard for Windows не установлен");
      });
      await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
      await applications.recover();
      await smart.recover();
    })());
  async function snapshot(ids) {
    let dump = "";
    try {
      dump = (await command("wg", ["show", "all", "dump"])).stdout;
    } catch (error) {
      if (!String(error.stderr || error.message).trim()) throw error;
    }
    const interfaces = sanitizedStats(dump, /^wg[a-f0-9]{10}$/);
    const profiles = {};
    await Promise.all(
      ids.map(async (id) => {
        const service = await serviceState(id);
        const active = service === "running" && !!interfaces[id];
        profiles[id] = {
          active,
          statusUnknown:
            service !== "absent" &&
            !(service === "running" && !!interfaces[id]),
          interfaceName: active ? id : null,
          stats: active ? interfaces[id] : null,
          smartError: smart.errors.get(id) || "",
        };
      }),
    );
    for (const appState of await applications.snapshots())
      if (ids.includes(appState.id)) profiles[appState.id] = appState;
    for (const id of ids)
      if (applications.errors.has(id))
        profiles[id].smartError = applications.errors.get(id);
    return { profiles, updatedAt: Date.now() };
  }
  async function nativeChange(request) {
    const before = await snapshot([request.id]);
    const current = before.profiles[request.id];
    if (!current.statusUnknown && current.active === request.active)
      return { ...before, output: "Состояние уже соответствует запросу" };
    if (current.statusUnknown)
      throw Error(
        "Обнаружено устаревшее системное состояние туннеля. Требуется восстановление, автоматическое изменение остановлено.",
      );
    const target = path.join(configDirectory, request.id + ".conf");
    const session = request.smartTunneling
      ? await smart.prepare(request.id, request.config, request.smartTunneling)
      : null;
    const hasMarker = await fs.access(smart.marker(request.id)).then(
      () => true,
      () => false,
    );
    if (!request.active && hasMarker) await smart.deactivate(request.id);
    if (request.active)
      await atomicWrite(
        target,
        avoidWindowsKillSwitch(session?.compiled || request.config),
      );
    try {
      const result = await command("wireguard", [
        request.active ? "/installtunnelservice" : "/uninstalltunnelservice",
        request.active ? target : request.id,
      ]);
      applications.errors.delete(request.id);
      let after;
      for (let attempt = 0; attempt < 40; attempt++) {
        after = await snapshot([request.id]);
        if (
          request.active
            ? after.profiles[request.id].active
            : !after.profiles[request.id].active &&
              !after.profiles[request.id].statusUnknown
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (
        request.active
          ? !after.profiles[request.id].active
          : after.profiles[request.id].active ||
            after.profiles[request.id].statusUnknown
      )
        throw Error("Служба WireGuard не подтвердила изменение состояния");
      if (session) await smart.activate(session, request.id);
      if (!request.active && hasMarker) await smart.finish(request.id);
      return {
        ...after,
        output: redact(
          [result.stdout, result.stderr].filter(Boolean).join("\n"),
        ),
      };
    } catch (error) {
      if (session) {
        await smart.deactivate(request.id).catch(() => {});
        if ((await serviceState(request.id)) !== "absent")
          await command("wireguard", [
            "/uninstalltunnelservice",
            request.id,
          ]).catch(() => {});
        await smart.finish(request.id);
      }
      throw Error(redact(error.stderr || error.message));
    }
  }
  async function handle(input) {
    const request = validateRequest(input);
    if (request.op === "ping") return { version: VERSION };
    if (request.op === "snapshot") return snapshot(request.ids);
    if (request.op === "forget") {
      const current = (await snapshot([request.id])).profiles[request.id];
      if (current.active || current.statusUnknown)
        throw Error("Сначала отключите туннель");
      await fs.rm(path.join(configDirectory, request.id + ".conf"), {
        force: true,
      });
      await applications.remove(request.id);
      applications.errors.delete(request.id);
      smart.errors.delete(request.id);
      return { removed: true };
    }
    const appState = (await applications.snapshots()).find(
      (state) => state.id === request.id,
    );
    if (!request.active && appState) {
      await applications.remove(request.id);
      return { ...(await snapshot([request.id])), output: "Отключено" };
    }
    if (request.applications) {
      const current = (await snapshot([request.id])).profiles[request.id];
      if (current.statusUnknown)
        throw Error("Обнаружено устаревшее системное состояние туннеля");
      if (current.active)
        return { ...(await snapshot([request.id])), output: "Уже подключено" };
      await applications.start(
        request.id,
        request.config,
        request.applications,
      );
      return {
        ...(await snapshot([request.id])),
        output: "Маршрутизация по приложениям включена",
      };
    }
    return applications.withNativeChange(() => nativeChange(request));
  }
  return {
    initialize,
    snapshot,
    handle: (input) =>
      serialize(async () => {
        await initialize();
        return handle(input);
      }),
    async shutdown() {
      await smart.shutdown().catch(() => {});
      await applications.shutdown().catch(() => {});
    },
    _test: { serviceState, routeEnvironment, binaries, powershell },
  };
}

module.exports = {
  createWindowsCore,
  atomicWrite,
  absentService,
  avoidWindowsKillSwitch,
};
