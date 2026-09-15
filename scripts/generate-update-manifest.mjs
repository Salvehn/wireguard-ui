import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const project = JSON.parse(await fsp.readFile("package.json", "utf8"));
const version = project.version;
const platform = process.argv[2] || "mac";
if (!["mac", "win"].includes(platform)) throw Error("Use mac or win");
const archiveName =
  platform === "win"
    ? "WireGuard-Desktop-x64-Setup.exe"
    : "WireGuard-Desktop-arm64.zip";
const archive = path.resolve("release", archiveName);
const privateFile =
  process.env.UPDATE_PRIVATE_KEY_FILE ||
  path.resolve(".update-keys/update-private.pem");
const publicFile = path.resolve("electron/update-public-key.pem");
const output = path.resolve(
  "release",
  platform === "win" ? "update-windows-x64.json" : "update-arm64.json",
);

const hash = crypto.createHash("sha512");
for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
const stat = await fsp.stat(archive);
const payload = {
  schema: 1,
  version,
  url: `https://github.com/Salvehn/wireguard-ui/releases/download/v${version}/${archiveName}`,
  size: stat.size,
  sha512: hash.digest("base64"),
};
const serialized = JSON.stringify(payload);
const privateKey = process.env.UPDATE_PRIVATE_KEY_PEM
  ? process.env.UPDATE_PRIVATE_KEY_PEM
  : process.env.UPDATE_PRIVATE_KEY_BASE64
    ? Buffer.from(process.env.UPDATE_PRIVATE_KEY_BASE64, "base64").toString(
        "utf8",
      )
    : await fsp.readFile(privateFile, "utf8");
const signature = crypto
  .sign(null, Buffer.from(serialized), privateKey)
  .toString("base64");
const publicKey = await fsp.readFile(publicFile, "utf8");
if (
  !crypto.verify(
    null,
    Buffer.from(serialized),
    publicKey,
    Buffer.from(signature, "base64"),
  )
)
  throw Error("Generated update signature could not be verified");
await fsp.writeFile(
  output,
  JSON.stringify({ ...payload, signature }, null, 2) + "\n",
  { mode: 0o644 },
);
console.log(`Signed update manifest created for ${version}: ${output}`);
