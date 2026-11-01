import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {modelCatalog,validateStagesForRun} from '../packages/engine/models.mjs';
const dir=mkdtempSync(join(tmpdir(),'sbq-hub-test-'));
const bins=join(dir,'bin');mkdirSync(bins);
const fake=(id,text)=>{const file=join(bins,id);writeFileSync(file,`#!/bin/sh\n${text}\n`);chmodSync(file,0o755);};
fake('kilo',`if [ "$1" = "models" ]; then echo "openai/demo-model"; echo "kilo-auto/free"; exit 0; fi
if [ "$1" = "--version" ]; then echo "kilo mock"; exit 0; fi
if [ "$1" = "profile" ]; then echo '{"email":"demo@example.com"}'; exit 0; fi
printf '%s\n' '{"type":"text","part":{"text":"Kilo finished safely"}}'`);
fake('freebuff',`if [ "$1" = "--version" ]; then echo "freebuff 1"; exit 0; fi; exit 0`);
const oldPath=process.env.PATH;process.env.PATH=bins+':'+oldPath;
try{
 const models=await modelCatalog('kilo',{cwd:dir,refresh:true});
 if(!models.models.some(m=>m.id==='kilo-auto/free'&&m.free))throw Error('Missing verified free model option');
 if(!models.models.some(m=>m.id==='openai/demo-model'))throw Error('Missing live Kilo catalog');
 const errors=await validateStagesForRun([{agent:'kilo',model:'kilo-auto/free',modelMode:'catalog',name:'Build'}],{cwd:dir});
 if(errors.length)throw Error('Rejected Kilo free model: '+errors.join(';'));
 const root=resolve(import.meta.dirname,'..');
 const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{env:{...process.env,HOME:dir},stdio:['ignore','pipe','pipe']});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  let info;for(let i=0;i<70;i++){await sleep(100);try{info=JSON.parse(readFileSync(join(dir,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{}}
  if(!info)throw Error('SBQ engine did not start');
  const api=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${info.port}${path}`,{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
  if((await api('GET','/api/health')).data.version!=='0.5.14')throw Error('Version mismatch');
  const providers=(await api('GET','/api/providers')).data.providers;
  if(!providers.some(p=>p.id==='freebuff'&&p.installed&&p.interactiveOnly))throw Error('Freebuff status not safe');
  if(!providers.some(p=>p.id==='kilo'&&p.installed))throw Error('Kilo missing');
  const free=(await api('GET','/api/models?agent=kilo&refresh=1')).data.models;
  if(!free.some(x=>x.id==='kilo-auto/free'))throw Error('Kilo free model unavailable');
  const saved=await api('PUT','/api/workflow',{stages:[{id:'free',name:'Free Kilo',role:'implement',agent:'kilo',model:'kilo-auto/free',modelMode:'catalog',instructions:'Make a sample change.'}]});
  if(saved.status!==200)throw Error('Save failed: '+JSON.stringify(saved));
  const started=await api('POST','/api/runs',{cwd:dir,task:'Mock implementation'});
  if(started.status!==202)throw Error('Run not accepted: '+JSON.stringify(started));
  let run;for(let i=0;i<100;i++){await sleep(100);run=(await api('GET',`/api/runs/${started.data.run.id}`)).data.run;if(['completed','failed','needs-attention'].includes(run.status))break;}
  if(run.status!=='needs-attention'||!run.events.some(e=>e.text.includes('ZERO project files')))throw Error('Kilo mock must not be marked successful without file changes: '+JSON.stringify(run));
  console.log('PASS: free Kilo model discovery/refresh, Freebuff interactive safety, existing profiles and workflow no-op detection');
 }finally{child.kill('SIGTERM');}
}finally{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});}
