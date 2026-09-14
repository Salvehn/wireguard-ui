const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Copy outside the checkout: Node must not resolve missing daemon dependencies
// from the project's node_modules and hide a broken release.
async function verifyHelper(source) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-helper-check-'));
  try {
    const isolated = path.join(temporary, 'helper');
    await fs.cp(source, isolated, { recursive: true });
    execFileSync(path.join(isolated, 'bin/node'), [
      '--no-addons', '--disable-proto=delete', '--no-global-search-paths',
      '-e', 'const core = require("./helper/core.cjs"); if (!Number.isInteger(core.VERSION)) throw Error("Invalid helper version");',
    ], {
      cwd: temporary,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_OPTIONS: '', NODE_PATH: '' },
      timeout: 30000,
      stdio: 'pipe',
    });
    console.log('Packaged helper loads with isolated dependencies.');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = async (context) => {
  const app = context.packager.appInfo.productFilename + '.app';
  await verifyHelper(path.join(context.appOutDir, app, 'Contents/Resources/helper'));
};
module.exports.verifyHelper = verifyHelper;
