const {test}=require('node:test');const assert=require('node:assert/strict');const {maskConfig,restoreConfig,revision}=require('./editor.cjs');
const key='A'.repeat(43)+'=',psk='B'.repeat(43)+'=';
const config=`[Interface]\nPrivateKey = ${key}\nAddress = 10.1.0.2/32\n[Peer]\nPublicKey = ${key}\nPresharedKey = ${psk}\nAllowedIPs = 10.1.0.0/24\n`;
test('editor masks secret keys and restores them exactly',()=>{const draft=maskConfig(config);assert.ok(!draft.includes(psk));assert.ok(draft.includes('PrivateKey = <UNCHANGED_KEY_0>'));assert.equal(restoreConfig(draft,config),config)});
test('editing address preserves keys and updates revision',()=>{const changed=restoreConfig(maskConfig(config).replace('10.1.0.2','10.1.0.3'),config);assert.ok(changed.includes(psk));assert.notEqual(revision(changed),revision(config))});
test('invalid edits and unknown key markers are rejected',()=>{assert.throws(()=>restoreConfig(maskConfig(config)+'PostUp = bad',config));assert.throws(()=>restoreConfig(maskConfig(config).replace('UNCHANGED_KEY_0','UNCHANGED_KEY_9'),config))});
