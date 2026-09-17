const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const VERSION = 12;

let identityFile = "";
let identityPromise;
function configure(userData) {
  if (typeof userData !== "string" || !path.win32.isAbsolute(userData))
    throw Error("Некорректная папка данных приложения");
  identityFile = path.join(userData, "windows-helper.json");
  identityPromise = null;
}
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function currentSid() {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await run(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]);
  const sid = stdout.trim();
  if (!/^S-1-(?:\d+-){2,14}\d+$/.test(sid))
    throw Error("Не удалось определить пользователя Windows");
  return sid;
}
async function identity() {
  if (!identityFile) throw Error("Windows helper client is not configured");
  return (identityPromise ||= (async () => {
    const sid = await currentSid();
    try {
      const saved = JSON.parse(await fs.readFile(identityFile, "utf8"));
      if (
        /^[a-f0-9]{64}$/.test(saved?.token) &&
        /^[a-f0-9]{16}$/.test(saved?.key) &&
        saved?.sid === sid
      )
        return saved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const saved = {
      sid,
      key: crypto.createHash("sha256").update(sid).digest("hex").slice(0, 16),
      token: crypto.randomBytes(32).toString("hex"),
    };
    await fs.mkdir(path.dirname(identityFile), { recursive: true });
    const temporary =
      identityFile + "." + crypto.randomBytes(6).toString("hex");
    await fs.writeFile(temporary, JSON.stringify(saved), { flag: "wx" });
    await fs.rm(identityFile, { force: true });
    await fs.rename(temporary, identityFile);
    return saved;
  })());
}
const pipePath = (key) => `\\\\.\\pipe\\wireguard-desktop-${key}`;
async function request(command, timeout = 130000) {
  const credentials = await identity();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath(credentials.key));
    let result = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () =>
      fail(Error("Системный помощник не ответил вовремя")),
    );
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ ...command, token: credentials.token }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      result += chunk;
      if (result.length > 2 * 1024 * 1024)
        fail(Error("Слишком большой ответ помощника"));
    });
    socket.on("error", fail);
    socket.on("end", () => {
      if (settled) return;
      try {
        const data = JSON.parse(result);
        settled = true;
        if (data.ok) resolve(data.result);
        else reject(Error(data.error || "Ошибка помощника"));
      } catch (error) {
        fail(error);
      }
    });
  });
}
async function available() {
  try {
    return compatibleVersion(await request({ op: "ping" }, 2500));
  } catch {
    return false;
  }
}
const compatibleVersion = (result) => result?.version === VERSION;
async function install(source) {
  const credentials = await identity();
  for (const file of [
    "windows-server.cjs",
    "install-helper.ps1",
    "bin/node.exe",
    "bin/helper-host.exe",
    "bin/sing-box.exe",
    "bin/wireguard/wireguard.exe",
    "bin/wireguard/wg.exe",
  ])
    await fs.access(path.join(source, file));
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const installer = path.join(source, "install-helper.ps1");
  const elevated = [
    `$arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(installer)},'-Source',${psQuote(source)},'-Key',${psQuote(credentials.key)},'-Token',${psQuote(credentials.token)},'-UserSid',${psQuote(credentials.sid)});`,
    `$p=Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -Wait -PassThru -ArgumentList $arguments;`,
    "exit $p.ExitCode",
  ].join("");
  await run(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", elevated],
    { timeout: 240000, maxBuffer: 2 * 1024 * 1024 },
  );
  for (let i = 0; i < 40; i++) {
    if (await available()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(
    "Помощник установлен, но не запустился. Проверьте службу WireGuard Desktop Helper.",
  );
}
module.exports = {
  request,
  available,
  install,
  configure,
  _test: { VERSION, compatibleVersion, psQuote, pipePath },
};
