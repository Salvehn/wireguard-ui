import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Windows helper packaging requires Windows x64");

const dependencies = [
  {
    name: "node.zip",
    url: "https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip",
    sha256: "313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66",
  },
  {
    name: "sing-box.zip",
    url: "https://github.com/SagerNet/sing-box/releases/download/v1.14.0/sing-box-1.14.0-windows-amd64.zip",
    sha256: "3ffb56267da14e287be48bd10cf7e6505260125bad940b75101fbb4d5d58e5d6",
  },
  {
    name: "wireguard-amd64.msi",
    url: "https://download.wireguard.com/windows-client/wireguard-amd64-1.1.msi",
    sha256: "6daa5d37a9e2950dfb8c48b95ab8e562cb2bad1c785d020f38f97bea4c6a5566",
  },
];
const cache = path.resolve("build", "downloads");
const base = path.resolve("build", "helper-win");
const hashFile = async (file) => {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
async function download(dependency) {
  await fsp.mkdir(cache, { recursive: true });
  const target = path.join(cache, dependency.name);
  if (
    (await fsp.access(target).then(
      () => true,
      () => false,
    )) &&
    (await hashFile(target)) === dependency.sha256
  )
    return target;
  const response = await fetch(dependency.url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw Error(
      `Could not download ${dependency.name}: HTTP ${response.status}`,
    );
  const temporary = target + "." + process.pid + ".tmp";
  try {
    await fsp.writeFile(temporary, response.body);
    if ((await hashFile(temporary)) !== dependency.sha256)
      throw Error(`Checksum mismatch for ${dependency.name}`);
    await fsp.rename(temporary, target);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return target;
}
const [nodeArchive, singBoxArchive, wireguardMsi] = await Promise.all(
  dependencies.map(download),
);
const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "wg-desktop-win-"));
try {
  const expand = (archive, destination) =>
    execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        archive,
        destination,
      ],
      { stdio: "inherit" },
    );
  const nodeRoot = path.join(temporary, "node");
  const singBoxRoot = path.join(temporary, "sing-box");
  expand(nodeArchive, nodeRoot);
  expand(singBoxArchive, singBoxRoot);
  await fsp.rm(base, { recursive: true, force: true });
  await fsp.mkdir(path.join(base, "bin"), { recursive: true });
  await fsp.mkdir(path.join(base, "licenses"), { recursive: true });
  await fsp.copyFile(
    path.join(nodeRoot, "node-v24.14.0-win-x64", "node.exe"),
    path.join(base, "bin", "node.exe"),
  );
  await fsp.copyFile(
    path.join(singBoxRoot, "sing-box-1.14.0-windows-amd64", "sing-box.exe"),
    path.join(base, "bin", "sing-box.exe"),
  );
  await fsp.copyFile(wireguardMsi, path.join(base, "wireguard-amd64.msi"));
  for (const name of [
    "windows-server.cjs",
    "windows-core.cjs",
    "windows-smart-dns.cjs",
    "windows-app-tunnels.cjs",
    "core.cjs",
    "smart-dns.cjs",
    "dns-wire.cjs",
  ])
    await fsp.copyFile(path.join("helper", name), path.join(base, name));
  await fsp.copyFile(
    "electron/app-tunneling.cjs",
    path.join(base, "app-tunneling.cjs"),
  );
  await fsp.copyFile("electron/config.cjs", path.join(base, "config.cjs"));
  await fsp.writeFile(
    path.join(base, "smart-tunneling.cjs"),
    (await fsp.readFile("electron/smart-tunneling.cjs", "utf8")).replace(
      'require("ipaddr.js")',
      'require("./vendor/ipaddr.js")',
    ),
  );
  await fsp.cp(
    "node_modules/ipaddr.js",
    path.join(base, "vendor", "ipaddr.js"),
    {
      recursive: true,
    },
  );
  await fsp.copyFile(
    "windows/install-helper.ps1",
    path.join(base, "install-helper.ps1"),
  );
  const framework = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
  );
  execFileSync(
    path.join(framework, "csc.exe"),
    [
      "/nologo",
      "/target:exe",
      `/out:${path.join(base, "bin", "helper-host.exe")}`,
      `/reference:${path.join(framework, "System.ServiceProcess.dll")}`,
      path.resolve("windows", "HelperHost.cs"),
    ],
    { stdio: "inherit" },
  );
  await fsp.copyFile(
    path.join(nodeRoot, "node-v24.14.0-win-x64", "LICENSE"),
    path.join(base, "licenses", "Node.txt"),
  );
  await fsp.copyFile(
    path.join(singBoxRoot, "sing-box-1.14.0-windows-amd64", "LICENSE"),
    path.join(base, "licenses", "SingBox.txt"),
  );
  await fsp.writeFile(
    path.join(base, "licenses", "SOURCES.txt"),
    [
      "Node.js 24.14.0: https://nodejs.org/dist/v24.14.0/",
      "sing-box 1.14.0: https://github.com/SagerNet/sing-box/tree/v1.14.0",
      "WireGuard for Windows 1.1: https://download.wireguard.com/windows-client/",
      "",
    ].join("\n"),
  );
  console.log("Standalone Windows helper prepared with verified dependencies.");
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}
