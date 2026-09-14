const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  SmartDns,
  systemRoutes,
  parseRouteTable,
} = require("../helper/smart-dns.cjs");
const { network } = require("./smart-tunneling.cjs");
const key = "A".repeat(43) + "=";
const original = `[Interface]\nPrivateKey=${key}\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=${key}\nEndpoint=198.51.100.1:51820\nAllowedIPs=0.0.0.0/0, ::/0\n`;
const id = "wg1234567890";
async function fixture(t, mode = "include") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wg-smart-dns-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "configs"),
    resolverDirectory = path.join(root, "resolvers");
  const routes = new Map(),
    calls = [],
    proxies = [];
  let failAdd = false,
    stopped = 0;
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file === "/usr/sbin/netstat") {
      const family = args.at(-1);
      return {
        stdout:
          "Destination Gateway Flags Netif Expire\n" +
          [...routes]
            .filter(([route]) => route.includes(":") === (family === "inet6"))
            .map(([route, iface]) => `${route} link#10 UCS ${iface}`)
            .join("\n"),
      };
    }
    if (file === "/sbin/route") {
      const action = args.includes("get")
        ? "get"
        : args.includes("add")
          ? "add"
          : "delete";
      const route =
        args[args.indexOf("-inet") + 1] || args[args.indexOf("-inet6") + 1];
      // Family flag is at index 2 for get and index 3 for add/delete.
      const range =
        args[
          (args.includes("-inet")
            ? args.indexOf("-inet")
            : args.indexOf("-inet6")) + 1
        ];
      if (action === "get") {
        const address = network(range);
        const matches = [...routes]
          .filter(([cidr]) => {
            const r = network(cidr);
            return (
              r.bits === address.bits &&
              r.start <= address.start &&
              r.end >= address.start
            );
          })
          .sort((a, b) => network(b[0]).prefix - network(a[0]).prefix);
        const [target, iface] = matches[0] || [
          address.bits === 128 ? "::/0" : "0.0.0.0/0",
          "en0",
        ];
        return { stdout: `destination: ${target}\ninterface: ${iface}\n` };
      }
      if (action === "add") {
        if (failAdd) throw Error("Injected route failure");
        if (routes.has(range)) throw Error("Route exists");
        routes.set(range, args.at(-1));
      }
      if (action === "delete") routes.delete(range);
    }
    return { stdout: "" };
  };
  const stopTunnel = async () => {
    stopped++;
    for (const [route, iface] of routes)
      if (iface === "utun8") routes.delete(route);
  };
  const options = {
    configDirectory,
    resolverDirectory,
    userId: 501,
    enforceOwnership: false,
    upstreams: () => ["192.0.2.53"],
    run,
    command: async (name, args) => {
      calls.push({ file: name, args });
    },
    serialize: (task) => task(),
    stopTunnel,
    proxy: async (config) => {
      const value = {
        ...config,
        closed: false,
        port: 53535,
        async close() {
          this.closed = true;
        },
      };
      proxies.push(value);
      return value;
    },
  };
  const manager = new SmartDns(options);
  const session = await manager.prepare(id, original, {
    mode,
    entries: ["*.example.com"],
  });
  for (const route of systemRoutes(session.compiled))
    routes.set(route, "utun8");
  await fs.writeFile(
    path.join(configDirectory, id + ".conf"),
    session.compiled,
  );
  await manager.activate(session, "utun8");
  t.after(async () => {
    if (manager.sessions.has(id)) {
      await manager.deactivate(id);
      await manager.finish(id);
    }
  });
  return {
    manager,
    session,
    routes,
    calls,
    proxies,
    root,
    configDirectory,
    resolverDirectory,
    options,
    fail: () => {
      failAdd = true;
    },
    stopped: () => stopped,
  };
}
test("route table parser keeps exact masks even when more-specific routes exist", () => {
  assert.deepEqual(
    parseRouteTable(
      "Destination Gateway Flags Netif Expire\n10.0/16 link#10 UCS utun8\n10.0.0.1 10.0.0.2 UH utun8\n",
      "inet",
    ),
    [
      { route: "10.0.0.0/16", interfaceName: "utun8" },
      { route: "10.0.0.1/32", interfaceName: "utun8" },
    ],
  );
  assert.deepEqual(
    parseRouteTable(
      "Destination Gateway Flags Netif Expire\n2001:db8::/32 link#10 UCS utun8\nfe80::%utun8/64 link#10 UC utun8\n",
      "inet6",
    ),
    [
      { route: "2001:db8::/32", interfaceName: "utun8" },
      { route: "fe80::/64", interfaceName: "utun8" },
    ],
  );
});
test("new subdomains install routes and learned IPs are retained for the connection", async (t) => {
  const f = await fixture(t);
  assert.equal(f.routes.size, 0);
  await f.proxies[0].observe("one.two.example.com", [
    "203.0.113.7",
    "2001:db8::7",
  ]);
  assert.equal(f.routes.get("203.0.113.7/32"), "utun8");
  assert.equal(f.routes.get("2001:db8::7/128"), "utun8");
  await f.proxies[0].observe("api.example.com", ["203.0.113.8"]);
  assert.equal(f.routes.get("203.0.113.7/32"), "utun8");
  assert.equal(f.routes.get("203.0.113.8/32"), "utun8");
  const saved = await fs.readFile(
    path.join(f.configDirectory, id + ".conf"),
    "utf8",
  );
  assert.ok(saved.includes("203.0.113.7/32"));
  const count = f.calls.length;
  await f.proxies[0].observe("example.com", ["203.0.113.9"]);
  assert.equal(f.calls.length, count);
  await f.manager.deactivate(id);
  await f.manager.finish(id);
  assert.deepEqual(await fs.readdir(f.resolverDirectory), []);
  assert.ok(f.proxies[0].closed);
  await assert.rejects(
    f.proxies[0].observe("api.example.com", ["203.0.113.10"]),
    /stopped/,
  );
});
test("exclusion DNS answers remove matching address from kernel and WireGuard routes", async (t) => {
  const f = await fixture(t, "exclude");
  await f.proxies[0].observe("api.example.com", ["203.0.113.7"]);
  const matches = (address) =>
    [...f.routes.keys()].some((value) => {
      const r = network(value),
        ip = network(address);
      return r.bits === ip.bits && r.start <= ip.start && r.end >= ip.end;
    });
  assert.ok(!matches("203.0.113.7"));
  assert.ok(matches("203.0.113.8"));
  const commands = f.calls.filter(
    (call) => call.file === "wg" && call.args[0] === "set",
  );
  assert.equal(commands.length, 1);
});
test("route failures stop the affected tunnel and clean resolver files", async (t) => {
  const f = await fixture(t);
  f.fail();
  await assert.rejects(
    f.proxies[0].observe("api.example.com", ["203.0.113.7"]),
    /Injected/,
  );
  assert.equal(f.stopped(), 1);
  assert.deepEqual(await fs.readdir(f.resolverDirectory), []);
  assert.equal(f.manager.sessions.size, 0);
  assert.ok(f.manager.errors.has(id));
});
test("a helper restart removes stale resolver files and stops only recorded dynamic tunnels", async (t) => {
  const f = await fixture(t);
  const recovered = new SmartDns(f.options);
  await recovered.recover();
  assert.equal(f.stopped(), 1);
  assert.deepEqual(await fs.readdir(f.resolverDirectory), []);
  assert.ok(recovered.errors.get(id).includes("перезапущен"));
  await f.proxies[0].close();
  f.manager.sessions.clear();
});
test("overlapping resolver domains and routes owned by another tunnel are not overwritten", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.manager.prepare("wg0987654321", original, {
      mode: "include",
      entries: ["*.api.example.com"],
    }),
    /пересекаются/,
  );
  f.routes.set("203.0.113.7/32", "utun99");
  await assert.rejects(
    f.proxies[0].observe("api.example.com", ["203.0.113.7"]),
    /занят/,
  );
  assert.equal(f.routes.get("203.0.113.7/32"), "utun99");
});

test("DNS route changes run inside the shared application routing coordination hook", async (t) => {
  const f = await fixture(t);
  const sequence = [];
  f.manager.withRoutesChange = async (task) => {
    sequence.push("pause-apps");
    assert.ok(!f.routes.has("203.0.113.7/32"));
    try {
      return await task();
    } finally {
      assert.equal(f.routes.get("203.0.113.7/32"), "utun8");
      sequence.push("resume-apps");
    }
  };
  await f.proxies[0].observe("api.example.com", ["203.0.113.7"]);
  assert.deepEqual(sequence, ["pause-apps", "resume-apps"]);
});

const privateId = "wg1111111111";
const privateText =
  "# Company DNS\nnameserver 192.168.160.14\ndomain pamir.int\n";
async function privateFixture(t) {
  const f = await fixture(t);
  const target = path.join(f.resolverDirectory, "pamir.int");
  await fs.writeFile(target, privateText, { mode: 0o640 });
  await fs.chmod(target, 0o640);
  const run = f.manager.run;
  f.manager.run = async (file, args) =>
    file === "/usr/sbin/scutil"
      ? {
          stdout:
            "DNS configuration\nresolver #1\n domain : pamir.int\n nameserver[0] : 192.168.160.14\n port : 53\n",
        }
      : run(file, args);
  const { question, errorResponse } = require("../helper/dns-wire.cjs");
  const queries = [];
  f.manager.forwardQuery = async (query, servers) => {
    queries.push({ name: question(query).name, servers });
    const response = errorResponse(query, 0);
    if (question(query).type !== 1) return response;
    response.writeUInt16BE(1, 6);
    return Buffer.concat([
      response,
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 20, 0, 7]),
    ]);
  };
  const session = await f.manager.prepare(privateId, original, {
    mode: "include",
    entries: ["pamir.int", "*.pamir.int"],
  });
  t.after(async () => {
    if (f.manager.sessions.has(privateId)) {
      await f.manager.deactivate(privateId);
      await f.manager.finish(privateId);
    }
  });
  return { ...f, target, privateSession: session, queries };
}
test("existing private resolver supplies upstream DNS and is restored byte-for-byte on disconnect", async (t) => {
  const f = await privateFixture(t);
  assert.equal(await fs.readFile(f.target, "utf8"), privateText);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.privateSession.serversFor("host.pamir.int"), [
    "192.168.160.14",
  ]);
  assert.deepEqual(f.privateSession.serversFor("pamir.int.example.org"), [
    "192.0.2.53",
  ]);
  await f.manager.activate(f.privateSession, "utun9");
  const marker = JSON.parse(
    await fs.readFile(f.manager.marker(privateId), "utf8"),
  );
  assert.equal(marker.replacements[0].original, privateText);
  assert.equal(marker.files.length, 0);
  assert.equal(
    await fs.readFile(f.target, "utf8"),
    marker.replacements[0].installed,
  );
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o640);
  const { makeQuery } = require("../helper/dns-wire.cjs");
  await f.proxies.at(-1).forwardQuery(makeQuery("host.pamir.int", 1));
  assert.deepEqual(f.queries.at(-1), {
    name: "host.pamir.int",
    servers: ["192.168.160.14"],
  });
  await f.manager.deactivate(privateId);
  await f.manager.finish(privateId);
  assert.equal(await fs.readFile(f.target, "utf8"), privateText);
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o640);
});
test("an apex without DNS records does not block subdomains and later apex answers are learned", async (t) => {
  const f = await privateFixture(t);
  const { makeQuery, errorResponse } = require("../helper/dns-wire.cjs");
  f.manager.forwardQuery = async (query) => errorResponse(query, 3);
  await f.manager.activate(f.privateSession, "utun9");
  const proxy = f.proxies.at(-1);
  assert.equal(
    (await proxy.forwardQuery(makeQuery("pamir.int", 1)))[3] & 15,
    3,
  );
  assert.equal(f.privateSession.learned.size, 0);
  assert.equal(proxy.matches("pamir.int"), true);
  assert.equal(proxy.matches("host.pamir.int"), true);
  assert.equal(proxy.matches("pamir.int.example.org"), false);
  await proxy.observe("host.pamir.int", ["10.20.0.7"]);
  await proxy.observe("pamir.int", ["10.20.0.8"]);
  assert.equal(f.routes.get("10.20.0.7/32"), "utun9");
  assert.equal(f.routes.get("10.20.0.8/32"), "utun9");
});
test("resolver backups restore after a helper restart", async (t) => {
  const f = await privateFixture(t);
  await f.manager.activate(f.privateSession, "utun9");
  const recovered = new SmartDns(f.options);
  await recovered.recover();
  assert.equal(await fs.readFile(f.target, "utf8"), privateText);
  assert.equal(
    await fs.access(recovered.marker(privateId)).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.match(recovered.errors.get(privateId), /перезапущен/);
  for (const proxy of f.proxies) await proxy.close();
  f.manager.sessions.clear();
});
test("write-ahead backup recovers an interruption just after resolver replacement", async (t) => {
  const f = await privateFixture(t);
  const write = f.manager.resolverWrite.bind(f.manager);
  f.manager.resolverWrite = async (...args) => {
    await write(...args);
    throw Error("Interrupted after rename");
  };
  await assert.rejects(
    f.manager.activate(f.privateSession, "utun9"),
    /Interrupted/,
  );
  assert.match(await fs.readFile(f.target, "utf8"), /managed resolver/);
  f.manager.resolverWrite = write;
  await f.manager.deactivate(privateId);
  await f.manager.finish(privateId);
  assert.equal(await fs.readFile(f.target, "utf8"), privateText);
});
test("external edits to a redirected resolver are never overwritten", async (t) => {
  const f = await privateFixture(t);
  await f.manager.activate(f.privateSession, "utun9");
  const changed = "nameserver 192.168.160.15\ndomain pamir.int\n";
  await fs.writeFile(f.target, changed);
  await assert.rejects(f.manager.deactivate(privateId), /DNS-файл изменён/);
  assert.equal(await fs.readFile(f.target, "utf8"), changed);
  assert.equal(f.proxies.at(-1).closed, true);
  assert.equal(
    JSON.parse(await fs.readFile(f.manager.marker(privateId), "utf8"))
      .replacements[0].original,
    privateText,
  );
});
test("another system resolver for the same domain still blocks takeover", async (t) => {
  const f = await privateFixture(t);
  f.manager.run = async () => ({
    stdout:
      "resolver #1\n domain : pamir.int\n nameserver[0] : 192.168.160.15\n",
  });
  await assert.rejects(
    f.manager.prepare(privateId, original, {
      mode: "include",
      entries: ["*.pamir.int"],
    }),
    /пересекаются/,
  );
  assert.equal(await fs.readFile(f.target, "utf8"), privateText);
});
test("changes between prepare and activate leave the DNS file untouched", async (t) => {
  const f = await privateFixture(t);
  const changed = "nameserver 192.168.160.15\ndomain pamir.int\n";
  await fs.writeFile(f.target, changed);
  await assert.rejects(
    f.manager.activate(f.privateSession, "utun9"),
    /изменились/,
  );
  await f.manager.deactivate(privateId);
  await f.manager.finish(privateId);
  assert.equal(await fs.readFile(f.target, "utf8"), changed);
});
