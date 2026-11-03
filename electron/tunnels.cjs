const ipaddr = require('ipaddr.js');

function routeNotes(profile, others, platform = process.platform) {
  const notes = [];
  const appMode = p => ['include','exclude'].includes(p.smartTunneling?.applications?.mode);
  const usesDNS = p => p.dns && !appMode(p) && (!p.smartTunneling || p.smartTunneling.mode==='off');
  const ranges = text => (text || '').split(',').map(s => s.trim()).filter(Boolean).flatMap(s => {
    try { return [ipaddr.parseCIDR(s)]; } catch { return []; }
  });
  for (const other of others.filter(p => p.active && p.id !== profile.id)) {
    const overlaps = ranges(profile.allowedIPs).some(([a, bitsA]) =>
      ranges(other.allowedIPs).some(([b, bitsB]) => a.kind() === b.kind() && a.match(b, Math.min(bitsA, bitsB))));
    if (overlaps && (appMode(profile)||appMode(other))) notes.push(`Совместная маршрутизация с «${other.name}»: рабочие подсети сохраняют приоритет, совпадающие правила приложений использует последнее подключённое соединение.`);
    else if (overlaps) notes.push(`Маршруты пересекаются с «${other.name}». Более узкая сеть имеет приоритет; одинаковые маршруты могут конфликтовать.`);
    if (usesDNS(profile) && usesDNS(other)) notes.push(`DNS задан также в «${other.name}». ${platform === 'win32' ? 'Windows' : 'macOS'} использует общие настройки DNS, результат зависит от порядка подключения.`);
  }
  return notes;
}

// Serialize system route and DNS changes without limiting active tunnels.
class TunnelController {
  constructor({list, execute, log, platform = process.platform}) {
    this.list = list; this.execute = execute; this.log = log; this.platform = platform;
    this.revisions = new Map(); this.pending = new Map(); this.tail = Promise.resolve();
  }
  revision(id) { return this.revisions.get(id) || 0; }
  // Keep DOWN/UP in one queue job, with cancellation checks at both boundaries.
  reconnect(id, {revision, cancelled, shouldReconnect}) {
    if (this.pending.has(id) || this.revision(id) !== revision || cancelled()) return Promise.resolve();
    this.pending.set(id, 'queued-reconnect');
    const job = this.tail.then(async () => {
      if (cancelled() || this.revision(id) !== revision) return;
      const profile = (await this.list()).find(p => p.id === id);
      if (!profile || cancelled() || this.revision(id) !== revision || !shouldReconnect(profile)) return;
      this.pending.set(id, 'reconnecting');
      this.log(`${profile.name}: восстановление соединения после сна`);
      await this.execute(profile, 'down');
      if (cancelled() || this.revision(id) !== revision) return;
      await this.execute(profile, 'up');
      this.log(`${profile.name}: туннель перезапущен после сна`);
    }).catch(error => { this.log(error.stderr || error.message); })
      .finally(() => this.pending.delete(id));
    this.tail = job;
    return job;
  }
  setActive(id, active) {
    if (typeof id !== 'string' || typeof active !== 'boolean') return Promise.reject(Error('Некорректная операция'));
    this.revisions.set(id, this.revision(id) + 1);
    if (this.pending.has(id)) return Promise.reject(Error('Для этого туннеля уже выполняется операция'));
    this.pending.set(id, active ? 'queued-up' : 'queued-down');
    const job = this.tail.then(async () => {
      const all = await this.list();
      const profile = all.find(p => p.id === id);
      if (!profile) throw Error('Туннель не найден');
      if (!profile.statusUnknown && profile.active === active) return;
      this.pending.set(id, active ? 'connecting' : 'disconnecting');
      if (active) for (const note of routeNotes(profile, all, this.platform)) this.log(`${profile.name}: ${note}`);
      this.log(`${profile.name}: ${active ? 'подключение VPN' : 'отключение VPN'}`);
      const output = await this.execute(profile, active ? 'up' : 'down');
      this.log(`${profile.name}: ${output || 'операция завершена'}`);
    }).catch(error => { this.log(error.stderr || error.message); throw error; })
      .finally(() => this.pending.delete(id));
    this.tail = job.catch(() => {});
    return job;
  }
}
module.exports = {routeNotes, TunnelController};
