const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
function loadModel(file, imports = {}) {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", outputText)(
    module,
    module.exports,
    (name) => {
      if (!(name in imports))
        throw Error("Unexpected model dependency: " + name);
      return imports[name];
    },
  );
  return module.exports;
}
const model = loadModel("src/entities/tunnel/model/traffic-history.ts");
const { trafficPaths } = loadModel(
  "src/widgets/connection-sparkline/model/paths.ts",
  { "@/entities/tunnel": model },
);
const profile = (id, time, rx, tx, extra = {}) => ({
  id,
  active: true,
  statusUnknown: false,
  interfaceName: "utun1",
  stats: { updatedAt: time, peers: [{ publicKey: "peer", rx, tx }] },
  ...extra,
});

test("traffic measures separate raw rates, ignores duplicates and records all profiles", () => {
  const history = model.createTrafficHistory();
  history.record([profile("a", 1000, 0, 0), profile("b", 1000, 100, 50)]);
  assert.equal(history.read("a", 1000).current, null);
  history.record([
    profile("a", 3500, 2621440, 2560),
    profile("b", 3500, 5100, 550),
  ]);
  assert.equal(history.read("a", 3500).current.rx, 1048576);
  assert.equal(history.read("a", 3500).current.tx, 1024);
  assert.equal(history.read("b", 3500).current.rx, 2000);
  history.record([
    profile("a", 3500, 2621440, 2560),
    profile("b", 3500, 5100, 550),
  ]);
  assert.equal(history.read("a", 3500).samples.length, 1);
  history.record([
    profile("a", 6000, 2621440, 2560),
    profile("b", 6000, 5100, 550),
  ]);
  assert.equal(
    history.read("a", 6000).current.rx,
    0,
    "idle is measured zero rather than decaying traffic",
  );
  assert.equal(
    history.read("a", 16001).current,
    null,
    "stale data is unknown rather than a live rate",
  );
});

test("missing statistics preserve history and break the next measured segment", () => {
  const history = model.createTrafficHistory();
  history.record([profile("a", 1000, 0, 0)]);
  history.record([profile("a", 3500, 2500, 5000)]);
  history.record([profile("a", 4000, 0, 0, { stats: null })]);
  assert.equal(history.read("a", 4000).samples.length, 1);
  assert.equal(history.read("a", 4000).current, null);
  history.record([profile("a", 6000, 8000, 9000)]);
  assert.equal(history.read("a", 6000).current, null);
  history.record([profile("a", 8500, 10000, 11000)]);
  const chart = trafficPaths(history.read("a", 8500).samples, 8500, 4096, "rx");
  assert.equal((chart.line.match(/M /g) || []).length, 2);
});

test("sleep, counter resets, peer changes and interface replacement establish a new baseline", () => {
  for (const changed of [
    profile("a", 20000, 5000, 5000),
    profile("a", 6000, 10, 10),
    profile("a", 6000, 5000, 5000, { interfaceName: "utun2" }),
    profile("a", 6000, 5000, 5000, {
      stats: {
        updatedAt: 6000,
        peers: [{ publicKey: "replacement", rx: 5000, tx: 5000 }],
      },
    }),
  ]) {
    const history = model.createTrafficHistory();
    history.record([profile("a", 1000, 0, 0)]);
    history.record([profile("a", 3500, 2500, 2500)]);
    history.record([changed]);
    assert.equal(history.read("a", changed.stats.updatedAt).samples.length, 1);
    assert.equal(history.read("a", changed.stats.updatedAt).current, null);
  }
});

test("paths never fill unmeasured time before or after an interval", () => {
  const samples = [{ start: 50000, time: 52500, rx: 1024, tx: 0 }];
  const chart = trafficPaths(samples, 60000, 2048, "rx");
  assert.ok(chart.line.startsWith("M 833.3333333333334 36"));
  assert.ok(!chart.line.includes("1000"), "no fabricated continuation to now");
  assert.deepEqual(trafficPaths(samples, 120000, 2048, "rx"), {
    line: "",
    area: "",
  });
});

test("history is bounded, forgotten profiles are removed and scale contracts gradually", () => {
  const history = model.createTrafficHistory();
  history.record([profile("a", 1000, 0, 0)]);
  history.record([profile("a", 3500, 2621440, 0)]);
  const peakScale = history.read("a", 3500).scale;
  let time = 3500;
  while (time < 66000) {
    time += 2500;
    history.record([profile("a", time, 2621440, 0)]);
  }
  const result = history.read("a", time);
  assert.ok(result.samples.every((sample) => sample.time > time - 60000));
  assert.ok(result.scale < peakScale && result.scale > 2048);
  history.record([]);
  assert.equal(history.read("a", time).samples.length, 0);
});

test("malformed counters never produce non-finite speeds", () => {
  const history = model.createTrafficHistory();
  history.record([profile("a", 1000, NaN, 0)]);
  history.record([profile("a", 3500, 2500, 2500)]);
  assert.equal(history.read("a", 3500).current, null);
  history.record([profile("a", 6000, 5000, 5000)]);
  assert.equal(history.read("a", 6000).current.rx, 1000);
  history.record([profile("a", NaN, 0, 0)]);
  assert.equal(history.read("a", 6000).current, null);
});
