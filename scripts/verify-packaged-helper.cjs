const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Copy outside the checkout: Node must not resolve missing daemon dependencies
// from the project's node_modules and hide a broken release.
async function verifyHelper(source, platform = process.platform) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-helper-check-'));
  try {
    const isolated = path.join(temporary, 'helper');
    await fs.cp(source, isolated, { recursive: true });
    const node = path.join(isolated, 'bin', platform === 'win32' ? 'node.exe' : 'node');
    const module = platform === 'win32' ? 'windows-core.cjs' : 'core.cjs';
    execFileSync(node, [
      '--no-addons', '--disable-proto=delete', '--no-global-search-paths',
      '-e', `const core = require("./helper/${module}"); if (!core.${platform === 'win32' ? 'createWindowsCore' : 'VERSION'}) throw Error("Invalid helper");`,
    ], {
      cwd: temporary,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      timeout: 30000,
      stdio: 'pipe',
    });
    console.log('Packaged helper loads with isolated dependencies.');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = async (context) => {
  if (context.electronPlatformName === 'win32') {
    await verifyHelper(path.join(context.appOutDir, 'resources', 'helper-win'), 'win32');
    return;
  }
  const app = context.packager.appInfo.productFilename + '.app';
  await verifyHelper(path.join(context.appOutDir, app, 'Contents/Resources/helper'), 'darwin');
};
module.exports.verifyHelper = verifyHelper;
