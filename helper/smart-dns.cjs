const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
  question,
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
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
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
    upstreams,
    proxy = createDnsProxy,
    forwardQuery = forward,
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
      forwardQuery,
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
  async currentUpstreams() {
    if (this.upstreams) return await this.upstreams();
    const { stdout } = await this.run("/usr/sbin/scutil", ["--dns"]);
    const global = stdout.split("DNS configuration (for scoped queries)")[0];
    // Read the current primary resolver for every connection. Do not retain
    // Node's resolver configuration from before a network/VPN change.
    const primary = global
      .split(/resolver #\d+/)
      .find(
        (block) =>
          /nameserver\[\d+\]/.test(block) &&
          !/^\s*(?:domain|options)\s*:/m.test(block),
      );
    return [
      ...(primary || "").matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)/gm),
    ].map((match) => match[1]);
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
    const replacements = [];
    const fail = (domain) => {
      throw Error(`DNS-правила пересекаются с существующим доменом: ${domain}`);
    };
    const files = await fs.readdir(this.resolverDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files) {
      const target = path.join(this.resolverDirectory, file);
      const info = await fs.lstat(target);
      // A symlink may represent a separately managed resolver. Do not replace it.
      if (!info.isFile()) {
        if (domains.some((domain) => suffixesOverlap(domain, file))) fail(file);
        continue;
      }
      if (info.size > 65536)
        throw Error("Не удалось проверить системные DNS-настройки");
      const original = await fs.readFile(target, "utf8");
      const configured = (
        original.match(/^\s*domain\s+([^\s#]+)/m)?.[1] || file
      )
        .toLowerCase()
        .replace(/\.$/, "");
      if (!domains.some((domain) => suffixesOverlap(domain, configured)))
        continue;
      // Support exact, ordinary unicast resolver files. Other active tunnels,
      // parent/child overrides and dynamic system resolvers still fail closed.
      if (
        !domains.includes(configured) ||
        original.startsWith("# WireGuard Desktop managed resolver\n") ||
        !/^[a-zA-Z0-9._-]{1,255}$/.test(file) ||
        file === "." ||
        file === ".." ||
        (this.enforceOwnership && (info.uid !== 0 || info.mode & 0o022)) ||
        replacements.some((record) => record.domain === configured)
      )
        fail(configured);
      const servers = [];
      for (const raw of original.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        if (!line) continue;
        const [key, value, ...rest] = line.split(/\s+/);
        if (!value || rest.length) fail(configured);
        if (key === "nameserver") {
          if (
            !net.isIP(value) ||
            value === "0.0.0.0" ||
            value === "::" ||
            value.startsWith("127.") ||
            value === "::1"
          )
            fail(configured);
          servers.push(value);
        } else if (key === "domain") {
          if (value.toLowerCase().replace(/\.$/, "") !== configured)
            fail(configured);
        } else if (key === "port") {
          if (value !== "53") fail(configured);
        } else if (
          !["search_order", "timeout"].includes(key) ||
          !/^\d+$/.test(value)
        )
          fail(configured);
      }
      if (!servers.length || servers.length > 3) fail(configured);
      replacements.push({
        file,
        domain: configured,
        servers,
        original,
        mode: info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
      });
    }
    const { stdout } = await this.run("/usr/sbin/scutil", ["--dns"]);
    // A matching file must account for the active system resolver too. Never
    // hijack another VPN's supplemental or multicast resolver with the same name.
    const globalDns = stdout.split("DNS configuration (for scoped queries)")[0];
    for (const block of globalDns.split(/resolver #\d+/)) {
      const configured = block
        .match(/^\s*domain\s*:\s*(\S+)/m)?.[1]
        ?.toLowerCase()
        .replace(/\.$/, "");
      if (
        !configured ||
        !domains.some((domain) => suffixesOverlap(domain, configured))
      )
        continue;
      const record = replacements.find((item) => item.domain === configured);
      const servers = [
        ...block.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)/gm),
      ].map((match) => match[1]);
      const port = block.match(/^\s*port\s*:\s*(\d+)/m)?.[1];
      if (
        !record ||
        /(?:options\s*:|if_index\s*:)/m.test(block) ||
        (port && port !== "53") ||
        servers.length !== record.servers.length ||
        servers.some((server, i) => server !== record.servers[i])
      )
        fail(configured);
    }
    return replacements;
  }
  async resolverWrite(file, text, record) {
    const target = path.join(this.resolverDirectory, file);
    // Stage outside /etc/resolver so configd cannot discover an intermediate
    // file as a second resolver for this domain.
    const staging = await fs.mkdtemp(
      path.join(this.configDirectory, ".resolver-write-"),
    );
    const temporary = path.join(staging, "resolver");
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      if (this.enforceOwnership)
        await fs.chown(temporary, record.uid, record.gid);
      await fs.chmod(temporary, record.mode);
      const handle = await fs.open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      const directory = await fs.open(this.resolverDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
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
    const replacements = await this.conflicts(domains);
    const deferredDomains = settings.entries.filter(
      (entry) =>
        !entry.startsWith("*.") &&
        domains.some(
          (domain) => entry === domain || entry.endsWith("." + domain),
        ),
    );
    const matches = (name) =>
      deferredDomains.includes(name) ||
      patterns.some((pattern) => matchesPattern(pattern, name));
    const servers = (await this.currentUpstreams()).filter((server) =>
      net.isIP(server),
    );
    if (!servers.length) throw Error("Системные DNS-серверы недоступны");
    const serversFor = (name) =>
      replacements.find(
        (record) =>
          name === record.domain || name.endsWith("." + record.domain),
      )?.servers || servers;
    // The private resolver must remain reachable before any domain addresses
    // can be learned. Compilation intersects these with the original peer
    // routes, so this cannot expand the VPN's configured network access.
    const supportingEntries =
      settings.mode === "include"
        ? [...new Set(replacements.flatMap((record) => record.servers))]
        : [];
    const cache = new Map();
    const lookup = async (name) => {
      if (!cache.has(name))
        cache.set(
          name,
          (async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt)
                await new Promise((resolve) => setTimeout(resolve, 250));
              const groups = await Promise.all(
                [1, 28].map(async (type) => {
                  const query = makeQuery(name, type);
                  let timer;
                  try {
                    return answers(
                      await Promise.race([
                        this.forwardQuery(query, serversFor(name)),
                        new Promise((_, reject) => {
                          timer = setTimeout(
                            () => reject(Error("DNS timeout")),
                            4000,
                          );
                        }),
                      ]),
                      query,
                    );
                  } catch {
                    return [];
                  } finally {
                    clearTimeout(timer);
                  }
                }),
              );
              const addresses = [...new Set(groups.flat())].map((address) => ({
                address,
              }));
              if (addresses.length) return addresses;
            }
            throw Error("DNS resolution failed after 3 attempts");
          })(),
        );
      return cache.get(name);
    };
    const compiled = await applySmartTunneling(original, settings, lookup, {
      allowDynamic: true,
      deferredDomains,
      additionalEntries: supportingEntries,
      dnsTimeoutMs: 15000,
    });
    const session = {
      id,
      original,
      settings,
      patterns,
      deferredDomains,
      matches,
      supportingEntries,
      domains,
      servers,
      serversFor,
      replacements,
      lookup,
      compiled,
      learned: new Set(),
      files: [],
      ready: false,
      proxy: null,
    };
    const content = {
      schema: 2,
      files: domains
        .filter(
          (domain) => !replacements.some((record) => record.domain === domain),
        )
        .map((domain) => this.resolverName(id, domain)),
      replacements: [],
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
      forwardQuery: (query) =>
        this.forwardQuery(query, session.serversFor(question(query).name)),
      matches: session.matches,
      observe: (name, addresses) =>
        this.serialize(() => this.observe(session, name, addresses)),
      onError: (error) => this.errors.set(session.id, error.message),
    });
    const contentFor = (domain) =>
      `# WireGuard Desktop managed resolver\ndomain ${domain}\nnameserver 127.0.0.1\nport ${session.proxy.port}\nsearch_order 100\ntimeout 3\n`;
    const replacements = session.replacements.map((record) => ({
      ...record,
      installed: contentFor(record.domain),
    }));
    for (const record of replacements) {
      const target = path.join(this.resolverDirectory, record.file);
      const info = await fs.lstat(target);
      if (
        !info.isFile() ||
        info.uid !== record.uid ||
        info.gid !== record.gid ||
        (info.mode & 0o777) !== record.mode ||
        (await fs.readFile(target, "utf8")) !== record.original
      )
        throw Error(
          `DNS-настройки изменились во время подключения: ${record.domain}`,
        );
    }
    // Persist the exact originals before replacing any file, including before
    // the first rename. Recovery can restore them after any interrupted step.
    const files = session.domains
      .filter(
        (domain) => !replacements.some((record) => record.domain === domain),
      )
      .map((domain) => this.resolverName(session.id, domain));
    await atomicWrite(
      this.marker(session.id),
      JSON.stringify({ schema: 2, files, replacements }),
    );
    for (const record of replacements)
      await this.resolverWrite(record.file, record.installed, record);
    for (const domain of session.domains) {
      if (replacements.some((record) => record.domain === domain)) continue;
      const name = this.resolverName(session.id, domain);
      await fs.writeFile(
        path.join(this.resolverDirectory, name),
        contentFor(domain),
        { flag: "wx", mode: 0o644 },
      );
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
    if (!session.matches(name)) return;
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
          {
            allowDynamic: true,
            additionalEntries: [...session.supportingEntries, ...learned],
            deferredDomains: session.deferredDomains,
          },
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
      ![1, 2].includes(marker.schema) ||
      !Array.isArray(marker.files) ||
      marker.files.length > 64
    )
      throw Error("Invalid Smart DNS recovery data");
    if (marker.schema === 2) {
      if (
        !Array.isArray(marker.replacements) ||
        marker.replacements.length > 64
      )
        throw Error("Invalid Smart DNS recovery data");
      for (const record of marker.replacements) {
        if (
          !record ||
          typeof record.file !== "string" ||
          !/^[a-zA-Z0-9._-]{1,255}$/.test(record.file) ||
          record.file === "." ||
          record.file === ".." ||
          typeof record.original !== "string" ||
          Buffer.byteLength(record.original) > 65536 ||
          typeof record.installed !== "string" ||
          !record.installed.startsWith(
            "# WireGuard Desktop managed resolver\n",
          ) ||
          !Number.isInteger(record.mode) ||
          record.mode < 0 ||
          record.mode > 0o777 ||
          !Number.isInteger(record.uid) ||
          record.uid < 0 ||
          !Number.isInteger(record.gid) ||
          record.gid < 0 ||
          (this.enforceOwnership && (record.uid !== 0 || record.mode & 0o022))
        )
          throw Error("Invalid Smart DNS resolver backup");
        const target = path.join(this.resolverDirectory, record.file);
        const info = await fs.lstat(target);
        if (
          !info.isFile() ||
          info.uid !== record.uid ||
          info.gid !== record.gid
        )
          throw Error(`Системный DNS-файл изменён: ${record.file}`);
        const current = await fs.readFile(target, "utf8");
        if (current === record.original) continue;
        if (current !== record.installed)
          throw Error(`Системный DNS-файл изменён: ${record.file}`);
        await this.resolverWrite(record.file, record.original, record);
      }
    }
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
    try {
      await this.removeFiles(id);
    } finally {
      if (session?.proxy) await session.proxy.close();
    }
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
