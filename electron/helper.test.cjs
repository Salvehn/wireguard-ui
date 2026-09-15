const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');
const {validateRequest,sanitizedStats,createCore}=require('../helper/core.cjs');
const key='A'.repeat(43)+'=';const config=`[Interface]\nPrivateKey=${key}\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=${key}\nAllowedIPs=10.0.0.0/24\n`;
test('privileged endpoint rejects shell hooks, arbitrary operations, paths and extra arguments',()=>{
 for(const op of ['shell','exec','__proto__','constructor'])assert.throws(()=>validateRequest({op}));
 assert.throws(()=>validateRequest({op:'setActive',id:'../../etc/hosts',active:true,config}));
 assert.throws(()=>validateRequest({op:'setActive',id:'wg1234567890',active:true,config:config+'PostUp=touch /tmp/bad'}));
 assert.throws(()=>validateRequest({op:'snapshot',ids:['wg1234567890'],command:'whoami'}));
 assert.throws(()=>validateRequest({op:'setActive',id:'wg1234567890',active:true,config:config+'\0'}));
});
test('snapshot strips private and preshared keys before IPC',()=>{
 const result=sanitizedStats('utun8\tPRIVATE_SECRET\tpublic\t51820\toff\nutun8\tpeer-public\tPSK_SECRET\t1.2.3.4:53\t0.0.0.0/0\t1234\t5678\t910\t25\n');
 assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.utun8.peers[0].rx,5678);
});
test('helper handles UP/DOWN without shell and avoids a duplicate UP',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-helper-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
 const runtime=path.join(tmp,'run');await fs.mkdir(runtime);const calls=[];let server;
 t.after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve))});
 const id='wg1234567890';let active=false;
 const core=createCore({base:'/root-owned/helper',runtimeDirectory:runtime,configDirectory:path.join(tmp,'configs'),run:async(executable,args,options)=>{
  assert.ok(!options.env.PATH.includes('/opt/homebrew'));assert.equal(options.shell,undefined);
  if(executable.endsWith('/wg'))return {stdout:active?'utun8\tSECRET\tpublic\t51820\toff\n':''};
  calls.push(args);assert.equal(executable,'/bin/bash');
  if(args[1]==='up'){active=true;server=net.createServer();await new Promise(resolve=>server.listen(path.join(runtime,'utun8.sock'),resolve));await fs.writeFile(path.join(runtime,id+'.name'),'utun8');}
  else{active=false;await new Promise(resolve=>server.close(resolve));await fs.unlink(path.join(runtime,id+'.name'));}
  return {stdout:'ok',stderr:''};
 }});
 await core.handle({op:'setActive',id,active:true,config});await core.handle({op:'setActive',id,active:true,config});
 assert.equal(calls.length,1);assert.equal((await core.handle({op:'snapshot',ids:[id]})).profiles[id].active,true);
 await core.handle({op:'setActive',id,active:false,config});assert.equal(calls.length,2);
 assert.equal((await fs.stat(path.join(tmp,'configs',id+'.conf'))).mode&0o777,0o600);
});
