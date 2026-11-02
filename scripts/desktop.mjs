// `npm run desktop`: check the Linux Electron sandbox first so a fresh Ubuntu
// install gets the two fix commands instead of a crash dump.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {electronSandbox,printCheck} from './linux-checks.mjs';
if(process.platform==='linux'){
 const check=electronSandbox();
 if(check.status!=='ready'){printCheck(check);console.log('\nThen run npm run desktop again. Do not run SBQ as root or with --no-sandbox.');process.exit(1);}
}
const electron=createRequire(import.meta.url)('electron');
// VS Code (itself Electron) can leak ELECTRON_RUN_AS_NODE into terminals and
// tasks; with it set, Electron runs as plain Node and the app cannot start.
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['apps/desktop/main.cjs',...process.argv.slice(2)],{stdio:'inherit',env});
child.on('close',code=>process.exit(code??0));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
