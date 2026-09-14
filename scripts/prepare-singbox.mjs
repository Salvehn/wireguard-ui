import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
export async function prepareSingBox() {
  const arch = {arm64:'arm64',x64:'amd64'}[process.arch];
  if(process.platform !== 'darwin' || !arch) throw Error('sing-box packaging requires macOS arm64 or x64');
  const version = '1.14.0';
  const hash = {arm64:'a150c94012ff768b7261939cd236b9c8554127f45137230295d23a5660225cc9',amd64:'6cf26fc3501f3117cf781e9405cf5338f60add6da5affae39421af6800ebbcb4'}[arch];
  const root = path.resolve('build/sing-box');
  const name = `sing-box-${version}-darwin-${arch}`;
  const archive = path.join(root,name+'.tar.gz');
  await fs.mkdir(root,{recursive:true});
  let bytes = await fs.readFile(archive).catch(()=>null);
  if(!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== hash) {
    console.log(`Downloading official sing-box ${version} (${arch})…`);
    const response = await fetch(`https://github.com/SagerNet/sing-box/releases/download/v${version}/${name}.tar.gz`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('Could not download sing-box: '+response.status);
    bytes=Buffer.from(await response.arrayBuffer());
    if(crypto.createHash('sha256').update(bytes).digest('hex') !== hash)throw Error('sing-box checksum mismatch');
    await fs.writeFile(archive,bytes,{mode:0o600});
  }
  execFileSync('/usr/bin/tar',['-xzf',archive,'-C',root]);
  return path.join(root,name);
}
