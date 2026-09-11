const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { worker } = require("./update-worker.cjs");

test("atomically replaces an app and keeps the new version after its health signal", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wg-worker-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const current = path.join(root, "Fake.app");
  const source = path.join(root, "source", "Fake.app");
  const userData = path.join(root, "data");
  await Promise.all([
    fsp.mkdir(path.join(current, "Contents", "MacOS"), { recursive: true }),
    fsp.mkdir(path.join(source, "Contents", "MacOS"), { recursive: true }),
    fsp.mkdir(userData, { recursive: true }),
  ]);
  await fsp.writeFile(path.join(current, "version"), "old");
  await fsp.writeFile(path.join(source, "version"), "new");
  const token = "a".repeat(32);
  const executable = `#!/bin/sh\ntoken="\${1#--update-token=}"\nprintf '{"token":"%s","version":"2.0.0"}' "$token" > ${JSON.stringify(path.join(userData, "update-health-"))}"$token".json\n`;
  await fsp.writeFile(
    path.join(source, "Contents", "MacOS", "Fake"),
    executable,
    { mode: 0o755 },
  );
  const info = path.join(source, "Contents", "Info.plist");
  await fsp.writeFile(
    info,
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>',
  );
  const archive = path.join(root, "update.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", source, archive]);
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);

  await worker({
    parentPid: 2147483647,
    archivePath: archive,
    currentApp: current,
    version: "2.0.0",
    sha512: hash.digest("base64"),
    userData,
    token,
  });
  assert.equal(
    await fsp.readFile(path.join(current, "version"), "utf8"),
    "new",
  );
  assert.equal(
    await fsp.access(archive).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await fsp
      .access(path.join(root, `.${path.basename(current)}.backup-${token}`))
      .then(
        () => true,
        () => false,
      ),
    false,
  );
  assert.equal(
    await fsp.access(path.join(userData, `update-health-${token}.json`)).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("restores the previous app when the new version does not become healthy", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wg-rollback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const current = path.join(root, "Fake.app");
  const source = path.join(root, "source", "Fake.app");
  const userData = path.join(root, "data");
  await Promise.all([
    fsp.mkdir(path.join(current, "Contents", "MacOS"), { recursive: true }),
    fsp.mkdir(path.join(source, "Contents", "MacOS"), { recursive: true }),
    fsp.mkdir(userData, { recursive: true }),
  ]);
  await fsp.writeFile(path.join(current, "version"), "old");
  await fsp.writeFile(path.join(source, "version"), "broken");
  await fsp.writeFile(
    path.join(current, "Contents", "MacOS", "Fake"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  await fsp.writeFile(
    path.join(source, "Contents", "MacOS", "Fake"),
    "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  await fsp.writeFile(
    path.join(source, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>',
  );
  const archive = path.join(root, "update.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", source, archive]);
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);

  await assert.rejects(
    worker({
      parentPid: 2147483647,
      archivePath: archive,
      currentApp: current,
      version: "2.0.0",
      sha512: hash.digest("base64"),
      userData,
      token: "b".repeat(32),
      healthTimeout: 500,
    }),
    /успешный запуск/,
  );
  assert.equal(
    await fsp.readFile(path.join(current, "version"), "utf8"),
    "old",
  );
});
