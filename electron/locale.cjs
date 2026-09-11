const fs = require('node:fs/promises');
const dictionary = require('../src/shared/lib/i18n/en.json');
const valid = value => ['system', 'ru', 'en'].includes(value);
const resolveLanguage = languages => /^ru(?:[-_]|$)/i.test(languages?.[0] || '') ? 'ru' : 'en';
function createLocale(file, systemLanguages) {
  let preference = 'system';
  let writes = Promise.resolve();
  const get = () => ({ preference, language: preference === 'system' ? resolveLanguage(systemLanguages()) : preference });
  return {
    get,
    async load() {
      try { const value = JSON.parse(await fs.readFile(file, 'utf8'))?.preference; if (valid(value)) preference = value; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      return get();
    },
    set(value) {
      if (!valid(value)) return Promise.reject(Error('Invalid language preference'));
      const next = writes.catch(() => {}).then(async () => {
        const temp = file + '.tmp';
        try { await fs.writeFile(temp, JSON.stringify({ preference: value }), { mode: 0o600 }); await fs.rename(temp, file); }
        finally { await fs.rm(temp, { force: true }); }
        preference = value;
        return get();
      });
      writes = next;
      return next;
    },
    t(source, values = {}) {
      const template = get().language === 'en' ? dictionary[source] || source : source;
      return template.replace(/\{(\w+)\}/g, (token, name) => String(values[name] ?? token));
    },
  };
}
module.exports = { createLocale, resolveLanguage };
