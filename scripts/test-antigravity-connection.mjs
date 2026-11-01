import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const temp=mkdtempSync(join(tmpdir(),'sbq-agy-auth-'));
const bin=join(temp,'bin');mkdirSync(bin);
const calls=join(temp,'model-calls.txt');const failureFlag=join(temp,'fail-verify');
const fake=`#!/bin/sh
if [ "$1" = "--version" ]; then echo 'agy 1.4.5 (mock)'; exit 0; fi
if [ "$1" = "-p" ]; then
  echo called >> "$SBQ_AGY_TEST_LOG"
  if [ -f "$SBQ_AGY_FAIL_FILE" ]; then
    echo '{"status":"ERROR","error":"authentication required"}'
    exit 1
  fi
  token=$(printf '%s' "$2" | grep -o 'SBQ_AUTH_[0-9A-F]*' | head -n 1)
  printf '{"status":"SUCCESS","response":"%s","usage":{"input_tokens":4,"output_tokens":6,"total_tokens":10}}' "$token"; echo
  exit 0
fi
exit 1
`;
writeFileSync(join(bin,'agy'),fake);chmodSync(join(bin,'agy'),0o755);
const root=resolve(import.meta.dirname,'..');
const env={...process.env,HOME:temp,PATH:bin+':'+process.env.PATH,SBQ_AGY_TEST_LOG:calls,SBQ_AGY_FAIL_FILE:failureFlag};
const child=spawn(process.execPath,[join(root,'packages/engine/server.mjs')],{env,stdio:['ignore','pipe','pipe']});
const sleep=ms=>new Promise(res=>setTimeout(res,ms));
try{
 let cfg;
 for(let i=0;i<100;i++){
  try{cfg=JSON.parse(readFileSync(join(temp,'.sbq-agents-hub','daemon.json'),'utf8'));break;}catch{await sleep(100);}
 }
 if(!cfg)throw new Error('Engine did not start');
 const api=async(method,path,body)=>{
  const r=await fetch(`http://127.0.0.1:${cfg.port}${path}`,{method,headers:{authorization:`Bearer ${cfg.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:r.status,data:await r.json()};
 };
 const agy=async()=> (await api('GET','/api/providers')).data.providers.find(p=>p.id==='agy');
 const initial=await agy();if(!initial.installed||initial.auth!=='unverified')throw Error('Initial Antigravity should be installed, unverified');
 if(existsSync(calls))throw Error('Provider status consumed model tokens');
 let res=await api('POST','/api/providers/agy/confirm',{confirmed:true});
 if(res.status!==200||(await agy()).auth!=='user-confirmed')throw Error('Manual confirmation failed');
 if(existsSync(calls))throw Error('Manual confirmation ran model');
 res=await api('POST','/api/providers/agy/verify',{});
 if(res.status!==400||existsSync(calls))throw Error('Unapproved verification should be blocked');
 res=await api('POST','/api/providers/agy/verify',{acknowledgeQuota:true});
 if(res.status!==200||!res.data.ok||res.data.usage?.totalTokens!==10)throw Error('Approved live probe failed: '+JSON.stringify(res));
 if((await agy()).auth!=='connected')throw Error('Successful live probe did not produce connected state');
 if(readFileSync(calls,'utf8').trim().split('\n').length!==1)throw Error('Expected one live model call');
 const stored=JSON.parse(readFileSync(join(temp,'.sbq-agents-hub','antigravity-connection.json'),'utf8'));
 if(stored.verifiedAt<=0||stored.userConfirmedAt<=0)throw Error('Verification metadata not persisted');
 writeFileSync(failureFlag,'1');
 res=await api('POST','/api/providers/agy/verify',{acknowledgeQuota:true});
 if(res.status!==422||res.data.ok)throw Error('Failed verification must not be reported successful');
 if((await agy()).auth!=='user-confirmed')throw Error('A failed re-verification must invalidate connected status');
 res=await api('POST','/api/providers/agy/confirm',{confirmed:false});
 if(res.status!==200||(await agy()).auth!=='unverified')throw Error('Clear confirmation failed');
 console.log('PASS: Antigravity check has zero model calls, manual confirmation is explicit, opt-in live verification and failure reset are correct.');
}finally{child.kill('SIGTERM');rmSync(temp,{recursive:true,force:true});}
