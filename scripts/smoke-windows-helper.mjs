import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw Error("Run this smoke test on Windows");
const [key, token] = process.argv.slice(2);
if (!/^[a-f0-9]{16}$/.test(key || "") || !/^[a-f0-9]{64}$/.test(token || ""))
  throw Error("Invalid smoke-test identity");
const pipe = `\\\\.\\pipe\\wireguard-desktop-${key}`;
const request = (command, timeout = 130000) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => socket.destroy(Error("helper timeout")));
    socket.once("connect", () =>
      socket.write(JSON.stringify({ ...command, token }) + "\n"),
    );
    socket.on("data", (chunk) => (text += chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const response = JSON.parse(text);
        if (!response.ok) throw Error(response.error || "helper error");
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitForHelper = async () => {
  const deadline = Date.now() + 30000;
  let lastError;
  do {
    try {
      return await request({ op: "ping" }, 2000);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Windows helper did not become ready within 30 seconds: ${lastError?.message || lastError}`,
  );
};
const wireguard = path.join(
  process.env.ProgramFiles || "C:\\Program Files",
  "WireGuard",
  "wg.exe",
);
const wg = (args, input) => {
  const result = spawnSync(wireguard, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw Error(result.stderr || "wg failed");
  return result.stdout.trim();
};
const privateKey = wg(["genkey"]);
const peerPrivate = wg(["genkey"]);
const peerPublic = wg(["pubkey"], peerPrivate + "\n");
const config = `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.254.254.1/32\n\n[Peer]\nPublicKey = ${peerPublic}\nAllowedIPs = 10.254.254.2/32\nEndpoint = 127.0.0.1:9\nPersistentKeepalive = 25\n`;
const ids = {
  native: "wg0000000001",
  wildcard: "wg0000000002",
  applications: "wg0000000003",
};
const deactivate = async (id) => {
  try {
    await request({ op: "setActive", id, active: false, config });
  } catch {}
};
try {
  const ping = await waitForHelper();
  if (ping.version !== 10) throw Error("unexpected helper version");

  const native = await request({
    op: "setActive",
    id: ids.native,
    active: true,
    config,
  });
  if (!native.profiles[ids.native]?.active) throw Error("native tunnel did not start");
  await deactivate(ids.native);

  const wildcard = await request({
    op: "setActive",
    id: ids.wildcard,
    active: true,
    config,
    smartTunneling: { mode: "include", entries: ["*.wg-desktop.test"] },
  });
  if (!wildcard.profiles[ids.wildcard]?.active)
    throw Error("wildcard tunnel did not start");
  await deactivate(ids.wildcard);

  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const applications = await request({
    op: "setActive",
    id: ids.applications,
    active: true,
    config,
    applications: { mode: "include", paths: [executable] },
  });
  if (!applications.profiles[ids.applications]?.active)
    throw Error("application tunnel did not start");
  await deactivate(ids.applications);
  console.log("Windows helper smoke test passed: native, wildcard, and application modes.");
} finally {
  await Promise.all(Object.values(ids).map(deactivate));
}
