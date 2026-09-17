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
  process.env.ProgramData || "C:\\ProgramData",
  "WireGuardDesktop",
  `Helper-${key}`,
  "bin",
  "wireguard",
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
};
const deactivate = async (id) => {
  try {
    await request({ op: "setActive", id, active: false, config });
  } catch {}
};
try {
  const ping = await waitForHelper();
  if (ping.version !== 12) throw Error("unexpected helper version");

  const native = await request({
    op: "setActive",
    id: ids.native,
    active: true,
    config,
  });
  if (!native.profiles[ids.native]?.active)
    throw Error("native tunnel did not start");
  await deactivate(ids.native);

  console.log(
    "Windows helper smoke test passed: installed service and native tunnel.",
  );
} finally {
  await Promise.all(Object.values(ids).map(deactivate));
}
