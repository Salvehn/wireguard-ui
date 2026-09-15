import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repository, run, nextVersion } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: npm run release -- [patch|minor|major|VERSION] [--notes FILE] [--skip-checks]

Requires a clean main branch and gh auth login. Runs local checks, bumps package
versions if requested, commits the version, and atomically pushes main and its
tag. GitHub Actions then builds, verifies, and publishes macOS arm64 and Windows
x64 artifacts together. With no version argument, releases the current version.
Use --notes for English release notes in the draft created before CI publishes.`);
  process.exit(0);
}
let requested;
let notes;
let skipChecks = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--notes" && args[i + 1]) notes = path.resolve(args[++i]);
  else if (args[i] === "--skip-checks" || args[i] === "--skip-build")
    skipChecks = true;
  else if (!args[i].startsWith("-") && !requested) requested = args[i];
  else throw Error("Unknown argument: " + args[i]);
}
if (notes) fs.accessSync(notes);
if (run("git", ["status", "--porcelain"], true).trim())
  throw Error("Commit source changes first; release requires a clean worktree");
if (run("git", ["branch", "--show-current"], true).trim() !== "main")
  throw Error("Release from main");
const origin = run("git", ["remote", "get-url", "origin"], true).trim();
if (
  ![
    `https://github.com/${repository}.git`,
    `https://github.com/${repository}`,
    `git@github.com:${repository}.git`,
  ].includes(origin)
)
  throw Error("Unexpected origin repository");
run("gh", ["auth", "status"]);
run("git", ["fetch", "origin", "main", "--tags"]);
run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);

const project = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = nextVersion(project.version, requested);
const tag = "v" + version;
let existingTag;
try {
  existingTag = run(
    "git",
    ["rev-parse", "--verify", `${tag}^{commit}`],
    true,
  ).trim();
} catch {}
const head = run("git", ["rev-parse", "HEAD"], true).trim();
if (existingTag && (existingTag !== head || version !== project.version))
  throw Error(
    `Tag ${tag} already exists at a different commit; choose a new version`,
  );

if (!skipChecks) {
  run("npm", ["run", "test:release"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);
}
if (version !== project.version) {
  for (const file of ["package.json", "package-lock.json"]) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.version = version;
    if (data.packages) data.packages[""].version = version;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }
  run("git", ["add", "--", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release ${version}`]);
}
if (!existingTag)
  run("git", ["tag", "-a", tag, "-m", `WireGuard Desktop ${version}`]);
run("git", ["push", "--atomic", "origin", "main", `refs/tags/${tag}`]);
if (notes) {
  let exists = true;
  try {
    run("gh", ["release", "view", tag, "--repo", repository], true);
  } catch {
    exists = false;
  }
  run("gh", [
    "release",
    exists ? "edit" : "create",
    tag,
    "--repo",
    repository,
    "--draft",
    "--title",
    `WireGuard Desktop ${version}`,
    "--notes-file",
    notes,
  ]);
}
if (existingTag)
  run("gh", [
    "workflow",
    "run",
    "desktop-release.yml",
    "--repo",
    repository,
    "-f",
    `tag=${tag}`,
  ]);
console.log(
  `Release ${tag} is building in GitHub Actions: https://github.com/${repository}/actions/workflows/desktop-release.yml`,
);
