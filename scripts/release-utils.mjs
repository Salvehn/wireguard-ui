import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const repository = "Salvehn/wireguard-ui";
export const assets = [
  "WireGuard-Desktop-arm64.dmg",
  "WireGuard-Desktop-arm64.dmg.blockmap",
  "WireGuard-Desktop-arm64.zip",
  "WireGuard-Desktop-arm64.zip.blockmap",
  "update-arm64.json",
];
export function run(file, args, capture = false) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 8 * 1024 * 1024,
  });
}
export function nextVersion(current, requested = current) {
  if (!/^\d+\.\d+\.\d+$/.test(current))
    throw Error("Only stable versions are supported");
  const parts = current.split(".").map(Number);
  if (["major", "minor", "patch"].includes(requested)) {
    const index = ["major", "minor", "patch"].indexOf(requested);
    parts[index]++;
    for (let i = index + 1; i < 3; i++) parts[i] = 0;
    return parts.join(".");
  }
  if (!/^\d+\.\d+\.\d+$/.test(requested))
    throw Error("Use patch, minor, major, or a version such as 0.3.6");
  const target = requested.split(".").map(Number);
  const difference = target.findIndex((part, i) => part !== parts[i]);
  if (difference >= 0 && target[difference] < parts[difference])
    throw Error("Cannot release an older version");
  return requested;
}
export async function hashFile(file, algorithm = "sha256", encoding = "hex") {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}
export async function verifyArtifacts(directory, version, publicKey) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "update-arm64.json"), "utf8"),
  );
  const { validateManifest } = await import("../electron/updater.cjs");
  validateManifest(manifest, publicKey);
  if (
    manifest.version !== version ||
    manifest.url !==
      `https://github.com/${repository}/releases/download/v${version}/WireGuard-Desktop-arm64.zip`
  )
    throw Error("Manifest does not match the release version");
  const archive = path.join(directory, "WireGuard-Desktop-arm64.zip");
  if (
    fs.statSync(archive).size !== manifest.size ||
    (await hashFile(archive, "sha512", "base64")) !== manifest.sha512
  )
    throw Error("Archive does not match the signed manifest");
  const files = [];
  for (const name of assets) {
    const file = path.join(directory, name),
      size = fs.statSync(file).size;
    if (!size) throw Error(`Empty release asset: ${name}`);
    files.push({
      name,
      file,
      size,
      digest: "sha256:" + (await hashFile(file)),
    });
  }
  return { manifest, files };
}
export function verifyRemoteAssets(local, remote) {
  if (remote.length !== local.length)
    throw Error("Unexpected release asset count");
  for (const file of local) {
    const asset = remote.find((item) => item.name === file.name);
    if (!asset || asset.size !== file.size || asset.digest !== file.digest)
      throw Error(`Uploaded asset mismatch: ${file.name}`);
  }
}
