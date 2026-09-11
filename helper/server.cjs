// Root-owned launchd helper. No shell, executable path or environment is accepted over IPC.
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createCore}=require('./core.cjs');
const {redact}=require('./config.cjs');
const uid=Number(process.argv[2]);
if(process.getuid()!==0||!Number.isSafeInteger(uid)||uid<1)process.exit(1);
const runtime=`/var/run/wireguard-desktop-${uid}`;
const socketPath=path.join(runtime,'helper.sock');
const configDirectory=`/Library/Application Support/WireGuardDesktop/${uid}/tunnels`;
const core=createCore({base:__dirname,configDirectory});
let tail=Promise.resolve();
async function start(){
 await fs.mkdir(runtime,{mode:0o755});
}
(async()=>{
 try{await start()}catch(error){if(error.code!=='EEXIST')throw error}
 const root=await fs.lstat(runtime);if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==0||(root.mode&0o022))throw Error('Unsafe runtime directory');
 await fs.rm(socketPath,{force:true});
 const server=net.createServer(socket=>{
   let body='',bytes=0,received=false;
   socket.setEncoding('utf8');socket.setTimeout(5000,()=>socket.destroy());socket.on('error',()=>{});
   socket.on('data',chunk=>{
    if(received)return;
    bytes+=Buffer.byteLength(chunk);if(bytes>131072){socket.destroy();return}body+=chunk.toString('utf8');
    if(!body.includes('\n'))return;
    received=true;socket.pause();socket.setTimeout(130000);
    const job=tail.then(async()=>{
     try{const result=await core.handle(JSON.parse(body.trim()));socket.end(JSON.stringify({ok:true,result})+'\n')}
     catch(error){socket.end(JSON.stringify({ok:false,error:redact(error.message)})+'\n')}
    });tail=job.catch(()=>{});
   });
 });
 // Parent is root-owned. Socket access is limited by the kernel to the installing UID.
 process.umask(0o077);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});
 await fs.chown(socketPath,uid,0);await fs.chmod(socketPath,0o600);
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
})().catch(error=>{process.stderr.write(error.message+'\n');process.exit(1)});
