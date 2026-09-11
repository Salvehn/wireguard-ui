const fs = require('node:fs/promises');
const valid = value => ['system', 'light', 'dark'].includes(value);
function createTheme(file, systemDark) {
  let preference = 'system';
  let writes = Promise.resolve();
  const resolve = p => (p === 'system' ? (systemDark() ? 'dark' : 'light') : p);
  const get = () => ({ preference, theme: resolve(preference) });
  return {
    get,
    async load() {
      try { const value = JSON.parse(await fs.readFile(file, 'utf8'))?.preference; if (valid(value)) preference = value; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      return get();
    },
    set(value) {
      if (!valid(value)) return Promise.reject(Error('Invalid theme preference'));
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
  };
}
module.exports = { createTheme };
