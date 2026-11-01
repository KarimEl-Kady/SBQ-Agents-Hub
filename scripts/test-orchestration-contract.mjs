// Offline end-to-end contract of the user's real workflow:
// architect plan -> implement -> review FIX -> implementation correction -> review PASS
// -> optional support SKIPPED -> final review PASS -> read-only release.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {analyzeCliResult,reviewVerdict,contextualExcerpt} from '../packages/engine/server.mjs';
const rejected=analyzeCliResult({exitCode:0,output:JSON.stringify({event:'result',result:{status:'WAITING',error:'CLI permission needed'}})});
assert.match(rejected.fatal,/Antigravity WAITING/);
assert.equal(reviewVerdict('Reference: SBQ_REVIEW_VERDICT: PASS\nActual findings require fixes\nSBQ_REVIEW_VERDICT: FIX'),'FIX');
assert.equal(reviewVerdict('Report says PASS but no final verdict'),null);
const long='AC-1-START\n'+'a'.repeat(130000)+'\nIMPORTANT-END';
assert.ok(contextualExcerpt(long).includes('AC-1-START'));
assert.ok(contextualExcerpt(long).includes('IMPORTANT-END'));
const dir=mkdtempSync(join(tmpdir(),'sbq-full-workflow-'));
const repo=join(dir,'repo'),bin=join(dir,'bin');mkdirSync(repo);mkdirSync(bin);writeFileSync(join(repo,'README.md'),'# Test\n');
const fake=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const agent=path.basename(process.argv[1]);const args=process.argv.slice(2);
const data=process.env.SBQ_TEST_ROOT,counts=path.join(data,'counts.json');
if(args[0]==='--version'){console.log(agent+' test');process.exit(0);}
if(agent==='claude'&&args[0]==='auth'){console.log('logged in');process.exit(0);}
if(agent==='codex'&&args[0]==='login'){console.log('logged in');process.exit(0);}
if(agent==='codex'&&args[0]==='sandbox'){process.exit(args[1]==='--'?0:2);}
if(agent==='opencode'&&args[0]==='auth'){console.log(JSON.stringify([{provider:'test'}]));process.exit(0);}
if(agent==='agy'&&args[0]==='models'){console.log('Gemini');process.exit(0);}
const state=fs.existsSync(counts)?JSON.parse(fs.readFileSync(counts,'utf8')):{};
const log=path.join(data,'calls.log');
const respond=(text)=>{
 if(agent==='claude')console.log(JSON.stringify({type:'result',result:text,session_id:'session-test-12345678',total_cost_usd:.001}));
 if(agent==='codex') {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:6,output_tokens:8}}));}
 if(agent==='agy')console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:text,usage:{input_tokens:3,output_tokens:8}}}));
 if(agent==='opencode')console.log(JSON.stringify({type:'text',part:{text}}));
};
if(agent==='codex'){
 let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>prompt+=v);process.stdin.on('end',()=>{
  if(!prompt.includes('AC-1-START')||!prompt.includes('IMPORTANT-END')){console.error('Architect plan was lost');process.exit(9);}
  state.codex=(state.codex||0)+1;
  if(state.codex===2&&!prompt.includes('FIX-THIS-TEST')){console.error('Review fix instructions were lost');process.exit(8);}
  fs.writeFileSync(path.join(process.cwd(),'feature.js'),'export const count = '+state.codex+';\\n');
  fs.writeFileSync(counts,JSON.stringify(state));fs.appendFileSync(log,'codex-'+state.codex+'\\n');
  respond('Implemented.\\nSBQ_STAGE_STATUS: COMPLETE');
 });
}else if(agent==='claude'){
 const input=args.join(' ');
 if(input.includes('ROLE: plan')){
  fs.appendFileSync(log,'plan\\n');respond('AC-1-START\\n'+'x'.repeat(72000)+'\\nIMPORTANT-END');
 }else if(input.includes('ROLE: review')){
  if(input.includes('STAGE: Final Review')){fs.appendFileSync(log,'final-review\\n');respond('All test criteria checked.\\nSBQ_REVIEW_VERDICT: PASS');}
  else {state.review=(state.review||0)+1;fs.writeFileSync(counts,JSON.stringify(state));fs.appendFileSync(log,'review-'+state.review+'\\n');respond(state.review===1?'FIX-THIS-TEST: Add missing test and document behavior.\\nSBQ_REVIEW_VERDICT: FIX':'All criteria checked.\\nSBQ_REVIEW_VERDICT: PASS');}
 }else respond('No matching stage');
}else if(agent==='agy') {fs.appendFileSync(log,'support\\n');respond('No supporting files required.\\nSBQ_STAGE_STATUS: SKIPPED');}
else if(agent==='opencode'){fs.appendFileSync(log,'release\\n');respond('Release checklist ready, no push performed.\\nSBQ_STAGE_STATUS: COMPLETE');}
else process.exit(2);
`;
for(const id of ['claude','codex','agy','opencode']){const p=join(bin,id);writeFileSync(p,fake);chmodSync(p,0o755);}
const root=resolve('.');const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{cwd:root,env:{...process.env,HOME:dir,PATH:bin+':'+process.env.PATH,SBQ_TEST_ROOT:dir},stdio:['ignore','pipe','pipe']});child.stderr.on('data',v=>process.stderr.write(v));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let daemon;for(let i=0;i<100;i++){await sleep(80);try{daemon=JSON.parse(readFileSync(join(dir,'.sbq-agents-hub','daemon.json'),'utf8'));break}catch{}}
 assert.ok(daemon,'server started');
 const api=async(method,p,body)=>{const r=await fetch(`http://127.0.0.1:${daemon.port}${p}`,{method,headers:{authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()}};
 const stages=[
  {id:'plan',name:'Planning',role:'plan',agent:'claude',modelMode:'default',instructions:'Create acceptance criteria'},
  {id:'implementation',name:'Implementation',role:'implement',agent:'codex',modelMode:'default',requireChanges:true,instructions:'Write feature'},
  {id:'review',name:'Review',role:'review',agent:'claude',modelMode:'default',reviewLoop:true,returnTo:'implementation',maxRetries:2,instructions:'Review'},
  {id:'support',name:'Supporting tasks',role:'support',agent:'agy',modelMode:'default',requireChanges:false,instructions:'Optionally seed'},
  {id:'final',name:'Final Review',role:'review',agent:'claude',modelMode:'default',reviewLoop:true,returnTo:'support',maxRetries:1,instructions:'Review all'},
  {id:'release',name:'Release Preparation',role:'release',agent:'opencode',modelMode:'default',instructions:'Prepare release checklist'}
 ];
 const save=await api('PUT','/api/workflow',{stages});assert.equal(save.status,200,JSON.stringify(save.data));
 const start=await api('POST','/api/runs',{cwd:repo,task:'Build feature and verify'});assert.equal(start.status,202,JSON.stringify(start.data));
 let run;for(let i=0;i<180;i++){await sleep(100);run=(await api('GET',`/api/runs/${start.data.run.id}`)).data.run;if(!['running','queued'].includes(run.status))break;}
 assert.equal(run.status,'completed',JSON.stringify(run.events.slice(-15)));
 assert.equal(run.stageResults.filter(x=>x.role==='implement'&&x.status==='verified').length,2);
 assert.ok(run.stageResults.some(x=>x.agent==='agy'&&x.status==='skipped'));
 assert.ok(run.stageResults.some(x=>x.agent==='opencode'&&x.status==='verified'));
 const calls=readFileSync(join(dir,'calls.log'),'utf8').trim().split('\n');
 assert.deepEqual(calls,['plan','codex-1','review-1','codex-2','review-2','support','final-review','release']);
 assert.ok(run.stageResults[0].artifact,'plan artifact persisted');
 const artifact=await api('GET',`/api/runs/${run.id}/artifacts/${run.stageResults[0].artifact}`);
 assert.equal(artifact.status,200);assert.ok(artifact.data.text.includes('IMPORTANT-END'));
 assert.ok(run.architectPlan.includes('AC-1-START'));
 assert.ok(existsSync(join(dir,'.sbq-agents-hub','runs',run.id+'.json')),'persisted run history');
 console.log('PASS: architect context across long plan, Codex FIX retry, reviewer verdicts, Antigravity optional skip, release gate, local artifact and history');
}finally{child.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});}
