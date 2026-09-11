import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root=path.resolve('src');
const layers=['shared','entities','features','widgets','pages','app'];
const files=fs.readdirSync(root,{recursive:true}).filter(p=>/\.tsx?$/.test(p));
const errors=[];
for(const file of files){
 const source=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);
 const from=file.split(path.sep);const rank=layers.indexOf(from[0]);
 function check(node){
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){
     const spec=node.moduleSpecifier.text;
     if(!spec.startsWith('@/')&&!spec.startsWith('.'))return;
     const target=spec.startsWith('@/')?spec.slice(2):path.relative(root,path.resolve(root,path.dirname(file),spec));
     const to=target.split(path.sep);const targetRank=layers.indexOf(to[0]);
     if(rank<0||targetRank<0)return;
     const sameSlice=from[0]===to[0]&&(from[0]==='app'||from[0]==='shared'||from[1]===to[1]);
     if(!sameSlice&&targetRank>=rank)errors.push(`${file}: forbidden dependency ${spec}`);
     if(!sameSlice&&to[0]!=='shared'&&to[0]!=='app'&&to.length>2)errors.push(`${file}: use the slice public API for ${spec}`);
     if(!sameSlice&&to[0]==='shared'&&to.length>3)errors.push(`${file}: use the shared module public API for ${spec}`);
   }
   ts.forEachChild(node,check);
 }
 check(source);
}
if(errors.length){console.error(errors.join('\n'));process.exit(1)}
console.log(`FSD boundaries verified (${files.length} TypeScript files).`);
