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
const { peerRoutes } = require("./smart-dns.cjs");
const {
  createDnsProxy,
  makeQuery,
  forward,
  answers,
  question,
} = require("./dns-wire.cjs");
const { atomicWrite } = require("./windows-app-tunnels.cjs");

const suffixesOverlap = (a, b) =>
  a === b || a.endsWith("." + b) || b.endsWith("." + a);
const asArray = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const json = (text, fallback = []) => {
  const value = String(text || "").trim();
  return value ? JSON.parse(value) : fallback;
};
function systemRoutes(config) {
  return new Set(peerRoutes(config).flatMap((peer) => peer.routes));
}

class WindowsSmartDns {
  constructor({
    configDirectory,
    command,
    powershell,
    serialize,
    stopTunnel,
    upstreams,
    proxy = createDnsProxy,
    forwardQuery = forward,
    withRoutesChange = (task) => task(),
  }) {
    Object.assign(this, {
      configDirectory,
      command,
      powershell,
      serialize,
      stopTunnel,
      upstreams,
      proxy,
      forwardQuery,
      withRoutesChange,
    });
    this.sessions = new Map();
    this.errors = new Map();
    this.dnsProxy = null;
  }
  marker(id) {
    return path.join(this.configDirectory, id + ".smart.json");
  }
  comment(id) {
    return `WireGuard Desktop ${id}`;
  }
  async currentUpstreams() {
    if (this.upstreams) return await this.upstreams();
    const script = [
      "$up=@(Get-NetAdapter -IncludeHidden | Where-Object {$_.Status -eq 'Up'} | ForEach-Object {$_.ifIndex});",
      "$addresses=Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 |",
      "Where-Object {$up -contains $_.InterfaceIndex} |",
      "ForEach-Object {$_.ServerAddresses} |",
      "Where-Object {$_ -and $_ -ne '127.0.0.1' -and $_ -ne '::1'} |",
      "Select-Object -Unique; @($addresses) | ConvertTo-Json -Compress",
    ].join(" ");
    return asArray(json((await this.powershell(script)).stdout)).filter(
      net.isIP,
    );
  }
  async conflicts(domains, id) {
    const script =
      "@(Get-DnsClientNrptRule | Select-Object Name,Namespace,Comment) | ConvertTo-Json -Compress";
    const rules = asArray(json((await this.powershell(script)).stdout));
    for (const rule of rules) {
      if (String(rule.Comment || "") === this.comment(id)) continue;
      const namespaces = asArray(rule.Namespace).map((value) =>
        String(value).toLowerCase().replace(/^\./, "").replace(/\.$/, ""),
      );
      const collision = namespaces.find((existing) =>
        domains.some((domain) => suffixesOverlap(domain, existing)),
      );
      if (collision)
        throw Error(
          `DNS-правила пересекаются с существующим доменом: ${collision}`,
        );
    }
  }
  async prepare(id, original, input) {
    if (!/^wg[a-f0-9]{10}$/.test(id)) throw Error("Invalid tunnel ID");
    const settings = validateSettings(input);
    const patterns = settings.entries.filter((entry) => entry.startsWith("*."));
    const roots = patterns.map((entry) => entry.slice(2));
    const domains = roots.filter(
      (domain) =>
        !roots.some(
          (other) => domain !== other && domain.endsWith("." + other),
        ),
    );
    await this.conflicts(domains, id);
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
    const servers = (await this.currentUpstreams()).filter(net.isIP);
    if (!servers.length) throw Error("Системные DNS-серверы недоступны");
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
                  try {
                    const response = await Promise.race([
                      this.forwardQuery(query, servers),
                      new Promise((_, reject) =>
                        setTimeout(() => reject(Error("DNS timeout")), 4000),
                      ),
                    ]);
                    return answers(response, query);
                  } catch {
                    return [];
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
      dnsTimeoutMs: 15000,
    });
    const session = {
      id,
      original,
      settings,
      patterns,
      deferredDomains,
      domains,
      matches,
      servers,
      lookup,
      compiled,
      learned: new Set(),
      rules: [],
      ready: false,
    };
    await fs.mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(
      this.marker(id),
      JSON.stringify({ schema: 1, rules: [] }),
    );
    this.errors.delete(id);
    return session;
  }
  sessionFor(name) {
    return [...this.sessions.values()]
      .filter((session) => session.matches(name))
      .sort(
        (a, b) =>
          b.domains.reduce((n, d) => Math.max(n, d.length), 0) -
          a.domains.reduce((n, d) => Math.max(n, d.length), 0),
      )[0];
  }
  async ensureProxy() {
    if (this.dnsProxy) return;
    this.dnsProxy = await this.proxy({
      servers: [],
      port: 53,
      matches: (name) => !!this.sessionFor(name),
      forwardQuery: (packet) => {
        const session = this.sessionFor(question(packet).name);
        if (!session) throw Error("No matching Smart DNS session");
        return this.forwardQuery(packet, session.servers);
      },
      observe: (name, addresses) => {
        const session = this.sessionFor(name);
        return session
          ? this.serialize(() => this.observe(session, name, addresses))
          : undefined;
      },
      onError: (error) => {
        const session = [...this.sessions.values()].find((item) => item.ready);
        if (session) this.errors.set(session.id, error.message);
      },
    });
  }
  async addRule(session, domain) {
    const namespace = "." + domain;
    const script = [
      `$rule=Add-DnsClientNrptRule -Namespace ${JSON.stringify(namespace)} -NameServers '127.0.0.1' -Comment ${JSON.stringify(this.comment(session.id))} -PassThru;`,
      "$rule | Select-Object Name,Namespace | ConvertTo-Json -Compress",
    ].join(" ");
    const rule = json((await this.powershell(script)).stdout, null);
    if (!rule?.Name) throw Error("Не удалось создать системное DNS-правило");
    session.rules.push(String(rule.Name));
    await atomicWrite(
      this.marker(session.id),
      JSON.stringify({ schema: 1, rules: session.rules }),
    );
  }
  async activate(session, interfaceName) {
    if (interfaceName !== session.id)
      throw Error("Invalid WireGuard interface");
    session.interfaceName = interfaceName;
    this.sessions.set(session.id, session);
    try {
      await this.ensureProxy();
      for (const domain of session.domains) await this.addRule(session, domain);
      session.ready = true;
      await this.powershell("Clear-DnsClientCache");
    } catch (error) {
      await this.deactivate(session.id).catch(() => {});
      throw error;
    }
  }
  async routeTable() {
    const script = [
      "@(Get-NetRoute -AddressFamily IPv4,IPv6 |",
      "Select-Object DestinationPrefix,InterfaceAlias) | ConvertTo-Json -Compress",
    ].join(" ");
    return asArray(json((await this.powershell(script)).stdout)).flatMap(
      (route) => {
        try {
          return [
            {
              route: cidr(network(String(route.DestinationPrefix))),
              interfaceName: String(route.InterfaceAlias),
            },
          ];
        } catch {
          return [];
        }
      },
    );
  }
  async replaceRoutes(session, next) {
    const before = systemRoutes(session.compiled);
    const after = systemRoutes(next);
    const table = await this.routeTable();
    const args = ["set", session.interfaceName];
    for (const peer of peerRoutes(next))
      args.push("peer", peer.key, "allowed-ips", peer.routes.join(","));
    await this.command("wg", args);
    for (const route of after) {
      if (before.has(route)) continue;
      const current = table.find((record) => record.route === route);
      if (current) {
        if (current.interfaceName === session.interfaceName) continue;
        throw Error("Маршрут Smart tunneling занят другим соединением");
      }
      const nextHop = route.includes(":") ? "::" : "0.0.0.0";
      await this.powershell(
        `New-NetRoute -DestinationPrefix ${JSON.stringify(route)} -InterfaceAlias ${JSON.stringify(session.interfaceName)} -NextHop ${JSON.stringify(nextHop)} -PolicyStore ActiveStore -ErrorAction Stop | Out-Null`,
      );
    }
    for (const route of before) {
      if (after.has(route)) continue;
      const current = table.find((record) => record.route === route);
      if (!current) continue;
      if (current.interfaceName !== session.interfaceName)
        throw Error("Маршрут Smart tunneling изменён другим соединением");
      await this.powershell(
        `Remove-NetRoute -DestinationPrefix ${JSON.stringify(route)} -InterfaceAlias ${JSON.stringify(session.interfaceName)} -Confirm:$false -ErrorAction Stop`,
      );
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
            additionalEntries: [...learned],
            deferredDomains: session.deferredDomains,
          },
        );
        await this.replaceRoutes(session, next);
        session.learned = learned;
      } catch (error) {
        this.errors.set(session.id, error.message);
        await this.deactivate(session.id);
        await this.stopTunnel(session.id);
        await this.finish(session.id);
        throw error;
      }
    });
  }
  async removeRules(id) {
    let marker;
    try {
      marker = JSON.parse(await fs.readFile(this.marker(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (
      marker?.schema !== 1 ||
      !Array.isArray(marker.rules) ||
      marker.rules.length > 64 ||
      !marker.rules.every((rule) => /^[{}a-fA-F0-9-]{1,128}$/.test(rule))
    )
      throw Error("Invalid Smart DNS recovery data");
    await this.powershell(
      `$comment=${JSON.stringify(this.comment(id))}; Get-DnsClientNrptRule | Where-Object {$_.Comment -eq $comment} | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force -ErrorAction SilentlyContinue }`,
    );
  }
  async deactivate(id) {
    const session = this.sessions.get(id);
    if (session) session.ready = false;
    this.sessions.delete(id);
    await this.removeRules(id);
    if (!this.sessions.size && this.dnsProxy) {
      const proxy = this.dnsProxy;
      this.dnsProxy = null;
      await proxy.close();
    }
    await this.powershell("Clear-DnsClientCache");
  }
  async finish(id) {
    await fs.rm(this.marker(id), { force: true });
  }
  async recover() {
    const files = await fs.readdir(this.configDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files.filter((name) =>
      /^wg[a-f0-9]{10}\.smart\.json$/.test(name),
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
  async shutdown() {
    for (const id of [...this.sessions.keys()]) await this.deactivate(id);
  }
}

module.exports = { WindowsSmartDns, systemRoutes, suffixesOverlap, asArray };
