// Regression tests: ensure bwrap failures short-circuit paid agents, while a
// successful sandbox allows actual changes and explicit BLOCKED is respected.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {codexSandboxError} from '../packages/engine/server.mjs';
assert.equal(codexSandboxError('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'),true);
assert.equal(codexSandboxError('Acceptance criteria mentioning bwrap in documentation'),false);
const root=resolve('.'),temp=mkdtempSync(join(tmpdir(),'sbq-codex-sandbox-'));
const repo=join(temp,'project'),bin=join(temp,'bin');mkdirSync(repo);mkdirSync(bin);
writeFileSync(join(repo,'README.md'),'# sandbox regression\n');
const fake=join(bin,'codex');
writeFileSync(fake,`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
const flag=path.join(process.env.TEST_SANDBOX_ROOT,'mode');
const mode=fs.readFileSync(flag,'utf8').trim();
if(a[0]==='--version'){console.log('codex mock 1.0');process.exit(0);}
if(a[0]==='login'&&a[1]==='status'){console.log('Logged in');process.exit(0);}
if(a[0]==='sandbox'&&a[1]==='--'){
 if(mode==='sandbox-broken'){
  console.error('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted');process.exit(1);
 }
 process.exit(0);
}
if(a[0]==='exec'){
 fs.appendFileSync(path.join(process.env.TEST_SANDBOX_ROOT,'model-calls'),'1');
 if(mode==='blocked-exit-zero'){
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Blocked: bwrap problem. SBQ_STAGE_STATUS: BLOCKED'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  process.exit(0);
 }
 if(mode==='structured-bwrap'){
  console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code:1,aggregated_output:'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  process.exit(0);
 }
 fs.writeFileSync(path.join(process.cwd(),'feature.js'),'export const ready = true;\\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Complete. SBQ_STAGE_STATUS: COMPLETE'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
 process.exit(0);
}
console.error('unsupported fake command',JSON.stringify(a));process.exit(2);
`);chmodSync(fake,0o755);
const fakeArchitect=join(bin,'claude');
writeFileSync(fakeArchitect,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);
if(a[0]==='--version'||a[0]==='auth'){console.log('Logged in');process.exit(0);}
fs.appendFileSync(path.join(process.env.TEST_SANDBOX_ROOT,'architect-calls'),'1');
console.log(JSON.stringify({type:'result',result:'Planning complete.'}));
`);chmodSync(fakeArchitect,0o755);
writeFileSync(join(temp,'architect-calls'),'');
const mode=join(temp,'mode'),calls=join(temp,'model-calls');writeFileSync(mode,'sandbox-broken');writeFileSync(calls,'');
const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,HOME:temp,TEST_SANDBOX_ROOT:temp},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let daemon;for(let i=0;i<80;i++){await sleep(80);try{daemon=JSON.parse(readFileSync(join(temp,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
 assert.ok(daemon,'engine started');
 const api=async(method,p,body)=>{const response=await fetch(`http://127.0.0.1:${daemon.port}${p}`,{method,headers:{authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
 const stage={id:'build',name:'Implementation',role:'implement',agent:'codex',modelMode:'default',effort:'default',requireChanges:true,instructions:'Create feature.js'};
 assert.equal((await api('PUT','/api/workflow',{stages:[stage]})).status,200);
 const done=async()=>{const started=await api('POST','/api/runs',{task:'Implement a feature',cwd:repo});assert.equal(started.status,202,JSON.stringify(started.data));for(let i=0;i<100;i++){await sleep(70);const r=(await api('GET',`/api/runs/${started.data.run.id}`)).data.run;if(!['queued','running'].includes(r.status))return r;}throw new Error('run timed out');};
 if(process.platform==='linux'){
  let diag=await api('GET','/api/diagnostics?agent=codex');assert.equal(diag.data.sandbox.status,'blocked');
  const refusal=await api('POST','/api/runs',{task:'Implement a feature',cwd:repo});assert.equal(refusal.status,409,'workflow-wide preflight must block BEFORE planning');assert.match(refusal.data.error,/Codex sandbox blocked/);assert.equal(readFileSync(calls,'utf8').length,0,'must not send model request on preflight failure');
  const paidPlan={id:'plan',name:'Expensive Architect Planning',role:'plan',agent:'claude',modelMode:'default',instructions:'Plan feature'};
  assert.equal((await api('PUT','/api/workflow',{stages:[paidPlan,stage]})).status,200);
  const early=await api('POST','/api/runs',{task:'Plan then implement',cwd:repo});
  assert.equal(early.status,409,'later Codex sandbox failure must prevent earlier paid planning');
  assert.equal(readFileSync(join(temp,'architect-calls'),'utf8').length,0,'the architect must not be invoked when downstream tooling is blocked');
  assert.equal((await api('PUT','/api/workflow',{stages:[stage]})).status,200);
 }
 writeFileSync(mode,'blocked-exit-zero');
 let run=await done();assert.equal(run.status,'needs-attention');assert.equal(run.stageResults[0].status,'blocked',JSON.stringify(run.events));assert.ok(!existsSync(join(repo,'feature.js')));
 writeFileSync(mode,'structured-bwrap');run=await done();assert.equal(run.status,'needs-attention');assert.equal(run.stageResults[0].status,'blocked',JSON.stringify(run.events));
 writeFileSync(mode,'success');run=await done();assert.equal(run.status,'completed',JSON.stringify(run.events));assert.ok(existsSync(join(repo,'feature.js')));
 console.log('PASS: preflight protects model quota; model BLOCKED status; structured sandbox error; successful file modifications');
}finally{child.kill('SIGTERM');rmSync(temp,{recursive:true,force:true});}
