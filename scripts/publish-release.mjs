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
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "node scripts/publish-release.mjs [--notes FILE]\nPublish or resume the current version using already built, signed artifacts.",
  );
  process.exit(0);
}
let notes;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--notes" && args[i + 1])
    notes = fs.readFileSync(path.resolve(args[++i]), "utf8");
  else throw Error("Unknown argument: " + args[i]);
}
const project = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = project.version,
  tag = "v" + version;
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
// gh supplies credentials from its existing login or GH_TOKEN. No token is read or printed.
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
  throw Error("Remote tag does not match the local commit");
const publicKey = fs.readFileSync("electron/update-public-key.pem");
const { files } = await verifyArtifacts("release", version, publicKey);
// The archive is signed by our updater; verify the macOS app bundle as well.
run("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  "release/mac-arm64/WireGuard Desktop.app",
]);
const appVersion = run(
  "/usr/libexec/PlistBuddy",
  [
    "-c",
    "Print :CFBundleShortVersionString",
    "release/mac-arm64/WireGuard Desktop.app/Contents/Info.plist",
  ],
  true,
).trim();
if (appVersion !== version)
  throw Error("Packaged app version does not match the release");
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
  verifyRemoteAssets(files, release.assets, false);
  console.log(`Already published and verified: ${release.html_url}`);
} else {
  if (!notes) {
    const generated = request("releases/generate-notes", "POST", {
      tag_name: tag,
      target_commitish: tagged,
    });
    notes = generated.body;
  }
  if (!release)
    release = request("releases", "POST", {
      tag_name: tag,
      target_commitish: tagged,
      name: `WireGuard Desktop ${version}`,
      body: notes,
      draft: true,
      prerelease: false,
    });
  else
    release = request("releases/" + release.id, "PATCH", {
      body: notes,
      name: `WireGuard Desktop ${version}`,
    });
  for (const file of files) {
    const old = release.assets.find((asset) => asset.name === file.name);
    if (old?.digest === file.digest && old.size === file.size) {
      console.log("Already uploaded: " + file.name);
      continue;
    }
    // Only draft assets can be replaced. Published releases are immutable above.
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
  verifyRemoteAssets(files, release.assets, false);
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
// Confirm what the app will download, including the cryptographic signature.
const { validateManifest } = await import("../electron/updater.cjs");
let verified = false;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const response = await fetch(
      `https://github.com/${repository}/releases/latest/download/update-arm64.json?release=${version}&check=${Date.now()}`,
      { cache: "no-store", signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw Error("Manifest HTTP " + response.status);
    const manifest = validateManifest(await response.json(), publicKey);
    if (manifest.version !== version)
      throw Error("Public update is not current yet");
    verified = true;
    break;
  } catch (error) {
    console.log("Waiting for public update endpoint: " + error.message);
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
if (!verified)
  throw Error(
    `Release is published at ${release.html_url}, but the public update endpoint could not be verified. Retry verification; do not replace the release.`,
  );
console.log(`Published and verified: ${release.html_url}`);
