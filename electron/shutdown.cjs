// Include in-flight recovery and snapshot reads in the shutdown deadline.
async function shutdownTunnels({profiles,downTunnel,log,timeout=12000}){
 let stopped=0,total=0,settled=false,timedOut=false,timer;
 const run=(async()=>{
  let all;
  try{all=await profiles()}catch{log('Ошибка чтения состояния');return}
  if(timedOut)return;
  const active=all.filter(p=>p.active&&!p.statusUnknown);total=active.length;
  await Promise.all(active.map(async profile=>{
   try{await downTunnel(profile);stopped++}catch{}
  }));
 })().finally(()=>{settled=true});
 try{
  await Promise.race([run,new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve()},timeout);timer.unref()})]);
  if(!settled)log('Не все туннели успели отключиться при завершении');
  return {stopped,total};
 }finally{clearTimeout(timer)}
}
module.exports={shutdownTunnels};
