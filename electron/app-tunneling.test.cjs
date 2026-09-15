const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  compileApps,
  compileGroup,
  validateApps,
} = require("./app-tunneling.cjs");
const { AppTunnels } = require("../helper/app-tunnels.cjs");
const { validateRequest } = require("../helper/core.cjs");
const config = `[Interface]\nPrivateKey = ${"A".repeat(43)}=\nAddress = 10.20.0.2/32, fd00::2/128\nDNS = 10.20.0.1\n[Peer]\nPublicKey = ${"B".repeat(43)}=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = [2001:db8::1]:51820\nPersistentKeepalive = 25`;
const settings = {
  mode: "include",
  paths: ["/Applications/Browser (Test).app"],
};
test("app rules match only the selected bundle and nested helper processes", () => {
  const compiled = compileApps(config, settings);
  const pattern = new RegExp(compiled.route.rules[1].process_path_regex[0]);
  assert.ok(
    pattern.test(
      "/Applications/Browser (Test).app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
    ),
  );
  assert.ok(
    !pattern.test("/Applications/Browser Test.app/Contents/MacOS/Browser"),
  );
  assert.ok(
    !pattern.test(
      "/Applications/Browser (Test).app-copy/Contents/MacOS/Browser",
    ),
  );
  assert.equal(compiled.route.rules[1].outbound, "vpn");
  assert.equal(compiled.route.final, "direct");
  assert.deepEqual(compiled.inbounds[0].route_address, ["0.0.0.0/0", "::/0"]);
  assert.equal(compiled.endpoints[0].peers[0].address, "2001:db8::1");
  assert.equal(compiled.endpoints[0].address[0], "10.20.0.2/32");
  assert.equal(compiled.inbounds[0].dns_mode, "disabled");
  const exclude = compileApps(config, { ...settings, mode: "exclude" });
  assert.equal(exclude.route.rules[1].outbound, "direct");
  assert.equal(exclude.route.final, "vpn");
});
test("application validation rejects paths and privileged requests outside the protocol", () => {
  for (const p of [
    "relative.app",
    "/Applications/../Fake.app",
    "/Applications/Fake.app\n",
    "/bin/sh",
  ])
    assert.throws(() => validateApps({ mode: "include", paths: [p] }));
  assert.throws(() => validateApps({ mode: "include", paths: [] }));
  assert.deepEqual(
    validateApps({
      ...settings,
      paths: [...settings.paths, ...settings.paths],
    }),
    settings,
  );
  const req = {
    op: "setActive",
    id: "wg0123456789",
    active: true,
    config,
    applications: settings,
  };
  assert.doesNotThrow(() => validateRequest(req));
  assert.throws(() =>
    validateRequest({
      ...req,
      smartTunneling: { mode: "include", entries: ["*.example.com"] },
    }),
  );
  assert.throws(() => validateRequest({ ...req, active: false }));
  assert.throws(() => validateRequest({ ...req, command: "/bin/sh" }));
  assert.throws(() => compileApps(config.replace("51820", "999999"), settings));
  assert.throws(() =>
    compileApps(config.replace("0.0.0.0/0, ::/0", "garbage"), settings),
  );
});
test("Windows application rules use exact executable paths and safe Wintun routing", () => {
  const windows = {
    mode: "include",
    paths: ["C:\\Program Files\\Browser\\browser.exe"],
  };
  assert.deepEqual(validateApps(windows, "win32"), windows);
  for (const value of [
    "browser.exe",
    "C:\\Program Files\\Browser\\..\\bad.exe",
    "C:\\Program Files\\Browser\\bad.com",
    "C:\\Program Files\\Browser\\bad.exe\n",
  ])
    assert.throws(() =>
      validateApps({ mode: "include", paths: [value] }, "win32"),
    );
  const compiled = compileApps(config, windows, "win32");
  assert.deepEqual(compiled.route.rules[1].process_path, windows.paths);
  const grouped = compileGroup(
    [{ id: "wg0123456789", config, settings: windows }],
    { routes: [], occupied: [], endpoints: [], platform: "win32" },
  );
  assert.equal(grouped.inbounds[0].strict_route, true);
  assert.deepEqual(grouped.route.rules[0], {
    ip_cidr: ["172.31.255.0/30", "fdce:5747:6170::/126"],
    action: "reject",
    method: "drop",
  });
  assert.deepEqual(
    grouped.route.rules.find((rule) => rule.type === "logical").rules[1]
      .process_path,
    windows.paths,
  );
});
async function fixture(t, { fail = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wg-apps-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, "bin"));
  await fs.writeFile(path.join(base, "bin/sing-box"), "");
  let running = false;
  const calls = [];
  let engine;
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("/sing-box")) return { stdout: "" };
    if (args[0] === "bootstrap") {
      running = true;
      await fs.writeFile(
        engine.log,
        fail ? "FATAL startup failure" : "INFO sing-box started (0.1s)",
      );
    }
    if (args[0] === "bootout") running = false;
    if (args[0] === "print") {
      if (!running) throw Object.assign(Error("missing"), { code: 113 });
      return { stdout: "state = running\npid = 999999" };
    }
    return { stdout: "" };
  };
  engine = new AppTunnels({
    base,
    configDirectory: path.join(base, "tunnels"),
    userId: 501,
    run,
    delay: async () => {},
  });
  return { engine, calls, run, base };
}
test("app engine starts a fixed launchd job, keeps keys private and stops cleanly", async (t) => {
  const { engine, calls } = await fixture(t);
  await engine.start("wg0123456789", config, settings);
  assert.equal((await engine.snapshot()).active, true);
  assert.equal((await fs.stat(engine.config)).mode & 0o777, 0o600);
  const plist = await fs.readFile(engine.plist, "utf8");
  assert.ok(!plist.includes("A".repeat(43)));
  assert.ok(calls.some((c) => c.args[0] === "bootstrap"));
  await engine.stop();
  assert.equal(await engine.record(), null);
  await assert.rejects(fs.access(engine.config));
});
test("app engine rolls back failed startup and recovery stops the recorded job", async (t) => {
  const bad = await fixture(t, { fail: true });
  await assert.rejects(
    bad.engine.start("wg0123456789", config, settings),
    /запустить/,
  );
  assert.equal(await bad.engine.record(), null);
  const { engine, run, base } = await fixture(t);
  await engine.start("wg0123456789", config, settings);
  const restarted = new AppTunnels({
    base,
    configDirectory: engine.configDirectory,
    userId: 501,
    run,
    delay: async () => {},
  });
  await restarted.recover();
  assert.equal(await restarted.record(), null);
  assert.ok(restarted.errors.has("wg0123456789"));
});

test("helper keeps multiple application connections active and removes only the requested one", async (t) => {
  const { createCore } = require("../helper/core.cjs");
  const { engine, base, run } = await fixture(t);
  const core = createCore({
    base,
    configDirectory: engine.configDirectory,
    runtimeDirectory: path.join(base, "run"),
    userId: 501,
    run: async (file, args) =>
      file.endsWith("/wg") ? { stdout: "" } : run(file, args),
  });
  const id = "wg0123456789";
  const started = await core.handle({
    op: "setActive",
    id,
    active: true,
    config,
    applications: settings,
  });
  assert.equal(started.profiles[id].active, true);
  assert.equal(started.profiles[id].appRouting, true);
  const second = "wg1111111111";
  await core.handle({
    op: "setActive",
    id: second,
    active: true,
    config,
    applications: { mode: "include", paths: ["/Applications/Other.app"] },
  });
  const both = await core.handle({ op: "snapshot", ids: [id, second] });
  assert.equal(both.profiles[id].active, true);
  assert.equal(both.profiles[second].active, true);
  const stopped = await core.handle({
    op: "setActive",
    id,
    active: false,
    config,
  });
  assert.equal(stopped.profiles[id].active, false);
  assert.deepEqual(
    (await engine.record()).sessions.map((s) => s.id),
    [second],
  );
  assert.equal(
    (await core.handle({ op: "snapshot", ids: [second] })).profiles[second]
      .active,
    true,
  );
  await core.handle({ op: "setActive", id: second, active: false, config });
  assert.equal(await engine.record(), null);
});

const appSession = (id, paths, mode = "include") => ({
  id,
  config,
  settings: { mode, paths },
});
const { network } = require("./smart-tunneling.cjs");
const contains = (cidr, address) => {
  const a = network(cidr),
    b = network(address);
  return a.bits === b.bits && a.start <= b.start && a.end >= b.end;
};
function routePacket(compiled, { address, processPath, port = 443 }) {
  const matches = (rule) => {
    if (rule.type === "logical") return rule.rules.every(matches);
    let match =
      (!rule.process_path || rule.process_path.includes(processPath)) &&
      (!rule.ip_cidr || rule.ip_cidr.some((c) => contains(c, address))) &&
      (!rule.process_path_regex ||
        rule.process_path_regex.some((p) => new RegExp(p).test(processPath))) &&
      (!rule.port || rule.port === port);
    return rule.invert ? !match : match;
  };
  return compiled.route.rules.find(matches)?.outbound || compiled.route.final;
}
test("shared routing chooses app VPNs, falls back to native full VPN and keeps work subnets", () => {
  const native = [
    { route: "0.0.0.0/1", interfaceName: "utun8" },
    { route: "128.0.0.0/1", interfaceName: "utun8" },
    { route: "10.0.0.0/8", interfaceName: "utun9" },
  ];
  const result = compileGroup(
    [
      appSession("wg1111111111", ["/Applications/Chat.app"]),
      appSession("wg2222222222", ["/Applications/Browser.app"]),
    ],
    {
      routes: native,
      occupied: native,
      endpoints: ["203.0.113.1"],
      transportPaths: ["/root-owned/bin/wireguard-go"],
    },
  );
  assert.equal(result.endpoints.length, 2);
  assert.equal(
    routePacket(result, {
      address: "8.8.8.8",
      processPath: "/root-owned/bin/wireguard-go",
    }),
    "direct",
  );
  assert.equal(
    routePacket(result, {
      address: "8.8.8.8",
      processPath: "/Applications/Chat.app/Contents/MacOS/Chat",
    }),
    "wg1111111111",
  );
  assert.equal(
    routePacket(result, {
      address: "8.8.8.8",
      processPath: "/Applications/Browser.app/Contents/MacOS/Browser",
    }),
    "wg2222222222",
  );
  assert.equal(
    routePacket(result, { address: "8.8.8.8", processPath: "/usr/bin/curl" }),
    "native-utun8",
  );
  assert.equal(
    routePacket(result, {
      address: "8.8.8.8",
      processPath: "/Applications/Chat.app/Contents/MacOS/Chat",
      port: 53,
    }),
    "native-utun8",
  );
  assert.equal(
    result.outbounds.find((o) => o.tag === "native-utun8").bind_interface,
    "utun8",
  );
  assert.ok(
    !result.inbounds[0].route_address.some((c) => contains(c, "10.20.30.40")),
  );
  assert.ok(
    !result.inbounds[0].route_address.some((c) => contains(c, "203.0.113.1")),
  );
  assert.ok(
    result.inbounds[0].route_address.some((c) => contains(c, "8.8.8.8")),
  );
  assert.ok(
    !result.inbounds[0].route_address.some((c) =>
      native.some((n) => n.route === c),
    ),
  );
});
test("overlapping app rules use the newest connection; exclusions continue through other connections", () => {
  const path = "/Applications/Chat.app";
  const before = appSession("wg1111111111", [path]);
  const after = appSession("wg2222222222", [path]);
  const packet = {
    address: "8.8.8.8",
    processPath: path + "/Contents/MacOS/Chat",
  };
  assert.equal(routePacket(compileGroup([before, after]), packet), after.id);
  assert.equal(
    routePacket(
      compileGroup([
        before,
        { ...after, settings: { mode: "exclude", paths: [path] } },
      ]),
      packet,
    ),
    before.id,
  );
  const limited = {
    ...after,
    config: config.replace("0.0.0.0/0, ::/0", "192.0.2.0/24"),
  };
  assert.equal(routePacket(compileGroup([before, limited]), packet), before.id);
});
test("adding and removing app connections changes the shared config without dropping surviving profiles", async (t) => {
  const { engine } = await fixture(t);
  await engine.start("wg1111111111", config, settings);
  await engine.start("wg2222222222", config, {
    mode: "exclude",
    paths: ["/Applications/Other.app"],
  });
  assert.deepEqual(
    (await engine.snapshots()).map((s) => [s.id, s.active]),
    [
      ["wg1111111111", true],
      ["wg2222222222", true],
    ],
  );
  let generated = JSON.parse(await fs.readFile(engine.config, "utf8"));
  assert.deepEqual(
    generated.endpoints.map((e) => e.tag),
    ["wg1111111111", "wg2222222222"],
  );
  await engine.remove("wg1111111111");
  generated = JSON.parse(await fs.readFile(engine.config, "utf8"));
  assert.deepEqual(
    generated.endpoints.map((e) => e.tag),
    ["wg2222222222"],
  );
  await engine.stop();
});
test("a failed app addition restores the previously running sessions", async (t) => {
  const { engine, run } = await fixture(t);
  await engine.start("wg1111111111", config, settings);
  let failed = false;
  engine.run = async (file, args) => {
    if (args[0] === "bootstrap" && !failed) {
      failed = true;
      throw Error("injected bootstrap failure");
    }
    return run(file, args);
  };
  await assert.rejects(
    engine.start("wg2222222222", config, settings),
    /bootstrap/,
  );
  assert.deepEqual(
    (await engine.snapshots()).map((s) => [s.id, s.active]),
    [["wg1111111111", true]],
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(engine.config, "utf8")).endpoints.map(
      (e) => e.tag,
    ),
    ["wg1111111111"],
  );
});
test("native changes pause app routes and resume against the new interface even when the change throws", async (t) => {
  const { engine } = await fixture(t);
  let iface = "utun8";
  engine.environment = async () => ({
    routes: [{ route: "0.0.0.0/1", interfaceName: iface }],
    occupied: [{ route: "0.0.0.0/1", interfaceName: iface }],
    endpoints: [],
  });
  await engine.start("wg1111111111", config, settings);
  await assert.rejects(
    engine.withNativeChange(async () => {
      assert.equal(await engine.running(), false);
      iface = "utun9";
      throw Error("native operation failed");
    }),
    /native operation/,
  );
  assert.equal((await engine.snapshot()).active, true);
  const generated = JSON.parse(await fs.readFile(engine.config, "utf8"));
  assert.ok(generated.outbounds.some((o) => o.bind_interface === "utun9"));
  assert.ok(!generated.outbounds.some((o) => o.bind_interface === "utun8"));
});

test("native and app tunnels coexist in both connection orders and disconnect independently", async (t) => {
  const net = require("node:net");
  const { createCore } = require("../helper/core.cjs");
  for (const nativeFirst of [true, false]) {
    const { engine, base, run } = await fixture(t);
    const runtime = path.join(base, "run");
    await fs.mkdir(runtime);
    const nativeId = "wg3333333333",
      appId = "wg4444444444";
    let native = false,
      server;
    t.after(async () => {
      if (server?.listening) await new Promise((r) => server.close(r));
    });
    const core = createCore({
      base,
      configDirectory: engine.configDirectory,
      runtimeDirectory: runtime,
      userId: 501,
      run: async (file, args) => {
        if (file.endsWith("/wg"))
          return {
            stdout: native
              ? "utun8\tSECRET\tpublic\t51820\toff\nutun8\tpeer\tPSK\t203.0.113.1:51820\t0.0.0.0/0\t0\t0\t0\t25\n"
              : "",
          };
        if (file === "/usr/sbin/netstat")
          return {
            stdout:
              native && args.includes("inet")
                ? "Destination Gateway Flags Netif Expire\n0/1 link#8 USc utun8\n128/1 link#8 USc utun8\n"
                : "",
          };
        if (file.endsWith("/bash")) {
          assert.equal(
            await engine.running(),
            false,
            "application routes must be gone during native changes",
          );
          if (args[1] === "up") {
            native = true;
            server = net.createServer();
            await new Promise((r) =>
              server.listen(path.join(runtime, "utun8.sock"), r),
            );
            await fs.writeFile(path.join(runtime, nativeId + ".name"), "utun8");
          } else {
            native = false;
            await new Promise((r) => server.close(r));
            await fs.rm(path.join(runtime, nativeId + ".name"));
          }
          return { stdout: "ok" };
        }
        return run(file, args);
      },
    });
    const upNative = () =>
      core.handle({ op: "setActive", id: nativeId, config, active: true });
    const upApp = () =>
      core.handle({
        op: "setActive",
        id: appId,
        config,
        active: true,
        applications: settings,
      });
    if (nativeFirst) {
      await upNative();
      await upApp();
    } else {
      await upApp();
      await upNative();
    }
    let state = await core.handle({ op: "snapshot", ids: [nativeId, appId] });
    assert.equal(state.profiles[nativeId].active, true);
    assert.equal(state.profiles[appId].active, true);
    const compiled = JSON.parse(await fs.readFile(engine.config, "utf8"));
    assert.ok(compiled.outbounds.some((o) => o.bind_interface === "utun8"));
    const first = nativeFirst ? nativeId : appId,
      second = nativeFirst ? appId : nativeId;
    await core.handle({ op: "setActive", id: first, config, active: false });
    state = await core.handle({ op: "snapshot", ids: [nativeId, appId] });
    assert.equal(state.profiles[first].active, false);
    assert.equal(state.profiles[second].active, true);
    if (second === appId)
      assert.ok(
        !JSON.parse(await fs.readFile(engine.config, "utf8")).outbounds.some(
          (o) => o.bind_interface === "utun8",
        ),
      );
    await core.handle({ op: "setActive", id: second, config, active: false });
  }
});

test("application routing preserves an untracked VPN and sends system DNS back to it", async (t) => {
  const { createCore } = require("../helper/core.cjs");
  const { engine, base, run } = await fixture(t);
  const core = createCore({
    base,
    configDirectory: engine.configDirectory,
    runtimeDirectory: path.join(base, "run"),
    userId: 501,
    run: async (file, args) => {
      if (file.endsWith("/wg")) return { stdout: "" };
      if (file === "/usr/sbin/netstat")
        return {
          stdout: args.includes("inet6")
            ? "Destination Gateway Flags Netif Expire\n"
            : "Destination Gateway Flags Netif Expire\n0/1 link#7 USc utun7\n128/1 link#7 USc utun7\n",
        };
      return run(file, args);
    },
  });
  await core.handle({
    op: "setActive",
    id: "wg5555555555",
    config,
    active: true,
    applications: settings,
  });
  const generated = JSON.parse(await fs.readFile(engine.config, "utf8"));
  assert.ok(
    generated.outbounds.some(
      (outbound) =>
        outbound.tag === "native-utun7" && outbound.bind_interface === "utun7",
    ),
  );
  assert.equal(
    routePacket(generated, {
      address: "8.8.8.8",
      processPath: "/usr/sbin/mDNSResponder",
      port: 53,
    }),
    "native-utun7",
  );
});

test("native changes wait for the old engine process to exit after launchd unregisters it", async (t) => {
  const { engine } = await fixture(t);
  await engine.start("wg1111111111", config, settings);
  let waits = 0;
  engine.processAlive = (pid) => {
    assert.equal(pid, 999999);
    return waits < 3;
  };
  engine.delay = async () => {
    waits++;
  };
  await engine.withNativeChange(async () => assert.equal(waits, 3));
  assert.equal((await engine.snapshot()).active, true);
});
test("recovery stops a shared job and reports every affected app connection", async (t) => {
  const { engine, base, run } = await fixture(t);
  await engine.start("wg1111111111", config, settings);
  await engine.start("wg2222222222", config, settings);
  const restarted = new AppTunnels({
    base,
    configDirectory: engine.configDirectory,
    userId: 501,
    run,
    delay: async () => {},
  });
  await restarted.recover();
  assert.deepEqual(
    [...restarted.errors.keys()],
    ["wg1111111111", "wg2222222222"],
  );
  assert.equal(await restarted.record(), null);
});
