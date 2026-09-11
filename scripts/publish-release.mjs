import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const owner = "Salvehn",
  repo = "wireguard-ui";
const project = JSON.parse(await fsp.readFile("package.json", "utf8"));
const tag = `v${project.version}`;
const token = process.env.GH_TOKEN;
if (!token) throw Error("GH_TOKEN is required to publish a release");
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "WireGuard-Desktop-release",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok)
    throw Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

let release;
const lookup = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
  { headers },
);
if (lookup.ok) {
  release = await lookup.json();
  if (!release.draft)
    throw Error(
      `Release ${tag} is already published. Increase the app version instead of replacing a trusted update.`,
    );
} else if (lookup.status === 404) {
  release = await api(
    `https://api.github.com/repos/${owner}/${repo}/releases`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        name: `WireGuard Desktop ${project.version}`,
        draft: true,
        prerelease: project.version.includes("-"),
      }),
    },
  );
} else throw Error(`GitHub API ${lookup.status}: ${await lookup.text()}`);

const files = [
  "WireGuard-Desktop-arm64.dmg",
  "WireGuard-Desktop-arm64.dmg.blockmap",
  "WireGuard-Desktop-arm64.zip",
  "WireGuard-Desktop-arm64.zip.blockmap",
  "update-arm64.json",
];
for (const name of files) {
  const file = path.resolve("release", name);
  const stat = await fsp.stat(file);
  const old = release.assets.find((asset) => asset.name === name);
  if (old)
    await api(
      `https://api.github.com/repos/${owner}/${repo}/releases/assets/${old.id}`,
      { method: "DELETE" },
    );
  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  await api(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
    },
    body: fs.createReadStream(file),
    duplex: "half",
  });
  console.log(`Published ${name}`);
}
if (release.draft) {
  await api(
    `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false }),
    },
  );
}
console.log(`Release ${tag} published`);
