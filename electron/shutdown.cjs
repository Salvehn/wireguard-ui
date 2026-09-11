// Disconnect confirmed-active tunnels when the app quits, without letting quit hang.
// Tunnels with unknown status are left untouched: they need manual recovery first,
// and the helper refuses to change them automatically.
async function shutdownTunnels({profiles,downTunnel,log,timeout=12000}){
 let all;
 try{all=await profiles()}catch{log('Ошибка чтения состояния');return {stopped:0,total:0}}
 const active=all.filter(p=>p.active);
 if(!active.length)return {stopped:0,total:0};
 let stopped=0,settled=false;
 // The helper serializes the operations itself, so requests may run in parallel.
 const run=Promise.all(active.map(async profile=>{
  try{await downTunnel(profile);stopped++}catch{}
 })).then(()=>{settled=true});
 await Promise.race([run,new Promise(resolve=>setTimeout(resolve,timeout).unref())]);
 if(!settled)log('Не все туннели успели отключиться при завершении');
 return {stopped,total:active.length};
}
module.exports={shutdownTunnels};
