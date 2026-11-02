import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { checkProjectDependencies } from '../packages/engine/project-readiness.mjs';
const tmp=mkdtempSync(join(tmpdir(),'sbq-dep-preflight-'));
const root=resolve('.'),repo=join(tmp,'crm'),bin=join(tmp,'bin');
mkdirSync(repo);mkdirSync(bin);
const put=(path,data)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,data)};
const stages=[{id:'plan',name:'Planning',role:'plan',agent:'claude',modelMode:'default'},{id:'build',name:'Implementation',role:'implement',agent:'codex',requireChanges:true,modelMode:'default',allowNetwork:false}];
try{
 assert.equal(checkProjectDependencies(repo).status,'not-applicable','an empty new project is allowed');
 put(join(repo,'package.json'),JSON.stringify({name:'crm',private:true,workspaces:['apps/*'],dependencies:{'left-pad':'1.3.0'}}));
 put(join(repo,'apps','api','package.json'),JSON.stringify({name:'crm-api',dependencies:{'safe-api':'1.0.0'}}));
 assert.equal(checkProjectDependencies(repo).status,'blocked');
 assert.deepEqual(checkProjectDependencies(repo).missing.map(x=>x.dependency),['left-pad','safe-api']);
 // A mock CLI: an attempted expensive plan must not be invoked while deps are missing.
 const cli=`#!/usr/bin/env node\nconst fs=require('fs'),path=require('path');const a=process.argv.slice(2),id=path.basename(process.argv[1]);\nif(a.includes('--version')||a.includes('status'))process.exit(0);\nif(id==='codex'&&a[0]==='sandbox')process.exit(a[1]==='--'?0:2);\nfs.appendFileSync(process.env.SBQ_CALLS,id+'\\n');\nif(id==='claude')console.log(JSON.stringify({type:'result',result:'Plan accepted'}));\nelse {fs.writeFileSync(path.join(process.cwd(),'implemented.js'),'export default true;\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'SBQ_STAGE_STATUS: COMPLETE'}}));}\n`;
 for(const id of ['claude','codex']){const target=join(bin,id);writeFileSync(target,cli);chmodSync(target,0o755);}
 const calls=join(tmp,'calls.txt');writeFileSync(calls,'');
 const engine=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{cwd:root,env:{...process.env,HOME:tmp,PATH:bin+':'+process.env.PATH,SBQ_CALLS:calls},stdio:['ignore','pipe','pipe']});
 engine.stderr.on('data',v=>process.stderr.write(v));
 try{
  let daemon;
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,80));try{daemon=JSON.parse(readFileSync(join(tmp,'.sbq-agents-hub','daemon.json'),'utf8'));break}catch{}}
  assert.ok(daemon,'engine starts');
  const api=async(method,p,body)=>{const res=await fetch(`http://127.0.0.1:${daemon.port}${p}`,{method,headers:{authorization:`Bearer ${daemon.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:res.status,body:await res.json()};};
  // With package installs allowed, missing node_modules is a warning, not a dead end.
  const installing=stages.map(x=>x.id==='build'?{...x,allowNetwork:true}:x);
  assert.equal((await api('PUT','/api/workflow',{stages:installing})).status,200);
  const warn=(await api('GET','/api/preflight?cwd='+encodeURIComponent(repo))).body.checks.find(x=>x.agent==='project-dependencies');
  assert.equal(warn.status,'warning');assert.match(warn.detail,/npm install/);
  assert.equal((await api('PUT','/api/workflow',{stages})).status,200);
  const readiness=await api('GET','/api/project-readiness?cwd='+encodeURIComponent(repo));assert.equal(readiness.body.status,'blocked');
  const preflight=await api('GET','/api/preflight?cwd='+encodeURIComponent(repo));
  assert.equal(preflight.body.checks.find(x=>x.agent==='project-dependencies').status,'blocked');
  const start=await api('POST','/api/runs',{task:'Build a CRM with tests',cwd:repo});
  assert.equal(start.status,409);assert.match(start.body.error,/Project dependency preflight/);
  assert.equal(readFileSync(calls,'utf8'),'','failed readiness must make ZERO model calls');
  mkdirSync(join(repo,'node_modules','left-pad'),{recursive:true});
  mkdirSync(join(repo,'node_modules','safe-api'),{recursive:true});
  assert.equal(checkProjectDependencies(repo).status,'ready','workspace hoisting supported');
  const after=await api('POST','/api/runs',{task:'Build a CRM with tests',cwd:repo});
  assert.equal(after.status,202,JSON.stringify(after.body));
  let run;for(let i=0;i<110;i++){await new Promise(r=>setTimeout(r,70));run=(await api('GET',`/api/runs/${after.body.run.id}`)).body.run;if(!['queued','running'].includes(run.status))break;}
  assert.equal(run.status,'completed',JSON.stringify(run.events.slice(-4)));
  assert.ok(existsSync(join(repo,'implemented.js')));
  assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,2,'plan and build only after ready');
  // A genuine edit and exit(0), without COMPLETE, must never silently pass.
  const codexFile=join(bin,'codex');
  writeFileSync(codexFile,readFileSync(codexFile,'utf8').replace('export default true','export default false').replace('SBQ_STAGE_STATUS: COMPLETE','Still implementing'));chmodSync(codexFile,0o755);
  const uncertain=await api('POST','/api/runs',{task:'Finish the CRM',cwd:repo});assert.equal(uncertain.status,202);
  let pending;for(let i=0;i<110;i++){await new Promise(r=>setTimeout(r,70));pending=(await api('GET',`/api/runs/${uncertain.body.run.id}`)).body.run;if(!['queued','running'].includes(pending.status))break;}
  assert.equal(pending.status,'needs-attention','no false success for a partially finished agent');
  assert.equal(pending.pendingRecovery?.code,'NO_COMPLETION_MARKER');
  assert.ok(pending.localChanges?.files?.some(x=>x.path==='implemented.js'),'partial file evidence is kept');
 }finally{engine.kill('SIGTERM');}
 const bad=join(tmp,'invalid');mkdirSync(bad);writeFileSync(join(bad,'package.json'),'bad json');assert.equal(checkProjectDependencies(bad).status,'invalid');
 const pnp=join(tmp,'pnp');mkdirSync(pnp);put(join(pnp,'package.json'),JSON.stringify({dependencies:{foo:'1'}}));writeFileSync(join(pnp,'.pnp.cjs'),'');assert.equal(checkProjectDependencies(pnp).status,'ready');
 console.log('PASS: missing npm dependencies block before planning when no stage may install, warn when one can; zero token calls; hoisted workspace install permits execution; new/invalid/PnP projects handled; incomplete stage is not falsely approved');
}finally{rmSync(tmp,{recursive:true,force:true});}
