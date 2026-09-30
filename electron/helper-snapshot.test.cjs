const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSnapshotPoller } = require("./helper-snapshot.cjs");

test("status polling automatically recovers after a sleep-related IPC failure", async () => {
  let time = 0,
    calls = 0;
  const states = [];
  const snapshot = {
    profiles: { wg0123456789: { active: true } },
    updatedAt: 5000,
  };
  const poller = createSnapshotPoller({
    now: () => time,
    request: async (command, timeout) => {
      assert.deepEqual(command, { op: "snapshot", ids: ["wg0123456789"] });
      assert.equal(timeout, 10000);
      if (++calls === 1) throw Error("socket closed after sleep");
      return snapshot;
    },
    receive: (state) => states.push(state),
    failed: (error) => states.push(error.message),
  });
  await poller.refresh(["wg0123456789"]);
  time = 2500;
  await poller.refresh(["wg0123456789"]);
  assert.equal(calls, 1);
  time = 5000;
  await poller.refresh(["wg0123456789"]);
  assert.deepEqual(states, ["socket closed after sleep", snapshot]);
  time = 6500;
  await poller.refresh(["wg0123456789"]);
  assert.equal(calls, 3, "successful recovery restores normal polling");
});

test("wake invalidation checks again immediately without duplicating an in-flight request", async () => {
  let calls = 0,
    resolve;
  const poller = createSnapshotPoller({
    now: () => 0,
    request: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    receive: () => {},
    failed: () => assert.fail("unexpected failure"),
  });
  const first = poller.refresh([]);
  await Promise.resolve();
  poller.invalidate();
  assert.equal(poller.refresh([], true), first);
  assert.equal(calls, 1);
  resolve({ profiles: {}, updatedAt: 0 });
  await first;
  const second = poller.refresh([]);
  await Promise.resolve();
  assert.equal(calls, 2);
  resolve({ profiles: {}, updatedAt: 0 });
  await second;
});
