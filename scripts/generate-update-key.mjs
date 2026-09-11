import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const privateDirectory = path.resolve(".update-keys");
const privateFile = path.join(privateDirectory, "update-private.pem");
const publicFile = path.resolve("electron/update-public-key.pem");
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

if ((await exists(privateFile)) || (await exists(publicFile))) {
  throw Error(
    "Update key already exists. Refusing to replace it because released apps depend on this key.",
  );
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
await fs.writeFile(
  privateFile,
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600, flag: "wx" },
);
await fs.writeFile(
  publicFile,
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o644, flag: "wx" },
);
console.log(
  "Update key created. Back up .update-keys/update-private.pem securely; never commit or share it.",
);
