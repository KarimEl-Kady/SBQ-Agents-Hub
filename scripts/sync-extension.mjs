import {copyFileSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
const source=resolve('packages/ui'),dest=resolve('apps/vscode/media');
mkdirSync(`${dest}/assets`,{recursive:true});
for(const name of ['index.html','app.css','app.js'])copyFileSync(`${source}/${name}`,`${dest}/${name}`);
for(const name of ['sbq-logo.svg','sbq-symbol.svg'])copyFileSync(`${source}/assets/${name}`,`${dest}/assets/${name}`);
// Bundle the engine so the extension can start it when the desktop app is closed.
const engineDest=resolve('apps/vscode/engine');mkdirSync(engineDest,{recursive:true});
for(const name of readdirSync(resolve('packages/engine')).filter(n=>n.endsWith('.mjs')))copyFileSync(resolve('packages/engine',name),`${engineDest}/${name}`);
// Keep the extension's version equal to the app/engine version.
const extPkgPath=resolve('apps/vscode/package.json'),extPkg=JSON.parse(readFileSync(extPkgPath,'utf8'));
const version=JSON.parse(readFileSync(resolve('package.json'),'utf8')).version;
if(extPkg.version!==version){extPkg.version=version;writeFileSync(extPkgPath,JSON.stringify(extPkg,null,2)+'\n');}
console.log('Synced SBQ dashboard resources and engine to VS Code extension.');
