const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const {
  createAppUpdater,
  isNewerVersion,
  manifestPayload,
  validateManifest,
} = require("./updater.cjs");

function signedManifest(data, privateKey) {
  return {
    ...data,
    signature: crypto
      .sign(null, Buffer.from(manifestPayload(data)), privateKey)
      .toString("base64"),
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: Buffer.isBuffer(body)
      ? Readable.from([body.subarray(0, 3), body.subarray(3)])
      : null,
  };
}

test("checks a signed manifest, downloads the archive and hands it to the installer", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wg-update-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = Buffer.from("verified update archive");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = signedManifest(
    {
      schema: 1,
      version: "1.3.0",
      url: "https://github.com/example/app/releases/download/v1.3.0/app.zip",
      size: archive.length,
      sha512: crypto.createHash("sha512").update(archive).digest("base64"),
    },
    privateKey,
  );
  let request = 0;
  let installed;
  const manager = createAppUpdater({
    app: {
      getVersion: () => "1.2.3",
      getPath: () => directory,
      isPackaged: true,
    },
    platform: "darwin",
    architecture: "arm64",
    publicKey,
    fetch: async () => response(request++ === 0 ? manifest : archive),
    installUpdate: async (update) => {
      installed = update;
    },
  });

  await manager.check();
  assert.equal(manager.getState().status, "available");
  await manager.download();
  assert.equal(manager.getState().status, "downloaded");
  assert.equal(manager.getState().percent, 100);
  await manager.install();
  assert.equal(manager.getState().status, "installing");
  assert.equal(installed.version, "1.3.0");
  assert.equal(
    await fs.readFile(installed.archivePath, "utf8"),
    archive.toString(),
  );
});

test("rejects a changed manifest before trusting its download URL", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = signedManifest(
    {
      schema: 1,
      version: "2.0.0",
      url: "https://example.com/update.zip",
      size: 12,
      sha512: crypto.createHash("sha512").update("original").digest("base64"),
    },
    privateKey,
  );
  manifest.url = "https://attacker.example/update.zip";
  assert.throws(() => validateManifest(manifest, publicKey), /подпись/);
});

test("compares stable and prerelease versions", () => {
  assert.equal(isNewerVersion("1.2.4", "1.2.3"), true);
  assert.equal(isNewerVersion("1.2.3", "1.2.3"), false);
  assert.equal(isNewerVersion("1.2.3-beta.2", "1.2.3-beta.1"), true);
  assert.equal(isNewerVersion("1.2.3-beta.1", "1.2.3"), false);
});

test("does not contact the update service from an unpackaged build", async () => {
  let checked = false;
  const manager = createAppUpdater({
    app: { getVersion: () => "1.2.3", isPackaged: false },
    platform: "darwin",
    architecture: "arm64",
    publicKey: "unused",
    fetch: async () => {
      checked = true;
    },
  });
  await manager.check();
  assert.equal(checked, false);
  assert.equal(manager.getState().supported, false);
});
