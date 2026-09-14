const path = require("node:path");
const { parseConfig } = require("./config.cjs");
const { network, cidr, subtract } = require("./smart-tunneling.cjs");
const enabled = (settings) =>
  settings?.mode === "include" || settings?.mode === "exclude";
function validateApps(input = { mode: "off", paths: [] }) {
  if (
    !input ||
    !["off", "include", "exclude"].includes(input.mode) ||
    !Array.isArray(input.paths) ||
    input.paths.length > 64
  )
    throw Error("Некорректные настройки приложений");
  const paths = [
    ...new Set(
      input.paths.map((value) => {
        if (
          typeof value !== "string" ||
          value.length > 1024 ||
          !value.startsWith("/") ||
          !value.endsWith(".app") ||
          /[\x00-\x1f\x7f]/.test(value) ||
          path.normalize(value) !== value
        )
          throw Error("Выберите приложение .app");
        return value;
      }),
    ),
  ];
  if (input.mode !== "off" && !paths.length)
    throw Error("Добавьте хотя бы одно приложение");
  return { mode: input.mode, paths };
}
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function compileApps(text, input) {
  parseConfig(text);
  const settings = validateApps(input);
  if (!enabled(settings)) throw Error("Маршрутизация по приложениям выключена");
  const iface = {},
    peers = [];
  let section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (line === "[Interface]") {
      section = iface;
      continue;
    }
    if (line === "[Peer]") {
      section = {};
      peers.push(section);
      continue;
    }
    const [, key, value] = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (Object.hasOwn(section, key))
      throw Error("Повторяющееся поле конфигурации");
    section[key] = value;
  }
  const prefixes = (value) =>
    (value || "").split(",").map((v) => {
      const text = v.trim();
      network(text);
      return text;
    });
  const number = (value, min, max) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < min || n > max)
      throw Error("Некорректное числовое поле конфигурации");
    return n;
  };
  const endpoint = {
    type: "wireguard",
    tag: "vpn",
    system: false,
    address: prefixes(iface.Address),
    private_key: iface.PrivateKey,
    ...(iface.MTU ? { mtu: number(iface.MTU, 1280, 9000) } : {}),
    ...(iface.ListenPort
      ? { listen_port: number(iface.ListenPort, 0, 65535) }
      : {}),
    peers: peers.map((peer) => {
      const match = (peer.Endpoint || "").match(
        /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/,
      );
      if (!match)
        throw Error("Для режима приложений нужен Endpoint у каждого Peer");
      return {
        address: match[1] || match[2],
        port: number(match[3], 1, 65535),
        public_key: peer.PublicKey,
        allowed_ips: prefixes(peer.AllowedIPs).map((v) => cidr(network(v))),
        ...(peer.PresharedKey ? { pre_shared_key: peer.PresharedKey } : {}),
        ...(peer.PersistentKeepalive
          ? {
              persistent_keepalive_interval: number(
                peer.PersistentKeepalive,
                0,
                65535,
              ),
            }
          : {}),
      };
    }),
  };
  const routes = [...new Set(endpoint.peers.flatMap((p) => p.allowed_ips))];
  const patterns = settings.paths.map(
    (p) => "^" + escapeRegex(p) + "/Contents/",
  );
  return {
    log: { level: "info", timestamp: false, disabled: false },
    dns: { servers: [{ type: "local", tag: "system" }] },
    inbounds: [
      {
        type: "tun",
        tag: "apps",
        address: ["172.31.255.1/30", "fdce:5747:6170::1/126"],
        auto_route: true,
        dns_mode: "disabled",
        route_address: routes,
        stack: "gvisor",
      },
    ],
    endpoints: [endpoint],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: {
      auto_detect_interface: true,
      default_domain_resolver: "system",
      rules: [
        { port: 53, action: "route", outbound: "direct" },
        {
          process_path_regex: patterns,
          action: "route",
          outbound: settings.mode === "include" ? "vpn" : "direct",
        },
      ],
      final: settings.mode === "include" ? "direct" : "vpn",
    },
  };
}
module.exports = { validateApps, compileApps, enabled, escapeRegex };

// One TUN owns application routes. Native WireGuard interfaces keep their own
// routes and are explicit fallbacks, so unselected traffic never skips them.
function compileGroup(
  sessions,
  environment = { routes: [], occupied: [], endpoints: [] },
) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 32)
    throw Error("Допустимо от 1 до 32 соединений с правилами приложений");
  if (environment.routes.length > 8192 || environment.occupied.length > 32768)
    throw Error("Слишком много совместных маршрутов");
  const ids = new Set();
  const compiled = sessions.map((session) => {
    if (!/^wg[a-f0-9]{10}$/.test(session.id) || ids.has(session.id))
      throw Error("Invalid application session");
    ids.add(session.id);
    return { session, config: compileApps(session.config, session.settings) };
  });
  const native = environment.routes
    .map((item) => {
      if (!/^utun\d+$/.test(item.interfaceName))
        throw Error("Invalid native interface");
      return { ...item, range: network(item.route) };
    })
    .sort((a, b) => b.range.prefix - a.range.prefix);
  const occupied = new Set(
    environment.occupied.map((item) => cidr(network(item.route))),
  );
  const exemptions = environment.endpoints.map((value) => network(value));
  const overlaps = (a, b) =>
    a.bits === b.bits && a.start <= b.end && b.start <= a.end;
  const split = (range) => {
    const half = (range.end - range.start + 1n) / 2n;
    return [
      { ...range, prefix: range.prefix + 1, end: range.start + half - 1n },
      { ...range, prefix: range.prefix + 1, start: range.start + half },
    ];
  };
  let capture = [];
  for (const { config } of compiled) {
    for (const value of config.inbounds[0].route_address) {
      const original = network(value);
      // Specific native networks (including learned DNS host routes) retain
      // their system priority. The two /1 routes of a full VPN are fallbacks.
      const preferred = native
        .filter((n) => n.range.prefix > 1 && n.range.prefix >= original.prefix)
        .map((n) => n.range);
      let remaining = [...preferred, ...exemptions].reduce(
        (ranges, excluded) => ranges.flatMap((r) => subtract(r, excluded)),
        [original],
      );
      const avoidCollision = (range) => {
        if (range.prefix === 0 || occupied.has(cidr(range))) {
          if (range.prefix === range.bits) return [];
          return split(range).flatMap(avoidCollision);
        }
        return [range];
      };
      capture.push(...remaining.flatMap(avoidCollision));
      if (capture.length > 32768)
        throw Error("Слишком много совместных маршрутов");
    }
  }
  capture.sort((a, b) => a.prefix - b.prefix);
  const unique = [];
  for (const range of capture)
    if (!unique.some((r) => r.prefix <= range.prefix && overlaps(r, range)))
      unique.push(range);
  if (unique.length > 8192) throw Error("Слишком много совместных маршрутов");
  if (!unique.length)
    throw Error(
      "Маршруты приложений полностью заняты более конкретными маршрутами других соединений",
    );
  const rules = [];
  // Keep the native transport outside its own VPN even if its peer roams.
  if (environment.transportPaths?.length)
    rules.push({
      process_path: environment.transportPaths,
      action: "route",
      outbound: "direct",
    });
  // System DNS keeps the native routing decision (including a private VPN DNS).
  for (const n of native)
    rules.push({
      port: 53,
      ip_cidr: [cidr(n.range)],
      action: "route",
      outbound: "native-" + n.interfaceName,
    });
  rules.push({ port: 53, action: "route", outbound: "direct" });
  // Newest connection wins when several app rules match. An exclusion skips
  // that connection and continues through the other apps/native routes.
  for (const { session, config } of [...compiled].reverse()) {
    const predicate = {
      process_path_regex: config.route.rules[1].process_path_regex,
    };
    if (session.settings.mode === "exclude") predicate.invert = true;
    rules.push({
      type: "logical",
      mode: "and",
      rules: [{ ip_cidr: config.inbounds[0].route_address }, predicate],
      action: "route",
      outbound: session.id,
    });
  }
  const seen = new Set();
  for (const n of native) {
    const route = cidr(n.range);
    if (seen.has(route)) continue;
    seen.add(route);
    rules.push({
      ip_cidr: [route],
      action: "route",
      outbound: "native-" + n.interfaceName,
    });
  }
  const result = compiled[0].config;
  result.inbounds[0].route_address = unique.map(cidr);
  result.endpoints = compiled.map(({ session, config }) => ({
    ...config.endpoints[0],
    tag: session.id,
  }));
  result.outbounds = [
    { type: "direct", tag: "direct" },
    ...[...new Set(native.map((n) => n.interfaceName))].map((iface) => ({
      type: "direct",
      tag: "native-" + iface,
      bind_interface: iface,
    })),
  ];
  result.route.rules = rules;
  result.route.final = "direct";
  return result;
}
module.exports.compileGroup = compileGroup;
