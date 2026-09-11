const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {parseConfig,redact}=require('./config.cjs');
const exec=promisify(execFile);
const VERSION=1;
const validId=id=>typeof id==='string'&&/^wg[a-f0-9]{10}$/.test(id);
function validateRequest(request){
 if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Invalid request');
 const fields={ping:['op'],snapshot:['op','ids'],forget:['op','id'],setActive:['op','id','active','config']};
 if(!Object.hasOwn(fields,request.op)||Object.keys(request).some(key=>!fields[request.op].includes(key)))throw Error('Unsupported request');
 if(request.op==='snapshot'&&(!Array.isArray(request.ids)||request.ids.length>256||!request.ids.every(validId)))throw Error('Invalid tunnel IDs');
 if(request.op==='forget'&&!validId(request.id))throw Error('Invalid tunnel ID');
 if(request.op==='setActive'){
   if(!validId(request.id)||typeof request.active!=='boolean'||typeof request.config!=='string'||Buffer.byteLength(request.config)>65536||request.config.includes('\0'))throw Error('Invalid tunnel configuration');
   parseConfig(request.config);
 }
 return request;
}
function sanitizedStats(text){
 const interfaces={};
 for(const line of text.trim().split(/[\r\n]+/)){
  const f=line.split('\t');if(f.length===5&&/^utun\d+$/.test(f[0]))interfaces[f[0]]={publicKey:f[2],listenPort:Number(f[3]),fwmark:f[4],updatedAt:Date.now(),peers:[]};
  if(f.length===9&&interfaces[f[0]])interfaces[f[0]].peers.push({publicKey:f[1],endpoint:f[3],allowedIPs:f[4],lastHandshake:Number(f[5]),rx:Number(f[6]),tx:Number(f[7]),keepalive:f[8]});
 }
 return interfaces;
}
function createCore({base,configDirectory,run=exec,runtimeDirectory='/var/run/wireguard'}){
 const bin=path.join(base,'bin');
 const env={PATH:`/usr/bin:/bin:/usr/sbin:/sbin:${bin}`,HOME:'/var/root',LANG:'C',LC_ALL:'C',WG_QUICK_USERSPACE_IMPLEMENTATION:path.join(bin,'wireguard-go')};
 const command=(name,args)=>run(path.join(bin,name),args,{env,timeout:120000,maxBuffer:1024*1024});
 async function snapshot(ids){
  const {stdout}=await command('wg',['show','all','dump']);const interfaces=sanitizedStats(stdout);const profiles={};
  for(const id of ids){
   let iface=null,active=false,statusUnknown=false;
   try{
    iface=(await fs.readFile(path.join(runtimeDirectory,id+'.name'),'utf8')).trim();
    if(/^utun\d+$/.test(iface)&&interfaces[iface]){
     const [name,sock]=await Promise.all([fs.stat(path.join(runtimeDirectory,id+'.name')),fs.stat(path.join(runtimeDirectory,iface+'.sock'))]);
     active=sock.isSocket()&&Math.abs(sock.mtimeMs-name.mtimeMs)<2000;
    }
    statusUnknown=!active;
   }catch(e){statusUnknown=e.code!=='ENOENT'}
   profiles[id]={active,statusUnknown,interfaceName:active?iface:null,stats:active?interfaces[iface]:null};
  }
  return {profiles,updatedAt:Date.now()};
 }
 async function handle(input){
  const req=validateRequest(input);
  if(req.op==='ping')return {version:VERSION};
  if(req.op==='snapshot')return snapshot(req.ids);
  if(req.op==='forget'){const current=(await snapshot([req.id])).profiles[req.id];if(current.active||current.statusUnknown)throw Error('Сначала отключите туннель');await fs.rm(path.join(configDirectory,req.id+'.conf'),{force:true});return {removed:true}}
  const before=await snapshot([req.id]);const current=before.profiles[req.id];
  if(!current.statusUnknown&&current.active===req.active)return {...before,output:'Состояние уже соответствует запросу'};
  if(current.statusUnknown)throw Error('Обнаружено устаревшее системное состояние туннеля. Требуется восстановление, автоматическое изменение остановлено.');
  await fs.mkdir(configDirectory,{recursive:true,mode:0o700});
  const target=path.join(configDirectory,req.id+'.conf');
  // Retain the configuration used for UP, so DOWN restores its routes and DNS.
  const exists=await fs.access(target).then(()=>true,()=>false);
  if(req.active||!exists){
   const tmp=target+'.'+crypto.randomBytes(8).toString('hex');
   try{await fs.writeFile(tmp,req.config,{flag:'wx',mode:0o600});await fs.rename(tmp,target)}finally{await fs.rm(tmp,{force:true})}
  }
  try{
   const {stdout,stderr}=await command('bash',[path.join(bin,'wg-quick'),req.active?'up':'down',target]);
   return {...await snapshot([req.id]),output:redact([stdout,stderr].filter(Boolean).join('\n'))};
  }catch(error){throw Error(redact(error.stderr||error.message))}
 }
 return {handle};
}
module.exports={VERSION,validateRequest,sanitizedStats,createCore};
