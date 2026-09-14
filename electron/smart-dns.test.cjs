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
