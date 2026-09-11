const crypto = require('node:crypto');
function parseConfig(text) {
  let section = '', peers = 0; const summary = {address:'',dns:'',endpoint:'',allowedIPs:''};
  const allowed = {Interface:['PrivateKey','Address','ListenPort','MTU','DNS'],Peer:['PublicKey','PresharedKey','AllowedIPs','Endpoint','PersistentKeepalive']};
  let privateKey = false, publicKey = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    if (/^\[.*\]$/.test(line)) { section = line.slice(1,-1); if (!allowed[section]) throw Error('Неизвестная секция конфигурации'); if(section==='Peer') peers++; continue; }
    const match = line.match(/^(\w+)\s*=\s*(.+)$/); if(!match || !allowed[section]?.includes(match[1])) throw Error('Неподдерживаемое поле. Shell hooks и SaveConfig запрещены.');
    const [,key,value] = match;
    if (key==='PrivateKey' || key==='PublicKey' || key==='PresharedKey') { if(!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error('Некорректный формат ключа'); if(key==='PrivateKey') privateKey=true; if(key==='PublicKey') publicKey=true; }
    const fields={Address:'address',DNS:'dns',Endpoint:'endpoint',AllowedIPs:'allowedIPs'};
    if(fields[key]) summary[fields[key]] += (summary[fields[key]] ? ', ' : '') + value;
  }
  if(!privateKey || !publicKey || !peers) throw Error('Нужны Interface с PrivateKey и Peer с PublicKey');
  return {...summary,peers};
}
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
const redact = s => s.replace(/[A-Za-z0-9+/]{43}=/g, '[скрытый ключ]');
module.exports={parseConfig,quote,redact};
