import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const baseVersion = "5.3";
const patchLevel = 15;
const source = {
  url: `https://ftp.gnu.org/gnu/bash/bash-${baseVersion}.tar.gz`,
  sha256: "0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba",
};
const patchHashes = [
  "1f608434364af86b9b45c8b0ea3fb3b165fb830d27697e6cdfc7ac17dee3287f",
  "e385548a00130765ec7938a56fbdca52447ab41fabc95a25f19ade527e282001",
  "f245d9c7dc3f5a20d84b53d249334747940936f09dc97e1dcb89fc3ab37d60ed",
  "9591d245045529f32f0812f94180b9d9ce9023f5a765c039b852e5dfc99747d0",
  "cca1ef52dbbf433bc98e33269b64b2c814028efe2538be1e2c9a377da90bc99d",
  "29119addefed8eff91ae37fd51822c31780ee30d4a28376e96002706c995ff10",
  "c0976bbfffa1453c7cfdd62058f206a318568ff2d690f5d4fa048793fa3eb299",
  "097cd723cbfb8907674ac32214063a3fd85282657ec5b4e544d2c0f719653fb4",
  "eee30fe78a4b0cb2fe20e010e00308899cfc613e0774ebb3c8557a1552f24f8c",
  "cf76f1cce2ea300c18bff9f002d21f280cc931acd17c28518110b93fe6e72569",
  "0298df8f5ea2a31d3be43ed7d269c5b3c7c342dd5b570bea7f64d66dcbbe7531",
  "d71379b39bebaedaf123414414e77fb458a0a43b9ad3116594c6df7ca6754573",
  "042f9cda967e24bf4211944697441e93d06ff42b4b998629a98a1b249279f200",
  "bd4360b401d38507e358783dcad8536a99c6789f0d3a5bd0cfb8c4a34144696c",
  "55b79ceee2fc27f6767eed697e939a7eb2fe2a28c01556bd75f18d581014f46e",
];

const hashFile = async (file) => {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

async function download(file, url, sha256) {
  if (
    (await fsp.access(file).then(
      () => true,
      () => false,
    )) &&
    (await hashFile(file)) === sha256
  )
    return;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body)
    throw Error(
      `Could not download ${path.basename(file)}: ${response.status}`,
    );
  const temporary = file + "." + process.pid + ".tmp";
  try {
    await fsp.writeFile(temporary, response.body);
    if ((await hashFile(temporary)) !== sha256)
      throw Error(`Checksum mismatch for ${path.basename(file)}`);
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

export async function prepareBash() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("Bash packaging requires macOS arm64");
  const cache = path.resolve("build", "bash");
  const binary = path.join(cache, `bash-${baseVersion}.${patchLevel}-arm64`);
  const license = path.join(cache, "COPYING");
  await fsp.mkdir(cache, { recursive: true });
  const archive = path.join(cache, `bash-${baseVersion}.tar.gz`);
  await download(archive, source.url, source.sha256);
  const patches = [];
  for (let index = 0; index < patchHashes.length; index++) {
    const number = String(index + 1).padStart(3, "0");
    const file = path.join(cache, `bash53-${number}`);
    await download(
      file,
      `https://ftp.gnu.org/gnu/bash/bash-${baseVersion}-patches/bash53-${number}`,
      patchHashes[index],
    );
    patches.push(file);
  }
  const cached = await Promise.all([
    fsp.access(binary).then(
      () => true,
      () => false,
    ),
    fsp.access(license).then(
      () => true,
      () => false,
    ),
  ]);
  if (cached.every(Boolean)) {
    try {
      const version = execFileSync(binary, ["--version"], { encoding: "utf8" });
      if (version.includes(`version ${baseVersion}.${patchLevel}`))
        return {
          binary,
          license,
          sourceFiles: [archive, ...patches],
          version: `${baseVersion}.${patchLevel}`,
        };
    } catch {}
  }

  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "wg-bash-"));
  try {
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", temporary]);
    const root = path.join(temporary, `bash-${baseVersion}`);
    for (const patch of patches)
      execFileSync("/usr/bin/patch", ["-p0", "-i", patch], {
        cwd: root,
        stdio: "inherit",
      });
    const buildEnvironment = {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: "11.0",
      CFLAGS: "-O2 -mmacosx-version-min=11.0",
      LDFLAGS: "-mmacosx-version-min=11.0",
    };
    execFileSync(
      path.join(root, "configure"),
      ["--disable-nls", "--disable-readline", "--without-bash-malloc"],
      { cwd: root, env: buildEnvironment, stdio: "inherit" },
    );
    execFileSync("/usr/bin/make", ["-j4"], {
      cwd: root,
      env: buildEnvironment,
      stdio: "inherit",
    });
    execFileSync("/usr/bin/strip", ["-x", path.join(root, "bash")]);
    await fsp.copyFile(path.join(root, "bash"), binary);
    await fsp.chmod(binary, 0o755);
    await fsp.copyFile(path.join(root, "COPYING"), license);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" });
  if (!version.includes(`version ${baseVersion}.${patchLevel}`))
    throw Error("Bundled Bash version could not be verified");
  return {
    binary,
    license,
    sourceFiles: [archive, ...patches],
    version: `${baseVersion}.${patchLevel}`,
  };
}
