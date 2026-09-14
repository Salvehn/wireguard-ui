const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {quote}=require('./config.cjs');
const run=promisify(execFile);
const VERSION=6;
const socketPath=()=>`/var/run/wireguard-desktop-${process.getuid()}/helper.sock`;
function request(command,timeout=130000){return new Promise((resolve,reject)=>{
 const socket=net.createConnection(socketPath());let result='';let settled=false;
 const fail=error=>{if(settled)return;settled=true;socket.destroy();reject(error)};
 socket.setEncoding('utf8');socket.setTimeout(timeout,()=>fail(Error('Системный помощник не ответил вовремя')));
 socket.on('connect',()=>socket.write(JSON.stringify(command)+'\n'));
 socket.on('data',chunk=>{result+=chunk;if(result.length>2*1024*1024)fail(Error('Слишком большой ответ помощника'))});
 socket.on('error',fail);
 socket.on('end',()=>{if(settled)return;try{const data=JSON.parse(result);settled=true;if(data.ok)resolve(data.result);else reject(Error(data.error||'Ошибка помощника'))}catch(error){fail(error)}});
 });}
async function available(){try{return (await request({op:'ping'},2000)).version===VERSION}catch{return false}}
async function install(source){
 const uid=process.getuid();const label=`local.wireguard.desktop.${uid}`;const destination='/Library/PrivilegedHelperTools/'+label;
 const plistPath='/Library/LaunchDaemons/'+label+'.plist';
 await fs.access(path.join(source,'server.cjs'));await fs.access(path.join(source,'bin/node'));
 const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${destination}/bin/node</string><string>--no-addons</string><string>--disable-proto=delete</string><string>${destination}/server.cjs</string><string>${uid}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>`;
 const stage=destination+'.install';
 const command=`set -e
/usr/bin/install -d -o root -g wheel -m 755 /Library/PrivilegedHelperTools /Library/LaunchDaemons
/bin/mkdir -p ${quote(stage)}
/usr/bin/ditto ${quote(source)} ${quote(stage)}
if [ -n "$(/usr/bin/find ${quote(stage)} -type l -print -quit)" ]; then exit 1; fi
/usr/sbin/chown -R root:wheel ${quote(stage)}
/bin/chmod -R go-w ${quote(stage)}
/bin/chmod 755 ${quote(stage)} ${quote(stage+'/bin')}
/bin/launchctl bootout system/${label} >/dev/null 2>&1 || true
if [ -d ${quote(destination)} ]; then /bin/rm -rf ${quote(destination)}; fi
/bin/mv ${quote(stage)} ${quote(destination)}
printf %s ${quote(plist)} > ${quote(plistPath)}
/usr/sbin/chown root:wheel ${quote(plistPath)}
/bin/chmod 644 ${quote(plistPath)}
/bin/launchctl bootstrap system ${quote(plistPath)}`;
 await run('/usr/bin/osascript',['-e','do shell script '+JSON.stringify('/bin/bash -c '+quote(command))+' with administrator privileges'],{timeout:180000,maxBuffer:1024*1024});
 for(let i=0;i<20;i++){if(await available())return;await new Promise(resolve=>setTimeout(resolve,250))}
 throw Error('Помощник установлен, но не запустился. Проверьте фоновые элементы macOS.');
}
module.exports={request,available,install};
