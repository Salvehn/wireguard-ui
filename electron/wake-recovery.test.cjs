const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createWakeRecovery,
  stalledAfterWake,
  connectionHealth,
} = require("./wake-recovery.cjs");
const { TunnelController } = require("./tunnels.cjs");
const baseline = () => ({
  id: "a",
  name: "A",
  active: true,
  interfaceName: "utun8",
  stats: {
    peers: [
      {
        publicKey: "peer",
        lastHandshake: 10,
        rx: 100,
        tx: 100,
        keepalive: "25",
      },
    ],
  },
});
const stalled = () => {
  const p = baseline();
  p.stats.peers[0].tx = 200;
  return p;
};
test("wake detection requires unanswered traffic; healthy, idle and replaced tunnels remain alone", () => {
  assert.equal(stalledAfterWake(stalled(), baseline(), 300000), true);
  assert.equal(stalledAfterWake(baseline(), baseline(), 300000), false);
  for (const change of [
    (p) => p.stats.peers[0].rx++,
    (p) => (p.stats.peers[0].lastHandshake = 301),
    (p) => (p.active = false),
    (p) => (p.statusUnknown = true),
    (p) => (p.appRouting = true),
    (p) => (p.interfaceName = "utun9"),
    (p) => (p.stats = null),
    (p) => (p.stats.peers[0].tx = 0),
  ]) {
    const p = stalled();
    change(p);
    assert.equal(stalledAfterWake(p, baseline(), 300000), false);
  }
});
test("only a stale established peer with keepalive gets a lost response warning", () => {
  const p = baseline();
  assert.equal(connectionHealth(p, 300000), "stale");
  assert.equal(connectionHealth(p, 20000), "unknown");
  p.stats.peers[0].keepalive = "off";
  assert.equal(connectionHealth(p, 300000), "unknown");
  p.stats.peers[0].keepalive = "25";
  p.stats.peers[0].lastHandshake = 0;
  assert.equal(connectionHealth(p, 300000), "unknown");
});
function setup() {
  let current = stalled(),
    callback;
  const calls = [];
  const controller = new TunnelController({
    list: async () => [current],
    log: () => {},
    execute: async (p, action) => {
      calls.push(action);
      current = { ...current, active: action === "up" };
    },
  });
  const recovery = createWakeRecovery({
    controller,
    snapshot: () => [baseline()],
    refresh: async () => {},
    log: () => {},
    now: () => 300000,
    schedule: (cb) => {
      callback = cb;
      return 1;
    },
    cancel: () => {},
  });
  return { controller, recovery, calls, fire: () => callback() };
}
test("resume restarts a stalled active tunnel once, serialized with other operations", async () => {
  const f = setup();
  f.recovery.resume();
  assert.deepEqual(f.calls, []);
  await f.fire();
  assert.deepEqual(f.calls, ["down", "up"]);
  assert.equal(f.controller.pending.size, 0);
});
test("manual disconnect during wake grace cancels recovery", async () => {
  const f = setup();
  f.recovery.resume();
  await f.controller.setActive("a", false);
  await f.fire();
  assert.deepEqual(f.calls, ["down"]);
});
test("quit or a new suspend cancels a scheduled recovery", async () => {
  const f = setup();
  f.recovery.resume();
  f.recovery.stop();
  await f.fire();
  assert.deepEqual(f.calls, []);
});
test("cancellation while DOWN is running prevents automatic UP", async () => {
  const f = setup();
  f.controller.execute = async (p, action) => {
    f.calls.push(action);
    f.recovery.stop();
  };
  f.recovery.resume();
  await f.fire();
  assert.deepEqual(f.calls, ["down"]);
});
test("failed DOWN does not attempt UP and releases queue", async () => {
  const f = setup();
  f.controller.execute = async (p, action) => {
    f.calls.push(action);
    throw Error("down failed");
  };
  f.recovery.resume();
  await f.fire();
  assert.deepEqual(f.calls, ["down"]);
  assert.equal(f.controller.pending.size, 0);
});
test("a recovered connection is rechecked at execution time", async () => {
  const f = setup();
  f.controller.list = async () => {
    const p = stalled();
    p.stats.peers[0].rx++;
    return [p];
  };
  f.recovery.resume();
  await f.fire();
  assert.deepEqual(f.calls, []);
});
test("a second resume invalidates the old timer and schedules only one restart", async () => {
  const f = setup();
  f.recovery.resume();
  // Retain the first callback, as if it were already queued by the event loop.
  const callbacks = [];
  const recovery = createWakeRecovery({
    controller: f.controller,
    snapshot: () => [baseline()],
    refresh: async () => {},
    log: () => {},
    now: () => 300000,
    schedule: (cb) => {
      callbacks.push(cb);
      return 1;
    },
    cancel: () => {},
  });
  recovery.resume();
  recovery.resume();
  await callbacks[0]();
  assert.deepEqual(f.calls, []);
  await callbacks[1]();
  assert.deepEqual(f.calls, ["down", "up"]);
});
test("shutdown waits for a recovery already bringing the tunnel UP, then disconnects it", async () => {
  const { shutdownTunnels } = require("./shutdown.cjs");
  const f = setup();
  let release, entered;
  const waiting = new Promise((resolve) => (entered = resolve));
  const execute = f.controller.execute;
  f.controller.execute = async (p, action) => {
    if (action === "up") {
      entered();
      await new Promise((resolve) => (release = resolve));
    }
    await execute(p, action);
  };
  f.recovery.resume();
  const job = f.fire();
  await waiting;
  f.recovery.stop();
  const shutdown = shutdownTunnels({
    profiles: async () => {
      await f.controller.tail;
      return f.controller.list();
    },
    downTunnel: (p) => f.controller.setActive(p.id, false),
    log: () => {},
  });
  release();
  await job;
  await shutdown;
  assert.deepEqual(f.calls, ["down", "up", "down"]);
});

test("a tunnel without its first handshake is waiting even before any traffic", () => {
  const p = baseline();
  p.stats.peers[0].lastHandshake = 0;
  p.stats.peers[0].rx = 0;
  assert.equal(connectionHealth(p), "waiting");
  p.stats.peers[0].tx = 0;
  assert.equal(connectionHealth(p), "waiting");
  p.stats.peers[0].lastHandshake = Date.now() / 1000;
  assert.equal(connectionHealth(p), "unknown");
  p.active = false;
  assert.equal(connectionHealth(p), "unknown");
});
