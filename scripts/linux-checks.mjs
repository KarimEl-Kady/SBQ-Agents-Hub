// Read-only Linux host checks shared by `npm run doctor:linux`, the postinstall
// hint and `npm run desktop`. Never runs sudo; only prints the exact commands.
import {existsSync,statSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const PROFILE_SOURCE='/usr/share/apparmor/extra-profiles/bwrap-userns-restrict';
const PROFILE_TARGET='/etc/apparmor.d/bwrap-userns-restrict';
function has(cmd){return spawnSync('sh',['-c',`command -v ${cmd}`],{stdio:'ignore'}).status===0;}
// 1 on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile.
export function usernsRestricted(){
 try{return readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8').trim()==='1';}catch{return false;}
}
// Electron needs either unrestricted user namespaces or a root-owned setuid helper.
export function electronSandbox(root=process.cwd()){
 const helper=resolve(root,'node_modules/electron/dist/chrome-sandbox');
 if(!existsSync(helper))return{status:'missing',title:'Electron is not installed',fix:['npm install']};
 const s=statSync(helper),ok=s.uid===0&&Boolean(s.mode&0o4000);
 if(ok||!usernsRestricted())return{status:'ready',title:'Electron sandbox ready'};
 return{status:'blocked',title:'Electron sandbox helper is not set up (Ubuntu 24.04+ blocks the app from starting)',
  fix:[`sudo chown root:root ${helper}`,`sudo chmod 4755 ${helper}`]};
}
// Codex runs commands inside bubblewrap. On Ubuntu 24.04+ bwrap needs the
// AppArmor profile shipped (but not enabled) by the apparmor package.
export function codexSandbox(){
 if(!has('codex'))return{status:'not-installed',title:'Codex CLI not installed (skip if you do not use Codex)'};
 const r=spawnSync('codex',['sandbox','--','/bin/true'],{encoding:'utf8',timeout:8000});
 if(r.status===0)return{status:'ready',title:'Codex sandbox self-test passed'};
 const fix=[];
 if(!has('bwrap'))fix.push('sudo apt install bubblewrap');
 if(usernsRestricted()&&!existsSync(PROFILE_TARGET)){
  if(existsSync(PROFILE_SOURCE))fix.push(`sudo cp ${PROFILE_SOURCE} ${PROFILE_TARGET}`,`sudo apparmor_parser -r ${PROFILE_TARGET}`);
  else fix.push('sudo apt install apparmor-profiles  # then rerun npm run doctor:linux');
 }
 return{status:'blocked',title:'Codex sandbox cannot start, so every Codex stage would fail',fix,raw:String(r.stderr||r.stdout||'').trim().slice(-400)};
}
export function nodeVersion(){
 const major=Number(process.versions.node.split('.')[0]);
 return major>=20?{status:'ready',title:`Node.js ${process.version}`}:{status:'blocked',title:`Node.js ${process.version} is too old (20 or newer needed, 22 LTS recommended)`,fix:['Install Node.js 22 LTS (for example with nvm: nvm install 22)']};
}
export function printCheck(c){
 const icon=c.status==='ready'?'✓':c.status==='blocked'||c.status==='missing'?'✗':'·';
 console.log(`${icon} ${c.title}`);
 if(c.raw)console.log('    '+c.raw.split('\n').slice(-3).join('\n    '));
 if(c.fix?.length){console.log('  Fix (review first, then run in a terminal):');for(const f of c.fix)console.log('    '+f);}
}
