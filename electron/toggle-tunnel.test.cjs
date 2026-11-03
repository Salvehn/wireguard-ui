const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const moduleUnderTest = { exports: {} };
new Function(
  "module",
  "exports",
  "require",
  ts.transpileModule(
    fs.readFileSync(
      path.join(
        __dirname,
        "../src/features/manage-tunnels/model/toggle-tunnel.ts",
      ),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(moduleUnderTest, moduleUnderTest.exports, () => ({ tunnelApi: {} }));
const { toggleTunnel } = moduleUnderTest.exports;
const profile = { id: "a", active: false, statusUnknown: false };
const state = (p = profile, status = "ready") => ({
  profiles: [p],
  helper: { status },
  backend: status === "ready" ? "helper" : null,
});
function api(ready, fresh = ready) {
  const calls = [];
  return {
    calls,
    setupHelper: async () => {
      calls.push("setup");
      return ready;
    },
    refreshStats: async () => {
      calls.push("refresh");
      return fresh;
    },
    setActive: async (id, active) => {
      calls.push([id, active]);
      return state({ ...profile, active });
    },
  };
}
test("permission immediately connects using fresh state instead of the stale active profile", async () => {
  const a = api(state());
  await toggleTunnel(
    { ...profile, active: true, statusUnknown: true },
    { backend: null },
    a,
  );
  assert.deepEqual(a.calls, ["setup", ["a", true]]);
});
test("unknown state after setup is refreshed and then connected in the same click", async () => {
  const a = api(state({ ...profile, statusUnknown: true }), state());
  await toggleTunnel({ ...profile, statusUnknown: true }, { backend: null }, a);
  assert.deepEqual(a.calls, ["setup", "refresh", ["a", true]]);
});
test("denied permissions, missing profiles and unresolved state never start a tunnel", async () => {
  for (const ready of [
    state(profile, "required"),
    { ...state(), profiles: [] },
    state({ ...profile, statusUnknown: true }),
  ]) {
    const a = api(ready);
    await toggleTunnel(profile, { backend: null }, a);
    assert.ok(!a.calls.some(Array.isArray));
  }
});
test("setup preserves an already active tunnel and ordinary clicks still disconnect it", async () => {
  const active = { ...profile, active: true };
  const a = api(state(active));
  await toggleTunnel(profile, { backend: null }, a);
  assert.deepEqual(a.calls, ["setup"]);
  await toggleTunnel(active, state(active), a);
  assert.deepEqual(a.calls, ["setup", ["a", false]]);
});
