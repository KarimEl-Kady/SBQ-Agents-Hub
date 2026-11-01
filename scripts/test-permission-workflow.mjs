import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { analyzeCliResult, suggestedToolPermission, makeCommand } from '../packages/engine/server.mjs';
const tmp=mkdtempSync(join(tmpdir(),'sbq-approval-')),bin=join(tmp,'bin'),cwd=join(tmp,'project');mkdirSync(bin);mkdirSync(cwd);
assert.equal(suggestedToolPermission({tool:'Bash',command:'php artisan test',path:''},cwd),'Bash(php artisan test)');
assert.equal(suggestedToolPermission({tool:'Bash',command:'rm -rf .',path:''},cwd),null);
assert.equal(suggestedToolPermission({tool:'Bash',command:'php artisan test && rm -rf .',path:''},cwd),null);
assert.equal(suggestedToolPermission({tool:'Read',command:'',path:'/etc/shadow'},cwd),null);
assert.equal(suggestedToolPermission({tool:'Read',command:'',path:join(cwd,'.env')},cwd),null);
assert.equal(suggestedToolPermission({tool:'Read',command:'',path:join(cwd,'src/thing.js')},cwd),`Read(//${join(cwd,'src/thing.js').slice(1)})`);
assert.ok(makeCommand({agent:'claude',role:'implement',modelMode:'default',effort:'default'},'test',{allowedTools:['Bash(php artisan test)'],resumeSessionId:'abcdefgh'})[1].includes('--resume'));
writeFileSync(join(cwd,'README.md'),'# project\n');
const fakeClaude=join(bin,'claude');
writeFileSync(fakeClaude,`#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('claude mock 1');process.exit(0)}
if(args[0]==='auth'){console.log('connected');process.exit(0)}
const prompt=args[args.indexOf('-p')+1]||'';
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({args,stage:prompt.match(/ROLE: (\\w+)/)?.[1]||'?'})+'\\n');
const stage=prompt.match(/ROLE: (\\w+)/)?.[1];
if(stage==='plan'){console.log(JSON.stringify({type:'result',is_error:false,result:'Plan accepted.\\nSBQ_STAGE_STATUS: COMPLETE',session_id:'planning123',total_cost_usd:0.04}));process.exit(0)}
if(stage==='implement'){
 if(!args.includes('--resume')){
  fs.writeFileSync('partial.js','export const partial=true;\\n');
  console.log(JSON.stringify({type:'result',is_error:false,result:'Need to run tests. SBQ_STAGE_STATUS: PARTIAL',session_id:'sessionabcd',total_cost_usd:0.12,permission_denials:[{tool_name:'Bash',tool_input:{command:'php artisan test'}},{tool_name:'Read',tool_input:{file_path:'/home/user/.claude/plans/private.md'}}]}));process.exit(0);
 }
 if(!args.includes('Bash(php artisan test)')){console.log(JSON.stringify({type:'result',is_error:true,result:'Not allowed to run tests'}));process.exit(1)}
 fs.writeFileSync('tests.js','export const testsPassed=true;\\n');
 console.log(JSON.stringify({type:'result',is_error:false,result:'Implementation and test ready.\\nSBQ_STAGE_STATUS: COMPLETE',session_id:'sessionabcd',total_cost_usd:0.06}));process.exit(0);
}
if(stage==='review'){console.log(JSON.stringify({type:'result',is_error:false,result:'All requirements verified.\\nSBQ_REVIEW_VERDICT: PASS',session_id:'reviewabcd'}));process.exit(0)}
process.exit(2);`);
chmodSync(fakeClaude,0o755);
const child=spawn(process.execPath,[resolve('packages/engine/server.mjs')],{env:{...process.env,HOME:tmp,PATH:bin+':'+process.env.PATH,MOCK_LOG:join(tmp,'calls.log')},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',b=>process.stderr.write(b));
const sleep=t=>new Promise(r=>setTimeout(r,t));
try{
 let daemon;for(let i=0;i<100;i++){await sleep(60);try{daemon=JSON.parse(readFileSync(join(tmp,'.sbq-agents-hub','daemon.json')));break}catch{}}
 assert.ok(daemon,'engine starts');
 const api=async(method,path,body)=>{const res=await fetch(`http://127.0.0.1:${daemon.port}${path}`,{method,headers:{Authorization:`Bearer ${daemon.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const wait=async id=>{for(let i=0;i<120;i++){await sleep(60);const {body}=await api('GET',`/api/runs/${id}`);if(!['queued','running'].includes(body.run.status))return body.run;}throw Error('run stuck')};
 const stages=[{id:'plan',role:'plan',name:'Planning',agent:'claude',modelMode:'default',effort:'default',instructions:'Plan it'},
 {id:'build',role:'implement',name:'Build',agent:'claude',modelMode:'default',effort:'default',requireChanges:true,instructions:'Implement and test'},
 {id:'review',role:'review',name:'Review',agent:'claude',modelMode:'default',effort:'default',instructions:'Review code',reviewLoop:true,returnTo:'build',maxRetries:2}];
 assert.equal((await api('PUT','/api/workflow',{stages})).status,200);
 const starter=await api('POST','/api/runs',{task:'Implement a feature',cwd});assert.equal(starter.status,202,JSON.stringify(starter.body));
 let run=await wait(starter.body.run.id);
 assert.equal(run.status,'needs-approval',JSON.stringify(run.events));
 assert.equal((await api('POST','/api/runs',{task:'Unsafe concurrent run',cwd})).status,409,'paused project must remain locked');
 assert.equal(run.stageResults.length,2,'review never invoked before approval');
 assert.equal(run.pendingApproval.partialChangedCount,1,'partial code retained');
 assert.ok(existsSync(join(cwd,'partial.js')));
 assert.equal(run.pendingApproval.requests[0].rule,'Bash(php artisan test)');
 assert.equal(run.pendingApproval.requests[1].rule,null,'external plan file cannot be auto-granted');
 assert.equal(run.pendingApproval.canResumeSession,true);
 assert.equal((await api('POST',`/api/runs/${run.id}/approve`,{approvedRules:['Bash'],guidance:''})).status,400,'unscoped rule rejected');
 assert.equal((await api('POST',`/api/runs/${run.id}/approve`,{approvedRules:['Bash(php artisan test)'],guidance:'Skip the external private plan file.'})).status,202);
 run=await wait(run.id);
 assert.equal(run.status,'completed',JSON.stringify(run.events));
 assert.ok(existsSync(join(cwd,'partial.js'))&&existsSync(join(cwd,'tests.js')),'partial and completed source preserved');
 assert.equal(run.stageResults.length,4,'one plan + first build + resumed build + review');
 assert.ok(run.events.some(e=>e.type==='usage'&&e.text.includes('CLI-reported cost')));
 const calls=readFileSync(join(tmp,'calls.log'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(x=>x.stage==='plan').length,1,'no repeated planning cost');
 assert.equal(calls.filter(x=>x.stage==='review').length,1);
 assert.ok(calls.some(x=>x.stage==='implement'&&x.args.includes('--resume')&&x.args.includes('Bash(php artisan test)')));
 console.log('PASS: structured permissions, safe exact grants, external-read blocked, partial files, resume same Claude session, verified review, no repeated planning');
}finally{child.kill('SIGTERM');rmSync(tmp,{recursive:true,force:true})}
