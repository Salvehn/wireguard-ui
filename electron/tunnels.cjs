const ipaddr = require('ipaddr.js');

function routeNotes(profile, others) {
  const notes = [];
  const ranges = text => (text || '').split(',').map(s => s.trim()).filter(Boolean).flatMap(s => {
    try { return [ipaddr.parseCIDR(s)]; } catch { return []; }
  });
  for (const other of others.filter(p => p.active && p.id !== profile.id)) {
    const overlaps = ranges(profile.allowedIPs).some(([a, bitsA]) =>
      ranges(other.allowedIPs).some(([b, bitsB]) => a.kind() === b.kind() && a.match(b, Math.min(bitsA, bitsB))));
    if (overlaps) notes.push(`Маршруты пересекаются с «${other.name}». Более узкая сеть имеет приоритет; одинаковые маршруты могут конфликтовать.`);
    if (profile.dns && other.dns) notes.push(`DNS задан также в «${other.name}». macOS использует общие настройки DNS, результат зависит от порядка подключения.`);
  }
  return notes;
}

// Serialize changes to macOS routes/DNS, without limiting the number of active tunnels.
class TunnelController {
  constructor({list, execute, log}) {
    this.list = list; this.execute = execute; this.log = log;
    this.pending = new Map(); this.tail = Promise.resolve();
  }
  setActive(id, active) {
    if (typeof id !== 'string' || typeof active !== 'boolean') return Promise.reject(Error('Некорректная операция'));
    if (this.pending.has(id)) return Promise.reject(Error('Для этого туннеля уже выполняется операция'));
    this.pending.set(id, active ? 'queued-up' : 'queued-down');
    const job = this.tail.then(async () => {
      const all = await this.list();
      const profile = all.find(p => p.id === id);
      if (!profile) throw Error('Туннель не найден');
      if (!profile.statusUnknown && profile.active === active) return;
      this.pending.set(id, active ? 'connecting' : 'disconnecting');
      if (active) for (const note of routeNotes(profile, all)) this.log(`${profile.name}: ${note}`);
      this.log(`${profile.name}: ${active ? 'подключение' : 'отключение'}, выполняется системным помощником`);
      const output = await this.execute(profile, active ? 'up' : 'down');
      this.log(`${profile.name}: ${output || 'операция завершена'}`);
    }).catch(error => { this.log(error.stderr || error.message); throw error; })
      .finally(() => this.pending.delete(id));
    this.tail = job.catch(() => {});
    return job;
  }
}
module.exports = {routeNotes, TunnelController};
