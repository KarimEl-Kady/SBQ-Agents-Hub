// The app/engine closes while the implementation stage runs. After restart the
// run must be recoverable: retry ONLY that stage (with explicit consent), keep the
// paid architect plan, and never repeat planning. Mocked CLIs, no model tokens.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'sbq-restart-'));
const repo=join(dir,'repo'),bin=join(dir,'bin');mkdirSync(repo);mkdirSync(bin);writeFileSync(join(repo,'README.md'),'# Test\n');
const fake=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const agent=path.basename(process.argv[1]),args=process.argv.slice(2),log=path.join(process.env.SBQ_TEST_ROOT,'calls.log');
if(args[0]==='--version'){console.log(agent+' test');process.exit(0);}
if(args[0]==='auth'||args[0]==='login'){console.log('logged in');process.exit(0);}
if(agent==='codex'&&args[0]==='sandbox')process.exit(0);
if(agent==='claude'){fs.appendFileSync(log,'plan\\n');console.log(JSON.stringify({type:'result',result:'PLAN-MARKER: build feature.js',session_id:'s1'}));process.exit(0);}
let prompt='';process.stdin.on('data',v=>prompt+=v);process.stdin.on('end',()=>{
 const n=fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\\n').filter(x=>x.startsWith('codex')).length+1:1;
 fs.appendFileSync(log,'codex-'+n+'\\n');
 if(n===1){setTimeout(()=>{},20000);return;} // hangs until the engine dies
 if(!prompt.includes('PLAN-MARKER')){console.error('plan lost after restart');process.exit(9);}
 fs.writeFileSync(path.join(process.cwd(),'feature.js'),'export default 1;\\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done.\\nSBQ_STAGE_STATUS: COMPLETE'}}));
});
`;
for(const id of ['claude','codex']){writeFileSync(join(bin,id),fake);chmodSync(join(bin,id),0o755);}
const root=resolve('.'),env={...process.env,HOME:dir,PATH:bin+':'+process.env.PATH,SBQ_TEST_ROOT:dir,SBQ_SKIP_PATH_DISCOVERY:'1'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(){
 const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 child.stderr.on('data',v=>process.stderr.write(v));
 let daemon;for(let i=0;i<100;i++){await sleep(80);try{daemon=JSON.parse(readFileSync(join(dir,'.sbq-agents-hub','daemon.json'),'utf8'));if(daemon.pid===child.pid)break;daemon=null;}catch{}}
 assert.ok(daemon,'engine started');
 const api=async(method,p,body)=>{const r=await fetch(`http://127.0.0.1:${daemon.port}${p}`,{method,headers:{authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 return{child,api};
}
let first,second;
try{
 first=await boot();
 const stages=[{id:'plan',name:'Planning',role:'plan',agent:'claude',modelMode:'default'},{id:'impl',name:'Implementation',role:'implement',agent:'codex',modelMode:'default',requireChanges:true}];
 assert.equal((await first.api('PUT','/api/workflow',{stages})).status,200);
 const start=await first.api('POST','/api/runs',{cwd:repo,task:'Build feature'});assert.equal(start.status,202,JSON.stringify(start.data));
 const id=start.data.run.id;
 for(let i=0;i<100;i++){await sleep(100);const run=(await first.api('GET','/api/runs/'+id)).data.run;if(run.stageResults.some(s=>s.id==='impl'))break;}
 await sleep(700); // let the history file flush
 first.child.kill('SIGKILL');await sleep(200);

 second=await boot();
 const after=(await second.api('GET','/api/runs/'+id)).data.run;
 assert.equal(after.status,'needs-attention',JSON.stringify(after.events.slice(-3)));
 assert.equal(after.pendingRecovery?.code,'INTERRUPTED');
 assert.equal(after.pendingRecovery.stageId,'impl');
 const noConsent=await second.api('POST',`/api/runs/${id}/retry-stage`,{});assert.equal(noConsent.status,400,'retry needs explicit consent');
 const retry=await second.api('POST',`/api/runs/${id}/retry-stage`,{confirmNewModelCall:true});assert.equal(retry.status,202,JSON.stringify(retry.data));
 let run;for(let i=0;i<100;i++){await sleep(100);run=(await second.api('GET','/api/runs/'+id)).data.run;if(!['running','queued'].includes(run.status))break;}
 assert.equal(run.status,'completed',JSON.stringify(run.events.slice(-5)));
 assert.deepEqual(readFileSync(join(dir,'calls.log'),'utf8').trim().split('\n'),['plan','codex-1','codex-2'],'planning never repeated');
 console.log('PASS: run interrupted by engine shutdown is recoverable after restart; consent required; only the interrupted stage re-runs; architect plan kept');
}finally{first?.child.kill('SIGKILL');second?.child.kill('SIGKILL');await sleep(100);rmSync(dir,{recursive:true,force:true});}
