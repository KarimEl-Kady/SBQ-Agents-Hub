// Regression: Claude's text can discuss denied operations without implying an
// actual CLI denial. A successful plan requiring decisions pauses safely and
// resumes without paying for planning twice. Only structured denials block it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeCliResult, planningQuestions } from '../packages/engine/server.mjs';
const sample='This specification discusses cases where approvals are denied. **Questions for you:** Please confirm or correct them: 1. Which orders? 2. When does a use count? 3. Rounding?';
assert.equal(analyzeCliResult({output:JSON.stringify({type:'result',is_error:false,result:sample}),stderr:'',exitCode:0}).fatal,null);
assert.equal(analyzeCliResult({output:JSON.stringify({type:'result',is_error:false,result:sample}),stderr:'',exitCode:0}).denials.length,0);
assert.match(planningQuestions(sample),/Which orders/);
assert.equal(planningQuestions('The plan is complete. Permission denied is handled in tests.'),null);
assert.deepEqual(analyzeCliResult({output:JSON.stringify({type:'result',is_error:false,result:'plan',permission_denials:[{tool_name:'Bash'}]}),exitCode:0}).denials,['Bash']);
assert.ok(analyzeCliResult({output:JSON.stringify({type:'result',is_error:true,result:'provider request failed'}),exitCode:0}).fatal);
const tmp=mkdtempSync(join(tmpdir(),'sbq-claude-plan-'));
const bin=join(tmp,'bin'),cwd=join(tmp,'project');mkdirSync(bin);mkdirSync(cwd);
writeFileSync(join(cwd,'README.md'),'# Test repository\n');
const fakeClaude=join(bin,'claude');
writeFileSync(fakeClaude,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('claude mock 1');process.exit(0)}
if(args[0]==='auth'){console.log('Connected');process.exit(0)}
fs.appendFileSync(process.env.SBQ_FAKE_COUNT,'call\\n');
const plan='The plan handles approval denied as a documented error case.\\n**Questions for you:** Please confirm or correct them:\\n1. Scope: all or category?\\n2. Usage: create or paid?\\n3. Rounding: half-up?';
const denied=fs.existsSync('denied.flag');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:plan,permission_denials:denied?[{tool_name:'Bash'}]:[]}));
`);
chmodSync(fakeClaude,0o755);
const fakeCodex=join(bin,'codex');
writeFileSync(fakeCodex,`#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('mock');process.exit(0)}
if(args[0]==='login'){console.log('Logged in');process.exit(0)}
if(args[0]==='sandbox'&&args[1]==='--'){process.exit(0)}
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 if(!prompt.includes('USER-CONFIRMED PLANNING DECISIONS')||!prompt.includes('half-up')){console.error('Answers missing');process.exit(1)}
 fs.writeFileSync('implemented.js','export const ok = true;\\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Code implemented. SBQ_STAGE_STATUS: COMPLETE'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));
});
`);
chmodSync(fakeCodex,0o755);
const child=spawn(process.execPath,[resolve('packages/engine/server.mjs')],{env:{...process.env,SBQ_FAKE_COUNT:join(tmp,'calls.txt'),PATH:bin+':'+process.env.PATH,HOME:tmp},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
const sleep=t=>new Promise(r=>setTimeout(r,t));
try{
 let daemon;for(let i=0;i<100;i++){await sleep(80);try{daemon=JSON.parse(readFileSync(join(tmp,'.sbq-agents-hub','daemon.json')));break}catch{}}
 assert.ok(daemon,'Server started');
 const api=async(method,path,body)=>{const result=await fetch(`http://127.0.0.1:${daemon.port}${path}`,{method,headers:{Authorization:'Bearer '+daemon.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:result.status,data:await result.json()}};
 const awaitRun=async id=>{for(let i=0;i<100;i++){await sleep(90);const r=(await api('GET',`/api/runs/${id}`)).data.run;if(!['queued','running'].includes(r.status))return r}throw Error('Timeout');};
 const stages=[{id:'plan',role:'plan',name:'Planning',agent:'claude',modelMode:'default',effort:'default',instructions:'Write plan'},{id:'build',role:'implement',name:'Build',agent:'codex',modelMode:'default',effort:'default',instructions:'Write files',requireChanges:true}];
 assert.equal((await api('PUT','/api/workflow',{stages})).status,200);
 let started=await api('POST','/api/runs',{task:'Implement coupon rules',cwd});assert.equal(started.status,202);
 let run=await awaitRun(started.data.run.id);
 assert.equal(run.status,'needs-input',JSON.stringify(run.events));
 assert.equal(run.stageResults.length,1,'No Codex call before unanswered decisions');
 assert.ok(run.pendingInput?.questions.includes('Rounding'));
 assert.equal(readFileSync(join(tmp,'calls.txt'),'utf8').trim().split('\n').length,1);
 const answer='Scope: category; Usage: count on creation; Rounding: half-up';
 assert.equal((await api('POST',`/api/runs/${run.id}/continue`,{answer})).status,202);
 run=await awaitRun(run.id);
 assert.equal(run.status,'completed',JSON.stringify(run.events));
 assert.ok(existsSync(join(cwd,'implemented.js')));
 assert.equal(readFileSync(join(tmp,'calls.txt'),'utf8').trim().split('\n').length,1,'Claude planning not repeated');
 writeFileSync(join(cwd,'denied.flag'),'1');
 started=await api('POST','/api/runs',{task:'Plan with actual tool denial',cwd});run=await awaitRun(started.data.run.id);
 assert.equal(run.status,'needs-approval');
 assert.equal(run.stageResults.length,1,'Explicit denial blocks implementation');
 assert.ok(run.events.some(e=>e.type==='approval'&&e.text.includes('permission request')));
 console.log('PASS: no prose false positives; safe needs-input; user answers resume; no duplicate planning cost; true denials block');
}finally{child.kill('SIGTERM');rmSync(tmp,{recursive:true,force:true})}
