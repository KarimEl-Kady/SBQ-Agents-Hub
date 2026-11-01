// Offline integration regression: Codex stdin EOF, permission modes,
// structured errors, no false-positive completion, and review/fix continuity.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {makeCommand} from '../packages/engine/server.mjs';
const root=resolve('.');
const temp=mkdtempSync(join(tmpdir(),'sbq-codex-bridge-'));
const repo=join(temp,'project'),bin=join(temp,'bin');mkdirSync(repo);mkdirSync(bin);
writeFileSync(join(repo,'README.md'),'# Codex agent test\n');
const fake=join(bin,'codex');
writeFileSync(fake,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli-mock 9.9.9');process.exit(0);}
if(args[0]==='login'&&args[1]==='status'){console.log('Logged in');process.exit(0);}
if(args[0]==='sandbox'&&args[1]==='--'){process.exit(0);}
if(args[0]!=='exec'){console.error('unsupported fake command');process.exit(2);}
if(args.at(-1)!=='-'){console.error('FAIL: must explicitly request prompt from stdin');process.exit(3);}
if(!args.includes('--sandbox')){console.error('FAIL: missing sandbox');process.exit(4);}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);
process.stdin.on('end',()=>{
 if(!prompt.includes('USER TASK:')){console.error('FAIL: prompt lost');process.exit(5);}
 const role=(prompt.match(/ROLE: (\\w+)/)||[])[1];
 const desired=(role==='implement'||role==='support')?'workspace-write':'read-only';
 if(args[args.indexOf('--sandbox')+1]!==desired){console.error('FAIL: incorrect sandbox');process.exit(6);}
 if(fs.existsSync('fail.flag')){
  console.error('Codex failed: selected model unavailable or not authorized');
  console.log(JSON.stringify({type:'turn.failed',error:{message:'Model unavailable: choose CLI default or reconnect'}}));
  process.exit(1);
 }
 if(role==='implement'){
  if(!fs.existsSync('noop.flag')) fs.writeFileSync('feature.js','export const ready = true;\\n');
  console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'write feature.js'}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Created feature.js. SBQ_STAGE_STATUS: COMPLETE'}}));
 } else if(role==='review') {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Everything checked. SBQ_REVIEW_VERDICT: PASS'}}));
 } else {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Read-only stage completed.'}}));
 }
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:7}}));
});
`);
chmodSync(fake,0o755);
const impl={id:'implement',name:'Implementation',role:'implement',agent:'codex',modelMode:'default',effort:'default',requireChanges:true,instructions:'Write feature.js'};
const plan={id:'plan',name:'Planning',role:'plan',agent:'codex',modelMode:'default',effort:'default',instructions:'Plan the work'};
const review={id:'review',name:'Review',role:'review',agent:'codex',modelMode:'default',effort:'default',reviewLoop:true,returnTo:'implement',maxRetries:1,instructions:'Review feature.js'};
const args=makeCommand(impl,'PROMPT TEST',{isGitRepo:false,cwd:repo});
assert.equal(args[0],'codex');assert.equal(args[1].at(-1),'-');assert.deepEqual(args[2],{input:'PROMPT TEST'});assert.equal(args[1][args[1].indexOf('--sandbox')+1],'workspace-write');
const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,HOME:temp},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let daemon;for(let i=0;i<100;i++){await sleep(80);try{daemon=JSON.parse(readFileSync(join(temp,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
 assert.ok(daemon,'engine started');
 const api=async(method,path,body)=>{const response=await fetch(`http://127.0.0.1:${daemon.port}${path}`,{method,headers:{authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
 const untilDone=async id=>{for(let n=0;n<120;n++){await sleep(90);const r=(await api('GET',`/api/runs/${id}`)).data.run;if(!['queued','running'].includes(r.status))return r;}throw Error('Timed out waiting for fake Codex — possible stdin deadlock');};
 const diagnostic=await api('GET','/api/diagnostics?agent=codex');
 assert.equal(diagnostic.status,200);assert.equal(diagnostic.data.auth,'connected');assert.equal(diagnostic.data.version,'codex-cli-mock 9.9.9');
 let saved=await api('PUT','/api/workflow',{stages:[plan,impl,review]});assert.equal(saved.status,200);
 let started=await api('POST','/api/runs',{task:'Make feature.js',cwd:repo});assert.equal(started.status,202);
 let run=await untilDone(started.data.run.id);
 assert.equal(run.status,'completed',JSON.stringify(run.events));
 assert.ok(existsSync(join(repo,'feature.js')));
 assert.equal(run.stageResults.length,3);
 assert.ok(run.events.some(e=>e.text.includes('Review decision: PASS')));
 assert.ok(run.events.some(e=>e.type==='tool'&&e.text.includes('write feature.js')));
 assert.ok(run.events.some(e=>e.type==='output'&&e.text.includes('tokens')&&e.text.includes('NOT stage verification')));
 // Explicit provider error cannot be interpreted as success.
 writeFileSync(join(repo,'fail.flag'),'fail');
 started=await api('POST','/api/runs',{task:'Implement another feature',cwd:repo});run=await untilDone(started.data.run.id);
 assert.equal(run.status,'needs-attention');
 assert.equal(run.stageResults.length,1,'No charged review after failure');
 assert.ok(run.events.some(e=>e.type==='error'&&e.text.includes('Model unavailable')),'Structured Codex error was not shown');
 assert.ok(run.events.some(e=>e.type==='output'&&e.text.includes('Codex failed')),'stderr not shown in chat');
 rmSync(join(repo,'fail.flag'));
 writeFileSync(join(repo,'noop.flag'),'no write');
 started=await api('POST','/api/runs',{task:'Implement but fake agent writes nothing',cwd:repo});run=await untilDone(started.data.run.id);
 assert.equal(run.status,'needs-attention');
 assert.equal(run.stageResults.length,2,'No paid reviewer after no-write stage');
 assert.ok(run.events.some(e=>e.text.includes('ZERO project files')));
 console.log('PASS: codex exec - + closed stdin, correct sandbox, real edit verification, PASS review, JSON/stderr errors, no-op guard, no model tokens consumed');
}finally{child.kill('SIGTERM');rmSync(temp,{recursive:true,force:true});}
