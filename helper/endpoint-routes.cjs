const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const dns = require("node:dns/promises");
const crypto = require("node:crypto");
const { network, cidr } = require("./smart-tunneling.cjs");
const ip = (value) =>
  net.isIP(value) ? cidr(network(value)).split("/")[0] : null;
const family = (address) => (net.isIP(address) === 6 ? "-inet6" : "-inet");
const physical = (name) => /^(?:en|bridge)\d+$/.test(name || "");
const validGateway = (value) =>
  typeof value === "string" &&
  !!ip(value.split("%")[0]) &&
  (!value.includes("%") || physical(value.split("%")[1]));
function parseRoute(text) {
  const field = (name) =>
    text.match(new RegExp("^\\s*" + name + ":\\s*(.+)$", "m"))?.[1].trim();
  return {
    address: ip(field("destination")),
    gateway: field("gateway"),
    interfaceName: field("interface"),
    flags: (field("flags") || "").replace(/[<>]/g, "").split(","),
  };
}
const exact = (route) =>
  route.flags.includes("HOST") &&
  !route.flags.includes("WASCLONED") &&
  !route.flags.includes("IFSCOPE");
const same = (a, b) =>
  a?.gateway === b?.gateway && a?.interfaceName === b?.interfaceName;

// This journal contains only route metadata, never WireGuard keys. All callers
// run in the helper's operation queue, including background network checks.
class EndpointRoutes {
  constructor({
    configDirectory,
    run,
    states,
    lookup = (host) => dns.lookup(host, { all: true }),
  }) {
    Object.assign(this, { run, states, lookup });
    this.file = path.join(configDirectory, "endpoint-routes.json");
    this.sessions = new Map();
    this.routes = new Map();
    this.errors = new Map();
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + "." + crypto.randomBytes(8).toString("hex");
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            schema: 1,
            sessions: [...this.sessions.values()],
            routes: [...this.routes.values()],
          }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.file);
      const directory = await fs.open(path.dirname(this.file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  async load() {
    let data;
    try {
      data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const validPath = (r) =>
      r && physical(r.interfaceName) && validGateway(r.gateway);
    if (
      data.schema !== 1 ||
      !Array.isArray(data.sessions) ||
      !Array.isArray(data.routes) ||
      data.sessions.length > 256 ||
      data.routes.length > 1024 ||
      data.sessions.some(
        (s) =>
          !/^wg[a-f0-9]{10}$/.test(s.id) ||
          !Array.isArray(s.endpoints) ||
          s.endpoints.some((a) => !ip(a)) ||
          (s.interfaceName !== null && !/^utun\d+$/.test(s.interfaceName)),
      ) ||
      data.routes.some(
        (r) =>
          !ip(r.address) ||
          !validPath(r) ||
          typeof r.owned !== "boolean" ||
          (r.previous && !validPath(r.previous)),
      )
    )
      throw Error("Invalid endpoint route journal");
    this.sessions = new Map(data.sessions.map((s) => [s.id, s]));
    this.routes = new Map(data.routes.map((r) => [r.address, r]));
  }
  async current(address) {
    try {
      return parseRoute(
        (await this.run("/sbin/route", ["-n", "get", family(address), address]))
          .stdout,
      );
    } catch (error) {
      if (
        /not in table|not found|no such process|network is unreachable/i.test(
          (error.stderr || "") + error.message,
        )
      )
        return { flags: [] };
      throw error;
    }
  }
  async uplinks() {
    const { stdout } = await this.run("/usr/sbin/networksetup", [
      "-listnetworkserviceorder",
    ]);
    return [
      ...new Set(
        [...stdout.matchAll(/Device:\s*((?:en|bridge)\d+)\)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
  }
  async gateway(address, interfaces) {
    for (const interfaceName of interfaces) {
      try {
        const route = parseRoute(
          (
            await this.run("/sbin/route", [
              "-n",
              "get",
              family(address),
              "-ifscope",
              interfaceName,
              "default",
            ])
          ).stdout,
        );
        if (
          route.interfaceName === interfaceName &&
          validGateway(route.gateway) &&
          net.isIP(route.gateway.split("%")[0]) === net.isIP(address) &&
          route.flags.includes("UP") &&
          route.flags.includes("GATEWAY")
        )
          return { interfaceName, gateway: route.gateway };
      } catch {}
    }
    throw Error("Нет прямого подключения к сети для VPN-сервера");
  }
  async command(action, record) {
    return this.run("/sbin/route", [
      "-q",
      "-n",
      action,
      family(record.address),
      "-host",
      record.address,
      record.gateway,
      "-ifp",
      record.interfaceName,
    ]);
  }
  async ensure(address, desired) {
    const record = this.routes.get(address),
      current = await this.current(address);
    const host = current.address === address && exact(current);
    const ours =
      host &&
      record?.owned &&
      (same(current, record) || same(current, record.previous));
    if (host && !ours) {
      if (!same(current, desired))
        throw Error("Маршрут к VPN-серверу занят другим соединением");
      // A matching pre-existing route is borrowed, never removed by us.
      if (!record || record.owned || !same(record, desired)) {
        this.routes.set(address, { address, ...desired, owned: false });
        await this.save();
      }
      return;
    }
    if (ours && same(current, desired)) {
      if (record.previous || !same(record, desired)) {
        this.routes.set(address, { address, ...desired, owned: true });
        await this.save();
      }
      return;
    }
    const next = {
      address,
      ...desired,
      owned: true,
      ...(ours
        ? {
            previous: {
              gateway: current.gateway,
              interfaceName: current.interfaceName,
            },
          }
        : {}),
    };
    this.routes.set(address, next);
    await this.save(); // before kernel mutation
    try {
      await this.command(ours ? "change" : "add", next);
    } catch (error) {
      // A failed add must not claim a route another process won a race to add.
      if (!ours) {
        this.routes.delete(address);
        await this.save();
      }
      throw error;
    }
    const installed = await this.current(address);
    if (
      installed.address !== address ||
      !exact(installed) ||
      !same(installed, next)
    )
      throw Error("Не удалось закрепить прямой маршрут к VPN-серверу");
    delete next.previous;
    await this.save();
  }
  async prune() {
    const used = new Set(
      [...this.sessions.values()].flatMap((s) => s.endpoints),
    );
    for (const [address, record] of this.routes) {
      if (used.has(address)) continue;
      const current = await this.current(address);
      if (
        record.owned &&
        current.address === address &&
        exact(current) &&
        (same(current, record) || same(current, record.previous))
      ) {
        await this.command("delete", {
          ...record,
          gateway: current.gateway,
          interfaceName: current.interfaceName,
        });
      }
      this.routes.delete(address);
      await this.save();
    }
  }
  async prepare(id, config) {
    const fullFamilies = new Set();
    for (const match of config.matchAll(/^\s*AllowedIPs\s*=\s*([^#\r\n]*)/gm))
      for (const value of match[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const route = network(value);
        if (route.prefix === 0)
          fullFamilies.add(net.isIP(cidr(route).split("/")[0]));
      }
    const lines = config.split(/\r?\n/),
      endpoints = [],
      changes = new Map(),
      paths = new Map();
    let interfaces;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(
        /^(\s*Endpoint\s*=\s*)(?:\[([^\]]+)\]|([^:#\s]+)):(\d+)\s*(?:#.*)?$/,
      );
      if (!match) continue;
      const host = match[2] || match[3];
      let timer;
      const addresses = ip(host)
        ? [{ address: host }]
        : await Promise.race([
            this.lookup(host),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("Не удалось разрешить адрес VPN-сервера")),
                5000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
      let selected, failure;
      for (const item of addresses) {
        const address = ip(item.address);
        if (!address) continue;
        if (fullFamilies.has(net.isIP(address))) {
          selected = address;
          break;
        }
        try {
          interfaces ||= await this.uplinks();
          paths.set(address, await this.gateway(address, interfaces));
          selected = address;
          endpoints.push(address);
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (!selected)
        throw failure || Error("Не удалось разрешить адрес VPN-сервера");
      changes.set(
        i,
        `${match[1]}${selected.includes(":") ? "[" + selected + "]" : selected}:${match[4]}`,
      );
    }
    if (!endpoints.length) return config;
    this.sessions.set(id, {
      id,
      endpoints: [...new Set(endpoints)],
      interfaceName: null,
    });
    await this.save();
    try {
      for (const address of endpoints)
        await this.ensure(address, paths.get(address));
    } catch (error) {
      await this.release(id);
      throw error;
    }
    return lines.map((line, i) => changes.get(i) || line).join("\n");
  }
  async activate(id, interfaceName) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.interfaceName = interfaceName;
    await this.save();
    this.errors.delete(id);
  }
  async release(id) {
    this.sessions.delete(id);
    this.errors.delete(id);
    await this.save();
    await this.prune();
  }
  async refresh() {
    if (!this.sessions.size && !this.routes.size) return;
    const states = await this.states([...this.sessions.keys()]);
    let interfaces;
    for (const [id, session] of this.sessions) {
      const state = states[id];
      if (!state || state.statusUnknown) continue;
      if (
        !state.active ||
        (session.interfaceName && state.interfaceName !== session.interfaceName)
      ) {
        await this.release(id);
        continue;
      }
      try {
        if (!session.interfaceName) {
          session.interfaceName = state.interfaceName;
          await this.save();
        }
        interfaces ||= await this.uplinks();
        // Keep the resolved endpoint stable for the connection. New connections
        // resolve the hostname again; network changes only change the uplink.
        for (const address of session.endpoints)
          await this.ensure(address, await this.gateway(address, interfaces));
        this.errors.delete(id);
      } catch (error) {
        this.errors.set(id, error.message);
      }
    }
    await this.prune();
  }
}
module.exports = { EndpointRoutes, parseRoute };
