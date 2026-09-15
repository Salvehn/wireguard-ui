const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { createCore, validateRequest } = require("../helper/core.cjs");
const { systemRoutes } = require("../helper/smart-dns.cjs");
const id = "wg1234567890",
  key = "A".repeat(43) + "=";
const config = `[Interface]\nPrivateKey=${key}\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=${key}\nEndpoint=198.51.100.1:51820\nAllowedIPs=0.0.0.0/0, ::/0\n`;

test("privileged helper validates wildcard requests and rejects unrelated settings", () => {
  for (const settings of [
    { mode: "include", entries: ["foo.*.example.com"] },
    { mode: "off", entries: ["*.example.com"] },
    { mode: "include", entries: ["example.com"] },
  ])
    assert.throws(() =>
      validateRequest({
        op: "setActive",
        id,
        config,
        active: true,
        smartTunneling: settings,
      }),
    );
  assert.throws(() =>
    validateRequest({
      op: "setActive",
      id,
      config,
      active: false,
      smartTunneling: { mode: "include", entries: ["*.example.com"] },
    }),
  );
  assert.equal(
    validateRequest({
      op: "setActive",
      id,
      config,
      active: true,
      smartTunneling: { mode: "include", entries: ["*.example.com"] },
    }).id,
    id,
  );
});
async function fixture(t, { failActivation = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wg-smart-helper-"));
  const runtime = path.join(root, "runtime"),
    configs = path.join(root, "configs"),
    resolvers = path.join(root, "resolvers");
  await fs.mkdir(runtime);
  let active = false,
    server,
    proxy,
    closed = false,
    configAtDown = "";
  const routes = new Map(),
    calls = [];
  t.after(async () => {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("/bin/wg"))
      return { stdout: active ? `utun8\tSECRET\t${key}\t51820\toff\n` : "" };
    if (file.endsWith("/bin/bash")) {
      if (args[1] === "up") {
        active = true;
        server = net.createServer();
        await new Promise((resolve) =>
          server.listen(path.join(runtime, "utun8.sock"), resolve),
        );
        await fs.writeFile(path.join(runtime, id + ".name"), "utun8");
        for (const route of systemRoutes(await fs.readFile(args[2], "utf8")))
          routes.set(route, "utun8");
      } else {
        configAtDown = await fs.readFile(args[2], "utf8");
        active = false;
        await new Promise((resolve) => server.close(resolve));
        await fs.unlink(path.join(runtime, id + ".name"));
        routes.clear();
      }
    }
    if (file === "/usr/sbin/netstat")
      return {
        stdout:
          "Destination Gateway Flags Netif Expire\n" +
          [...routes]
            .filter(
              ([route]) => route.includes(":") === (args.at(-1) === "inet6"),
            )
            .map(([route, iface]) => `${route} link#10 UCS ${iface}`)
            .join("\n"),
      };
    if (file === "/sbin/route") {
      const route =
        args[
          (args.includes("-inet")
            ? args.indexOf("-inet")
            : args.indexOf("-inet6")) + 1
        ];
      if (args.includes("add")) routes.set(route, "utun8");
      if (args.includes("delete")) routes.delete(route);
    }
    return { stdout: "", stderr: "" };
  };
  const core = createCore({
    base: "/root-owned/helper",
    configDirectory: configs,
    runtimeDirectory: runtime,
    userId: 501,
    run,
    smartOptions: {
      resolverDirectory: resolvers,
      enforceOwnership: false,
      upstreams: () => ["192.0.2.53"],
      proxy: async (options) => {
        if (failActivation) throw Error("DNS port unavailable");
        proxy = options;
        return {
          port: 53535,
          close: async () => {
            closed = true;
          },
        };
      },
    },
  });
  return {
    core,
    configs,
    resolvers,
    routes,
    calls,
    getProxy: () => proxy,
    closed: () => closed,
    active: () => active,
    configAtDown: () => configAtDown,
  };
}
test("helper connects wildcard-only tunnel, applies a DNS rule and fully cleans up on DOWN", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.core.handle({ op: "ping" })).version, 10);
  await f.core.handle({
    op: "setActive",
    id,
    active: true,
    config,
    smartTunneling: { mode: "include", entries: ["*.example.com"] },
  });
  assert.equal(f.active(), true);
  assert.equal(f.routes.size, 0);
  assert.equal((await fs.readdir(f.resolvers)).length, 1);
  await f.getProxy().observe("api.example.com", ["203.0.113.7"]);
  assert.equal(f.routes.get("203.0.113.7/32"), "utun8");
  const snapshot = await f.core.handle({ op: "snapshot", ids: [id] });
  assert.equal(snapshot.profiles[id].active, true);
  assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
  await f.core.handle({ op: "setActive", id, active: false, config });
  assert.equal(f.active(), false);
  assert.equal(f.closed(), true);
  assert.equal(f.routes.size, 0);
  assert.deepEqual(await fs.readdir(f.resolvers), []);
  assert.ok(f.configAtDown().includes("203.0.113.7/32"));
  assert.ok(
    !(await fs.readdir(f.configs)).some((file) => file.endsWith(".smart.json")),
  );
});
test("DNS activation failure rolls back the new tunnel and its resolver journal", async (t) => {
  const f = await fixture(t, { failActivation: true });
  await assert.rejects(
    f.core.handle({
      op: "setActive",
      id,
      active: true,
      config,
      smartTunneling: { mode: "include", entries: ["*.example.com"] },
    }),
    /DNS port unavailable/,
  );
  assert.equal(f.active(), false);
  assert.deepEqual(await fs.readdir(f.resolvers), []);
  assert.ok(
    !(await fs.readdir(f.configs)).some((file) => file.endsWith(".smart.json")),
  );
});
