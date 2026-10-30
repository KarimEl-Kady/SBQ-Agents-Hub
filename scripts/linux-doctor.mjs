import { existsSync, statSync } from 'node:fs';
import {resolve} from 'node:path';
if(process.platform!=='linux'){
 console.log('SBQ Linux doctor is only needed on Linux.');
 process.exit(0);
}
const helper=resolve('node_modules/electron/dist/chrome-sandbox');
if(!existsSync(helper)){
 console.log('Electron is not installed in this folder. Run npm install first.');
 process.exit(1);
}
const s=statSync(helper);const rootOwned=s.uid===0;const setuid=Boolean(s.mode&0o4000);
console.log('SBQ Linux sandbox helper:',helper);
console.log('Owned by root:',rootOwned?'yes':'no');
console.log('setuid bit:',setuid?'yes':'no');
if(!rootOwned||!setuid){
 console.log('\nTo enable the SUID helper, first review the file and your system policy, then run:\n');
 console.log('sudo chown root:root node_modules/electron/dist/chrome-sandbox');
 console.log('sudo chmod 4755 node_modules/electron/dist/chrome-sandbox');
 console.log('\nDo not run the whole application as root. Do not routinely disable Chromium sandboxing.');
 process.exitCode=1;
}else console.log('SUID helper permissions look correct. Try npm run desktop.');
