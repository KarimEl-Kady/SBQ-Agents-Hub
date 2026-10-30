/** SBQ Agents Hub source checkout diagnostic; never reads auth secrets. */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,platform} from 'node:os';
console.log('\nSBQ Agents Hub — first-run setup\n');
console.log('Platform:',platform(), '| Node:',process.version);
console.log('Local project config:',join(homedir(),'.sbq-agents-hub'));
console.log('\nInstalled agent CLIs (not an account/auth check):');
const agents=[['Claude Code','claude'],['Codex','codex'],['Antigravity','agy'],['OpenCode','opencode'],['Gemini CLI','gemini'],['Kilo Code','kilo'],['Freebuff (interactive only)','freebuff']];
for(const [name,cmd] of agents){try{const test=spawnSync(cmd,['--version'],{encoding:'utf8',timeout:3000,windowsHide:true});console.log((test.status===0?'  ✓ ':'  · ')+name+(test.status===0?' found':' not detected'));}catch{console.log('  · '+name+' not detected');}}
const sandbox=resolve('node_modules/electron/dist/chrome-sandbox');
if(platform()==='linux'&&existsSync(sandbox))console.log('\nLinux source setup: run npm run doctor:linux if Electron shows a sandbox error.');
console.log('\nNext:');
console.log('  Source development: npm run desktop');
console.log('  VS Code extension: npm run engine (then run extension in VS Code)');
console.log('  Native installers: see GitHub Actions release workflow in README');
console.log('  In the app: Connections → check existing sign-ins; Workflows → choose models.');
console.log('\nNote: Freebuff is interactive-only and cannot execute SBQ workflow stages.\n');
