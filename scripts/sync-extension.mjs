import {copyFileSync,mkdirSync} from 'node:fs';import {resolve} from 'node:path';
const source=resolve('packages/ui'),dest=resolve('apps/vscode/media');
mkdirSync(`${dest}/assets`,{recursive:true});
for(const name of ['index.html','app.css','app.js'])copyFileSync(`${source}/${name}`,`${dest}/${name}`);
for(const name of ['sbq-logo.svg','sbq-symbol.svg'])copyFileSync(`${source}/assets/${name}`,`${dest}/assets/${name}`);
console.log('Synced SBQ dashboard resources to VS Code extension.');
