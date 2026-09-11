const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocale, resolveLanguage } = require('./locale.cjs');
const dictionary = require('../src/shared/lib/i18n/en.json');
test('system locale supports regional Russian and falls back to English', () => {
  assert.equal(resolveLanguage(['ru-RU', 'en']), 'ru');
  assert.equal(resolveLanguage(['ru_BY']), 'ru');
  assert.equal(resolveLanguage(['en-GB', 'ru']), 'en');
  assert.equal(resolveLanguage(['de-DE', 'ru']), 'en');
  assert.equal(resolveLanguage([]), 'en');
});
test('manual language persists, overrides system and can return to automatic', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-locale-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'locale.json');
  let system = ['ru-RU'];
  const locale = createLocale(file, () => system);
  assert.deepEqual(await locale.load(), { preference: 'system', language: 'ru' });
  await locale.set('en');
  const restarted = createLocale(file, () => system);
  assert.deepEqual(await restarted.load(), { preference: 'en', language: 'en' });
  await locale.set('system');
  system = ['en-US'];
  assert.deepEqual(locale.get(), { preference: 'system', language: 'en' });
  assert.equal(locale.t('Удалить «{name}»?', { name: 'Мой VPN' }), 'Delete “Мой VPN”?');
  await assert.rejects(locale.set('../ru'), /Invalid language/);
  assert.equal(locale.get().preference, 'system');
  await Promise.all([locale.set('ru'), locale.set('en')]);
  assert.equal(locale.get().preference, 'en');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).preference, 'en');
});
test('corrupt or unsupported saved preferences use system language', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-locale-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'locale.json');
  for (const content of ['{', 'null', '{"preference":"fr"}']) {
    await fs.writeFile(file, content);
    assert.deepEqual(await createLocale(file, () => ['ru']).load(), { preference: 'system', language: 'ru' });
  }
});
test('all translations preserve placeholders and translated UI keys are covered', async () => {
  const ts = require('typescript');
  for (const [key, value] of Object.entries(dictionary)) {
    assert.deepEqual([...key.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), [...value.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), key);
  }
  for (const f of (await fs.readdir(path.join(__dirname, '../src'), { recursive: true })).filter(f => /\.tsx?$/.test(f))) {
    const source = ts.createSourceFile(f, await fs.readFile(path.join(__dirname, '../src', f), 'utf8'), ts.ScriptTarget.Latest, true);
    const walk = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteral(node.arguments[0])) assert.ok(dictionary[node.arguments[0].text.trim()], `${f}: ${node.arguments[0].text}`);
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
});
