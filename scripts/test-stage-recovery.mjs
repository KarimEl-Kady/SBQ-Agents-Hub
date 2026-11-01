import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { environmentBlocker } from '../packages/engine/server.mjs';

assert.equal(environmentBlocker('Docker daemon access needs to be available to this environment')?.code,'DOCKER_UNAVAILABLE');
assert.equal(environmentBlocker('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted')?.code,'CODEX_SANDBOX_BLOCKED');
assert.equal(environmentBlocker('The offline cache lacks required packages and npm install did not complete')?.code,'DEPENDENCIES_UNAVAILABLE');
assert.equal(environmentBlocker('Tests passed'),null);
const root=resolve('.'),tmp=mkdtempSync(join(tmpdir(),'sbq-recovery-')),repo=join(tmp,'repo'),bin=join(tmp,'bin');
mkdirSync(repo);mkdirSync(bin);writeFileSync(join(repo,'README.md'),'# Recovery test\n');
const mock=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),agent=path.basename(process.argv[1]),args=process.argv.slice(2);
const state=path.join(process.env.SBQ_RECOVERY_TMP,'state.json'),s=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')):{plan:0,codex:0,review:0};
const persist=()=>fs.writeFileSync(state,JSON.stringify(s));
if(args[0]==='--version'||(agent==='claude'&&args[0]==='auth')||(agent==='codex'&&args[0]==='login')){console.log('ok');process.exit(0);}
if(agent==='codex'&&args[0]==='sandbox'){process.exit(args[1]==='--'?0:2);}
const output=(text)=>{if(agent==='claude')console.log(JSON.stringify({type:'result',result:text}));else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));};
if(agent==='claude'){
 const prompt=args.join(' ');
 if(prompt.includes('ROLE: plan')){s.plan++;persist();output('Implement CRM and add tests. AC-1: project file. AC-2: test file.');}
 else {s.review++;persist();output('AC-1 and AC-2 verified.\\nSBQ_REVIEW_VERDICT: PASS');}
}else if(agent==='codex'){
 process.stdin.resume();process.stdin.on('end',()=>{
  s.codex++;persist();
  if(s.codex===1){fs.writeFileSync(path.join(process.cwd(),'feature.js'),'export const feature = true;\\n');output('Docker daemon access needs to be available. Tests missing.\\nSBQ_STAGE_STATUS: BLOCKED');}
  else {fs.writeFileSync(path.join(process.cwd(),'feature.test.js'),'export const tested = true;\\n');output('Feature and tests finished.\\nSBQ_STAGE_STATUS: COMPLETE');}
 });
}else process.exit(2);
`;
for(const name of ['claude','codex']){const file=join(bin,name);writeFileSync(file,mock);chmodSync(file,0o755);}
const dockerMock=join(bin,'docker');writeFileSync(dockerMock,`#!/usr/bin/env node\nconst fs=require('node:fs');process.exit(fs.existsSync(process.env.SBQ_RECOVERY_TMP+'/docker-ready')?0:1);\n`);chmodSync(dockerMock,0o755);
const server=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{cwd:root,env:{...process.env,HOME:tmp,PATH:bin+':'+process.env.PATH,SBQ_RECOVERY_TMP:tmp},stdio:['ignore','pipe','pipe']});
server.stderr.on('data',v=>process.stderr.write(v));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
try{
 let daemon;for(let i=0;i<100;i++){await sleep(70);try{daemon=JSON.parse(readFileSync(join(tmp,'.sbq-agents-hub','daemon.json'),'utf8'));break}catch{}}
 assert.ok(daemon,'engine starts');
 const api=async(method,p,body)=>{const r=await fetch(`http://127.0.0.1:${daemon.port}${p}`,{method,headers:{authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{code:r.status,body:await r.json()}};
 const stages=[
  {id:'plan',name:'Planning',role:'plan',agent:'claude',modelMode:'default',instructions:'Plan project'},
  {id:'build',name:'Implementation',role:'implement',agent:'codex',modelMode:'default',requireChanges:true,instructions:'Build project and tests'},
  {id:'review',name:'Review',role:'review',agent:'claude',modelMode:'default',reviewLoop:true,returnTo:'build',maxRetries:1,instructions:'Review it'}];
 assert.equal((await api('PUT','/api/workflow',{stages})).code,200);
 const readiness=await api('GET','/api/preflight?cwd='+encodeURIComponent(repo));assert.equal(readiness.code,200);assert.equal(readiness.body.checks.length,3);assert.equal(readiness.body.checks.find(x=>x.agent==='project-dependencies').status,'not-applicable');
 const start=await api('POST','/api/runs',{cwd:repo,task:'Build CRM with tests'});assert.equal(start.code,202,JSON.stringify(start.body));
 const poll=async()=>{for(let i=0;i<100;i++){await sleep(90);const r=(await api('GET',`/api/runs/${start.body.run.id}`)).body.run;if(!['queued','running'].includes(r.status))return r;}throw Error('run timeout')};
 let run=await poll();assert.equal(run.status,'needs-attention',JSON.stringify(run.events.slice(-5)));
 assert.equal(run.pendingRecovery.code,'DOCKER_UNAVAILABLE');assert.ok(existsSync(join(repo,'feature.js')));
 assert.equal(run.stageResults.at(-1).status,'blocked');
 const partial=await api('GET',`/api/runs/${run.id}/changes`);
 assert.equal(partial.code,200);assert.equal(partial.body.source,'local-snapshot');
 assert.equal(partial.body.files[0]?.path,'feature.js');
 assert.match(partial.body.diff,/\+export const feature = true;/);
 const noGit=await api('GET','/api/changes?cwd='+encodeURIComponent(repo));
 assert.equal(noGit.code,200);assert.equal(noGit.body.files[0]?.path,'feature.js');
 assert.equal((await api('POST',`/api/runs/${run.id}/retry-stage`,{guidance:'Continue'})).code,400);
 let counter=JSON.parse(readFileSync(join(tmp,'state.json'),'utf8'));assert.equal(counter.plan,1);assert.equal(counter.codex,1);
 const blockedRetry=await api('POST',`/api/runs/${run.id}/retry-stage`,{confirmNewModelCall:true,guidance:'Try again'});assert.equal(blockedRetry.code,409,'do not retry model while Docker is still blocked');
 writeFileSync(join(tmp,'docker-ready'),'1');
 const retry=await api('POST',`/api/runs/${run.id}/retry-stage`,{confirmNewModelCall:true,guidance:'Docker daemon is now available; finish tests and code'});
 assert.equal(retry.code,202,JSON.stringify(retry.body));
 run=await poll();assert.equal(run.status,'completed',JSON.stringify(run.events.slice(-6)));
 counter=JSON.parse(readFileSync(join(tmp,'state.json'),'utf8'));assert.deepEqual(counter,{plan:1,codex:2,review:1});
 assert.ok(existsSync(join(repo,'feature.test.js')));
 const localChanges=await api('GET',`/api/runs/${run.id}/changes`);
 assert.equal(localChanges.code,200);assert.equal(localChanges.body.files.length,2);
 assert.ok(localChanges.body.diff.includes('feature.test.js'));
 assert.equal((await api('GET',`/api/runs/${run.id}/changes?file=feature.test.js`)).body.files.length,1);
 const badFile=await api('GET',`/api/runs/${run.id}/changes?file=../../etc/passwd`);
 assert.equal(badFile.code,400);
 assert.ok(existsSync(join(repo,'feature.js')));
 assert.equal(run.stageResults.find(r=>r.id==='plan').status,'verified');
 assert.ok(run.stageResults.some(r=>r.id==='build'&&r.status==='blocked-previous-attempt'));
 assert.ok(run.stageResults.some(r=>r.id==='build'&&r.status==='verified'));
 console.log('PASS: Docker BLOCKED with partial files; no unauthorised retry; user-confirmed stage-only recovery; no re-planning; review completion');
}finally{server.kill('SIGTERM');rmSync(tmp,{recursive:true,force:true});}
