const fs=require('node:fs/promises');
const path=require('node:path');
const fingerprint=stat=>`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`;
class RuntimeStatus {
 constructor(directory='/var/run/wireguard',cacheFile=null){this.directory=directory;this.cacheFile=cacheFile;this.cache={}}
 async load(){if(!this.cacheFile)return;try{this.cache=JSON.parse(await fs.readFile(this.cacheFile,'utf8'))}catch{this.cache={}}}
 async remember(output){
  for(const line of output.split(/[\r\n]+/)){
   const [,id,iface]=line.split('\t');if(!line.startsWith('mapping\t')||!/^wg[a-f0-9]{10}$/.test(id)||!/^utun\d+$/.test(iface))continue;
   try{const stat=await fs.stat(path.join(this.directory,id+'.name'));this.cache[id]={iface,fingerprint:fingerprint(stat)}}catch{}
  }
  if(this.cacheFile){const tmp=this.cacheFile+'.'+require('node:crypto').randomBytes(6).toString('hex')+'.tmp';await fs.writeFile(tmp,JSON.stringify(this.cache),{mode:0o600});await fs.rename(tmp,this.cacheFile)}
 }
 async read(id){
  const name=path.join(this.directory,id+'.name');let stat;
  try{stat=await fs.stat(name)}catch(error){if(error.code==='ENOENT')return {active:false,statusUnknown:false,interfaceName:null};return {active:false,statusUnknown:true,interfaceName:null}}
  let iface;
  try{iface=(await fs.readFile(name,'utf8')).trim()}catch(error){
   if(error.code!=='EACCES'&&error.code!=='EPERM')return {active:false,statusUnknown:true,interfaceName:null};
   const cached=this.cache[id];if(cached?.fingerprint===fingerprint(stat))iface=cached.iface;
  }
  if(!iface||!/^utun\d+$/.test(iface))return {active:false,statusUnknown:true,interfaceName:null};
  try{const socket=await fs.stat(path.join(this.directory,iface+'.sock'));
   if(!socket.isSocket()||Math.abs(socket.mtimeMs-stat.mtimeMs)>=2000)return {active:false,statusUnknown:true,interfaceName:null};
   return {active:true,statusUnknown:false,interfaceName:iface};
  }catch(error){return {active:false,statusUnknown:error.code!=='ENOENT',interfaceName:null}}
 }
}
const mappingCommand=`for name in /var/run/wireguard/wg*.name; do
 [ -f "$name" ] || continue
 id=$(/usr/bin/basename "$name" .name)
 iface=$(/bin/cat "$name")
 case "$iface" in utun[0-9]*) [ -S "/var/run/wireguard/$iface.sock" ] && printf 'mapping\\t%s\\t%s\\n' "$id" "$iface" ;; esac
done
true`;
module.exports={RuntimeStatus,mappingCommand};
