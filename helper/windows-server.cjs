// LocalSystem Windows service child. The named pipe is reachable by desktop
// users, while a per-user 256-bit token authorizes every validated request.
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createWindowsCore } = require("./windows-core.cjs");
const { redact } = require("./config.cjs");

const key = process.argv[2];
if (process.platform !== "win32" || !/^[a-f0-9]{16}$/.test(key || ""))
  process.exit(1);
const pipePath = `\\\\.\\pipe\\wireguard-desktop-${key}`;
const programData = process.env.ProgramData || "C:\\ProgramData";
const configDirectory = path.join(
  programData,
  "WireGuardDesktop",
  `Helper-${key}`,
  "tunnels",
);
let server;
let core;
let closing = false;
const clients = new Set();

async function close() {
  if (closing) return;
  closing = true;
  if (server)
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
  await core?.shutdown().catch(() => {});
  process.exit(0);
}

(async () => {
  const token = (
    await fs.readFile(path.join(__dirname, "token"), "ascii")
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid helper token");
  core = createWindowsCore({ base: __dirname, configDirectory });
  await core.initialize();
  server = net.createServer((socket) => {
    if (clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    let body = "";
    let bytes = 0;
    let received = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (received) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 131072) {
        socket.destroy();
        return;
      }
      body += chunk;
      if (!body.includes("\n")) return;
      received = true;
      socket.pause();
      socket.setTimeout(130000);
      void Promise.resolve()
        .then(async () => {
          const request = JSON.parse(body.trim());
          if (request?.token !== token) throw Error("Access denied");
          delete request.token;
          return core.handle(request);
        })
        .then(
          (result) => socket.end(JSON.stringify({ ok: true, result }) + "\n"),
          (error) =>
            socket.end(
              JSON.stringify({ ok: false, error: redact(error.message) }) +
                "\n",
            ),
        );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { path: pipePath, readableAll: true, writableAll: true },
      resolve,
    );
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (text) => {
    if (text.split(/\r?\n/).includes("shutdown")) void close();
  });
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
})().catch((error) => {
  process.stderr.write(redact(error.stack || error.message) + "\n");
  process.exit(1);
});
