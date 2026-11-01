// Regression test: an agent's exit=0 must NEVER mean code was changed.
// Runs completely offline with a fake executable, a real temporary Git repo,
// stage-local snapshots, and a bounded FIX -> edit -> PASS reviewer loop.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {makeCommand} from '../packages/engine/server.mjs';

const folder=mkdtempSync(join(tmpdir(),'sbq-verified-'));
const repo=join(folder,'repo'),bin=join(folder,'bin'),counters=join(folder,'counters');
mkdirSync(repo);mkdirSync(bin);mkdirSync(counters);
const cli=join(bin,'kilo');
writeFileSync(cli,`#!/bin/sh
if [ "$1" = "--version" ]; then echo 'kilo mock 1.0'; exit 0; fi
if [ "$1" = "profile" ]; then echo '{"email":"fake@example.com"}'; exit 0; fi
case "$*" in
  *"ROLE: review"*)
    n=$(cat "$COUNTER_PATH/review" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_PATH/review"
    if [ "$n" -eq 1 ]; then
      echo '{"type":"text","part":{"text":"Test missing. SBQ_REVIEW_VERDICT: FIX"}}'
    else
      echo '{"type":"text","part":{"text":"Acceptance criteria pass. SBQ_REVIEW_VERDICT: PASS"}}'
    fi ;;
  *"ROLE: implement"*)
    n=$(cat "$COUNTER_PATH/implement" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_PATH/implement"
    if [ "$NO_WRITE" != 1 ]; then printf 'export const feature = %s;\\n' "$n" > "$PWD/feature.js"; fi
    echo '{"type":"text","part":{"text":"Implementation done. SBQ_STAGE_STATUS: COMPLETE"}}' ;;
  *) echo '{"type":"text","part":{"text":"Plan completed without edits."}}' ;;
esac
`);chmodSync(cli,0o755);
const git=(...a)=>{const r=spawnSync('git',a,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
git('init');git('config','user.email','test@example.invalid');git('config','user.name','SBQ Tests');
writeFileSync(join(repo,'README.md'),'# Worktree\n');git('add','.');git('commit','-m','baseline');
const execStage={id:'implement',name:'Implement',role:'implement',agent:'kilo',modelMode:'default',effort:'default',requireChanges:true,instructions:'Write feature.js'};
const reviewStage={id:'review',name:'Verify changes',role:'review',agent:'kilo',modelMode:'default',effort:'default',reviewLoop:true,returnTo:'implement',maxRetries:2,instructions:'Review feature.js'};
const commandClaude=makeCommand({...execStage,agent:'claude'},'task');
assert.equal(commandClaude[1].includes('acceptEdits'),true,'Claude implementation must not run in plan mode');
const commandClaudeReview=makeCommand({...reviewStage,agent:'claude'},'task');
assert.ok(commandClaudeReview[1].includes('plan'));
const commandAgy=makeCommand({...execStage,agent:'agy'},'task');
assert.equal(commandAgy[1][commandAgy[1].indexOf('--mode')+1],'accept-edits');
const commandCodex=makeCommand({...execStage,agent:'codex'},'task',{cwd:repo,isGitRepo:true});
assert.ok(commandCodex[1].includes('workspace-write'));
const child=spawn(process.execPath,[resolve('packages/engine/server.mjs')],{cwd:resolve('.'),env:{...process.env,PATH:bin+':'+process.env.PATH,HOME:folder,COUNTER_PATH:counters},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let daemon;for(let i=0;i<75;i++){await sleep(100);try{daemon=JSON.parse(readFileSync(join(folder,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
 assert.ok(daemon,'local engine started');
 const api=async(method,path,body)=>{const result=await fetch(`http://127.0.0.1:${daemon.port}${path}`,{method,headers:{Authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:result.status,data:await result.json()};};
 const untilDone=async(id)=>{let run;for(let i=0;i<100;i++){await sleep(100);run=(await api('GET',`/api/runs/${id}`)).data.run;if(['completed','failed','canceled','needs-attention','needs-review'].includes(run.status))return run;}throw new Error('run did not terminate');};
 const saved=await api('PUT','/api/workflow',{stages:[execStage,reviewStage]});assert.equal(saved.status,200,JSON.stringify(saved));
 const invalid=await api('PUT','/api/workflow',{stages:[execStage,{...reviewStage,returnTo:'does-not-exist'}]});assert.equal(invalid.status,400,'invalid loop target rejected');
 // Zero file changes must block the whole workflow, including the paid reviewer.
 // The default fake Kilo responds with a success message but creates no files.
 const noWrite=readFileSync(cli,'utf8').replace('if [ "$NO_WRITE" != 1 ]; then','if [ 1 != 1 ]; then');
 writeFileSync(cli,noWrite);chmodSync(cli,0o755);
 let started=await api('POST','/api/runs',{task:'Implement a feature',cwd:repo});
 assert.equal(started.status,202);
 let run=await untilDone(started.data.run.id);
 assert.equal(run.status,'needs-attention',JSON.stringify(run.events));
 assert.ok(run.events.some(e=>e.type==='warning'&&e.text.includes('ZERO project files')));
 assert.equal(run.stageResults[0].changedFiles.length,0);
 assert.equal(run.stageResults.length,1,'No unnecessary model call after a failed write');
 // Real implementation: one FIX, one correction, PASS and verified files.
 writeFileSync(cli,readFileSync(cli,'utf8').replace('if [ 1 != 1 ]; then','if [ "$NO_WRITE" != 1 ]; then'));chmodSync(cli,0o755);
 started=await api('POST','/api/runs',{task:'Implement a feature',cwd:repo});
 run=await untilDone(started.data.run.id);
 assert.equal(run.status,'completed',JSON.stringify(run.events));
 assert.ok(run.events.some(e=>e.text.includes('Review decision: FIX')));
 assert.ok(run.events.some(e=>e.text.includes('Review decision: PASS')));
 assert.equal(run.stageResults.filter(s=>s.role==='implement'&&s.status==='verified').length,2);
 assert.ok(run.stageResults.some(s=>s.changedFiles.some(f=>f.path==='feature.js')));
 assert.ok(readFileSync(join(repo,'feature.js'),'utf8').includes('3;'));
 console.log('PASS: role permissions; zero-edits blocked; no wasted review call; local Git worktree modified; bounded FIX->retry->PASS');
}finally{child.kill('SIGTERM');rmSync(folder,{recursive:true,force:true});}
