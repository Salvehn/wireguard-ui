const {parseConfig}=require('./config.cjs');
const crypto=require('node:crypto');
const revision=text=>crypto.createHash('sha256').update(text).digest('hex');
function maskConfig(text){let index=0;return text.replace(/^(\s*(?:PrivateKey|PresharedKey)\s*=\s*)([^\r\n#]+)(.*)$/gm,(_,prefix,value,suffix)=>prefix+`<UNCHANGED_KEY_${index++}>`+suffix)}
function restoreConfig(draft,original){
 const secrets=[...original.matchAll(/^\s*(?:PrivateKey|PresharedKey)\s*=\s*([^\r\n#]+)/gm)].map(m=>m[1].trim());
 const text=draft.replace(/<UNCHANGED_KEY_(\d+)>/g,(_,i)=>{if(!secrets[Number(i)])throw Error('Неизвестный маркер ключа');return secrets[Number(i)]});
 parseConfig(text);return text;
}
module.exports={maskConfig,restoreConfig,revision};
