const {test}=require('node:test');const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');const {parseStats,statsFilter}=require('./stats.cjs');
test('privileged filter strips secrets and separates stats for parallel interfaces',()=>{
 const dump='utun8\tSECRET_PRIVATE_A\tPUBLIC_A\t51820\toff\nutun8\tPEER_A\tSECRET_PSK\t1.2.3.4:1234\t10.0.0.0/24\t1720000000\t1024\t2048\t25\nutun9\tSECRET_PRIVATE_B\tPUBLIC_B\t51821\toff\nutun9\tPEER_B\tSECRET_PSK_B\t[::1]:1234\t::/0\t0\t0\t0\toff\n';
 const clean=execFileSync('/usr/bin/awk',[statsFilter],{input:dump,encoding:'utf8'});assert.ok(!clean.includes('SECRET'));const stats=parseStats(clean,123);assert.equal(stats.utun8.peers[0].rx,1024);assert.equal(stats.utun8.peers[0].lastHandshake,1720000000);assert.equal(stats.utun9.peers[0].lastHandshake,0);assert.equal(stats.utun9.peers[0].endpoint,'[::1]:1234');assert.equal(stats.utun8.updatedAt,123);
});
