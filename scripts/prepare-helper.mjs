import {prepareSingBox} from './prepare-singbox.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const base=path.resolve('build/helper');await fs.mkdir(path.join(base,'bin'),{recursive:true});await fs.mkdir(path.join(base,'licenses'),{recursive:true});
const node=process.env.WG_NODE_RUNTIME||(process.env.NVM_BIN?path.join(process.env.NVM_BIN,'node'):process.execPath);
const prefix=process.arch==='arm64'?'/opt/homebrew':'/usr/local';
const singBoxRoot=await prepareSingBox();
const sources={node,wg:prefix+'/bin/wg','wg-quick':prefix+'/bin/wg-quick','wireguard-go':prefix+'/bin/wireguard-go','sing-box':path.join(singBoxRoot,'sing-box')};
for(const [name,source] of Object.entries(sources)){
 const actual=await fs.realpath(source);
 if(name!=='wg-quick'){
  const dependencies=execFileSync('/usr/bin/otool',['-L',actual],{encoding:'utf8'}).split('\n').slice(1).map(line=>line.trim().split(' ')[0]).filter(Boolean);
  if(dependencies.some(file=>!file.startsWith('/usr/lib/')&&!file.startsWith('/System/Library/')))throw Error(`${name} has non-system libraries; bundle those before distribution`);
 }
 await fs.copyFile(actual,path.join(base,'bin',name));await fs.chmod(path.join(base,'bin',name),0o755);
}
for(const name of ['server.cjs','core.cjs','smart-dns.cjs','dns-wire.cjs','app-tunnels.cjs'])await fs.copyFile('helper/'+name,path.join(base,name));
await fs.copyFile('electron/app-tunneling.cjs',path.join(base,'app-tunneling.cjs'));
await fs.copyFile('electron/config.cjs',path.join(base,'config.cjs'));
// electron-builder excludes nested node_modules from extraResources. Keep this
// standalone daemon dependency in an explicit vendor directory instead.
await fs.writeFile(path.join(base,'smart-tunneling.cjs'),(await fs.readFile('electron/smart-tunneling.cjs','utf8')).replace('require("ipaddr.js")','require("./vendor/ipaddr.js")'));
await fs.rm(path.join(base,'node_modules'),{recursive:true,force:true});
await fs.cp('node_modules/ipaddr.js',path.join(base,'vendor/ipaddr.js'),{recursive:true});
const licenses={Node:path.resolve(path.dirname(node),'../LICENSE'),WireGuardTools:prefix+'/opt/wireguard-tools/COPYING',WireGuardGo:prefix+'/opt/wireguard-go/LICENSE'};
for(const [name,file] of Object.entries(licenses))await fs.copyFile(file,path.join(base,'licenses',name+'.txt'));
await fs.writeFile(path.join(base,'licenses/SOURCES.txt'),'Node.js: https://nodejs.org/\nWireGuard tools: https://git.zx2c4.com/wireguard-tools/\nWireGuard Go: https://git.zx2c4.com/wireguard-go/\n');
console.log('Standalone WireGuard helper prepared with root-owned runtime and backend binaries.');

await fs.copyFile(path.join(singBoxRoot,'LICENSE'),path.join(base,'licenses/SingBox.txt'));
await fs.appendFile(path.join(base,'licenses/SOURCES.txt'),'sing-box 1.14.0: https://github.com/SagerNet/sing-box/tree/v1.14.0 (GPL-3.0-or-later)\n');
