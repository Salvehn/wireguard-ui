import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repository, run, nextVersion } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: npm run release:mac -- [patch|minor|major|VERSION] [--notes FILE] [--skip-build]

Requires a clean main branch, gh auth login, and the existing update signing key.
Bumps package versions if requested, runs tests and builds, commits the version
change, pushes main/tag, uploads a draft, verifies hashes, and publishes latest.
With no version argument, releases the current package version.
--skip-build resumes with existing signed artifacts (all hashes are verified).
Already published versions are verified without replacing their files.`);
  process.exit(0);
}
let requested,
  notes,
  skipBuild = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--notes" && args[i + 1]) notes = path.resolve(args[++i]);
  else if (args[i] === "--skip-build") skipBuild = true;
  else if (!args[i].startsWith("-") && !requested) requested = args[i];
  else throw Error("Unknown argument: " + args[i]);
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw Error("Run on an Apple Silicon Mac");
if (notes) fs.accessSync(notes);
if (run("git", ["status", "--porcelain"], true).trim())
  throw Error(
    "Commit your source changes first; the release script requires a clean worktree",
  );
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
const version = nextVersion(project.version, requested),
  tag = "v" + version;
if (skipBuild && version !== project.version)
  throw Error("--skip-build cannot be used when bumping the version");
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
if (version !== project.version) {
  for (const file of ["package.json", "package-lock.json"]) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.version = version;
    if (data.packages) data.packages[""].version = version;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }
}
if (!skipBuild) {
  try {
    run("npm", ["run", "test:release"]);
    run("npm", ["test"]);
    run("npm", ["run", "dist:mac"]);
    run("npm", ["run", "update:manifest"]);
  } catch (error) {
    console.error(
      "Build stopped before tagging or publishing. Fix the failure and commit any version changes before retrying.",
    );
    throw error;
  }
}
if (version !== project.version) {
  run("git", ["add", "--", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release ${version}`]);
}
if (!existingTag)
  run("git", ["tag", "-a", tag, "-m", `WireGuard Desktop ${version}`]);
run("git", ["push", "--atomic", "origin", "main", `refs/tags/${tag}`]);
run(process.execPath, [
  "scripts/publish-release.mjs",
  ...(notes ? ["--notes", notes] : []),
]);
