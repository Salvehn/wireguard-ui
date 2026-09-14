const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  applySmartTunneling,
  validateSettings,
  network,
} = require("./smart-tunneling.cjs");
const { parseConfig } = require("./config.cjs");
const config = `[Interface]\nPrivateKey = ${"A".repeat(43)}=\nAddress = 10.8.0.2/32\nDNS = 10.8.0.1\n[Peer]\nPublicKey = ${"B".repeat(43)}=\nEndpoint = 198.51.100.1:51820\nAllowedIPs = 0.0.0.0/0, ::/0\n`;
const settings = (mode, entries) => ({ mode, entries });
const routes = (text) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("AllowedIPs"))
    .flatMap((line) =>
      line
        .split("=")[1]
        .split(",")
        .map((x) => network(x.trim())),
    );
const contains = (text, ip) => {
  const address = network(ip);
  return routes(text).some(
    (r) =>
      r.bits === address.bits &&
      r.start <= address.start &&
      r.end >= address.end,
  );
};
test("off preserves exact original configuration and DNS without resolving", async () => {
  assert.equal(
    await applySmartTunneling(config, settings("off", ["example.com"]), () => {
      throw Error("must not resolve");
    }),
    config,
  );
});
test("include routes only selected IPv4 and IPv6 and keeps keys; system DNS is used", async () => {
  const out = await applySmartTunneling(
    config,
    settings("include", ["203.0.113.10", "2001:db8::/32"]),
  );
  assert.ok(contains(out, "203.0.113.10"));
  assert.ok(!contains(out, "203.0.113.11"));
  assert.ok(contains(out, "2001:db8::1"));
  assert.ok(!contains(out, "2001:db9::1"));
  assert.ok(!out.includes("DNS ="));
  assert.ok(out.includes("A".repeat(43)));
  parseConfig(out);
});
test("exclusions subtract exact subnets in both families, preserve surrounding addresses and bypass endpoint", async () => {
  const out = await applySmartTunneling(
    config,
    settings("exclude", ["10.0.0.0/8", "2001:db8::/32"]),
  );
  for (const ip of [
    "10.0.0.0",
    "10.255.255.255",
    "2001:db8::1",
    "198.51.100.1",
  ])
    assert.ok(!contains(out, ip), ip);
  for (const ip of ["9.255.255.255", "11.0.0.0", "2001:db9::1", "198.51.100.2"])
    assert.ok(contains(out, ip), ip);
  parseConfig(out);
});
test("selection intersects original routes rather than expanding a split tunnel", async () => {
  const split = config.replace("0.0.0.0/0, ::/0", "10.1.0.0/16");
  const out = await applySmartTunneling(
    split,
    settings("include", ["10.0.0.0/8", "203.0.113.1"]),
  );
  assert.ok(contains(out, "10.1.1.1"));
  assert.ok(!contains(out, "10.2.1.1"));
  assert.ok(!contains(out, "203.0.113.1"));
  await assert.rejects(
    applySmartTunneling(split, settings("include", ["203.0.113.1"])),
    /не оставляет/,
  );
});
test("domains resolve again on every connection and endpoint hostnames are pinned outside tunnel", async () => {
  let address = "203.0.113.10";
  const lookup = async (name) => [
    { address: name === "vpn.example.com" ? "198.51.100.1" : address },
  ];
  const source = config.replace("198.51.100.1", "vpn.example.com");
  const first = await applySmartTunneling(
    source,
    settings("include", ["example.com"]),
    lookup,
  );
  address = "203.0.113.11";
  const second = await applySmartTunneling(
    source,
    settings("include", ["example.com"]),
    lookup,
  );
  assert.ok(contains(first, "203.0.113.10"));
  assert.ok(contains(second, "203.0.113.11"));
  assert.ok(!contains(second, "203.0.113.10"));
  assert.ok(second.includes("Endpoint = 198.51.100.1:51820"));
});
test("unresolved domains fail instead of silently changing routing policy", async () => {
  await assert.rejects(
    applySmartTunneling(
      config,
      settings("exclude", ["missing.example"]),
      async () => {
        throw Error("not found");
      },
    ),
    /missing.example/,
  );
});
test("rules remain assigned to their original peers", async () => {
  const multi =
    config.replace("0.0.0.0/0, ::/0", "10.0.0.0/8") +
    `[Peer]\nPublicKey = ${"C".repeat(43)}=\nAllowedIPs = 192.168.0.0/16\n`;
  const out = await applySmartTunneling(
    multi,
    settings("include", ["10.1.0.0/16", "192.168.1.0/24"]),
  );
  const peers = out.split("[Peer]");
  assert.ok(peers[1].includes("10.1.0.0/16"));
  assert.ok(!peers[1].includes("192.168.1.0/24"));
  assert.ok(peers[2].includes("192.168.1.0/24"));
});
test("validation normalizes, deduplicates and rejects invalid input", () => {
  assert.deepEqual(
    validateSettings(
      settings("include", ["EXAMPLE.COM", "example.com", "10.1.2.3/8"]),
    ).entries,
    ["example.com", "10.0.0.0/8"],
  );
  for (const entry of [
    "https://example.com",
    "example.com/path",
    "foo.*.example.com",
    "1.2.3.999",
    "10.0.0.0/33",
    "x\nPostUp=x",
  ])
    assert.throws(
      () => validateSettings(settings("include", [entry])),
      undefined,
      entry,
    );
  assert.throws(() => validateSettings(settings("include", [])));
  assert.throws(() =>
    validateSettings(settings("exclude", Array(65).fill("example.com"))),
  );
});

test("wildcards match every subdomain level but never apex or a suffix lookalike", () => {
  const { matchesPattern, hasWildcard } = require("./smart-tunneling.cjs");
  const normalized = validateSettings(settings("include", ["*.EXAMPLE.COM."]));
  assert.deepEqual(normalized.entries, ["*.example.com"]);
  assert.ok(hasWildcard(normalized));
  for (const name of [
    "api.example.com",
    "one.two.example.com",
    "API.EXAMPLE.COM.",
  ])
    assert.ok(matchesPattern("*.example.com", name));
  for (const name of ["example.com", "evilexample.com", "example.com.evil.net"])
    assert.ok(!matchesPattern("*.example.com", name));
  for (const value of [
    "*",
    "*.com",
    "foo.*.example.com",
    "*example.com",
    "*.127.0.0.1",
  ])
    assert.throws(() => validateSettings(settings("include", [value])));
});
test("wildcard-only include starts with no routes and learns addresses without widening base routes", async () => {
  const rule = settings("include", ["*.example.com"]);
  await assert.rejects(applySmartTunneling(config, rule), /помощника/);
  const initial = await applySmartTunneling(config, rule, undefined, {
    allowDynamic: true,
  });
  assert.equal(routes(initial).length, 0);
  parseConfig(initial);
  const learned = await applySmartTunneling(config, rule, undefined, {
    allowDynamic: true,
    additionalEntries: ["203.0.113.7/32", "2001:db8::7/128"],
  });
  assert.ok(contains(learned, "203.0.113.7"));
  assert.ok(!contains(learned, "203.0.113.8"));
  assert.ok(contains(learned, "2001:db8::7"));
  const split = config.replace("0.0.0.0/0, ::/0", "10.0.0.0/8");
  const out = await applySmartTunneling(split, rule, undefined, {
    allowDynamic: true,
    additionalEntries: ["203.0.113.7/32"],
  });
  assert.equal(routes(out).length, 0);
});
