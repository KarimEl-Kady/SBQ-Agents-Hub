// Dependency-free integration smoke test. Uses a fake Claude CLI, never an actual model.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'agentflow-home-'));
const bins=join(home,'bin');mkdirSync(bins);
const fake=join(bins,'claude');writeFileSync(fake,`#!/bin/sh
case "$1" in
  --version) echo "fake-claude 1.0" ;;
  auth) echo '{"loggedIn":true}' ;;
  *) echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"The sample plan is complete."}}}'; echo '{"type":"result","result":"The sample plan is complete."}' ;;
esac
`);chmodSync(fake,0o755);
const root=resolve(import.meta.dirname,'..');
const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{env:{...process.env,HOME:home,PATH:`${bins}:${process.env.PATH}`},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let info;for(let i=0;i<50;i++){await wait(100);try{info=JSON.parse(readFileSync(join(home,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
 if(!info)throw Error('Engine did not start');
 const req=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${info.port}${path}`,{method,headers:{Authorization:`Bearer ${info.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()}};
 const unauth=await fetch(`http://127.0.0.1:${info.port}/api/health`);if(unauth.status!==401)throw Error('Unauthorized requests not rejected');
 const providers=await req('GET','/api/providers');if(!providers.data.providers.some(p=>p.id==='claude'&&p.auth==='connected'))throw Error('Provider status probe failed');
 const stages=[{id:'sample',name:'Plan task',role:'plan',agent:'claude',model:'',effort:'default',instructions:'Plan a simple change'}];
 const updated=await req('PUT','/api/workflow',{stages});if(updated.data.stages.length!==1)throw Error('Workflow save failed');
 const created=await req('POST','/api/runs',{task:'Create a sample plan',cwd:home});if(created.status!==202)throw Error(JSON.stringify(created));
 let run;for(let i=0;i<100;i++){await wait(100);run=(await req('GET',`/api/runs/${created.data.run.id}`)).data.run;if(['completed','failed'].includes(run.status))break;}
 if(run?.status!=='completed'||!run.events.some(e=>e.text.includes('sample plan')))throw Error('Workflow did not execute and stream events: '+JSON.stringify(run));
 console.log('PASS: credential-free local API, fake CLI auth check, workflow storage, stage execution and event timeline');
}finally{child.kill('SIGTERM');}
