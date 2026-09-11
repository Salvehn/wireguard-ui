const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTheme } = require('./theme.cjs');
test('system theme follows the macOS appearance', () => {
  let dark = true;
  const theme = createTheme('/unused', () => dark);
  assert.deepEqual(theme.get(), { preference: 'system', theme: 'dark' });
  dark = false;
  assert.deepEqual(theme.get(), { preference: 'system', theme: 'light' });
});
test('manual theme persists, overrides system and can return to automatic', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-theme-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'theme.json');
  let dark = true;
  const theme = createTheme(file, () => dark);
  assert.deepEqual(await theme.load(), { preference: 'system', theme: 'dark' });
  await theme.set('light');
  assert.deepEqual(theme.get(), { preference: 'light', theme: 'light' });
  const restarted = createTheme(file, () => true);
  assert.deepEqual(await restarted.load(), { preference: 'light', theme: 'light' });
  await theme.set('system');
  assert.deepEqual(theme.get(), { preference: 'system', theme: 'dark' });
  dark = false;
  assert.deepEqual(theme.get(), { preference: 'system', theme: 'light' });
  await assert.rejects(theme.set('../ru'), /Invalid theme/);
  assert.equal(theme.get().preference, 'system');
  await Promise.all([theme.set('light'), theme.set('dark')]);
  assert.equal(theme.get().preference, 'dark');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).preference, 'dark');
});
test('corrupt or unsupported saved preferences use system theme', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-theme-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'theme.json');
  for (const content of ['{', 'null', '{"preference":"sepia"}']) {
    await fs.writeFile(file, content);
    assert.deepEqual(await createTheme(file, () => true).load(), { preference: 'system', theme: 'dark' });
  }
});
