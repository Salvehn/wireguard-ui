import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  assets,
  windowsAssets,
  nextVersion,
  verifyArtifacts,
  verifyRemoteAssets,
} from "./release-utils.mjs";

test("version bumps reset smaller components and refuse downgrades", () => {
  assert.equal(nextVersion("0.3.5", "patch"), "0.3.6");
  assert.equal(nextVersion("0.3.5", "minor"), "0.4.0");
  assert.equal(nextVersion("0.3.5", "major"), "1.0.0");
  assert.equal(nextVersion("0.3.5"), "0.3.5");
  assert.throws(() => nextVersion("0.3.5", "0.3.4"), /older/);
  assert.throws(() => nextVersion("0.3.5", "invalid"), /Use/);
});
test("Windows release validation binds the installer to its signed manifest", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wg-win-release-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const installer = Buffer.from("test Windows installer");
  const payload = {
    schema: 1,
    version: "0.4.0",
    url: "https://github.com/Salvehn/wireguard-ui/releases/download/v0.4.0/WireGuard-Desktop-x64-Setup.exe",
    size: installer.length,
    sha512: crypto.createHash("sha512").update(installer).digest("base64"),
  };
  const manifest = {
    ...payload,
    signature: crypto
      .sign(null, Buffer.from(JSON.stringify(payload)), privateKey)
      .toString("base64"),
  };
  for (const name of windowsAssets)
    await fs.writeFile(
      path.join(dir, name),
      name.endsWith("Setup.exe") ? installer : Buffer.from("asset"),
    );
  await fs.writeFile(
    path.join(dir, "update-windows-x64.json"),
    JSON.stringify(manifest),
  );
  const result = await verifyArtifacts(dir, "0.4.0", publicKey, "win");
  assert.equal(result.files.length, 3);
  verifyRemoteAssets(
    result.files,
    [...result.files, { name: "mac.dmg" }],
    false,
  );
});
test("release validation rejects tampered archives and mismatched versions", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wg-release-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const archive = Buffer.from("test archive");
  const payload = {
    schema: 1,
    version: "0.3.5",
    url: "https://github.com/Salvehn/wireguard-ui/releases/download/v0.3.5/WireGuard-Desktop-arm64.zip",
    size: archive.length,
    sha512: crypto.createHash("sha512").update(archive).digest("base64"),
  };
  const manifest = {
    ...payload,
    signature: crypto
      .sign(null, Buffer.from(JSON.stringify(payload)), privateKey)
      .toString("base64"),
  };
  for (const name of assets)
    await fs.writeFile(
      path.join(dir, name),
      name.endsWith(".zip") ? archive : Buffer.from("test asset"),
    );
  await fs.writeFile(
    path.join(dir, "update-arm64.json"),
    JSON.stringify(manifest),
  );
  const result = await verifyArtifacts(dir, "0.3.5", publicKey);
  assert.equal(result.files.length, 5);
  verifyRemoteAssets(result.files, result.files);
  assert.throws(
    () => verifyRemoteAssets(result.files, result.files.slice(1)),
    /count/,
  );
  assert.throws(
    () =>
      verifyRemoteAssets(
        result.files,
        result.files.map((item, i) =>
          i ? item : { ...item, digest: "wrong" },
        ),
      ),
    /mismatch/,
  );
  await assert.rejects(verifyArtifacts(dir, "0.3.6", publicKey), /version/);
  await fs.writeFile(path.join(dir, "WireGuard-Desktop-arm64.zip"), "changed");
  await assert.rejects(verifyArtifacts(dir, "0.3.5", publicKey), /Archive/);
});
