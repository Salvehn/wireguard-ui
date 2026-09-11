const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const {RuntimeStatus}=require('./runtime-status.cjs');
test('unreadable root mapping stays unknown, verified cache survives restart, stale cache rejected',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wg-status-'));const id='wg1234567890',file=path.join(dir,id+'.name');const cache=path.join(dir,'cache.json');
 const server=net.createServer();await new Promise(resolve=>server.listen(path.join(dir,'utun8.sock'),resolve));await fs.writeFile(file,'utun8\n');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true})});
 const actualRead=fs.readFile;t.mock.method(fs,'readFile',async(filePath,...args)=>{if(filePath===file)throw Object.assign(Error('permission denied'),{code:'EACCES'});return actualRead(filePath,...args)});
 const runtime=new RuntimeStatus(dir,cache);assert.deepEqual(await runtime.read(id),{active:false,statusUnknown:true,interfaceName:null});
 await runtime.remember('mapping\t'+id+'\tutun8\r');assert.equal((await runtime.read(id)).active,true);
 const restarted=new RuntimeStatus(dir,cache);await restarted.load();assert.equal((await restarted.read(id)).interfaceName,'utun8');
 await fs.unlink(file);await fs.writeFile(file,'utun9\n');assert.equal((await restarted.read(id)).statusUnknown,true);
 await fs.unlink(file);assert.deepEqual(await restarted.read(id),{active:false,statusUnknown:false,interfaceName:null});
});
