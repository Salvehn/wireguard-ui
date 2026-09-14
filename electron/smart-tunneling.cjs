const ipaddr = require("ipaddr.js");
const { domainToASCII } = require("node:url");
const dns = require("node:dns/promises");
const { parseConfig } = require("./config.cjs");

const defaults = () => ({ mode: "off", entries: [] });
function network(value) {
  const [ip, prefix] = value.includes("/")
    ? ipaddr.parseCIDR(value)
    : [ipaddr.parse(value), value.includes(":") ? 128 : 32];
  const bits = ip.kind() === "ipv4" ? 32 : 128;
  const number = ip
    .toByteArray()
    .reduce((sum, byte) => (sum << 8n) | BigInt(byte), 0n);
  const size = 1n << BigInt(bits - prefix);
  const start = (number / size) * size;
  return { bits, prefix, start, end: start + size - 1n };
}
function cidr(range) {
  let value = range.start;
  const bytes = Array(range.bits / 8).fill(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return `${ipaddr.fromByteArray(bytes).toString()}/${range.prefix}`;
}
function normalizeEntry(value) {
  if (typeof value !== "string" || value.length > 253)
    throw Error("Некорректный адрес Smart tunneling");
  const text = value.trim().toLowerCase();
  try {
    return cidr(network(text));
  } catch {}
  if (/[\s/:?#@\\%]/.test(text))
    throw Error("Укажите домен, IP-адрес или CIDR без протокола и пути");
  const wildcard = text.startsWith("*.");
  const domain = domainToASCII(
    (wildcard ? text.slice(2) : text).replace(/\.$/, ""),
  );
  if (
    domain.length > 253 ||
    !domain.includes(".") ||
    !domain
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[\d.]+$/.test(domain)
  )
    throw Error("Укажите домен, IP-адрес или CIDR без протокола и пути");
  return wildcard ? `*.${domain}` : domain;
}
function validateSettings(value) {
  if (
    !value ||
    !["off", "include", "exclude"].includes(value.mode) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 64
  )
    throw Error("Некорректные настройки Smart tunneling (максимум 64 адреса)");
  const entries = [...new Set(value.entries.map(normalizeEntry))];
  if (value.mode !== "off" && !entries.length)
    throw Error("Добавьте хотя бы один адрес");
  return { mode: value.mode, entries };
}
function overlap(a, b) {
  return a.bits === b.bits && a.start <= b.end && b.start <= a.end;
}
function subtract(a, b) {
  if (!overlap(a, b)) return [a];
  if (b.start <= a.start && b.end >= a.end) return [];
  const half = (a.end - a.start + 1n) / 2n;
  return [
    { ...a, prefix: a.prefix + 1, end: a.start + half - 1n },
    { ...a, prefix: a.prefix + 1, start: a.start + half },
  ].flatMap((part) => subtract(part, b));
}
async function resolveEntries(entries, lookup = dns.lookup) {
  const groups = await Promise.all(
    entries.map(async (entry) => {
      try {
        return [network(entry)];
      } catch {}
      let timer;
      try {
        const addresses = await Promise.race([
          lookup(entry, { all: true, verbatim: true }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("DNS timeout")), 5000);
          }),
        ]);
        if (!addresses.length || addresses.length > 256)
          throw Error("Invalid DNS answer");
        return addresses.map(({ address }) => network(address));
      } catch {
        throw Error(`Не удалось разрешить домен Smart tunneling: ${entry}`);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ranges = groups.flat();
  if (ranges.length > 256)
    throw Error("Слишком много маршрутов Smart tunneling; сократите список");
  return ranges;
}
async function applySmartTunneling(
  config,
  input = defaults(),
  lookup,
  { allowDynamic = false, additionalEntries = [], deferredDomains = [] } = {},
) {
  const settings = validateSettings(input);
  if (settings.mode === "off") return config;
  const dynamic = hasWildcard(settings);
  if (dynamic && !allowDynamic)
    throw Error("Маски требуют обновления системного помощника");
  const rules = await resolveEntries(
    [
      ...settings.entries.filter(
        (entry) =>
          !entry.startsWith("*.") &&
          !(allowDynamic && deferredDomains.includes(entry)),
      ),
      ...additionalEntries,
    ],
    lookup,
  );
  // Subtracting a default route disables wg-quick's automatic endpoint bypass.
  // Pin endpoints for this connection and exclude their host routes explicitly.
  const endpointRules = [];
  const endpointLines = new Map();
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(
      /^(\s*Endpoint\s*=\s*)(?:\[([^\]]+)\]|([^:#\s]+)):(\d+)\s*(?:#.*)?$/,
    );
    if (!match) continue;
    const addresses = await resolveEntries([match[2] || match[3]], lookup);
    const host = cidr(addresses[0]).split("/")[0];
    endpointRules.push(addresses[0]);
    endpointLines.set(
      line,
      `${match[1]}${host.includes(":") ? "[" + host + "]" : host}:${match[4]}`,
    );
  }
  let count = 0;
  const result = config
    .split(/\r?\n/)
    .map((line) => {
      if (endpointLines.has(line)) return endpointLines.get(line);
      // Keep system DNS: selective traffic must not depend on an unreachable VPN DNS server.
      if (/^\s*DNS\s*=/i.test(line)) return "";
      const match = line.match(/^(\s*AllowedIPs\s*=\s*)([^#]*)(.*)$/i);
      if (!match) return line;
      const base = match[2].split(",").map((value) => network(value.trim()));
      let routes =
        settings.mode === "include"
          ? base.flatMap((a) =>
              rules
                .filter((b) => overlap(a, b))
                .map((b) => (a.prefix >= b.prefix ? a : b)),
            )
          : rules.reduce(
              (remaining, rule) => remaining.flatMap((a) => subtract(a, rule)),
              base,
            );
      routes = endpointRules.reduce(
        (remaining, rule) => remaining.flatMap((a) => subtract(a, rule)),
        routes,
      );
      const unique = [...new Set(routes.map(cidr))];
      count += unique.length;
      if (count > 1024)
        throw Error(
          "Слишком много маршрутов Smart tunneling; сократите список",
        );
      return unique.length
        ? match[1] + unique.join(", ") + (match[3] ? " " + match[3] : "")
        : "";
    })
    .join("\n");
  if (!count && !dynamic)
    throw Error("Список не оставляет маршрутов для этого соединения");
  if (Buffer.byteLength(result) > 65536)
    throw Error("Слишком много маршрутов Smart tunneling; сократите список");
  return result;
}
function hasWildcard(settings) {
  return (
    (settings?.mode !== "off" &&
      settings?.entries?.some(
        (entry) => typeof entry === "string" && entry.startsWith("*."),
      )) ||
    false
  );
}
// Saving is an offline operation. DNS and route expansion belong to connection
// startup, when private domains may become resolvable through another VPN.
function validateSettingsForSave(config, input) {
  parseConfig(config);
  return validateSettings(input);
}
function matchesPattern(pattern, domain) {
  const name = domain.toLowerCase().replace(/\.$/, "");
  return pattern.startsWith("*.")
    ? name.endsWith("." + pattern.slice(2))
    : name === pattern;
}
module.exports = {
  hasWildcard,
  matchesPattern,
  defaults,
  validateSettings,
  validateSettingsForSave,
  applySmartTunneling,
  network,
  subtract,
  cidr,
};
