import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  repository,
  run,
  verifyArtifacts,
  verifyRemoteAssets,
} from "./release-utils.mjs";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const project = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = project.version;
const tag = "v" + version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw Error("Only stable releases are supported");
run("gh", ["auth", "status"]);
const api = (endpoint) =>
  JSON.parse(run("gh", ["api", `repos/${repository}/${endpoint}`], true));
const head = run("git", ["rev-parse", "HEAD"], true).trim();
const tagged = run("git", ["rev-parse", `${tag}^{commit}`], true).trim();
if (head !== tagged) throw Error("HEAD must match the release tag");
const remoteTag = api("git/ref/tags/" + tag);
let remoteCommit = remoteTag.object;
if (remoteCommit.type === "tag")
  remoteCommit = api("git/tags/" + remoteCommit.sha).object;
if (remoteCommit.sha !== tagged)
  throw Error("Remote tag does not match the build commit");
const publicKey = fs.readFileSync("electron/update-public-key.pem");
const { files } = await verifyArtifacts("release", version, publicKey, "win");
let release;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    release = api("releases/tags/" + tag);
    if (!release.draft) break;
    if (attempt < 59)
      await new Promise((resolve) => setTimeout(resolve, 10000));
  } catch (error) {
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
if (!release || release.draft)
  throw Error("The macOS release was not published before the Windows timeout");
for (const file of files) {
  const existing = release.assets.find((asset) => asset.name === file.name);
  if (existing) {
    if (existing.size !== file.size || existing.digest !== file.digest)
      throw Error(`Published Windows asset differs: ${file.name}`);
    console.log("Already uploaded: " + file.name);
    continue;
  }
  run("gh", ["release", "upload", tag, file.file, "--repo", repository]);
}
release = api("releases/tags/" + tag);
verifyRemoteAssets(files, release.assets, false);
let verified = false;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const response = await fetch(
      `https://github.com/${repository}/releases/latest/download/update-windows-x64.json?release=${version}&check=${Date.now()}`,
      { cache: "no-store", signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw Error("Manifest HTTP " + response.status);
    const { validateManifest } = await import("../electron/updater.cjs");
    const manifest = validateManifest(await response.json(), publicKey);
    if (manifest.version !== version)
      throw Error("Public Windows update is not current yet");
    verified = true;
    break;
  } catch (error) {
    console.log("Waiting for public Windows update endpoint: " + error.message);
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
if (!verified)
  throw Error(
    "Windows assets uploaded, but public manifest verification failed",
  );
console.log(`Windows release published and verified: ${release.html_url}`);
