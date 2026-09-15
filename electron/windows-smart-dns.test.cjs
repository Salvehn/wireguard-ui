const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WindowsSmartDns } = require("../helper/windows-smart-dns.cjs");

const key = "A".repeat(43) + "=";
const config = `[Interface]\nPrivateKey=${key}\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=${key}\nAllowedIPs=0.0.0.0/0\nEndpoint=198.51.100.2:51820\n`;

test("Windows wildcard DNS installs NRPT and updates WireGuard policy before routes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wg-win-dns-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  let proxyOptions;
  let proxyClosed = false;
  const powershell = async (script) => {
    calls.push({ type: "powershell", script });
    if (script.includes("Get-DnsClientNrptRule")) return { stdout: "[]" };
    if (script.includes("Get-DnsClientServerAddress"))
      return { stdout: '["1.1.1.1"]' };
    if (script.includes("Add-DnsClientNrptRule"))
      return {
        stdout:
          '{"Name":"{01234567-89ab-cdef-0123-456789abcdef}","Namespace":[".example.com"]}',
      };
    if (script.includes("Get-NetRoute")) return { stdout: "[]" };
    return { stdout: "" };
  };
  const manager = new WindowsSmartDns({
    configDirectory: directory,
    powershell,
    command: async (name, args) => {
      calls.push({ type: name, args });
      return { stdout: "" };
    },
    serialize: (task) => task(),
    stopTunnel: async () => {},
    proxy: async (options) => {
      proxyOptions = options;
      return {
        port: 53,
        close: async () => {
          proxyClosed = true;
        },
      };
    },
    forwardQuery: async () => {
      throw Error("not used");
    },
  });
  const id = "wg1234567890";
  const session = await manager.prepare(id, config, {
    mode: "include",
    entries: ["*.example.com"],
  });
  await manager.activate(session, id);
  assert.equal(proxyOptions.port, 53);
  assert.equal(proxyOptions.matches("www.example.com"), true);
  await manager.observe(session, "www.example.com", ["203.0.113.7"]);
  const wg = calls.find((call) => call.type === "wg");
  const route = calls.find(
    (call) =>
      call.type === "powershell" && call.script.includes("New-NetRoute"),
  );
  assert.ok(wg);
  assert.ok(route);
  assert.ok(calls.indexOf(wg) < calls.indexOf(route));
  assert.match(wg.args.join(" "), /203\.0\.113\.7\/32/);
  await manager.deactivate(id);
  assert.equal(proxyClosed, true);
  assert.ok(
    calls.some(
      (call) =>
        call.type === "powershell" &&
        call.script.includes("Remove-DnsClientNrptRule"),
    ),
  );
});
