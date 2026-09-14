const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns");
const net = require("node:net");
const {
  applySmartTunneling,
  validateSettings,
  matchesPattern,
  network,
  cidr,
} = require("./smart-tunneling.cjs");
const {
  createDnsProxy,
  makeQuery,
  forward,
  answers,
} = require("./dns-wire.cjs");

function peerRoutes(config) {
  const peers = [];
  let peer;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (line === "[Peer]") {
      peer = { key: "", routes: [] };
      peers.push(peer);
    } else if (line === "[Interface]") peer = null;
    else if (peer) {
      const pair = line.match(/^(PublicKey|AllowedIPs)\s*=\s*(.*)$/);
      if (!pair) continue;
      if (pair[1] === "PublicKey") peer.key = pair[2];
      else
        peer.routes.push(
          ...pair[2]
            .split(",")
            .filter(Boolean)
            .map((value) => cidr(network(value.trim()))),
        );
    }
  }
  return peers;
}
function systemRoutes(config) {
  return new Set(
    peerRoutes(config)
      .flatMap((peer) => peer.routes)
      .flatMap((value) =>
        value === "0.0.0.0/0"
          ? ["0.0.0.0/1", "128.0.0.0/1"]
          : value === "::/0"
            ? ["::/1", "8000::/1"]
            : [value],
      ),
  );
}
function parseRouteTable(output, family) {
  let interfaceColumn = -1,
    flagsColumn = -1;
  const result = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] === "Destination") {
      interfaceColumn = columns.indexOf("Netif");
      flagsColumn = columns.indexOf("Flags");
      continue;
    }
    if (
      interfaceColumn < 0 ||
      flagsColumn < 0 ||
      columns.length <= interfaceColumn
    )
      continue;
    const interfaceName = columns[interfaceColumn];
    if (!/^[a-z]+\d+$/.test(interfaceName)) continue;
    let value = columns[0],
      prefix;
    try {
      if (value === "default")
        value = family === "inet6" ? "::/0" : "0.0.0.0/0";
      else {
        let [address, suffix] = value.split("/");
        address = address.replace(/%[^/]+$/, "");
        if (family === "inet") {
          const octets = address.split(".");
          if (
            !octets.every((octet) => /^\d{1,3}$/.test(octet)) ||
            octets.length > 4
          )
            continue;
          prefix =
            suffix ??
            (columns[flagsColumn].includes("H")
              ? "32"
              : String(octets.length * 8));
          while (octets.length < 4) octets.push("0");
          value = octets.join(".") + "/" + prefix;
        } else value = address + "/" + (suffix ?? "128");
      }
      result.push({ route: cidr(network(value)), interfaceName });
    } catch {}
  }
  return result;
}
async function atomicWrite(file, text) {
  const temporary = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function suffixesOverlap(a, b) {
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

class SmartDns {
  constructor({
    configDirectory,
    resolverDirectory = "/etc/resolver",
    userId,
    command,
    run,
    serialize,
    stopTunnel,
    upstreams = () => dns.getServers(),
    proxy = createDnsProxy,
    enforceOwnership = true,
    withRoutesChange = (task) => task(),
  }) {
    Object.assign(this, {
      configDirectory,
      resolverDirectory,
      userId,
      command,
      run,
      serialize,
      stopTunnel,
      upstreams,
      proxy,
      enforceOwnership,
      withRoutesChange,
    });
    this.sessions = new Map();
    this.errors = new Map();
  }
  marker(id) {
    return path.join(this.configDirectory, id + ".smart.json");
  }
  resolverName(id, domain) {
    return `wireguard-desktop-${this.userId}-${id}-${crypto.createHash("sha256").update(domain).digest("hex").slice(0, 16)}`;
  }
  async assertDirectory() {
    await fs.mkdir(this.resolverDirectory, { recursive: true, mode: 0o755 });
    const stat = await fs.lstat(this.resolverDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (this.enforceOwnership && (stat.uid !== 0 || stat.mode & 0o022))
    )
      throw Error("Небезопасная папка системных DNS-настроек");
  }
  async conflicts(domains) {
    const files = await fs.readdir(this.resolverDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files) {
      const info = await fs.lstat(path.join(this.resolverDirectory, file));
      if (!info.isFile()) continue;
      if (info.size > 65536)
        throw Error("Не удалось проверить системные DNS-настройки");
      const content = await fs.readFile(
        path.join(this.resolverDirectory, file),
        "utf8",
      );
      const configured = content.match(/^\s*domain\s+([^\s#]+)/m)?.[1] || file;
      if (
        domains.some((domain) =>
          suffixesOverlap(domain, configured.toLowerCase().replace(/\.$/, "")),
        )
      )
        throw Error(
          `DNS-правила пересекаются с существующим доменом: ${configured}`,
        );
    }
    const { stdout } = await this.run("/usr/sbin/scutil", ["--dns"]);
    for (const match of stdout.matchAll(/^\s*domain\s*:\s*(\S+)/gm))
      if (
        domains.some((domain) =>
          suffixesOverlap(domain, match[1].toLowerCase().replace(/\.$/, "")),
        )
      )
        throw Error(
          `DNS-правила пересекаются с существующим доменом: ${match[1]}`,
        );
  }
  async prepare(id, original, input) {
    if (!/^wg[a-f0-9]{10}$/.test(id)) throw Error("Invalid tunnel ID");
    const settings = validateSettings(input);
    const patterns = settings.entries.filter((entry) => entry.startsWith("*."));
    const allDomains = patterns.map((entry) => entry.slice(2));
    const domains = allDomains.filter(
      (domain) =>
        !allDomains.some(
          (other) => domain !== other && domain.endsWith("." + other),
        ),
    );
    await this.assertDirectory();
    await this.conflicts(domains);
    const servers = this.upstreams().filter((server) => net.isIP(server));
    if (!servers.length) throw Error("Системные DNS-серверы недоступны");
    const cache = new Map();
    const lookup = async (name) => {
      if (!cache.has(name))
        cache.set(
          name,
          (async () => {
            const groups = await Promise.all(
              [1, 28].map(async (type) => {
                const query = makeQuery(name, type);
                try {
                  return answers(await forward(query, servers), query);
                } catch {
                  return [];
                }
              }),
            );
            const addresses = [...new Set(groups.flat())].map((address) => ({
              address,
            }));
            if (!addresses.length) throw Error("DNS resolution failed");
            return addresses;
          })(),
        );
      return cache.get(name);
    };
    const compiled = await applySmartTunneling(original, settings, lookup, {
      allowDynamic: true,
    });
    const session = {
      id,
      original,
      settings,
      patterns,
      domains,
      servers,
      lookup,
      compiled,
      learned: new Set(),
      files: [],
      ready: false,
      proxy: null,
    };
    const content = {
      schema: 1,
      files: domains.map((domain) => this.resolverName(id, domain)),
    };
    await fs.mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.marker(id), JSON.stringify(content));
    this.errors.delete(id);
    return session;
  }
  async activate(session, interfaceName) {
    if (!/^utun\d+$/.test(interfaceName))
      throw Error("Invalid WireGuard interface");
    session.interfaceName = interfaceName;
    this.sessions.set(session.id, session);
    session.proxy = await this.proxy({
      servers: session.servers,
      matches: (name) =>
        session.patterns.some((pattern) => matchesPattern(pattern, name)),
      observe: (name, addresses) =>
        this.serialize(() => this.observe(session, name, addresses)),
      onError: (error) => this.errors.set(session.id, error.message),
    });
    for (const domain of session.domains) {
      const name = this.resolverName(session.id, domain);
      const content = `# WireGuard Desktop managed resolver\ndomain ${domain}\nnameserver 127.0.0.1\nport ${session.proxy.port}\nsearch_order 100\ntimeout 3\n`;
      await fs.writeFile(path.join(this.resolverDirectory, name), content, {
        flag: "wx",
        mode: 0o644,
      });
      session.files.push(name);
    }
    session.ready = true;
    // Clear pre-existing system cache so suffix queries reach the new resolver.
    await this.run("/usr/bin/dscacheutil", ["-flushcache"]);
    await this.run("/usr/bin/killall", ["-HUP", "mDNSResponder"]);
  }
  async routeTable() {
    const groups = await Promise.all(
      ["inet", "inet6"].map(async (family) => {
        const { stdout } = await this.run("/usr/sbin/netstat", [
          "-rn",
          "-f",
          family,
        ]);
        return parseRouteTable(stdout, family);
      }),
    );
    return groups.flat();
  }
  async replaceRoutes(session, next) {
    const before = systemRoutes(session.compiled),
      after = systemRoutes(next);
    // Set cryptokey policy first. During exclusions, packets are dropped until
    // the matching kernel route has been removed, rather than leaking via VPN.
    const table = await this.routeTable();
    const args = ["set", session.interfaceName];
    for (const peer of peerRoutes(next))
      args.push("peer", peer.key, "allowed-ips", peer.routes.join(","));
    await this.command("wg", args);
    for (const route of after) {
      if (before.has(route)) continue;
      const current = table.find((record) => record.route === route);
      if (current?.route === route) {
        if (current.interfaceName === session.interfaceName) continue;
        throw Error("Маршрут Smart tunneling занят другим соединением");
      }
      await this.run("/sbin/route", [
        "-q",
        "-n",
        "add",
        route.includes(":") ? "-inet6" : "-inet",
        route,
        "-interface",
        session.interfaceName,
      ]);
    }
    for (const route of before) {
      if (after.has(route)) continue;
      const current = table.find((record) => record.route === route);
      if (!current) continue;
      if (current.route !== route) continue;
      if (current.interfaceName !== session.interfaceName)
        throw Error("Маршрут Smart tunneling изменён другим соединением");
      await this.run("/sbin/route", [
        "-q",
        "-n",
        "delete",
        route.includes(":") ? "-inet6" : "-inet",
        route,
        "-interface",
        session.interfaceName,
      ]);
    }
    await atomicWrite(
      path.join(this.configDirectory, session.id + ".conf"),
      next,
    );
    session.compiled = next;
  }
  async observe(session, name, addresses) {
    if (!session.ready || this.sessions.get(session.id) !== session)
      throw Error("Smart tunneling stopped");
    if (!session.patterns.some((pattern) => matchesPattern(pattern, name)))
      return;
    const learned = new Set(session.learned);
    for (const address of addresses) learned.add(cidr(network(address)));
    if (learned.size === session.learned.size) return;
    return this.withRoutesChange(async () => {
      try {
        if (learned.size > 256)
          throw Error(
            "Слишком много адресов поддоменов; переподключите туннель",
          );
        const next = await applySmartTunneling(
          session.original,
          session.settings,
          session.lookup,
          { allowDynamic: true, additionalEntries: [...learned] },
        );
        await this.replaceRoutes(session, next);
        session.learned = learned;
      } catch (error) {
        this.errors.set(session.id, error.message);
        // A partial route update must never leave a tunnel claiming its old policy.
        await this.deactivate(session.id);
        await this.stopTunnel(session.id);
        await this.finish(session.id);
        throw error;
      }
    });
  }
  async removeFiles(id) {
    let marker;
    try {
      marker = JSON.parse(await fs.readFile(this.marker(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (
      marker.schema !== 1 ||
      !Array.isArray(marker.files) ||
      marker.files.length > 64
    )
      throw Error("Invalid Smart DNS recovery data");
    const prefix = `wireguard-desktop-${this.userId}-${id}-`;
    for (const file of marker.files) {
      if (
        typeof file !== "string" ||
        !file.startsWith(prefix) ||
        !/^[a-z0-9-]+$/.test(file)
      )
        throw Error("Invalid Smart DNS resolver file");
      const target = path.join(this.resolverDirectory, file);
      const text = await fs.readFile(target, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (text && !text.startsWith("# WireGuard Desktop managed resolver\n"))
        throw Error("DNS resolver file has been changed");
      if (text) await fs.unlink(target);
    }
  }
  async deactivate(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.ready = false;
      this.sessions.delete(id);
    }
    await this.removeFiles(id);
    if (session?.proxy) await session.proxy.close();
    await this.run("/usr/bin/dscacheutil", ["-flushcache"]);
    await this.run("/usr/bin/killall", ["-HUP", "mDNSResponder"]);
  }
  async finish(id) {
    await fs.rm(this.marker(id), { force: true });
  }
  async recover() {
    const files = await fs.readdir(this.configDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files.filter((file) =>
      /^wg[a-f0-9]{10}\.smart\.json$/.test(file),
    )) {
      const id = file.slice(0, -11);
      await this.deactivate(id);
      await this.stopTunnel(id);
      await this.finish(id);
      this.errors.set(
        id,
        "DNS-помощник перезапущен. Подключите туннель заново для применения масок.",
      );
    }
  }
}
module.exports = {
  SmartDns,
  peerRoutes,
  systemRoutes,
  parseRouteTable,
  suffixesOverlap,
};
