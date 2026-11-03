const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EndpointRoutes } = require("../helper/endpoint-routes.cjs");
const id = "wg1234567890",
  other = "wg0123456789",
  address = "198.51.100.10";
const config = (endpoint = address, routes = "10.0.0.0/8") =>
  `[Peer]\nEndpoint = ${endpoint}:51820\nAllowedIPs = ${routes}\n`;
function routeText(r) {
  return `destination: ${r.address || "default"}\ngateway: ${r.gateway}\ninterface: ${r.interfaceName}\nflags: <${(r.flags || ["UP", "GATEWAY", "HOST", "STATIC"]).join(",")}>\n`;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wg-endpoints-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const table = new Map(),
    states = {},
    calls = [];
  let uplink = { interfaceName: "en0", gateway: "192.168.50.1" },
    failAdd = false;
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("networksetup"))
      return {
        stdout:
          "(Hardware Port: Wi-Fi, Device: en0)\n(Hardware Port: Ethernet, Device: en7)",
      };
    if (args.includes("get")) {
      if (args.includes("-ifscope")) {
        if (
          !uplink ||
          args[args.indexOf("-ifscope") + 1] !== uplink.interfaceName
        )
          throw Error("not in table");
        return {
          stdout: routeText({ ...uplink, flags: ["UP", "GATEWAY", "STATIC"] }),
        };
      }
      return {
        stdout: routeText(
          table.get(args.at(-1)) || {
            gateway: "169.254.10.1",
            interfaceName: "utun225",
            flags: ["UP", "GATEWAY"],
          },
        ),
      };
    }
    const i = args.indexOf("-host"),
      address = args[i + 1],
      gateway = args[i + 2],
      interfaceName = args[args.indexOf("-ifp") + 1];
    if (args.includes("delete")) table.delete(address);
    else {
      if (failAdd) throw Error("route failed");
      table.set(address, { address, gateway, interfaceName });
    }
    return { stdout: "" };
  };
  const options = {
    configDirectory: directory,
    run,
    states: async () => states,
    lookup: async () => [{ address }],
  };
  const manager = new EndpointRoutes(options);
  const active = (id) =>
    (states[id] = {
      active: true,
      statusUnknown: false,
      interfaceName: "utun8",
    });
  return {
    manager,
    options,
    table,
    states,
    calls,
    active,
    setUplink: (v) => (uplink = v),
    setFail: (v) => (failAdd = v),
  };
}
test("split connects pin the resolved server outside another VPN and disconnect removes only that route", async (t) => {
  const f = await fixture(t);
  const result = await f.manager.prepare(id, config("vpn.example.com"));
  assert.match(result, /Endpoint = 198.51.100.10:51820/);
  assert.equal(f.table.get(address).interfaceName, "en0");
  await f.manager.activate(id, "utun8");
  await f.manager.release(id);
  assert.equal(f.table.size, 0);
});
test("native full tunnels retain wg-quick endpoint handling", async (t) => {
  const f = await fixture(t);
  const original = config(address, "0.0.0.0/0");
  assert.equal(await f.manager.prepare(id, original), original);
  assert.equal(f.calls.length, 0);
});
test("two tunnels sharing a server retain the route until the last disconnect", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(id, config());
  await f.manager.prepare(other, config());
  await f.manager.release(id);
  assert.equal(f.table.size, 1);
  await f.manager.release(other);
  assert.equal(f.table.size, 0);
});
test("existing matching routes are borrowed and conflicting routes are never overwritten", async (t) => {
  const f = await fixture(t);
  f.table.set(address, {
    address,
    gateway: "192.168.50.1",
    interfaceName: "en0",
  });
  await f.manager.prepare(id, config());
  await f.manager.release(id);
  assert.equal(f.table.size, 1);
  f.table.set(address, {
    address,
    gateway: "169.254.10.1",
    interfaceName: "utun225",
  });
  await assert.rejects(f.manager.prepare(id, config()), /занят/);
  assert.equal(f.table.get(address).interfaceName, "utun225");
  assert.equal(f.calls.filter((c) => c.args.includes("delete")).length, 0);
});
test("network changes update owned routes, outages retry, and externally replaced routes survive cleanup", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(id, config());
  await f.manager.activate(id, "utun8");
  f.active(id);
  f.setUplink(null);
  await f.manager.refresh();
  assert.match(f.manager.errors.get(id), /Нет прямого/);
  assert.equal(f.table.size, 1);
  f.setUplink({ interfaceName: "en7", gateway: "10.1.0.1" });
  await f.manager.refresh();
  assert.equal(f.table.get(address).interfaceName, "en7");
  assert.equal(f.manager.errors.size, 0);
  f.table.set(address, {
    address,
    interfaceName: "utun999",
    gateway: "10.2.0.1",
  });
  await f.manager.refresh();
  assert.match(f.manager.errors.get(id), /занят/);
  await f.manager.release(id);
  assert.equal(f.table.get(address).interfaceName, "utun999");
});
test("restart resumes ownership for active tunnels and cleans inactive tunnels", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(id, config());
  await f.manager.activate(id, "utun8");
  f.active(id);
  const restarted = new EndpointRoutes(f.options);
  await restarted.load();
  await restarted.refresh();
  assert.equal(f.table.size, 1);
  f.states[id].active = false;
  await restarted.refresh();
  assert.equal(f.table.size, 0);
  assert.equal(restarted.sessions.size, 0);
});
test("failed route installation rolls back partial pins and does not leave a session", async (t) => {
  const f = await fixture(t);
  f.setFail(true);
  await assert.rejects(f.manager.prepare(id, config()), /route failed/);
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.table.size, 0);
});
test("a route deleted externally is recreated, but a replaced interface is not adopted", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(id, config());
  await f.manager.activate(id, "utun8");
  f.active(id);
  f.table.clear();
  await f.manager.refresh();
  assert.equal(f.table.size, 1);
  f.states[id].interfaceName = "utun9";
  await f.manager.refresh();
  assert.equal(f.table.size, 0);
});
test("IPv6 endpoint uses a physical IPv6 gateway and is pinned as a host", async (t) => {
  const f = await fixture(t);
  f.setUplink({ interfaceName: "en0", gateway: "fe80::1%en0" });
  await f.manager.prepare(id, config("[2001:db8::1]"));
  assert.ok(f.table.has("2001:db8::1"));
  assert.ok(
    f.calls.some((c) => c.args.includes("add") && c.args.includes("-inet6")),
  );
  await f.manager.release(id);
  assert.equal(f.table.size, 0);
});
test("unverified tunnel state retains owned routes until the helper can identify it", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(id, config());
  await f.manager.activate(id, "utun8");
  f.states[id] = { active: false, statusUnknown: true };
  await f.manager.refresh();
  assert.equal(f.table.size, 1);
});
test("a crash between journaling and changing the gateway preserves ownership of the old route", async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(id, config());
  await f.manager.activate(id, "utun8");
  f.active(id);
  const r = f.manager.routes.get(address);
  r.previous = { gateway: r.gateway, interfaceName: r.interfaceName };
  r.gateway = "10.1.0.1";
  r.interfaceName = "en7";
  await f.manager.save();
  const restarted = new EndpointRoutes(f.options);
  await restarted.load();
  await restarted.refresh();
  await restarted.release(id);
  assert.equal(f.table.size, 0);
});
test("invalid recovery data cannot supply arbitrary route arguments", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    f.manager.file,
    JSON.stringify({
      schema: 1,
      sessions: [],
      routes: [
        {
          address: "-flush",
          gateway: "1.1.1.1",
          interfaceName: "en0",
          owned: true,
        },
      ],
    }),
  );
  await assert.rejects(f.manager.load(), /Invalid endpoint/);
  assert.equal(f.calls.length, 0);
});
