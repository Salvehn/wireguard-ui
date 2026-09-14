const { test } = require("node:test");
const assert = require("node:assert/strict");
const ipaddr = require("ipaddr.js");
const {
  question,
  answers,
  readName,
  makeQuery,
  errorResponse,
  createDnsProxy,
  exchange,
} = require("../helper/dns-wire.cjs");

function answer(query, values, alias) {
  const q = question(query),
    header = Buffer.from(query.subarray(0, q.end));
  header[2] |= 0x80;
  header[3] = 0x80;
  const records = [];
  const encode = (name) =>
    Buffer.concat([
      ...name
        .split(".")
        .map((label) =>
          Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
        ),
      Buffer.from([0]),
    ]);
  function record(name, type, data) {
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(type, 0);
    meta.writeUInt16BE(1, 2);
    meta.writeUInt32BE(120, 4);
    meta.writeUInt16BE(data.length, 8);
    return Buffer.concat([encode(name), meta, data]);
  }
  if (alias) records.push(record(q.name, 5, encode(alias)));
  for (const value of values) {
    const ip = ipaddr.parse(value);
    records.push(
      record(
        alias || q.name,
        ip.kind() === "ipv4" ? 1 : 28,
        Buffer.from(ip.toByteArray()),
      ),
    );
  }
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}
test("DNS answer parser follows CNAMEs and extracts both address families", () => {
  const query = makeQuery("api.example.com", 1);
  assert.deepEqual(
    answers(
      answer(query, ["203.0.113.7", "2001:db8::7"], "cdn.example.net"),
      query,
    ),
    ["203.0.113.7", "2001:db8:0:0:0:0:0:7"],
  );
});
test("DNS parser rejects pointer loops, mismatched questions and truncated records", () => {
  assert.throws(() => readName(Buffer.from([0xc0, 0x00]), 0));
  const query = makeQuery("api.example.com", 1),
    result = answer(query, ["203.0.113.7"]);
  assert.throws(() => answers(result.subarray(0, result.length - 1), query));
  assert.throws(() => answers(result, makeQuery("attacker.example.com", 1)));
  result.writeUInt16BE((query.readUInt16BE(0) + 1) % 65536, 0);
  assert.throws(() => answers(result, query));
});
test("DNS responses with errors never add routes; malformed questions are rejected", () => {
  const query = makeQuery("api.example.com", 1);
  assert.deepEqual(answers(errorResponse(query, 3), query), []);
  assert.throws(() => question(Buffer.alloc(10)));
  const bad = Buffer.from(query);
  bad.writeUInt16BE(2, 4);
  assert.throws(() => question(bad));
});
test("UDP and TCP DNS responses wait for policy installation; HTTPS hints cannot bypass it", async (t) => {
  const seen = [];
  const proxy = await createDnsProxy({
    servers: [],
    matches: (name) => name.endsWith(".example.com"),
    forwardQuery: async (query) => answer(query, ["203.0.113.7"]),
    observe: async (name, addresses) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push({ name, addresses });
    },
  });
  t.after(() => proxy.close());
  for (const tcp of [false, true]) {
    const query = makeQuery("api.example.com", 1);
    const result = await exchange(query, "127.0.0.1", proxy.port, tcp);
    assert.equal(answers(result, query)[0], "203.0.113.7");
    assert.equal(seen.length, tcp ? 2 : 1);
  }
  const https = makeQuery("api.example.com", 65);
  const response = await exchange(https, "127.0.0.1", proxy.port);
  assert.equal(response[3] & 15, 0);
  assert.equal(response.readUInt16BE(6), 0);
  assert.equal(seen.length, 2);
  const base = makeQuery("example.com", 1);
  await exchange(base, "127.0.0.1", proxy.port);
  assert.equal(seen.length, 2);
});
test("failed policy updates return SERVFAIL rather than an unprotected address", async (t) => {
  const proxy = await createDnsProxy({
    servers: [],
    matches: () => true,
    forwardQuery: async (query) => answer(query, ["203.0.113.7"]),
    observe: async () => {
      throw Error("Route conflict");
    },
  });
  t.after(() => proxy.close());
  const query = makeQuery("api.example.com", 1);
  const response = await exchange(query, "127.0.0.1", proxy.port);
  assert.equal(response[3] & 15, 2);
  assert.equal(response.readUInt16BE(6), 0);
});
module.exports = { answer };
