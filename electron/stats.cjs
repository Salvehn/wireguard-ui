// Input is sanitized by awk before it leaves the privileged process.
function parseStats(text, now = Date.now()) {
  const interfaces = {};
  for (const line of text.trim().split(/[\r\n]+/)) {
    const f=line.split('\t');
    if(f[0]==='interface' && f.length===5) interfaces[f[1]]={publicKey:f[2],listenPort:Number(f[3]),fwmark:f[4],peers:[],updatedAt:now};
    if(f[0]==='peer' && f.length===9) {
      const iface=interfaces[f[1]];if(!iface)continue;
      iface.peers.push({publicKey:f[2],endpoint:f[3],allowedIPs:f[4],lastHandshake:Number(f[5]),rx:Number(f[6]),tx:Number(f[7]),keepalive:f[8]});
    }
  }
  return interfaces;
}
// Interface dump: name, PRIVATE, public, port, fwmark.
// Peer dump: name, public, PRESHARED, endpoint, allowed, handshake, rx, tx, keepalive.
const statsFilter = 'BEGIN { FS="\\t"; OFS="\\t" } NF == 5 { print "interface", $1, $3, $4, $5 } NF == 9 { print "peer", $1, $2, $4, $5, $6, $7, $8, $9 }';
module.exports={parseStats,statsFilter};
