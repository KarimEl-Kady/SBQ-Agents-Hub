// End-to-end checks with fake CLIs, temp git worktree; no model calls or user files.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'agentflow-v03-test-')), repo=join(home,'project'),bin=join(home,'bin');
mkdirSync(bin);mkdirSync(repo);
const fake=join(bin,'claude');writeFileSync(fake,`#!/bin/sh
case "$1" in
  --version) echo 'fake claude 1.0' ;;
  auth) printf "%s" "$CLAUDE_CONFIG_DIR" > "$HOME/auth-profile"; echo '{"loggedIn":true}' ;;
  *) printf "%s" "$CLAUDE_CONFIG_DIR" > "$HOME/run-profile"; echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Reviewed: no blocking bugs found."}}}';echo '{"type":"result","result":"Reviewed: no blocking bugs found."}' ;;
esac
`);chmodSync(fake,0o755);
const fakeOC=join(bin,'opencode');writeFileSync(fakeOC,`#!/bin/sh
case "$1" in
  --version) echo 'opencode 1.0' ;;
  auth) echo '[{"provider":"openai","type":"oauth"}]' ;;
  models) echo 'openai/gpt-demo'; echo 'claude-agent/opus#high' ;;
esac
`);chmodSync(fakeOC,0o755);
const git=(...args)=>{const p=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(p.status!==0)throw new Error(p.stderr);};
git('init');git('config','user.email','test@example.com');git('config','user.name','Integration Test');
writeFileSync(join(repo,'example.js'),'export const foo = 1;\n');git('add','.');git('commit','-m','baseline');writeFileSync(join(repo,'example.js'),'export const foo = 2;\n');
const child=spawn(process.execPath,[resolve('packages/engine/server.mjs')],{cwd:resolve('.'),env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let cfg;for(let i=0;i<60;i++){await wait(100);try{cfg=JSON.parse(readFileSync(join(home,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
 if(!cfg)throw Error('engine did not start');
 const request=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${cfg.port}${path}`,{method,headers:{Authorization:`Bearer ${cfg.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 const status=await request('GET','/api/providers');if(status.data.providers.find(x=>x.id==='opencode')?.auth!=='connected')throw Error('Existing OpenCode session not recognized');
 const created=await request('POST','/api/providers/claude/accounts/create',{name:'Work'});if(created.status!==200)throw Error('Account creation failed');const profile=created.data.accounts.active;const expected=join(home,'.sbq-agents-hub','accounts','claude',profile);await request('GET','/api/providers');if(readFileSync(join(home,'auth-profile'),'utf8')!==expected)throw Error('Status used wrong account');
 const invalid=await request('POST','/api/providers/claude/accounts/select',{id:'../../escape'});if(invalid.status!==400)throw Error('Invalid account accepted');
 const models=await request('GET','/api/models?agent=opencode');if(!models.data.models.some(m=>m.id==='openai/gpt-demo'))throw Error('OpenCode model selection failed');
 const changes=await request('GET','/api/changes?cwd='+encodeURIComponent(repo));if(!changes.data.diff.includes('+export const foo = 2;'))throw Error('Git diff missing expected modification');
 const bad=await request('PUT','/api/workflow',{stages:[{id:'invalid',name:'bad',role:'review',agent:'claude',model:'Sonnet5.5',modelMode:'catalog',effort:'default',instructions:'test'}]});if(bad.status!==200)throw Error('Unexpected workflow validation failure');
 const badRun=await request('POST','/api/runs',{task:'check invalid model',cwd:repo});if(badRun.status!==400||!badRun.data.error.includes('model \"Sonnet5.5\"'))throw Error('Saved unavailable model should have been rejected');
 const runReq=await request('POST','/api/reviews',{cwd:repo,agent:'claude',model:'',modelMode:'default',effort:'default',instructions:'Check changed files'});if(runReq.status!==202)throw Error('Review endpoint failed '+JSON.stringify(runReq));
 let result;for(let i=0;i<100;i++){await wait(100);result=(await request('GET','/api/runs/'+runReq.data.run.id)).data.run;if(['completed','failed'].includes(result.status))break;}
 if(readFileSync(join(home,'run-profile'),'utf8')!==expected)throw Error('Review used wrong account');
 if(result?.status!=='completed'||!result.events.some(x=>x.text.includes('Reviewed:')))throw Error('AI review failed '+JSON.stringify(result));
 const switched=await request('POST','/api/providers/claude/accounts/select',{id:'default'});if(switched.data.accounts.active!=='default')throw Error('Switch to default failed');await request('GET','/api/providers');if(readFileSync(join(home,'auth-profile'),'utf8')!=='')throw Error('Default account not restored');
 const after=await request('GET','/api/changes?cwd='+encodeURIComponent(repo));if(!after.data.diff.includes('+export const foo = 2;'))throw Error('Review corrupted git changes');
 console.log('PASS: model catalog, existing OpenCode session, broken model rejection, Git diff, and on-demand code review');
}finally{child.kill('SIGTERM');rmSync(home,{recursive:true,force:true});}
