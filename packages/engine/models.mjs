import { spawn as nativeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let spawn = nativeSpawn;
try { spawn = require('cross-spawn'); } catch { /* npm install supplies cross-spawn; built-in spawn works for native executable paths */ }

const VALID_AGENTS = ['claude', 'codex', 'agy', 'opencode', 'gemini', 'kilo'];
const CACHE_TTL = 60_000;
const cache = new Map();
const modelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,119}$/;

export function validAgent(agent) { return VALID_AGENTS.includes(agent); }
export function validModelId(model) { return modelIdPattern.test(model); }

function run(exe, args, {cwd, timeout=5000}={}) {
  return new Promise(resolve => {
    let output='', error='', child, finished=false;
    const finish=(result)=>{if (!finished){finished=true;clearTimeout(timer);resolve(result);}};
    try { child=spawn(exe,args,{cwd,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']}); }
    catch(e){resolve({code:127,output:'',error:String(e)});return;}
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish({code:124,output,error:'Model discovery timed out'});},timeout);
    child.stdout.on('data',d=>output=(output+d.toString()).slice(0,250_000));
    child.stderr.on('data',d=>error=(error+d.toString()).slice(-3000));
    child.on('error',e=>finish({code:127,output,error:String(e)}));
    child.on('close',code=>finish({code:code??1,output,error}));
  });
}

function fromLines(output,parser) {
  const seen=new Set(), models=[];
  for(const raw of output.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/)){
    const item=parser(raw.trim());
    if(item&&!seen.has(item.id)&&validModelId(item.id)){seen.add(item.id);models.push(item);}
    if(models.length===150)break;
  }
  return models;
}

async function codexModels() {
  // Use the read-only app-server catalog. It is not an entitlement check.
  return new Promise(resolve=>{
    let child,done=false,buffer='';
    const finish=(models=[])=>{if(done)return;done=true;clearTimeout(timer);child?.kill('SIGTERM');resolve(models);};
    try{child=spawn('codex',['app-server','--listen','stdio://'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch{return resolve([]);}
    const write=obj=>{try{child.stdin.write(JSON.stringify(obj)+'\n');}catch{finish();}};
    const timer=setTimeout(()=>finish(),4500);
    child.stdin.on('error',()=>finish()); // Codex may exit before initialize; EPIPE is not a crash.
    child.on('error',()=>finish());child.on('close',()=>finish());
    child.stdout.on('data',data=>{
      buffer+=data.toString();if(buffer.length>450_000)return finish();
      let i;
      while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let msg;
        try{msg=JSON.parse(line);}catch{continue;}
        if(msg.id===1&&msg.result){write({method:'initialized'});write({id:2,method:'model/list',params:{limit:100}});}
        if(msg.id===2){const data=msg.result?.data||msg.result?.models||[];const arr=Array.isArray(data)?data:[];
          return finish(arr.map(x=>({id:String(x.id||x.model||x.slug||''),label:String(x.displayName||x.display_name||x.name||x.id||''),source:'catalog'})).filter(x=>validModelId(x.id)).slice(0,100));}
      }
    });
    write({id:1,method:'initialize',params:{clientInfo:{name:'sbq-agents-hub',title:'SBQ Agents Hub',version:'0.5.0'}}});
  });
}

// Experimental, read-only Codex CLI fallback. App-server's model/list is the
// preferred source; debug models helps when app-server is unsupported by an
// installed Codex build. Neither response guarantees account entitlement.
async function codexDebugModels(cwd){
  const r=await run('codex',['debug','models'],{cwd,timeout:5500});
  if(r.code!==0)return [];
  let data;
  try {data=JSON.parse(r.output);} catch {return [];}
  const arr=Array.isArray(data)?data:Array.isArray(data.models)?data.models:Array.isArray(data.data)?data.data:[];
  return arr.map(x=>({id:String(x.id||x.model||x.slug||''),label:String(x.displayName||x.display_name||x.name||x.id||x.slug||''),source:'cli-debug'})).filter(x=>validModelId(x.id)).slice(0,100);
}

export async function modelCatalog(agent,{cwd,refresh=false}={}){
  if(!validAgent(agent))throw new Error('Invalid runner');
  const key=agent+'|'+(cwd||'');const cached=cache.get(key);
  if(!refresh&&cached&&Date.now()-cached.time<CACHE_TTL)return cached.result;
  let models=[],source='unavailable',note='This CLI does not expose a verified model catalog. Use its default or enter an exact ID yourself.';
  if(agent==='claude'){
    // Documented exact model IDs and convenient CLI aliases. Not an entitlement check.
    models=[
      {id:'sonnet',label:'Sonnet · latest (alias)'},
      {id:'opus',label:'Opus · latest (alias)'},
      {id:'haiku',label:'Haiku · latest (alias)'},
      {id:'fable',label:'Fable · latest (alias)'},
      ...[
        ['claude-opus-5-5','Opus 5.5'],
        ['claude-sonnet-5-5','Sonnet 5.5'],
        ['claude-haiku-5-5','Haiku 5.5'],
        ['claude-fable-5-1','Fable 5.1'],
        ['claude-opus-5','Opus 5'],
        ['claude-sonnet-5','Sonnet 5'],
        ['claude-fable-5','Fable 5'],
        ['claude-opus-4-8','Opus 4.8'],
        ['claude-opus-4-7','Opus 4.7'],
        ['claude-sonnet-4-6','Sonnet 4.6'],
        ['claude-opus-4-6','Opus 4.6']
      ].map(([id,label])=>({id,label}))
    ];
    source='documented';note='Documented Claude Code model IDs and aliases. Your subscription may not include every model. CLI default follows your current Claude settings.';
  }
  if(agent==='gemini'){
    models=[{id:'auto',label:'Auto · provider routing'},
      {id:'gemini-3.1-pro-preview',label:'Gemini 3.1 Pro (preview)'},
      {id:'gemini-3-flash-preview',label:'Gemini 3 Flash (preview)'}];
    source='suggestions';note='Gemini CLI model suggestions, not a live account catalog. Use CLI default or a custom ID to match your installed Gemini CLI.';
  }
  if(agent==='agy'){
    const r=await run('agy',['models'],{cwd,timeout:6500});
    if(r.code===0){models=fromLines(r.output,line=>{
      if(!line||/^(available|model|[-=]+|usage|\$)/i.test(line))return null;
      const m=line.match(/^([a-z][a-z0-9.-]+)\s{2,}(.+)$/i);
      if(m)return{id:m[1],label:m[2].trim(),source:'cli'};
      if(/^(gemini|claude|gpt)[\w .()\/-]+$/i.test(line)&&!line.includes(':'))return{id:line,label:line,source:'cli'};
      return null;
    });}
    if(models.length){source='cli';note='Discovered by agy models. Availability may still depend on your signed-in account.';}
  }
  if(agent==='opencode'||agent==='kilo'){
    const args=['models',...(refresh?['--refresh']:[])];
    const r=await run(agent,args,{cwd,timeout:refresh?14000:6500});
    if(r.code===0)models=fromLines(r.output,line=>/^[a-z0-9._-]+\/[a-z0-9._/-]+(?:#[a-z0-9._-]+)?$/i.test(line)?{id:line,label:line,source:'cli',free:/\/free$|^opencode\//i.test(line)}:null);
    if(agent==='kilo'&&!models.some(m=>m.id==='kilo-auto/free'))models.unshift({id:'kilo-auto/free',label:'Auto Free · free model routing (availability varies)',source:'documented',free:true});
    if(models.length){source=r.code===0?'cli':'documented';note=`${agent==='kilo'?'Kilo':'OpenCode'} model catalog${refresh?' refreshed':''}. Listed models may require connection; free tiers may have limits and data-retention policies.`;}
  }
  if(agent==='codex'){
    models=await codexModels();
    if(models.length){source='app-server';note='Catalog returned by Codex app-server. A model is verified only when an actual run succeeds.';}
    else {models=await codexDebugModels(cwd);if(models.length){source='cli-debug';note='Read-only Codex debug catalog. This does not guarantee model access for your current subscription.';}}
  }
  const result={agent,source,note,models,checkedAt:new Date().toISOString(),supportsLiveCatalog:['codex','agy','opencode','kilo'].includes(agent)};cache.set(key,{time:Date.now(),result});return result;
}

export async function validateStagesForRun(stages,{cwd}={}){
  const errors=[];const catalogs=new Map();
  for(const [index,s] of stages.entries()){
    if(!validAgent(s.agent)){errors.push(`Stage ${index+1}: unsupported agent`);continue;}
    if(s.modelMode==='default'||!s.model)continue;
    if(!validModelId(s.model)){errors.push(`Stage ${index+1} (${s.name}): invalid model ID "${s.model}"`);continue;}
    if(s.modelMode==='custom')continue; // Explicit opt-in; never silently switch models.
    if(!catalogs.has(s.agent))catalogs.set(s.agent,await modelCatalog(s.agent,{cwd}));
    let catalog=catalogs.get(s.agent);
    if(!catalog.models.some(m=>m.id===s.model)){
      // Recheck the provider catalog once before rejecting a recently-added model.
      // This is a read-only CLI operation and never consumes coding-model tokens.
      catalog=await modelCatalog(s.agent,{cwd,refresh:true});catalogs.set(s.agent,catalog);
    }
    if(!catalog.models.some(m=>m.id===s.model)){
      const sample=catalog.models.slice(0,5).map(m=>m.id).join(', ');
      const reason=catalog.models.length?'is not currently listed by the CLI':'could not be verified (no readable CLI catalog)';
      errors.push(`Stage ${index+1} (${s.name}): model "${s.model}" ${reason} for ${s.agent}. Open Workflows and choose CLI Default, or explicitly select Custom model ID to try this exact ID at your own risk. ${sample?'Models currently listed: '+sample+'. ':''}No model request was sent.`);
    }
  }
  return errors;
}
