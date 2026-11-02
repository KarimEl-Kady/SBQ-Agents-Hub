// Usage: npm run doctor:linux   (read-only; prints fixes, never runs sudo)
//        node scripts/linux-doctor.mjs --postinstall   (short hint, never fails npm install)
import {spawnSync} from 'node:child_process';
import {electronSandbox,codexSandbox,nodeVersion,printCheck} from './linux-checks.mjs';
const postinstall=process.argv.includes('--postinstall');
if(process.platform!=='linux'){if(!postinstall)console.log('SBQ Linux doctor is only needed on Linux.');process.exit(0);}
if(postinstall){
 // Skip when SBQ is installed as a dependency or in CI.
 if(process.env.CI)process.exit(0);
 const problems=[electronSandbox(),codexSandbox()].filter(c=>c.status==='blocked');
 if(problems.length){console.log('\nSBQ Agents Hub: host setup needed before first run.');for(const p of problems)printCheck(p);console.log('Run npm run doctor:linux for the full report.\n');}
 process.exit(0);
}
console.log('SBQ Agents Hub — Linux setup check (no model tokens, no sudo)\n');
const checks=[nodeVersion(),electronSandbox(),codexSandbox()];
for(const c of checks)printCheck(c);
console.log('\nAgent CLIs visible to SBQ:');
for(const [name,cmd,auth] of [['Claude Code','claude',['auth','status']],['Codex','codex',['login','status']],['Antigravity','agy',null],['OpenCode','opencode',['auth','list']]]){
 const v=spawnSync(cmd,['--version'],{encoding:'utf8',timeout:5000});
 if(v.status!==0){console.log(`· ${name}: not found`);continue;}
 const signedIn=auth?spawnSync(cmd,auth,{encoding:'utf8',timeout:8000}).status===0:null;
 console.log(`${signedIn===false?'✗':'✓'} ${name} ${String(v.stdout).trim().split('\n')[0]}${signedIn===false?' — not signed in, run: '+({claude:'claude auth login',codex:'codex login',opencode:'opencode auth login'})[cmd]:''}`);
}
if(checks.some(c=>c.status==='blocked'||c.status==='missing')){console.log('\nFix the ✗ items above, then run npm run desktop.');process.exitCode=1;}
else console.log('\nHost looks ready. Start with npm run desktop.');
