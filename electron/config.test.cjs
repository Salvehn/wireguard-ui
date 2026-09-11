const {test}=require('node:test');const assert=require('node:assert/strict');const {parseConfig,quote,redact}=require('./config.cjs');
const key='A'.repeat(43)+'=';const config=`[Interface]\nPrivateKey = ${key}\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = ${key}\nAllowedIPs = 0.0.0.0/0`;
test('returns only public metadata',()=>{const result=parseConfig(config);assert.equal(result.address,'10.0.0.2/32');assert.equal(result.peers,1);assert.ok(!JSON.stringify(result).includes(key))});
test('rejects root shell hooks and SaveConfig',()=>{for(const field of ['PreUp','PostUp','PreDown','PostDown','SaveConfig'])assert.throws(()=>parseConfig(config+'\n[Interface]\n'+field+' = dangerous'))});
test('rejects invalid keys and missing sections',()=>{assert.throws(()=>parseConfig('[Interface]\nAddress=10.0.0.2'));assert.throws(()=>parseConfig(config.replace(key,'bad')))});
test('quotes shell paths and redacts keys',()=>{assert.equal(quote("a'b"),"'a'\\''b'");assert.equal(redact('key '+key),'key [скрытый ключ]')});
