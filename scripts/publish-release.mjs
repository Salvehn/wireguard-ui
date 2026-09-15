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
const api = (endpoint, body) =>
  JSON.parse(
    run(
      "gh",
      [
        "api",
        `repos/${repository}/${endpoint}`,
        ...(body
          ? ["--method", body.method || "POST", "--input", body.file]
          : []),
      ],
      true,
    ),
  );
const request = (endpoint, method, payload) => {
  const file = path.resolve(
    "release",
    ".github-request-" + process.pid + ".json",
  );
  try {
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    return api(endpoint, { method, file });
  } finally {
    fs.rmSync(file, { force: true });
  }
};
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
const mac = await verifyArtifacts("release", version, publicKey, "mac");
const windows = await verifyArtifacts("release", version, publicKey, "win");
const files = [...mac.files, ...windows.files];
const pages = JSON.parse(
  run(
    "gh",
    [
      "api",
      `repos/${repository}/releases?per_page=100`,
      "--paginate",
      "--slurp",
    ],
    true,
  ),
);
let release = pages.flat().find((item) => item.tag_name === tag);
if (release && !release.draft) {
  verifyRemoteAssets(files, release.assets);
} else {
  if (!release) {
    const generated = request("releases/generate-notes", "POST", {
      tag_name: tag,
      target_commitish: tagged,
    });
    release = request("releases", "POST", {
      tag_name: tag,
      target_commitish: tagged,
      name: `WireGuard Desktop ${version}`,
      body: generated.body,
      draft: true,
      prerelease: false,
    });
  }
  for (const file of files) {
    const old = release.assets.find((asset) => asset.name === file.name);
    if (old?.digest === file.digest && old.size === file.size) {
      console.log("Already uploaded: " + file.name);
      continue;
    }
    run("gh", [
      "release",
      "upload",
      tag,
      file.file,
      "--repo",
      repository,
      ...(old ? ["--clobber"] : []),
    ]);
  }
  release = api("releases/" + release.id);
  verifyRemoteAssets(files, release.assets);
  const latest = api("releases/latest");
  const { isNewerVersion } = await import("../electron/updater.cjs");
  if (isNewerVersion(latest.tag_name, version))
    throw Error(
      "A newer release is already latest; refusing to move updates backwards",
    );
  release = request("releases/" + release.id, "PATCH", {
    draft: false,
    make_latest: "true",
  });
}

const { validateManifest } = await import("../electron/updater.cjs");
for (const [name, expected] of [
  ["update-arm64.json", mac.manifest],
  ["update-windows-x64.json", windows.manifest],
]) {
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(
        `https://github.com/${repository}/releases/latest/download/${name}?release=${version}&check=${Date.now()}`,
        { cache: "no-store", signal: AbortSignal.timeout(20000) },
      );
      if (!response.ok) throw Error(`Manifest HTTP ${response.status}`);
      const manifest = validateManifest(await response.json(), publicKey);
      if (
        manifest.version !== expected.version ||
        manifest.sha512 !== expected.sha512
      )
        throw Error("Public update manifest does not match this release");
      verified = true;
      break;
    } catch (error) {
      console.log(`Waiting for ${name}: ${error.message}`);
      if (attempt < 5)
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!verified)
    throw Error(
      `Release is published at ${release.html_url}, but ${name} could not be verified`,
    );
}
console.log(`Published and verified macOS + Windows release: ${release.html_url}`);
