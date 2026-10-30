import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {modelCatalog,validateStagesForRun} from '../packages/engine/models.mjs';
const claude=await modelCatalog('claude',{refresh:true});
for(const id of ['sonnet','opus','haiku','fable','claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5']){
 if(!claude.models.some(m=>m.id===id))throw new Error('Missing Claude model: '+id);
}
const errors=await validateStagesForRun([{name:'Test',agent:'claude',model:'claude-sonnet-5-5',modelMode:'catalog'}]);
if(errors.length)throw new Error('Claude 5.5 model rejected: '+errors.join(','));
const gemini=await modelCatalog('gemini',{refresh:true});
if(!gemini.models.some(m=>m.id==='auto'))throw new Error('Missing Gemini default');
const home=mkdtempSync(join(tmpdir(),'sbq-test-'));const bins=join(home,'bin');mkdirSync(bins);
for(const id of ['claude','codex','agy','opencode']){const sh=join(bins,id);writeFileSync(sh,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake"; else exit 0; fi\n');chmodSync(sh,0o755);}
const fake=join(bins,'gemini');writeFileSync(fake,`#!/bin/sh
if [ "$1" = "--version" ]; then echo "gemini-test"; exit 0; fi
printf '%s\\n' '{"type":"message","role":"assistant","content":"Mock Gemini output."}'
printf '%s\\n' '{"type":"result","response":"Task completed."}'
`);chmodSync(fake,0o755);
const root=resolve(import.meta.dirname,'..');
const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{env:{...process.env,HOME:home,PATH:`${bins}:${process.env.PATH}`},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let info;for(let i=0;i<45;i++){await sleep(100);try{info=JSON.parse(readFileSync(join(home,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
 if(!info)throw Error('Engine startup failed');
 const api=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${info.port}${path}`,{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()}};
 const health=await api('GET','/api/health');if(health.data.version!=='0.5.0')throw Error('Incorrect engine version');
 const providers=await api('GET','/api/providers');if(!providers.data.providers.some(p=>p.id==='gemini'&&p.auth==='unverified'))throw Error('Incorrect Gemini connection state');
 const save=await api('PUT','/api/workflow',{stages:[{id:'g',name:'Gemini plan',role:'plan',agent:'gemini',model:'',modelMode:'default',effort:'default',instructions:'Make a plan'}]});if(save.status!==200)throw Error('Gemini workflow not accepted');
 const created=await api('POST','/api/runs',{task:'Write a plan',cwd:home});if(created.status!==202)throw Error('Gemini run not accepted: '+JSON.stringify(created));
 let run;for(let i=0;i<60;i++){await sleep(100);run=(await api('GET',`/api/runs/${created.data.run.id}`)).data.run;if(['completed','failed'].includes(run.status))break;}
 if(run?.status!=='completed'||!run.events.some(e=>e.text.includes('Mock Gemini output')))throw Error('Gemini run failure: '+JSON.stringify(run));
 console.log('PASS: Claude 5.5 model IDs, Gemini CLI adapter, provider status, workflow save and stream events');
}finally{child.kill('SIGTERM');}
