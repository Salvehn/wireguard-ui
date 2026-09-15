const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createWindowsCore,
  avoidWindowsKillSwitch,
} = require("../helper/windows-core.cjs");
const { _test: client } = require("./helper-client-windows.cjs");

const key = "A".repeat(43) + "=";
const config = `[Interface]\nPrivateKey=${key}\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=${key}\nAllowedIPs=10.0.0.0/24\nEndpoint=198.51.100.2:51820\n`;

test("Windows helper client quotes elevation arguments and isolates its pipe", () => {
  assert.equal(client.psQuote("C:\\It's Here"), "'C:\\It''s Here'");
  assert.equal(
    client.pipePath("0123456789abcdef"),
    "\\\\.\\pipe\\wireguard-desktop-0123456789abcdef",
  );
});

test("Windows native configs avoid the WireGuard /0 firewall kill switch", () => {
  const transformed = avoidWindowsKillSwitch(
    "[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0, 10.0.0.0/8 # routes",
  );
  assert.match(transformed, /0\.0\.0\.0\/1, 128\.0\.0\.0\/1/);
  assert.match(transformed, /::\/1, 8000::\/1/);
  assert.match(transformed, /10\.0\.0\.0\/8 # routes/);
});

test("Windows helper installs, observes and removes a tunnel service", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wg-win-helper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const programFiles = path.join(root, "Program Files");
  const wireguard = path.join(programFiles, "WireGuard");
  const base = path.join(root, "helper");
  const tunnels = path.join(root, "tunnels");
  await Promise.all([
    fs.mkdir(wireguard, { recursive: true }),
    fs.mkdir(path.join(base, "bin"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(wireguard, "wireguard.exe"), ""),
    fs.writeFile(path.join(wireguard, "wg.exe"), ""),
    fs.writeFile(path.join(base, "bin", "sing-box.exe"), ""),
  ]);
  let active = false;
  const calls = [];
  const id = "wg1234567890";
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("wg.exe") && !file.endsWith("wireguard.exe"))
      return {
        stdout: active
          ? `${id}\tPRIVATE\tpublic\t51820\toff\n${id}\tpeer\tPSK\t198.51.100.2:51820\t10.0.0.0/24\t1\t2\t3\t25\n`
          : "",
        stderr: "",
      };
    if (file.endsWith("wireguard.exe")) {
      active = args[0] === "/installtunnelservice";
      return { stdout: "ok", stderr: "" };
    }
    if (file.endsWith("sc.exe")) {
      if (!active)
        throw Object.assign(Error("1060"), { stdout: "[SC] 1060", stderr: "" });
      return { stdout: "STATE : 4 RUNNING", stderr: "" };
    }
    return { stdout: "[]", stderr: "" };
  };
  const core = createWindowsCore({
    base,
    configDirectory: tunnels,
    run,
    environment: {
      ProgramFiles: programFiles,
      SystemRoot: path.join(root, "Windows"),
      PATH: "",
    },
  });
  await core.handle({ op: "setActive", id, active: true, config });
  const connected = await core.handle({ op: "snapshot", ids: [id] });
  assert.equal(connected.profiles[id].active, true);
  assert.equal(connected.profiles[id].stats.peers[0].rx, 2);
  assert.equal(
    await fs.readFile(path.join(tunnels, id + ".conf"), "utf8"),
    config,
  );
  await core.handle({ op: "setActive", id, active: false, config });
  assert.equal(
    (await core.handle({ op: "snapshot", ids: [id] })).profiles[id].active,
    false,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.file.endsWith("wireguard.exe") &&
        call.args[0] === "/installtunnelservice",
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.file.endsWith("wireguard.exe") &&
        call.args[0] === "/uninstalltunnelservice",
    ),
  );
});
