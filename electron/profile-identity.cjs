const crypto=require('node:crypto');
const normalizeName=name=>name.normalize('NFC').trim().toLocaleLowerCase('en-US');
function configFingerprint(text){
 const canonical=text.split(/\r?\n/).map(line=>line.replace(/#.*/,'').trim()).filter(Boolean).map(line=>line.replace(/\s*=\s*/,'=')).join('\n');
 return crypto.createHash('sha256').update(canonical).digest('hex');
}
function assertUniqueProfile(name,config,existing){
 if(existing.some(p=>normalizeName(p.name)===normalizeName(name)))throw Error(`Профиль «${name}» уже существует. Откройте его редактор для изменения конфигурации.`);
 const fingerprint=configFingerprint(config);const same=existing.find(p=>configFingerprint(p.config)===fingerprint);
 if(same)throw Error(`Этот конфиг уже импортирован как «${same.name}».`);
}
module.exports={normalizeName,configFingerprint,assertUniqueProfile};
