import http from 'node:http';
import { spawn as nativeSpawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let spawn = nativeSpawn;
try { spawn = require('cross-spawn'); } catch { /* npm install supplies cross-spawn; built-in spawn works for native executable paths */ }
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, copyFileSync, lstatSync, readdirSync, renameSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { modelCatalog, validateStagesForRun, validModelId, validAgent } from './models.mjs';
import { repositoryChanges } from './git.mjs';
import { workspaceSnapshot, compareSnapshots, localChangeReport } from './workspace.mjs';
import { checkProjectDependencies } from './project-readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(homedir(), '.sbq-agents-hub');
const LEGACY_DATA = join(homedir(), '.agentflow');
// Single source of truth: the nearest package.json (repo root, or the VS Code
// extension's own package.json for the bundled engine copy).
const ENGINE_VERSION = (()=>{const here=dirname(fileURLToPath(import.meta.url));for(const file of [join(ROOT,'package.json'),join(here,'..','package.json')]){try{const p=JSON.parse(readFileSync(file,'utf8'));if(p.name==='sbq-agents-hub'&&p.version)return p.version;}catch{}}return '0.0.0';})();
const DAEMON_INFO = join(DATA, 'daemon.json');
const WORKFLOW_PATH = join(DATA, 'workflow.json');
const AGY_CONNECTION_PATH = join(DATA, 'antigravity-connection.json');
const ARTIFACT_DIR = join(DATA, 'run-artifacts');
const RUN_DIR = join(DATA, 'runs');
// Package-manager caches for sandboxed agents. Kept outside the project (so they
// never show up as code changes) and outside the user's real ~/.npm or pnpm store.
const AGENT_CACHE_DIR = join(DATA, 'agent-cache');
// Preserve enough architect context for implementers and each FIX iteration.
const MAX_CONTEXT_CHARS = 64000;
const RUNNABLE_AGENTS = ['claude', 'codex', 'agy', 'opencode', 'gemini', 'kilo'];
const CLI_NAMES = [...RUNNABLE_AGENTS,'freebuff'];
// Opt-in only. Each rule is an exact non-shell CLI command, never an entire Bash tool grant.
const INSTALL_COMMANDS = ['npm install','npm ci','pnpm install','yarn install','bun install'];
const PREAPPROVED_CHECKS = new Set(['php artisan test','vendor/bin/pint','vendor/bin/pint --test','npm test','npm run test','npm run lint','npm run build','composer test','dotnet test','pytest',...INSTALL_COMMANDS]);
const DEFAULT_WORKFLOW = [
  { id:'plan',name:'Planning',role:'plan',agent:'claude',model:'',modelMode:'default',effort:'default',instructions:'Inspect the repository, write a concrete implementation plan and testable acceptance criteria. Do not change files.' },
  { id:'build',name:'Implementation',role:'implement',agent:'codex',model:'',modelMode:'default',effort:'default',instructions:'Implement the requested code in the selected project. Add or update tests. Your output is not considered success without actual workspace changes.',requireChanges:true },
  { id:'review',name:'Code Review',role:'review',agent:'claude',model:'',modelMode:'default',effort:'default',instructions:'Compare the implementation to the task and acceptance criteria. Be strict about missing or defective code.',reviewLoop:true,returnTo:'build',maxRetries:2 },
  { id:'support',name:'Supporting tasks',role:'support',agent:'agy',model:'',modelMode:'default',effort:'default',instructions:'Check whether seeders, fixtures or documentation are required by the accepted plan. If needed, implement them; otherwise explicitly report SBQ_STAGE_STATUS: SKIPPED and explain why. Do not invent unnecessary files.',requireChanges:false },
  { id:'final-review',name:'Final Review',role:'review',agent:'claude',model:'',modelMode:'default',effort:'default',instructions:'Verify every original requirement, required tests, documentation and supporting changes. Return FIX if any requirement is unverified.',reviewLoop:true,returnTo:'support',maxRetries:1 },
  { id:'release',name:'Release Preparation',role:'release',agent:'opencode',model:'',modelMode:'default',effort:'default',instructions:'Prepare a release checklist and recommended commit message. Do not commit, push, or deploy without explicit user approval.',requireChanges:false }
];
// Apps started from a desktop menu, Dock or the VS Code extension host often get
// a minimal PATH, so installed CLIs look "not installed". Merge the user's login
// shell PATH plus common per-user install folders. Never reads credentials.
const MARK='__SBQ_PATH__';
function loginShellPath(){
 if(process.platform==='win32'||!process.env.SHELL)return [];
 try{
  const r=spawnSync(process.env.SHELL,['-ilc',`printf '${MARK}%s${MARK}' "$PATH"`],{encoding:'utf8',timeout:4000,stdio:['ignore','pipe','ignore']});
  const m=String(r.stdout||'').match(new RegExp(MARK+'(.*?)'+MARK,'s'));
  return m?m[1].split(':').filter(Boolean):[];
 }catch{return [];}
}
function versionKey(v){return String(v).replace(/^v/,'').split('.').map(n=>Number.parseInt(n,10)||0);}
export function includeCommonCliPaths(){
 if(process.env.SBQ_SKIP_PATH_DISCOVERY==='1')return;
 const h=homedir(),delim=process.platform==='win32'?';':':';
 const candidates=[
  join(h,'.local','bin'),join(h,'bin'),join(h,'.opencode','bin'),join(h,'.bun','bin'),
  join(h,'.volta','bin'),join(h,'.npm-global','bin'),join(h,'.local','share','pnpm'),join(h,'.yarn','bin'),
  join(h,'.deno','bin'),join(h,'.cargo','bin'),'/opt/homebrew/bin','/usr/local/bin','/snap/bin'
 ];
 if(process.platform==='win32'&&process.env.APPDATA)candidates.push(join(process.env.APPDATA,'npm'));
 const nvm=join(h,'.nvm','versions','node');
 if(existsSync(nvm))try{
  const versions=readdirSync(nvm).sort((a,b)=>{const x=versionKey(a),y=versionKey(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return y[i]-x[i];return 0;});
  for(const v of versions.slice(0,5))candidates.push(join(nvm,v,'bin'));
 }catch{}
 const original=String(process.env.PATH||'').split(delim).filter(Boolean);
 process.env.PATH=[...new Set([...original,...loginShellPath(),...candidates.filter(x=>existsSync(x))])].join(delim);
}
function ensureData(){ mkdirSync(DATA, {recursive:true,mode:0o700}); const old=join(LEGACY_DATA,'workflow.json');if(!existsSync(WORKFLOW_PATH)&&existsSync(old))try{copyFileSync(old,WORKFLOW_PATH);if(process.platform!=='win32')chmodSync(WORKFLOW_PATH,0o600);}catch{}}
const ACCOUNT_PATH=join(DATA,'accounts.json');
const PROFILE_AGENTS=['claude','codex'];
function readAccounts(){try{const value=JSON.parse(readFileSync(ACCOUNT_PATH,'utf8'));return value&&typeof value==='object'?value:{};}catch{return {};}}
function accountInfo(agent){const data=readAccounts()[agent]||{};const profiles=Array.isArray(data.profiles)?data.profiles.filter(p=>p&&/^[a-f0-9-]{36}$/.test(p.id)&&typeof p.name==='string'):[];return {profiles,active:profiles.some(p=>p.id===data.active)?data.active:'default'};}
function accountEnv(agent){if(!PROFILE_AGENTS.includes(agent))return {};const {active}=accountInfo(agent);if(active==='default')return {};return {[agent==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']:join(DATA,'accounts',agent,active)};}
function saveAccount(agent,action,body){
 if(!PROFILE_AGENTS.includes(agent))throw new Error('Named accounts are not supported for this agent');
 const all=readAccounts(),info=accountInfo(agent);
 if(action==='create'){const name=typeof body.name==='string'?body.name.trim():'';if(!name||name.length>80)throw new Error('Enter an account name (1–80 characters)');if(info.profiles.length>=30)throw new Error('Maximum of 30 accounts');const id=randomUUID();mkdirSync(join(DATA,'accounts',agent,id),{recursive:true,mode:0o700});info.profiles.push({id,name});info.active=id;}
 else if(action==='select'){if(body.id!=='default'&&!info.profiles.some(p=>p.id===body.id))throw new Error('Unknown account');info.active=body.id;}
 else throw new Error('Unknown account action');
 all[agent]=info;writeFileSync(ACCOUNT_PATH,JSON.stringify(all,null,2),{mode:0o600});return info;
}
function readWorkflow(){ ensureData(); try{const v=JSON.parse(readFileSync(WORKFLOW_PATH,'utf8'));return Array.isArray(v)&&v.length?v.map(s=>({...s,modelMode:s.modelMode||(s.model?'catalog':'default')})):DEFAULT_WORKFLOW;}catch{return DEFAULT_WORKFLOW;} }
function saveWorkflow(stages){
 ensureData();
 if(!Array.isArray(stages)||stages.length<1||stages.length>30)throw new Error('Workflow must contain 1–30 stages');
 const ids=new Set();
 const cleaned=stages.map((s,i)=>{
  const id=String(s.id||randomUUID());if(ids.has(id))throw new Error('Duplicate stage IDs');ids.add(id);
  const role=['plan','implement','review','support','release'].includes(s.role)?s.role:'support';
  const result={id,name:String(s.name||`Stage ${i+1}`).slice(0,100),role,
   agent:RUNNABLE_AGENTS.includes(s.agent)?s.agent:'claude',model:String(s.model||'').trim().slice(0,120),
   modelMode:['default','catalog','custom'].includes(s.modelMode)?s.modelMode:(s.model?'catalog':'default'),
   effort:['default','low','medium','high','xhigh'].includes(s.effort)?s.effort:'default',
   instructions:String(s.instructions||'').slice(0,8000),
   requireChanges:typeof s.requireChanges==='boolean'?s.requireChanges:['implement','support'].includes(role),
   verifyCommand:String(s.verifyCommand||'').trim().slice(0,200),
   requiresDocker:s.requiresDocker===true,
   allowNetwork:['implement','support'].includes(role)?s.allowNetwork!==false:false,
   allowedCommands:[...new Set(Array.isArray(s.allowedCommands)?s.allowedCommands:[])].filter(x=>PREAPPROVED_CHECKS.has(x)).slice(0,10),
   reviewLoop:role==='review'&&s.reviewLoop===true,
   returnTo:String(s.returnTo||''),maxRetries:Math.min(5,Math.max(0,Number(s.maxRetries)||0))};
  if(result.modelMode!=='default'&&!result.model)throw new Error(`Stage ${i+1}: choose CLI default or enter a model ID`);
  if(result.modelMode!=='default'&&!validModelId(result.model))throw new Error('Invalid model ID');
  return result;
 });
 for(const [i,s] of cleaned.entries())if(s.reviewLoop){const target=cleaned.findIndex(x=>x.id===s.returnTo);if(target<0||target>=i||!['implement','support'].includes(cleaned[target].role))throw new Error(`Review stage ${s.name}: select an earlier implementation/support stage as retry target`);}
 writeFileSync(WORKFLOW_PATH,JSON.stringify(cleaned,null,2),{mode:0o600});return cleaned;
}
// Always close child stdin. A dangling pipe causes some Codex releases to wait at
// "Reading additional input from stdin..." until our 15-minute deadline.
function runProcess(executable,args,{cwd,timeout=5000,onLine,onStderr,signal,input,env}={}){
 return new Promise((resolveResult)=>{
  let child,output='',stderr='',settled=false,timedOut=false,timeoutTimer,killTimer;
  let stdoutBuffer='',stderrBuffer='';
  const finish=(result)=>{
   if(settled)return;
   settled=true;clearTimeout(timeoutTimer);clearTimeout(killTimer);
   resolveResult({exitCode:result.exitCode,output,stderr,missing:!!result.missing,timedOut,signal:result.signal||null});
  };
  if(signal?.aborted)return finish({exitCode:130,signal:'ABORTED'});
  try{
   child=spawn(executable,args,{cwd,shell:false,windowsHide:true,env:{...process.env,...accountEnv(executable),...env},signal,stdio:['pipe','pipe','pipe']});
  }catch(error){stderr=String(error);return finish({exitCode:127,missing:true});}
  // Codex uses `codex exec -` to read the prompt from stdin; other CLIs must
  // receive EOF immediately so they never pause asking for more input.
  if(child.stdin){
   child.stdin.on('error',error=>{if(error.code!=='EPIPE'&&error.code!=='ERR_STREAM_DESTROYED')onStderr?.(`stdin: ${error.message}`);});
   child.stdin.end(input==null?'':String(input));
  }
  const deliver=(chunk,stream)=>{
   const text=chunk.toString('utf8');
   if(stream==='stdout'){
    output=(output+text).slice(-250000);stdoutBuffer+=text;
    let i;while((i=stdoutBuffer.indexOf('\n'))>=0){const line=stdoutBuffer.slice(0,i).replace(/\r$/,'');stdoutBuffer=stdoutBuffer.slice(i+1);onLine?.(line);}
    if(stdoutBuffer.length>250000){onLine?.(stdoutBuffer.slice(0,2000));stdoutBuffer='';}
   }else{
    stderr=(stderr+text).slice(-24000);stderrBuffer+=text;
    let i;while((i=stderrBuffer.indexOf('\n'))>=0){const line=stderrBuffer.slice(0,i).replace(/\r$/,'');stderrBuffer=stderrBuffer.slice(i+1);onStderr?.(line);}
    if(stderrBuffer.length>24000){onStderr?.(stderrBuffer.slice(0,2000));stderrBuffer='';}
   }
  };
  child.stdout?.on('data',chunk=>deliver(chunk,'stdout'));
  child.stderr?.on('data',chunk=>deliver(chunk,'stderr'));
  child.on('error',error=>{
   stderr=(stderr+'\n'+String(error)).slice(-24000);
   if(stdoutBuffer)onLine?.(stdoutBuffer);if(stderrBuffer)onStderr?.(stderrBuffer);
   finish({exitCode:signal?.aborted?130:127,missing:error.code==='ENOENT',signal:signal?.aborted?'ABORTED':null});
  });
  timeoutTimer=setTimeout(()=>{
   timedOut=true;onStderr?.(`SBQ timeout: ${executable} did not finish within ${Math.ceil(timeout/1000)}s; terminating the process.`);
   try{child.kill('SIGTERM');}catch{}
   killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},2000);
  },timeout);
  child.on('close',(code,termSignal)=>{
   if(stdoutBuffer)onLine?.(stdoutBuffer);if(stderrBuffer)onStderr?.(stderrBuffer);
   finish({exitCode:timedOut?124:signal?.aborted?130:code??1,signal:termSignal});
  });
 });
}
// No model requests: test the Codex Linux sandbox before paid stages. Recent
// Ubuntu/AppArmor + bubblewrap combinations can prevent *every* filesystem
// operation, even with workspace-write permissions. Never auto-disable security.
export function codexSandboxError(text){
 const s=String(text||'');
 return /bwrap:\s*(?:(?:loopback:)?\s*)Failed RTM_NEWADDR:\s*Operation not permitted/i.test(s)
  || /bwrap:.*(?:setting up uid map|Permission denied|Operation not permitted)/i.test(s)
  || /(?:fs sandbox helper failed|sandbox.*could not initialize).*?(?:permission denied|operation not permitted)/is.test(s);
}
const CODEX_SANDBOX_GUIDANCE='Codex Linux sandbox cannot initialize (Bubblewrap / AppArmor); the repository was not accessible. No model request was sent for this stage. Confirm the installed CLI syntax with `codex sandbox --help`, then test `codex sandbox -- /bin/true` where supported. Check your distribution’s scoped sandbox/AppArmor configuration. Never disable host security or grant unrestricted access automatically.';
// Some older/mock CLI versions do not offer `codex sandbox --`. In that case
// do not infer success or block valid workflows; inspect actual Codex output.
export async function codexSandboxPreflight({cwd,timeout=6000}={}){
 if(process.platform!=='linux')return{status:'not-applicable',detail:'Linux-only preflight'};
 const r=await runProcess('codex',['sandbox','--','/bin/true'],{cwd,timeout});
 const output=[r.stdout,r.output,r.stderr].filter(Boolean).join('\n').slice(-4000);
 if(r.exitCode===0)return{status:'ready',detail:'Codex Linux sandbox self-test passed (no model tokens used).'};
 if(r.timedOut)return{status:'blocked',detail:'Codex sandbox self-test timed out. SBQ stopped before the paid model call. Check the local Codex installation and sandbox using `codex sandbox -- /bin/true`.'};
 if(codexSandboxError(output))return{status:'blocked',detail:CODEX_SANDBOX_GUIDANCE,raw:output.slice(-900)};
 if(/filesystem-restricted execution requires bubblewrap|Failed to execvp|unknown (?:subcommand|argument)|unexpected argument/i.test(output))return{status:'unverified',detail:'This Codex release could not complete the local sandbox self-test. Check `codex sandbox --help` and run the supported non-model test before using the agent.',raw:output.slice(-500)};
 return{status:'unverified',detail:'Codex sandbox self-test unavailable or inconclusive. Execution will be checked for sandbox errors.',raw:output.slice(-500)};
}
// Antigravity has no documented read-only `auth status` command. SBQ stores
// *only* evidence of a voluntary user confirmation or a successful opted-in
// headless probe. Never inspect the OS keyring, browser cookies or token files.
function readAgyConnection(){
 ensureData();
 try{
  const data=JSON.parse(readFileSync(AGY_CONNECTION_PATH,'utf8'));
  return {userConfirmedAt:Number(data.userConfirmedAt)||0,verifiedAt:Number(data.verifiedAt)||0};
 }catch{return {userConfirmedAt:0,verifiedAt:0};}
}
function writeAgyConnection(data){
 ensureData();
 const value={userConfirmedAt:Number(data.userConfirmedAt)||0,verifiedAt:Number(data.verifiedAt)||0};
 writeFileSync(AGY_CONNECTION_PATH,JSON.stringify(value,null,2),{mode:0o600});
 if(process.platform!=='win32')chmodSync(AGY_CONNECTION_PATH,0o600);
 return value;
}
function agyStatus(){
 const state=readAgyConnection();
 const current=state.verifiedAt>0 && Date.now()-state.verifiedAt < 24*60*60*1000;
 if(current)return{auth:'connected',verifiedAt:state.verifiedAt,authSource:'headless-success',detail:'Antigravity session verified by a successful, user-approved headless request. This does not guarantee access to every model or future quota.'};
 if(state.userConfirmedAt)return{auth:'user-confirmed',confirmedAt:state.userConfirmedAt,verifiedAt:state.verifiedAt||undefined,authSource:'user-confirmed',detail:'You confirmed sign-in in the official Antigravity app/IDE/CLI. SBQ has not independently verified this session; you can run stages or optionally test with a small request.'};
 return{auth:'unverified',authSource:'shared-keyring',detail:'Antigravity IDE, App and agy share local keyring sign-in. The CLI has no documented free auth-status command. Confirm your existing sign-in without model usage or opt in to a small live verification.'};
}
async function verifyAgyConnection(){
 const version=await runProcess('agy',['--version'],{timeout:5000});
 if(version.missing||version.exitCode!==0)return{ok:false,error:'Antigravity CLI (agy) is not available in the SBQ process PATH. Open agy in your terminal first.'};
 const nonce='SBQ_AUTH_'+randomBytes(12).toString('hex').toUpperCase();
 const prompt=`Connection check only: reply with exactly ${nonce}. Do not use tools, inspect files, or change anything.`;
 const check=await runProcess('agy',['-p',prompt,'--output-format','json','--mode','plan'],{cwd:DATA,timeout:90000});
 let envelope;
 try{envelope=JSON.parse(check.output.trim());}catch{}
 const isSuccess=check.exitCode===0 && envelope?.status==='SUCCESS' && String(envelope.response||'').trim()===nonce;
 if(!isSuccess){
  // A failed explicit recheck invalidates the previous positive probe, but does
  // not alter the user's official provider credentials or confirmation.
  const old=readAgyConnection();
  if(old.verifiedAt)writeAgyConnection({userConfirmedAt:old.userConfirmedAt,verifiedAt:0});
  const reason=String(envelope?.error||check.stderr||'The CLI did not return the expected success response.').slice(0,400);
  return{ok:false,error:check.timedOut?'Antigravity verification timed out.':reason,exitCode:check.exitCode};
 }
 const old=readAgyConnection();const verifiedAt=Date.now();
 writeAgyConnection({userConfirmedAt:old.userConfirmedAt||verifiedAt,verifiedAt});
 return{ok:true,verifiedAt,usage:envelope.usage?{inputTokens:envelope.usage.input_tokens||0,outputTokens:envelope.usage.output_tokens||0,totalTokens:envelope.usage.total_tokens||0}:undefined};
}
// All probes stay inside the official CLI: never read cookies, keyrings or credential files.
function countOpenCodeAccounts(raw){
 try{
  const j=JSON.parse(raw);
  const accounts=Array.isArray(j)?j:Array.isArray(j.accounts)?j.accounts:Array.isArray(j.providers)?j.providers:(j&&typeof j==='object'?Object.entries(j).map(([provider,value])=>({provider,accounts:value})):[]);
  return accounts.filter(Boolean).length;
 }catch{return 0;}
}
// `opencode auth list` prints one "●  <Provider> <type>" line per credential and
// a "└  N credentials" footer. Any provider counts (DeepSeek, Moonshot, ...).
export function parseOpenCodeAuthList(text){
 const clean=String(text||'').replace(/\x1b\[[0-9;]*m/g,'');
 const footer=clean.match(/(\d+)\s+credentials?\b/i);
 if(footer)return Number(footer[1]);
 return clean.split(/\r?\n/).filter(x=>/^\s*[●•✓✔]\s+\S/.test(x)).length;
}
async function checkProvider(id){
 const version=await runProcess(id,['--version'],{timeout:3500});
 if(version.missing||version.exitCode===127)return{id,installed:false,auth:'not-installed',detail:'CLI not found in the application PATH. Existing IDE sign-in can be reused when a compatible CLI is installed.'};
 if(id==='agy')return{id,installed:true,...agyStatus()};
 if(id==='gemini'||id==='freebuff'){
  return id==='freebuff'?{id,installed:true,auth:'unverified',interactiveOnly:true,detail:'Freebuff provides free, ad-supported models, but its CLI is interactive-only; SBQ can launch it in a terminal, not run it as an unattended workflow stage.'}:{id,installed:true,auth:'unverified',authSource:'gemini-local-cli',detail:'Gemini CLI can reuse an existing Google sign-in when opened interactively. SBQ cannot verify its current quota or account without a provider-approved probe.'};
 }
 let probe;
 if(id==='claude')probe=await runProcess('claude',['auth','status'],{timeout:5000});
 if(id==='kilo'){probe=await runProcess('kilo',['profile','--json'],{timeout:5500});return{id,installed:true,auth:probe.exitCode===0&&/(email|username|account)/i.test(probe.output)?'connected':'unverified',detail:'Kilo can reuse its local provider configuration. Open kilo to connect or select kilo-auto/free. A successful profile check does not guarantee all models are available.'};}
 if(id==='codex')probe=await runProcess('codex',['login','status'],{timeout:5000});
 if(id==='opencode'){
  probe=await runProcess('opencode',['auth','list','--format','json'],{timeout:6500});
  let count=probe.exitCode===0?countOpenCodeAccounts(probe.output):0;
  // Older OpenCode installations expose a plain-text account list instead of --format json.
  // Only infer connection when a recognizable provider line is present; never read credential files.
  if(count===0){const older=await runProcess('opencode',['auth','list'],{timeout:5500});
   if(older.exitCode===0)count=parseOpenCodeAuthList(older.output);
  }
  return {id,installed:true,auth:count>0?'connected':'unverified',authSource:'opencode-local-service',accountCount:count,
   detail:count>0?`${count} existing OpenCode connection(s) recognized from the CLI / local app. No credentials were copied.`:'OpenCode Desktop, IDE extension and CLI can use the same local OpenCode service. Click Recheck existing session. To add ChatGPT / Claude Agent without an API key, select the browser or CLI login method in OpenCode.'};
 }
 return{id,installed:true,auth:probe.exitCode===0?'connected':'not-connected',detail:probe.exitCode===0?'Existing official CLI session detected. No new API key needed.':'No active CLI sign-in detected. Start the official browser sign-in.'};
}
// Local host preflight only. No model tokens and no elevated privileges.
async function dockerDaemonPreflight(){
 const r=await runProcess('docker',['info','--format','{{.ServerVersion}}'],{timeout:4500});
 if(r.exitCode===0)return{status:'ready',detail:'Docker daemon reachable with current user permissions.'};
 return{status:'blocked',detail:'Docker is required by this stage, but the daemon is unavailable or this user cannot reach it. Inspect `docker info`, the service state and socket access; never auto-run sudo or modify docker group membership.',raw:String(r.stderr||r.output||'Docker executable missing').slice(-350)};
}
// Workflow-wide readiness check occurs before the expensive planning model call.
// Never run a $1+ architect plan if the downstream implementer cannot start.
async function workflowReadiness(stages,cwd){
 const checked=new Set();const errors=[];
 if(stages.some(s=>s.requiresDocker)){const check=await dockerDaemonPreflight();if(check.status!=='ready')errors.push(`Docker preflight: ${check.detail} ${check.raw||''}`);}
 for(const [i,s] of stages.entries()){
  if(checked.has(s.agent))continue;checked.add(s.agent);
  const p=await checkProvider(s.agent);
  if(!p.installed){errors.push(`Stage ${i+1} (${s.name}): ${s.agent} CLI is missing from SBQ PATH. Install it or change this stage.`);continue;}
  if(p.auth==='not-connected'){errors.push(`Stage ${i+1} (${s.name}): ${s.agent} is not authenticated. Sign in through Connections first.`);continue;}
  if(s.agent==='codex'){
   const check=await codexSandboxPreflight({cwd});
   if(check.status==='blocked'||check.status==='unverified')errors.push(`Stage ${i+1} (${s.name}): Codex sandbox ${check.status}. ${check.detail} ${check.raw||''}`.slice(0,1100));
  }
 }
 return errors;
}
const LOGIN_COMMANDS={claude:'claude auth login',codex:'codex login',agy:'agy',opencode:'opencode auth login',gemini:'gemini',kilo:'kilo',freebuff:'freebuff'};
const runs=new Map();const abortControllers=new Map();const continuations=new Map();
const saveTimers=new Map();
function persistRun(run){
 try{
  mkdirSync(RUN_DIR,{recursive:true,mode:0o700});
  const filename=join(RUN_DIR,run.id+'.json');
  const staged=filename+'.tmp';
  writeFileSync(staged,JSON.stringify(run),{mode:0o600});
  renameSync(staged,filename);
 }catch(error){console.error('SBQ local history persistence failed:',error.message);}
}
function schedulePersist(run){
 if(saveTimers.has(run.id))return;
 const timer=setTimeout(()=>{saveTimers.delete(run.id);persistRun(run);},250);
 timer.unref?.();saveTimers.set(run.id,timer);
}
// Enough state to restart one stage after the engine stops (app closed, crash,
// reboot). Saved with the run history; retry still needs explicit user consent.
function resumeState(state){return{stages:state.stages,startIndex:state.startIndex,previous:String(state.previous||'').slice(-MAX_CONTEXT_CHARS),attempts:[...(state.attempts||new Map())],completedEdits:state.completedEdits||0,partialEdits:state.partialEdits||0,partialFiles:(state.partialFiles||[]).slice(0,100)};}
function continuationFromResume(r){return{...r,attempts:new Map(Array.isArray(r.attempts)?r.attempts:[])};}
function restoreAfterRestart(run){
 const r=run.resume,stage=Array.isArray(r?.stages)?r.stages[r.startIndex]:null;
 if(!stage)return false;
 if(run.status==='needs-input'&&run.pendingInput){
  continuations.set(run.id,continuationFromResume(r));
  run.events.push({id:randomUUID(),type:'system',text:'SBQ restarted. Your planning answers can still continue this run; planning will not be repeated.',ts:Date.now()});
  return true;
 }
 const last=run.stageResults.at(-1);if(last&&['running','awaiting-approval'].includes(last.status))last.status='interrupted';
 run.pendingApproval=null;run.pendingInput=null;
 run.pendingRecovery=run.pendingRecovery||{stageId:stage.id,stageName:stage.name,agent:stage.agent,code:'INTERRUPTED',
  title:'SBQ closed while this stage was running',
  detail:'Earlier completed stages and the architect plan are kept. Check the project files, then retry only this stage.',
  changedFiles:(r.partialFiles||[]).slice(0,100),attempts:run.recoveryAttempts?.[stage.id]||0,maxAttempts:2,
  warning:'Retry makes a NEW agent request and may consume tokens. Previously completed stages will not be re-run.'};
 run.status='needs-attention';
 continuations.set(run.id,{...continuationFromResume(r),recovery:true});
 run.events.push({id:randomUUID(),type:'warning',text:`SBQ restarted while "${stage.name}" was unfinished. Completed stages are kept; you can retry only this stage.`,ts:Date.now(),stageId:stage.id});
 return true;
}
function loadPreviousRuns(){
 mkdirSync(RUN_DIR,{recursive:true,mode:0o700});
 const names=readdirSync(RUN_DIR).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).slice(-80);
 for(const name of names){try{
  const run=JSON.parse(readFileSync(join(RUN_DIR,name),'utf8'));
  if(!run||run.id+'.json'!==name||typeof run.cwd!=='string'||!Array.isArray(run.events)||!Array.isArray(run.stageResults))continue;
  if(['running','queued','needs-approval','needs-input'].includes(run.status)||run.pendingRecovery){
   if(restoreAfterRestart(run)){persistRun(run);runs.set(run.id,run);continue;}
   run.status='interrupted';run.pendingApproval=null;run.pendingInput=null;run.pendingRecovery=null;
   run.events.push({id:randomUUID(),type:'warning',text:'The previous engine session ended. The run and stage outputs are preserved, but this CLI session cannot be safely resumed automatically. Review repository changes before starting a new run.',ts:Date.now()});
   persistRun(run);
  }
  runs.set(run.id,run);
 }catch{/* A corrupt history file must never prevent startup. */}}
}
function emit(run,type,text,extra={}){run.events.push({id:randomUUID(),type,text:String(text).slice(0,2000),ts:Date.now(),...extra});if(run.events.length>1200)run.events.splice(0,run.events.length-1200);run.updatedAt=Date.now();schedulePersist(run);}
function compactEvent(line,agent){let o;try{o=JSON.parse(line);}catch{return null;}
 // Fatal machine-readable errors must be visible and must block stage approval.
 if(o.type==='error'||o.type==='turn.failed'||o.type==='item.failed'||o.event==='error'||o.is_error===true){
  const reason=o.error?.message||o.message||o.item?.error?.message||o.details||JSON.stringify(o.error||o);
  return {kind:'error',text:String(reason).slice(0,1400)};
 }
 if(agent==='agy'){
  if(o.event==='step_update'){const t=o.step_update||{};if(t.text_delta)return{kind:'message',text:t.text_delta};if(t.step_type==='tool'&&t.state==='ACTIVE')return{kind:'tool',text:`Tool: ${t.tool_name||'activity'}`};}
  if(o.event==='result'){
   const status=String(o.result?.status||'').toUpperCase();
   if(status&&status!=='SUCCESS')return{kind:'error',text:`Antigravity ${status}: ${o.result?.error||'No further diagnostic supplied'}`};
   if(o.result?.response)return{kind:'result',text:o.result.response};
  }
 }
 if(agent==='claude'){
  if(o.type==='stream_event'&&o.event?.type==='content_block_delta'&&o.event.delta?.type==='text_delta')return{kind:'message',text:o.event.delta.text};
  if(o.type==='assistant'){const tools=(o.message?.content||[]).filter(x=>x.type==='tool_use').map(x=>x.name);if(tools.length)return{kind:'tool',text:`Tools: ${tools.join(', ')}`};}
  if(o.type==='result'){if(o.is_error)return{kind:'error',text:String(o.result||'Claude returned an error')};return{kind:'result',text:o.result||''};}
 }
 if(agent==='codex'){
  if(o.type==='item.completed'&&o.item?.type==='agent_message')return{kind:'message',text:o.item.text||''};
  if(o.type==='item.started'&&o.item?.type==='command_execution')return{kind:'tool',text:`Command: ${String(o.item.command||'repository command').slice(0,220)}`};
  if(o.type==='item.completed'&&o.item?.type==='command_execution'){
   const detail=String(o.item.aggregated_output||o.item.output||'');
   if(codexSandboxError(detail))return{kind:'error',text:`Codex sandbox failure: ${detail.slice(-600)}`};
   return{kind:'tool',text:`Command finished (exit ${o.item.exit_code??'unknown'})${o.item.exit_code!==0&&detail?` · ${detail.slice(-250)}`:''}`};
  }
  if(o.type==='turn.completed')return{kind:'output',text:`Codex CLI turn ended (NOT stage verification)${o.usage?` · input ${o.usage.input_tokens||0}, output ${o.usage.output_tokens||0} tokens`:''}`};
 }
 if(agent==='gemini'){if(o.type==='message'&&o.role==='assistant'&&o.content)return{kind:'message',text:String(o.content)};if(o.type==='tool_use')return{kind:'tool',text:`Tool: ${o.tool_name||o.name||'activity'}`};if(o.type==='result'&&o.response)return{kind:'result',text:String(o.response)};}
 if(agent==='opencode'||agent==='kilo'){if(o.type==='text'&&o.part?.text)return{kind:'message',text:o.part.text};if(o.type==='tool')return{kind:'tool',text:`Tool activity: ${o.part?.tool||'tool'}`};}
 return null;
}
// The requested role determines permissions, not the runner name. Never put an
// implementation/support agent into read-only planning mode.
// Writable stages may install project packages unless the stage opts out.
// Read-only roles (plan/review/release) never get network or extra write access.
export function stageAllowsInstalls(s){return ['implement','support'].includes(s.role)&&s.allowNetwork!==false;}
export function makeCommand(s,prompt,{isGitRepo=true,cwd,allowedTools=[],resumeSessionId=null,cacheDir=AGENT_CACHE_DIR}={}){
 const model=s.modelMode==='default'?'':s.model?.trim(), effort=s.effort;
 const writable=['implement','support'].includes(s.role);
 const installs=stageAllowsInstalls(s);
 if(s.agent==='claude'){
  const args=['-p',prompt,'--output-format','stream-json','--verbose','--permission-mode',writable?'acceptEdits':'plan'];
  if(resumeSessionId)args.push('--resume',resumeSessionId);
  const tools=[...new Set([...allowedTools,...(installs?INSTALL_COMMANDS.map(c=>`Bash(${c})`):[])])];
  if(tools.length)args.push('--allowedTools',...tools);
  if(model)args.push('--model',model);
  if(effort&&effort!=='default')args.push('--effort',effort);
  return ['claude',args];
 }
 if(s.agent==='codex'){
  const args=['exec','--json','--sandbox',writable?'workspace-write':'read-only'];
  if(!isGitRepo)args.push('--skip-git-repo-check');
  if(cwd)args.push('--cd',cwd);
  let env;
  if(installs){
   // workspace-write blocks the network and every folder outside the project by
   // default, so `npm install` failed with EAI_AGAIN and unwritable ~/.npm logs.
   // Allow the network and point package caches at one private SBQ folder.
   args.push('-c','sandbox_workspace_write.network_access=true','--add-dir',cacheDir);
   // Each tool reads its own variable names (pnpm 11 ignores npm_config_*).
   // XDG_CACHE_HOME covers tools that cache under ~/.cache (Prisma engines,
   // node-gyp, Playwright); corepack then keeps pnpm/yarn in the same folder.
   env={npm_config_cache:join(cacheDir,'npm'),pnpm_config_store_dir:join(cacheDir,'pnpm-store'),pnpm_config_cache_dir:join(cacheDir,'pnpm-cache'),
    YARN_CACHE_FOLDER:join(cacheDir,'yarn'),BUN_INSTALL_CACHE_DIR:join(cacheDir,'bun'),XDG_CACHE_HOME:join(cacheDir,'xdg-cache'),
    COREPACK_HOME:join(cacheDir,'corepack'),COREPACK_ENABLE_DOWNLOAD_PROMPT:'0'};
  }
  if(model)args.push('--model',model);
  if(effort&&effort!=='default')args.push('-c',`model_reasoning_effort=${effort}`);
  // Force explicit stdin-input mode; passing a positional prompt can make some
  // CLI versions wait indefinitely for additional stdin in an Electron process.
  args.push('-');return ['codex',args,{input:prompt,env}];
 }
 if(s.agent==='agy'){
  const args=['-p',prompt,'--output-format','stream-json','--mode',writable?'accept-edits':'plan'];
  if(model)args.push('--model',model);
  if(effort&&['low','medium','high'].includes(effort))args.push('--effort',effort);
  return ['agy',args];
 }
 if(s.agent==='gemini'){
  const args=['-p',prompt,'--output-format','stream-json'];
  if(model)args.push('--model',model);
  if(!writable)args.push('--approval-mode','plan');
  return ['gemini',args];
 }
 const args=['run','--format','json','--agent',writable?'build':'plan'];
 if(model)args.push('--model',model);
 if(effort&&effort!=='default')args.push('--variant',effort);
 args.push(prompt);
 return [s.agent,args];
}
export function reviewVerdict(output){
 // Only a standalone final verdict counts. Ignore markers quoted in task text,
 // code blocks or prior review reports. Ambiguity must not silently pass.
 const lines=String(output||'').trim().split(/\r?\n/).map(x=>x.trim());
 const tail=lines.filter(Boolean).at(-1)||'';
 const m=tail.match(/(?:^|\s)SBQ_REVIEW_VERDICT:\s*(PASS|FIX)$/i);
 return m?m[1].toUpperCase():null;
}
// Only predeclared, explicit project check commands are executed. No shell,
// interpolation, or pipelines; this is not an arbitrary command terminal.
// A stage can create useful files and still be blocked by a missing local service.
// Keep its evidence and allow ONE explicit, user-approved retry of that stage;
// never replay the expensive architect stage implicitly.
export function environmentBlocker(text){
 const value=String(text||'');
 if(codexSandboxError(value))return{code:'CODEX_SANDBOX_BLOCKED',title:'Codex sandbox could not start',detail:'Fix the local Bubblewrap/AppArmor configuration before retrying; do not disable host security.'};
 if(/(?:cannot connect to the docker daemon|docker daemon.*(?:not running|not available|access)|docker daemon access needs to be available|permission denied.*docker\.sock|docker\.sock.*permission denied)/i.test(value))return{code:'DOCKER_UNAVAILABLE',title:'Docker daemon unavailable',detail:'Check Docker service and socket access on your machine, then explicitly retry this stage. Do not grant unrestricted Docker access automatically.'};
 if(/(?:npm (?:install|ci).{0,140}(?:did not complete|failed|network|offline)|dependencies (?:are|were) (?:absent|missing|not installed)|offline cache (?:lacks|is missing)|ERR_PNPM_FETCH|ENOTCACHED|EAI_AGAIN)/i.test(value))return{code:'DEPENDENCIES_UNAVAILABLE',title:'Project dependencies unavailable',detail:'Some required dependencies were not installed, so build/tests cannot be verified. Check registry/network access and install the project dependencies with your approval; verify locally, then explicitly retry only this stage.'};
 return null;
}
const CHECK_COMMANDS={
 'npm test':['npm',['test']], 'npm run test':['npm',['run','test']],
 'npm run build':['npm',['run','build']], 'npm run lint':['npm',['run','lint']],
 'pnpm test':['pnpm',['test']], 'pnpm build':['pnpm',['build']],
 'dotnet test':['dotnet',['test']], 'pytest':['pytest',[]],
 'php artisan test':['php',['artisan','test']], 'composer test':['composer',['test']]
};
async function runCheck(command,cwd,signal,onLine){
 if(!command)return {skipped:true};
 const spec=CHECK_COMMANDS[command];
 if(!spec) return {exitCode:2,stderr:`Unsupported verification command: ${command}. Choose one of: ${Object.keys(CHECK_COMMANDS).join(', ')}`};
 return runProcess(spec[0],spec[1],{cwd,signal,timeout:120000,onLine});
}
// Trust only machine-readable CLI status, NEVER scan assistant prose for the
// words "permission", "approval", "denied", etc. Those words commonly appear
// in architecture plans, test expectations, and the user's own task.
export function analyzeCliResult(result){
 let fatal=null,sessionId=null,totalCostUsd=null;
 const denials=[],requested=[];
 if(result.timedOut)return {fatal:'The CLI timed out while running the stage.',denials,requested,sessionId,totalCostUsd};
 for(const line of (result.output||'').split(/\r?\n/)){
  let event;try{event=JSON.parse(line);}catch{continue;}
  if(!event||typeof event!=='object')continue;
  if(event.event==='result'&&event.result&&typeof event.result==='object'){
   const agyStatus=String(event.result.status||'').toUpperCase();
   if(agyStatus&&agyStatus!=='SUCCESS')fatal=`Antigravity ${agyStatus}: ${String(event.result.error||'The agent did not complete the turn').slice(0,500)}`;
   if(typeof event.result.conversation_id==='string')sessionId=event.result.conversation_id;
  }
  if(event.type==='result'){
   if(typeof event.session_id==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(event.session_id))sessionId=event.session_id;
   if(typeof event.total_cost_usd==='number'&&Number.isFinite(event.total_cost_usd))totalCostUsd=event.total_cost_usd;
   if(Array.isArray(event.permission_denials))requested.push(...event.permission_denials);
  }
  if(event.type==='system'&&event.subtype==='permission_denied')requested.push(event);
  if(['error','turn.failed','item.failed'].includes(event.type)||event.event==='error'||event.is_error===true||event.status==='ERROR'||(event.type==='result'&&String(event.subtype||'').startsWith('error_'))){
   fatal=String(event.error?.message||event.message||event.result||event.item?.error?.message||'The CLI returned a structured error').slice(0,600);
  }
 }
 const seen=new Set(),requests=[];
 for(const denial of requested){
  const tool=String(denial?.tool_name||denial?.tool||'unknown').slice(0,60);
  const toolInput=denial?.tool_input||denial?.input||{};
  const command=typeof toolInput.command==='string'?toolInput.command.slice(0,400):'';
  const path=typeof toolInput.file_path==='string'?toolInput.file_path.slice(0,400):'';
  const key=JSON.stringify([tool,command,path]);if(seen.has(key))continue;seen.add(key);
  requests.push({tool,command,path});denials.push(tool);
 }
 return {fatal,denials:[...new Set(denials)],requested:requests,sessionId,totalCostUsd};
}
// Permission rules are narrow and derived only from machine-readable denied
// tool calls. Never accept arbitrary tool rules from a browser or a prompt.
function isWithinWorkspace(file,cwd){
 if(!file||!cwd)return false;
 const target=resolve(cwd,file),base=resolve(cwd);
 const rel=relative(base,target);
 if(rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep))return false;
 // Never pre-approve files reached through symlinks (which can escape cwd).
 let current=target;
 while(current!==base){if(existsSync(current)){try{if(lstatSync(current).isSymbolicLink())return false;}catch{return false;}}current=dirname(current);}
 return true;
}
const SAFE_COMMAND=/^(?:php artisan test(?:\s+--(?:filter|testsuite|group)\s*[= ]\s*[A-Za-z0-9_\\-]+)?|vendor\/bin\/pint(?:\s+--test)?|npm test|npm run (?:test|lint|build)|composer test|dotnet test|pytest|composer install|dotnet restore|go mod download|cargo fetch|npm (?:install|ci)|pnpm install|yarn install|bun install)(?:\s*)$/;
export function suggestedToolPermission(request,cwd){
 const {tool,command,path}=request;
 if(tool==='Bash'){
  // Exact, simple project verification commands only. No shell punctuation,
  // pipelines, globs, redirects, environment assignments or destructive flags.
  if(!command||/[;&|`$<>\n\r*?{}]/.test(command)||!SAFE_COMMAND.test(command))return null;
  return `Bash(${command.trim()})`;
 }
 if(process.platform!=='win32'&&['Read','Write','Edit'].includes(tool)&&path&&isWithinWorkspace(path,cwd)){
  if(/(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|\.npmrc)$/i.test(path))return null;
  const target=resolve(cwd,path);
  // Claude's path rules use // for an absolute filesystem path;
  // Edit(path) covers both Edit and Write tools.
  return `${tool==='Read'?'Read':'Edit'}(//${target.replace(/^\/+/, '')})`;
 }
 return null;
}
function permissionChoices(requested,cwd){return requested.map(r=>({...r,rule:suggestedToolPermission(r,cwd)}));}

// Local-only visible results, not hidden model thoughts or raw credential-bearing CLI JSON.
// Artifacts survive a UI refresh; they never leave the user's machine.
function storeStageArtifact(run,stageRecord,content){
 if(!String(content||'').trim())return;
 ensureData();mkdirSync(ARTIFACT_DIR,{recursive:true,mode:0o700});
 const filename=`${run.id}-${run.stageResults.length}-${stageRecord.role}.txt`;
 const fullpath=join(ARTIFACT_DIR,filename);
 writeFileSync(fullpath,String(content).slice(-200000),{mode:0o600});
 stageRecord.artifact=filename;
}
export function contextualExcerpt(value,max=MAX_CONTEXT_CHARS){
 const text=String(value||'');
 if(text.length<=max)return text;
 // The beginning usually contains the implementation contract and acceptance
 // criteria; the tail contains the final outcome and caveats. Preserve both.
 const front=Math.floor(max*0.7),back=max-front;
 return text.slice(0,front)+'\n\n[SBQ: long output abbreviated; full local stage artifact retained]\n\n'+text.slice(-back);
}


// Ask for missing business decisions explicitly, instead of proceeding on
// invented assumptions or treating a complete planning response as a failure.
// In plan mode Claude Code often saves the full plan to ~/.claude/plans/<name>.md
// and replies with a short summary. Hand the full file to later stages instead.
// Only files inside that folder, written during this stage, are read.
export function claudePlanFromOutput(text,{home=homedir(),configDir=join(home,'.claude'),since=0}={}){
 const dir=join(configDir,'plans');
 const candidates=[...String(text||'').matchAll(/(?:~|\/)[^\s`'"()<>]+?\.md\b/g)].map(m=>m[0].replace(/^~/,home));
 for(const candidate of candidates.reverse()){
  try{
   const file=resolve(candidate);
   if(dirname(file)!==dir)continue;
   const real=realpathSync(file);if(dirname(real)!==realpathSync(dir))continue;
   const info=statSync(real);
   if(!info.isFile()||info.size>400000||info.mtimeMs<since-2000)continue;
   const content=readFileSync(real,'utf8');
   if(content.trim())return content;
  }catch{}
 }
 return null;
}
// Instructions for a writable stage when the project's packages are missing.
export function dependencySetupHint(deps,{allowInstall=true}={}){
 return [`Node.js dependency check: ${deps.missingCount||'Some'} declared package(s) were not found (${(deps.missing||[]).slice(0,5).map(x=>`${x.manifest}: ${x.dependency}`).join(', ')}).`,
  'Determine whether they are relevant to this task before installing anything; this repository may contain multiple projects or languages. Inspect the appropriate manifest, lockfile, and project instructions.',
  allowInstall?'If they are needed, use the appropriate project directory and package manager; never use sudo or global installs.':'Installing packages or accessing the network is not enabled for this stage. Continue work that does not need them, and report any verification you cannot perform.',
  'Package and tool caches are redirected to a writable SBQ folder.'].join(' ');
}

export function planningQuestions(text){
 const answer=String(text||'');
 const match=answer.match(/(?:\*\*)?Questions for you\s*:\s*(?:\*\*)?/i);
 if(match)return answer.slice(match.index).replace(/SBQ_INPUT_REQUIRED:\s*(?:YES|NO)/gi,'').trim().slice(0,3000);
 if(/SBQ_INPUT_REQUIRED:\s*YES\b/i.test(answer))return answer.slice(-3000);
 return null;
}
function recordLocalEvidence(run,stage,before,after){
 const report=localChangeReport(before,after);
 if(!report.files.length)return;
 const current=run.localChanges||{source:'local-snapshot',isGitRepo:false,files:[],diff:'',note:''};
 const fileMap=new Map(current.files.map(x=>[x.path,x]));
 for(const file of report.files)fileMap.set(file.path,{...file,stageId:stage.id,stageName:stage.name});
 const chunk=`\n# Changes from stage: ${stage.name}\n`+report.diff;
 // Keep most recent stage diff evidence in bounded local run history; do not
 // claim this is a complete original-to-current Git diff across multiple stages.
 run.localChanges={source:'local-snapshot',isGitRepo:false,files:[...fileMap.values()].slice(0,300),
  diff:(current.diff+chunk).slice(-190000),truncated:current.truncated||report.truncated,
  note:'SBQ run-local file changes (including partial work); no Git repository required. Text patches are per-stage, not an original Git baseline. Tests remain unverified unless executed.',
  changedCount:fileMap.size};
 schedulePersist(run);
}
function oldRunEvidence(run){
 const entries=new Map();
 for(const stage of run.stageResults||[]){
  for(const item of stage.changedFiles||[]){
   const name=String(item.path||'');
   // Historical records have file names but no saved baseline. Don't fabricate diffs.
   if(!name||name.includes('\0')||name.startsWith('/')||name.split(/[\\/]/).includes('..'))continue;
   entries.set(name,{path:name,status:item.status||'modified',stageId:stage.id,stageName:stage.name});
  }
 }
 if(!entries.size)return null;
 return{source:'local-observations',isGitRepo:false,files:[...entries.values()].slice(0,300),diff:'',changedCount:entries.size,
  note:'Historical SBQ run: recorded file names only. The old version did not preserve before/after text, so a trustworthy historical diff is unavailable. Select the project path and inspect these files directly.'};
}
function runChangeReport(run,{file}={}){
 const result=run.localChanges||oldRunEvidence(run);
 if(!result)return{source:'local-snapshot',isGitRepo:false,files:[],diff:'',note:'No SBQ file-change evidence recorded for this run yet. This does not imply the project is clean.'};
 if(!file)return result;
 if(!result.files.some(x=>x.path===file))throw new Error('File is not part of this run change evidence');
 const sections=result.diff.split(/(?=diff --local a\/)/).filter(x=>x.includes(`diff --local a/${file} b/${file}\n`));
 return {...result,files:result.files.filter(x=>x.path===file),diff:sections.join('\n')};
}
function latestLocalRun(cwd){return [...runs.values()].filter(r=>r.cwd===cwd&&(r.localChanges?.files?.length||oldRunEvidence(r)?.files?.length)).sort((a,b)=>b.createdAt-a.createdAt)[0];}
function pauseForRecovery(run,stage,stageIndex,stages,state,blocker,output,observedFiles=[]){
 const oldAttempts=run.recoveryAttempts?.[stage.id]||0;
 run.status='needs-attention';run.pendingRecovery={stageId:stage.id,stageName:stage.name,agent:stage.agent,
  code:blocker.code,title:blocker.title,detail:blocker.detail,
  changedFiles:observedFiles.slice(0,100),attempts:oldAttempts,maxAttempts:2,
  warning:'Retry makes a NEW agent request and may consume tokens. Previously completed stages will not be re-run.'};
 continuations.set(run.id,{...state,stages,startIndex:stageIndex,
  partialFiles:observedFiles.slice(0,100),
  previous:[state.previous,`BLOCKED STAGE OUTPUT (not complete):\n${contextualExcerpt(output,16000)}`].filter(Boolean).join('\n\n'),
  recovery:true});
 run.resume=resumeState(continuations.get(run.id));
 emit(run,'warning',`${stage.name}: ${blocker.title}. ${observedFiles.length} changed file(s) retained as PARTIAL work; no following stages will run. Review the work, fix the environment and explicitly retry this stage.`,{stageId:stage.id,agent:stage.agent,code:blocker.code});
}
async function executeWorkflow(run,stages,signal,{startIndex=0,previous='',attempts=new Map(),completedEdits=0,approvedTools=[],resumeSessionId=null,permissionRetries=0,partialEdits=0,partialFiles=[],recovery=false}={}){

 run.status='running';run.pendingApproval=null;run.pendingRecovery=null;emit(run,'system',startIndex?'Continuing from approved planning decisions; no planning model call repeated.':'Workflow started; local file verification is enabled.');
 for(let i=startIndex;i<stages.length;i++){
  if(signal.aborted){run.status='canceled';break;}
  const s=stages[i];run.stageIndex=i;
  const stageRecord={id:s.id,name:s.name,role:s.role,agent:s.agent,status:'running',changedFiles:[],checks:[],attempt:permissionRetries+1};
  run.stageResults.push(stageRecord);
  run.resume=resumeState({stages,startIndex:i,previous,attempts,completedEdits,partialEdits,partialFiles});
  emit(run,'stage',`Starting ${s.name} (${s.role})`,{agent:s.agent,model:s.modelMode==='default'?'CLI default':s.model,stageId:s.id});
  // Detect missing CLIs and reliable unauthenticated sessions before any model
  // request; ambiguous IDE/keyring sessions remain unverified, not rejected.
  const account=await checkProvider(s.agent);
  if(!account.installed||account.auth==='not-connected'){
   stageRecord.status='blocked';run.status='needs-attention';
   emit(run,'error',`${s.name}: ${!account.installed?'Agent CLI is not installed or not visible to SBQ.':'The official CLI reports no active login.'} Open Connections and complete the supported sign-in before retrying. No model request was sent.`,{agent:s.agent,stageId:s.id,code:'AGENT_NOT_READY'});
   break;
  }
  if(s.agent==='agy'&&account.auth==='unverified')emit(run,'warning','Antigravity can reuse your existing IDE/CLI keyring session. SBQ cannot confirm it with a free auth-status API; execution will report any authentication error directly.',{agent:s.agent,stageId:s.id});
  // Preflight must run *before* sending a paid prompt. Failed namespace
  // initialization is a host setup problem, not a retryable model decision.
  if(s.requiresDocker){const docker=await dockerDaemonPreflight();if(docker.status!=='ready'){stageRecord.status='blocked';run.status='needs-attention';emit(run,'error',`${s.name}: Docker is required but not ready. ${docker.detail} ${docker.raw||''}`,{agent:s.agent,stageId:s.id,code:'DOCKER_UNAVAILABLE'});break;}}
  if(s.agent==='codex'){
   const probe=await codexSandboxPreflight({cwd:run.cwd});
   if(probe.status==='blocked'){
    stageRecord.status='blocked';run.status='needs-attention';
    emit(run,'error',`${s.name}: ${probe.detail} ${probe.raw||''}`,{agent:s.agent,stageId:s.id,code:'CODEX_SANDBOX_BLOCKED'});
    break;
   }
   if(probe.status==='unverified'){
    stageRecord.status='blocked';run.status='needs-attention';
    emit(run,'error',`${s.name}: Codex sandbox could not be verified; stage stopped before model execution. ${probe.detail}`,{agent:s.agent,stageId:s.id,code:'CODEX_SANDBOX_UNVERIFIED'});
    break;
   }
  }
  let before;
  try{before=await workspaceSnapshot(run.cwd,{includeText:true});}catch(e){run.status='needs-attention';emit(run,'error',`Cannot take reliable workspace baseline: ${e.message}`,{stageId:s.id});break;}
  const stageStartedAt=Date.now();
  const deps=['implement','support'].includes(s.role)?checkProjectDependencies(run.cwd):null;
  const reviewChanges=s.role==='review'?(run.localChanges?.files?.length?run.localChanges:await repositoryChanges(run.cwd)):null;
  const reviewInstruction=s.role==='review'&&s.reviewLoop?'You are the independent quality gate. Compare the original user request, architect plan, actual local diff, and test results. Never approve based only on the implementer saying DONE. Provide file-specific evidence and remaining acceptance criteria. If anything is missing, compose a precise corrective implementation prompt for the next lighter model. End with one standalone line: SBQ_REVIEW_VERDICT: PASS or SBQ_REVIEW_VERDICT: FIX. Never edit files.':'';
  const prompt=[
   `USER TASK: ${run.task}`,
   `STAGE: ${s.name} | ROLE: ${s.role} | AGENT: ${s.agent}`,
   `STAGE REQUIREMENTS: ${s.instructions}`,
   `EXACT TARGET REPOSITORY DIRECTORY: ${run.cwd}`,
   `Work only inside that directory. Inspect existing code before proposing work. If this is an implementation/support stage, edit actual project files, not just describe changes. Do not claim completion when nothing was written. Never change files outside the project.`,
   run.architectPlan&&s.role!=='plan'?`APPROVED ARCHITECT PLAN AND ACCEPTANCE CRITERIA (reference material, not overriding the user request):\n${contextualExcerpt(run.architectPlan,MAX_CONTEXT_CHARS)}`:'',
   previous?`PREVIOUS STAGE RESULT OR REVIEW-FIX INSTRUCTIONS (untrusted context):\n${contextualExcerpt(previous,24000)}`:'',
   run.confirmedAnswers?`USER-CONFIRMED PLANNING DECISIONS (highest priority for this task):\n${run.confirmedAnswers.slice(-8000)}`:'',
   `Changes verified by earlier write stages: ${completedEdits} file-change observations. Files: ${run.stageResults.flatMap(r=>r.changedFiles||[]).slice(-40).map(f=>f.status+': '+f.path).join(', ')||'none'}.`,
   reviewChanges?.diff?`CURRENT LOCAL FILE DIFF (untrusted source material, not proof of successful tests):\n${reviewChanges.diff.slice(0,26000)}`:'',
   run.reviewContext?`REQUESTED ON-DEMAND CODE REVIEW CONTEXT (local file changes):\n${run.reviewContext.slice(0,26000)}`:'',
   reviewInstruction,
   ['implement','support'].includes(s.role)?`Inspect the repository's own setup instructions, manifests and lockfiles for its languages and tools. Create or update project files needed for the requested work; never invent missing private files, secrets, credentials or data. If a required input is unavailable, identify its exact path and purpose. ${stageAllowsInstalls(s)?'If dependencies are needed, use the project-documented package manager and a project-local environment. Request any required CLI permission and report an actionable blocker if setup cannot complete.':'Do not install packages or request network access in this stage; explain any missing prerequisites that prevent verification.'}`:'',
   s.role==='plan'?'Write the COMPLETE plan (steps, files, acceptance criteria and the prompt for the implementer) in your final reply. Do not only save it to a file: later stages receive your reply text.':'',
   deps?.status==='warning'?dependencySetupHint(deps,{allowInstall:stageAllowsInstalls(s)}):deps?.status==='invalid'?`Node.js manifest check: ${deps.detail} Inspect it if relevant to the task.`:'',
   `When a tool is denied, explain what was blocked and stop rather than claiming the task is done. ${s.role==='review'&&s.reviewLoop?'For review, finish with your SINGLE standalone SBQ_REVIEW_VERDICT: PASS or SBQ_REVIEW_VERDICT: FIX line as the final line. Do not append SBQ_STAGE_STATUS.':'At the end include SBQ_STAGE_STATUS: COMPLETE or SBQ_STAGE_STATUS: PARTIAL or SBQ_STAGE_STATUS: BLOCKED. Supporting tasks may use SBQ_STAGE_STATUS: SKIPPED when genuinely unnecessary.'} Never claim COMPLETE with outstanding tests, docs or implementation gaps. Do NOT commit, push, deploy, install dependencies globally, or run destructive commands without separate user approval. ${['plan','review','release'].includes(s.role)?'Read-only: do not modify files.':''}`
  ].filter(Boolean).join('\n\n');
  if(stageAllowsInstalls(s))mkdirSync(AGENT_CACHE_DIR,{recursive:true,mode:0o700});
  const [cmd,args,io]=makeCommand(s,prompt,{isGitRepo:reviewChanges?.isGitRepo??(await repositoryChanges(run.cwd)).isGitRepo,cwd:run.cwd,allowedTools:[...new Set([...(s.agent==='claude'&&(s.role==='implement'||s.role==='support')?(s.allowedCommands||[]).filter(c=>PREAPPROVED_CHECKS.has(c)).map(c=>`Bash(${c})`):[]),...approvedTools])],resumeSessionId:s.agent==='claude'?resumeSessionId:null});
  let response='',finalResultText='',cliErrors=[];
  const result=await runProcess(cmd,args,{cwd:run.cwd,timeout:15*60*1000,signal,input:io?.input,env:io?.env,
   onStderr:line=>{if(!line.trim())return;cliErrors.push(line);if(cliErrors.length>30)cliErrors.shift();emit(run,'output',`CLI stderr: ${line.slice(0,900)}`,{agent:s.agent,stageId:s.id});},
   onLine:line=>{
    const event=compactEvent(line,s.agent);
    if(event){emit(run,event.kind,event.text,{agent:s.agent,stageId:s.id});if(event.kind==='error'){cliErrors.push(event.text);}if(event.kind==='result'&&s.agent==='claude'&&event.text.trim())finalResultText=event.text;else if(event.kind==='message'||(event.kind==='result'&&s.agent!=='codex'))response=(response+event.text+"\n").slice(-200000);}
    else if(line&& !line.startsWith('{'))emit(run,'output',line.slice(0,900),{agent:s.agent,stageId:s.id});
   }});
  if(signal.aborted){stageRecord.status='canceled';run.status='canceled';emit(run,'warning','Run canceled');break;}
  const diagnostics=analyzeCliResult(result);
  // Capture the actual model response before any verification errors or retries.
  // Avoid raw structured streams: those may contain metadata not intended for chat.
  storeStageArtifact(run,stageRecord,finalResultText||response);
  if(diagnostics.totalCostUsd!=null){stageRecord.reportedCostUsd=diagnostics.totalCostUsd;emit(run,'usage',`${s.name}: CLI-reported cost $${diagnostics.totalCostUsd.toFixed(4)} (not necessarily billed subscription spending).`,{agent:s.agent,stageId:s.id});}
  if(diagnostics.requested.length&&!result.timedOut&&!result.missing&&!diagnostics.fatal){
   // A denied operation is not a permanent failure. Capture actual changes
   // before pausing: the stage may already have written valuable source code.
   let evidence;
   try{const after=await workspaceSnapshot(run.cwd,{includeText:true});evidence=compareSnapshots(before,after);recordLocalEvidence(run,s,before,after);}
   catch(error){run.status='needs-attention';stageRecord.status='failed';emit(run,'error',`Unable to snapshot partial changes: ${error.message}`,{stageId:s.id});break;}
   stageRecord.changedFiles=[...partialFiles,...evidence.changed];stageRecord.verification={...evidence,changed:stageRecord.changedFiles.slice(0,100)};
   if(['plan','review','release'].includes(s.role)&&evidence.changedCount){run.status='needs-attention';stageRecord.status='failed';emit(run,'error','Read-only stage modified files before the permission denial. Inspect changes manually; SBQ will not auto-resume.',{stageId:s.id});break;}
   stageRecord.status='awaiting-approval';run.status='needs-approval';
   const requests=permissionChoices(diagnostics.requested,run.cwd);
   const sessionId=diagnostics.sessionId;
   const presetCommands=s.agent==='claude'&&['implement','support'].includes(s.role)&&requests.some(x=>x.tool==='Bash')?[...PREAPPROVED_CHECKS].map(command=>({command,rule:`Bash(${command})`})) : [];
   run.pendingApproval={stageId:s.id,agent:s.agent,requests,presetCommands,partialFiles:stageRecord.changedFiles.slice(0,100),partialChangedCount:partialEdits+evidence.changedCount,canResumeSession:Boolean(sessionId),attempt:permissionRetries+1,maxAttempts:3};
   continuations.set(run.id,{stages,startIndex:i,previous,attempts:new Map(attempts),completedEdits,approvedTools:[],resumeSessionId:sessionId,permissionRetries:permissionRetries+1,partialEdits:partialEdits+evidence.changedCount,partialFiles:stageRecord.changedFiles.slice(0,100)});
   emit(run,'approval',`${s.name}: ${requests.length} permission request(s) denied by ${s.agent}. ${evidence.changedCount} partial file change(s) preserved. Review requested operations before any further model calls.`,{agent:s.agent,stageId:s.id});
   break;
  }
  const environmentalBlocker=environmentBlocker([result.output,result.stderr,cliErrors.join('\n')].join('\n'));
  const sandboxBlocked=s.agent==='codex'&&environmentalBlocker?.code==='CODEX_SANDBOX_BLOCKED';
  if(sandboxBlocked){
   stageRecord.status='blocked';run.status='needs-attention';
   emit(run,'error',`${s.name}: ${CODEX_SANDBOX_GUIDANCE}`,{agent:s.agent,stageId:s.id,code:'CODEX_SANDBOX_BLOCKED'});
   break;
  }
  const blocked=diagnostics.fatal;
  if(result.exitCode!==0||blocked){
   if(environmentalBlocker){
    let changed=[];
    try{const after=await workspaceSnapshot(run.cwd,{includeText:true});changed=compareSnapshots(before,after).changed;recordLocalEvidence(run,s,before,after);}catch{}
    stageRecord.status='blocked';stageRecord.changedFiles=[...partialFiles,...changed];
    pauseForRecovery(run,s,i,stages,{previous,attempts:new Map(attempts),completedEdits,partialEdits:partialEdits+changed.length},environmentalBlocker,result.output+'\n'+result.stderr,stageRecord.changedFiles);
    break;
   }
   stageRecord.status='failed';run.status='needs-attention';
   const detail=(cliErrors.slice(-6).join('\n')||result.stderr||result.output||'').replace(/\x1b\[[0-9;]*m/g,'').slice(-1600);
   const reason=result.timedOut?'TIMEOUT':result.missing?'CLI NOT FOUND':`exit ${result.exitCode}`;
   emit(run,'error',`${s.name} failed (${reason}). ${blocked||''} ${detail}`,{agent:s.agent,stageId:s.id});break;
  }
  let after;
  try{after=await workspaceSnapshot(run.cwd,{includeText:true});}catch(e){run.status='needs-attention';emit(run,'error',`Unable to verify workspace after ${s.name}: ${e.message}`,{stageId:s.id});break;}
  const evidence=compareSnapshots(before,after);
  recordLocalEvidence(run,s,before,after);
  stageRecord.changedFiles=[...partialFiles,...evidence.changed];
  stageRecord.verification={...evidence,changed:stageRecord.changedFiles.slice(0,100)};
  emit(run,'evidence',`${s.name}: ${evidence.changedCount} actual project file(s) changed [${evidence.method}].${evidence.changedCount?' '+evidence.changed.slice(0,8).map(f=>`${f.status}: ${f.path}`).join(', '):''}`,{agent:s.agent,stageId:s.id,changedFiles:evidence.changed.slice(0,100),changedCount:evidence.changedCount});
  if(['plan','review','release'].includes(s.role)&&evidence.changedCount){
   stageRecord.status='failed';run.status='needs-attention';
   emit(run,'error',`${s.name} was read-only but modified ${evidence.changedCount} file(s). Review the changes before continuing.`,{stageId:s.id});break;
  }
  const declaredStatuses=[...String(response+'\n'+finalResultText).matchAll(/SBQ_STAGE_STATUS:\s*(COMPLETE|PARTIAL|BLOCKED|SKIPPED)\b/gi)].map(m=>m[1].toUpperCase());
  const declaredStatus=declaredStatuses.at(-1)||null;
  if(s.role==='support'&&declaredStatus==='SKIPPED'&&!evidence.changedCount&&!partialEdits&&!s.requireChanges){
   stageRecord.status='skipped';emit(run,'system',`${s.name}: no supporting edits needed; moving to final verification.`,{stageId:s.id});
   previous='Supporting tasks checked: no additional files required.';continue;
  }
  if(['PARTIAL','BLOCKED'].includes(declaredStatus)){
   stageRecord.status=declaredStatus==='BLOCKED'?'blocked':'partial';run.status='needs-attention';
   const blocker=environmentBlocker(response+'\n'+finalResultText+'\n'+result.output)||{
    code:declaredStatus==='BLOCKED'?'AGENT_BLOCKED':'PARTIAL_WORK',
    title:declaredStatus==='BLOCKED'?'Agent blocked before completing the stage':'Stage has unfinished requirements',
    detail:'Review the stage output and remaining requirements before retrying.'};
   pauseForRecovery(run,s,i,stages,{previous,attempts:new Map(attempts),completedEdits,partialEdits:partialEdits+evidence.changedCount},blocker,response+'\n'+finalResultText,[...partialFiles,...evidence.changed]);
   break;
  }
  if(recovery&&['implement','support'].includes(s.role)&&declaredStatus!=='COMPLETE'&&declaredStatus!=='SKIPPED'){
   stageRecord.status='unverified';run.status='needs-attention';
   emit(run,'warning',`${s.name}: recovery must explicitly confirm COMPLETE with remaining requirements done. The previous partial edits do not prove completion.`,{stageId:s.id});break;
  }
  if((typeof s.requireChanges==='boolean'?s.requireChanges:['implement','support'].includes(s.role))&&!(evidence.changedCount+partialEdits)){
   stageRecord.status='unverified';run.status='needs-attention';
   emit(run,'warning',`${s.name} returned success but changed ZERO project files. SBQ blocked completion to avoid wasting more tokens. Check permissions, the project directory, and the agent output.`,{agent:s.agent,stageId:s.id});break;
  }
  // Exiting 0 and writing files is not a completion declaration. The agent may
  // have stopped halfway through a migration or skipped tests and documentation.
  // Require an explicit marker BEFORE charging an independent reviewer.
  if(['implement','support'].includes(s.role)&&declaredStatus!=='COMPLETE'){
   stageRecord.status='unverified';
   pauseForRecovery(run,s,i,stages,{previous,attempts:new Map(attempts),completedEdits,partialEdits:partialEdits+evidence.changedCount},
    {code:'NO_COMPLETION_MARKER',title:'Agent did not confirm task completion',detail:'The agent wrote files but never declared SBQ_STAGE_STATUS: COMPLETE. Inspect the partial edits and outstanding requirements, then explicitly retry only this stage if appropriate.'},
    response+'\n'+finalResultText,[...partialFiles,...evidence.changed]);
   break;
  }
  if(['implement','support'].includes(s.role))completedEdits+=evidence.changedCount+partialEdits;
  if(s.verifyCommand){
   emit(run,'tool',`Verifying: ${s.verifyCommand}`,{stageId:s.id});
   const check=await runCheck(s.verifyCommand,run.cwd,signal,line=>emit(run,'output',line,{stageId:s.id}));
   stageRecord.checks.push({command:s.verifyCommand,exitCode:check.exitCode??null,skipped:check.skipped||false});
   if(signal.aborted){run.status='canceled';break;}
   if(check.exitCode!==0){run.status='needs-attention';stageRecord.status='failed';emit(run,'error',`Verification command failed: ${s.verifyCommand}. ${(check.stderr||'').slice(-900)}`,{stageId:s.id});break;}
   emit(run,'success',`Verification passed: ${s.verifyCommand}`,{stageId:s.id});
  }
  const output=finalResultText||response||result.output.slice(-12000)||'';
  if(['plan','review'].includes(s.role)&&!output.trim()){
   stageRecord.status='unverified';run.status='needs-attention';emit(run,'warning',`${s.name} produced no readable result. Execution stopped.`,{stageId:s.id});break;
  }
  // An agent can change files then explicitly report unfinished tests or docs.
  // Never mark that stage verified or send it to review automatically.
  if(['implement','support'].includes(s.role)&&/SBQ_STAGE_STATUS:\s*(?:PARTIAL|BLOCKED)\b/i.test(output)){
   stageRecord.status='partial';run.status='needs-attention';
   emit(run,'warning',`${s.name} reported remaining work. ${evidence.changedCount} file(s) changed, but completion is NOT verified. Review its outstanding tasks before restarting.`,{stageId:s.id});break;
  }
  const planFile=s.role==='plan'&&s.agent==='claude'?claudePlanFromOutput(output,{since:stageStartedAt,configDir:accountEnv('claude').CLAUDE_CONFIG_DIR||process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude')}):null;
  if(planFile){
   storeStageArtifact(run,stageRecord,planFile+'\n\n---\nPlanner summary:\n'+output);
   emit(run,'system',`${s.name}: Claude saved the full plan to a file; using its ${planFile.length.toLocaleString()} characters instead of the short summary.`,{stageId:s.id});
  }
  previous=contextualExcerpt(planFile?planFile+'\n\n'+output:output,MAX_CONTEXT_CHARS);
  if(s.role==='plan'){
   run.architectPlan=previous;
   emit(run,'artifact',`Architect plan captured (${output.length.toLocaleString()} characters) for the implementer and all review/fix retries.`,{stageId:s.id,artifact:stageRecord.artifact});
   const questions=planningQuestions(output);
   if(questions){
    stageRecord.status='awaiting-input';run.status='needs-input';
    run.pendingInput={stageId:s.id,questions};
    continuations.set(run.id,{stages,startIndex:i+1,previous,attempts:new Map(attempts),completedEdits});
    run.resume=resumeState(continuations.get(run.id));
    emit(run,'question',`Planning completed successfully, but needs your decisions before implementation.\n\n${questions.slice(0,1800)}`,{agent:s.agent,stageId:s.id});
    break;
   }
  }
  if(s.role==='review'&&s.reviewLoop){
   if(!completedEdits){run.status='needs-attention';emit(run,'warning','Review cannot approve a task with no verified implementation edits.',{stageId:s.id});break;}
   const verdict=reviewVerdict(output);
   if(!verdict){run.status='needs-review';emit(run,'warning','No unambiguous PASS/FIX reviewer verdict; awaiting manual review.',{stageId:s.id});break;}
   stageRecord.verdict=verdict;
   emit(run,verdict==='PASS'?'success':'warning',`Review decision: ${verdict}`,{stageId:s.id});
   if(verdict==='FIX'){
    const count=attempts.get(s.id)||0;
    if(count>=s.maxRetries){run.status='needs-review';emit(run,'warning',`Review still reports fixes after ${count} attempts. Stopped instead of looping indefinitely.`,{stageId:s.id});break;}
    const target=stages.findIndex(x=>x.id===s.returnTo);
    if(target<0||target>=i){run.status='failed';emit(run,'error',`Invalid review target: ${s.returnTo}`,{stageId:s.id});break;}
    attempts.set(s.id,count+1);stageRecord.status='fix-required';
    emit(run,'stage',`Returning to ${stages[target].name} for correction ${count+1}/${s.maxRetries}.`,{stageId:stages[target].id});
    i=target-1;continue;
   }
  }
  stageRecord.status='verified';approvedTools=[];resumeSessionId=null;permissionRetries=0;partialEdits=0;partialFiles=[];
  if(s.agent==='agy'){
   const old=readAgyConnection();const now=Date.now();
   writeAgyConnection({userConfirmedAt:old.userConfirmedAt||now,verifiedAt:now});
  }
  emit(run,'success',`${s.name}: verified (${evidence.changedCount+partialEdits} file-change observations).`,{stageId:s.id});
 }
 if(run.status==='running'){
  continuations.delete(run.id);run.pendingInput=null;
  run.status=completedEdits>0||!stages.some(x=>(typeof x.requireChanges==='boolean'?x.requireChanges:['implement','support'].includes(x.role)))?'completed':'needs-attention';
  emit(run,run.status==='completed'?'success':'warning',run.status==='completed'?'Workflow finished with verified local edits. Review diffs before committing.':'No verified repository modifications were produced; not marked complete.');
 }
 run.updatedAt=Date.now();
}
function createRun({task,cwd,stages,mode='workflow'}){
 const run={id:randomUUID(),task:task.slice(0,6000),cwd,status:'queued',mode,stageIndex:-1,createdAt:Date.now(),updatedAt:Date.now(),events:[],stageResults:[]};
 runs.set(run.id,run);schedulePersist(run);const controller=new AbortController();abortControllers.set(run.id,controller);
 executeWorkflow(run,stages,controller.signal).catch(e=>{run.status=controller.signal.aborted?'canceled':'failed';emit(run,'error',String(e?.message||e));}).finally(()=>abortControllers.delete(run.id));
 return run;
}
function isBusy(cwd,excludeRunId=null){return [...runs.values()].some(x=>x.cwd===cwd&&x.id!==excludeRunId&&['queued','running','needs-approval','needs-input'].includes(x.status));}
function send(res,code,body){const payload=JSON.stringify(body);res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(payload)});res.end(payload);}
async function readBody(req){let text='';for await(const c of req){text+=c;if(text.length>1_000_000)throw new Error('Request too large');}return text?JSON.parse(text):{};}
function authHeader(req,token){const val=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const a=Buffer.from(val),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);}
export async function startEngine({port=0}={}){includeCommonCliPaths();ensureData();loadPreviousRuns();const token=randomBytes(32).toString('hex');const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');if(!authHeader(req,token))return send(res,401,{error:'Unauthorized'});if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,version:ENGINE_VERSION});if(req.method==='GET'&&url.pathname==='/api/project-readiness'){const cwd=url.searchParams.get('cwd');if(!cwd||!existsSync(cwd)||!statSync(cwd).isDirectory())return send(res,400,{error:'Choose an existing local project directory'});return send(res,200,checkProjectDependencies(cwd));}if(req.method==='GET'&&url.pathname==='/api/diagnostics'){const agent=url.searchParams.get('agent')||'codex';if(!RUNNABLE_AGENTS.includes(agent))return send(res,400,{error:'Unknown agent'});const status=await checkProvider(agent);const version=status.installed?await runProcess(agent,['--version'],{timeout:5000}):null;const sandbox=agent==='codex'&&status.installed?await codexSandboxPreflight():null;return send(res,200,{agent,installed:status.installed,auth:status.auth,version:version?.output.trim().slice(0,200)||'unavailable',detail:status.detail,sandbox,advice:agent==='codex'?(sandbox?.status==='blocked'?sandbox.detail:'Codex uses workspace-write for implementation and closes stdin. CLI default model helps isolate model-access errors. Sandbox status: '+(sandbox?.status||'not-installed')+'. No model tokens used.'):'Verify your official CLI sign-in and writable project permissions. No paid model call was made.'});}if(req.method==='GET'&&url.pathname==='/api/preflight'){
 const stages=readWorkflow(),checks=[];const seen=new Set();const cwd=url.searchParams.get('cwd')||undefined;
 for(const stage of stages){
  if(seen.has(stage.agent))continue;seen.add(stage.agent);
  const info=await checkProvider(stage.agent);
  let status=!info.installed||info.auth==='not-connected'?'blocked':info.auth==='connected'?'ready':'unverified';
  let detail=info.detail||'';
  if(stage.agent==='codex'&&info.installed){
   const probe=await codexSandboxPreflight({cwd});
   if(probe.status==='blocked'){status='blocked';detail=probe.detail+' '+(probe.raw||'');}
   else if(probe.status==='unverified'&&status==='ready'){status='unverified';detail=probe.detail;}
  }
  checks.push({agent:stage.agent,label:({claude:'Claude',codex:'Codex sandbox',agy:'Antigravity',opencode:'OpenCode',gemini:'Gemini CLI',kilo:'Kilo Code'})[stage.agent]||stage.agent,status,detail:String(detail).slice(0,600)});
 }
 if(stages.some(s=>s.requiresDocker)){const d=await dockerDaemonPreflight();checks.push({agent:'docker',label:'Docker daemon',status:d.status,detail:d.detail});}
 if(cwd&&existsSync(cwd)&&statSync(cwd).isDirectory()&&stages.some(s=>['implement','support'].includes(s.role))){
  const deps=checkProjectDependencies(cwd);
  const installer=stages.find(stageAllowsInstalls);
  const canInstall=deps.status==='warning'&&installer;
  checks.push({agent:'project-dependencies',label:'Project dependencies',status:['blocked','invalid'].includes(deps.status)?'warning':deps.status,detail:canInstall?`${deps.detail} The "${installer.name}" stage may install dependencies if needed.`:deps.detail,missingCount:deps.missingCount||0});
 }
 return send(res,200,{checks,checkedAt:Date.now(),note:'Read-only local checks. No AI requests, dependency installations or package scripts.'});
}if(req.method==='GET'&&url.pathname==='/api/providers')return send(res,200,{providers:await Promise.all(CLI_NAMES.map(async id=>({...await checkProvider(id),...(PROFILE_AGENTS.includes(id)?{accounts:accountInfo(id)}:{})}))),loginCommands:LOGIN_COMMANDS});if(req.method==='POST'&&/^\/api\/providers\/(claude|codex)\/accounts\/(create|select)$/.test(url.pathname)){const [,agent,action]=url.pathname.match(/^\/api\/providers\/(claude|codex)\/accounts\/(create|select)$/);if([...runs.values()].some(r=>['queued','running','needs-approval'].includes(r.status)))return send(res,409,{error:'Finish the running workflow or resolve its pending permission decision before switching accounts.'});const body=await readBody(req);try{return send(res,200,{accounts:saveAccount(agent,action,body)});}catch(e){return send(res,400,{error:e.message});}}if(req.method==='POST'&&url.pathname==='/api/providers/agy/confirm'){
 const status=await checkProvider('agy');if(!status.installed)return send(res,400,{error:'Antigravity CLI not installed. Install agy to use it in SBQ.'});
 const request=await readBody(req);if(typeof request.confirmed!=='boolean')return send(res,400,{error:'confirmed must be a boolean'});
 const state=request.confirmed?writeAgyConnection({userConfirmedAt:Date.now(),verifiedAt:readAgyConnection().verifiedAt}):writeAgyConnection({userConfirmedAt:0,verifiedAt:0});
 return send(res,200,{ok:true,userConfirmed:!!state.userConfirmedAt,provider:await checkProvider('agy')});
 }
 if(req.method==='POST'&&url.pathname==='/api/providers/agy/verify'){
  const request=await readBody(req);if(request.acknowledgeQuota!==true)return send(res,400,{error:'Confirm that the verification sends a model request and may consume tokens or quota.'});
  const result=await verifyAgyConnection();return send(res,result.ok?200:422,result);
 }
 if(req.method==='GET'&&url.pathname==='/api/models'){const agent=url.searchParams.get('agent');if(!validAgent(agent))return send(res,400,{error:'Unknown agent'});const cwd=url.searchParams.get('cwd')||undefined;return send(res,200,await modelCatalog(agent,{cwd,refresh:url.searchParams.get('refresh')==='1'}));}if(req.method==='GET'&&url.pathname==='/api/workflow/template')return send(res,200,{stages:DEFAULT_WORKFLOW});if(req.method==='GET'&&url.pathname==='/api/workflow')return send(res,200,{stages:readWorkflow()});if(req.method==='PUT'&&url.pathname==='/api/workflow')return send(res,200,{stages:saveWorkflow((await readBody(req)).stages||[])});if(req.method==='GET'&&url.pathname==='/api/changes'){const cwd=url.searchParams.get('cwd');if(!cwd||!existsSync(cwd)||!statSync(cwd).isDirectory())return send(res,400,{error:'Choose an existing project directory'});const root=resolve(cwd),selected=url.searchParams.get('file')||undefined;
 const candidate=latestLocalRun(root);
 if(candidate){const gitStatus=await repositoryChanges(root,{file:selected});if(!gitStatus.isGitRepo)return send(res,200,runChangeReport(candidate,{file:selected}));return send(res,200,gitStatus);}
 return send(res,200,await repositoryChanges(root,{file:selected}));}if(req.method==='POST'&&url.pathname==='/api/reviews'){
 const v=await readBody(req); const cwd=resolve(String(v.cwd||''));
 if(!v.cwd||!existsSync(cwd)||!statSync(cwd).isDirectory())return send(res,400,{error:'Choose an existing project directory'});
 if(isBusy(cwd))return send(res,409,{error:'Finish or cancel the active run for this project first'});
 const agent=String(v.agent||'claude');const modelMode=['default','catalog','custom'].includes(v.modelMode)?v.modelMode:'default';
 if(!RUNNABLE_AGENTS.includes(agent))return send(res,400,{error:'Unknown review agent'});
 const s={id:'manual-review',name:'On-demand Git review',role:'review',agent,reviewLoop:false,requireChanges:false,modelMode,model:String(v.model||''),effort:['default','low','medium','high','xhigh'].includes(v.effort)?v.effort:'default',instructions:String(v.instructions||'Identify bugs, security risks, missing tests and deviations. Do not change files.').slice(0,3000)};
 const changes=await repositoryChanges(cwd);
 const localRun=latestLocalRun(cwd);const local=localRun?.localChanges|| (localRun&&oldRunEvidence(localRun));
 const evidence=changes.isGitRepo?changes:local;
 if(!evidence?.files?.length)return send(res,400,{error:'No recorded local or Git file changes to review. Run a stage first or select a project with Git changes.'});
 const errors=await validateStagesForRun([s],{cwd});if(errors.length)return send(res,400,{error:errors.join('\n')});
 const run=createRun({cwd,task:'Review the recorded local source changes. Report actionable findings by severity and file, with proposed tests. Do NOT change files.',stages:[s],mode:'manual-review'});run.reviewContext=evidence.diff||`Recorded local changed files (historical baseline unavailable):\n${evidence.files.map(f=>f.status+': '+f.path).join('\n')}\nInspect these files independently against the user requirements.`;
 return send(res,202,{run:{id:run.id,status:run.status}});
 }
 if(req.method==='GET'&&url.pathname==='/api/runs')return send(res,200,{runs:[...runs.values()].map(({events,...run})=>({...run,eventCount:events.length})).reverse()});if(req.method==='POST'&&url.pathname==='/api/runs'){const v=await readBody(req);if(typeof v.task!=='string'||!v.task.trim())return send(res,400,{error:'Task cannot be empty'});if(typeof v.cwd!=='string'||!v.cwd.trim())return send(res,400,{error:'Choose a local project directory'});const cwd=resolve(v.cwd);if(!existsSync(cwd)||!statSync(cwd).isDirectory())return send(res,400,{error:'Project directory does not exist'});if(isBusy(cwd))return send(res,409,{error:'Another run is active for this directory'});const accountSelection=JSON.stringify(PROFILE_AGENTS.map(accountInfo));const stages=readWorkflow();if(!stages.length)return send(res,400,{error:'Workflow has no stages'});const modelErrors=await validateStagesForRun(stages,{cwd});if(modelErrors.length)return send(res,400,{error:modelErrors.join('\n')});const readinessErrors=await workflowReadiness(stages,cwd);if(readinessErrors.length)return send(res,409,{error:'Workflow preflight blocked the run BEFORE any model tokens were used.\n'+readinessErrors.join('\n')});if(accountSelection!==JSON.stringify(PROFILE_AGENTS.map(accountInfo)))return send(res,409,{error:'Account selection changed during preflight. Start the workflow again.'});const run=createRun({task:v.task,cwd,stages});send(res,202,{run:{id:run.id,status:run.status}});return;}
 const artifactMatch=url.pathname.match(/^\/api\/runs\/([a-z\d-]+)\/artifacts\/([a-zA-Z0-9-]+\.txt)$/);
 if(req.method==='GET'&&artifactMatch){const run=runs.get(artifactMatch[1]);if(!run)return send(res,404,{error:'Run not found'});
  const file=artifactMatch[2];if(!run.stageResults.some(x=>x.artifact===file))return send(res,404,{error:'Unknown artifact'});
  return send(res,200,{filename:file,text:readFileSync(join(ARTIFACT_DIR,file),'utf8')});}
 const changeMatch=url.pathname.match(/^\/api\/runs\/([a-z\d-]+)\/changes$/);if(req.method==='GET'&&changeMatch){const run=runs.get(changeMatch[1]);if(!run)return send(res,404,{error:'Run not found'});const file=url.searchParams.get('file')||undefined;
  return send(res,200,runChangeReport(run,{file}));}
 const approvalMatch=url.pathname.match(/^\/api\/runs\/([a-z\d-]+)\/approve$/);
 if(req.method==='POST'&&approvalMatch){
  const run=runs.get(approvalMatch[1]);if(!run)return send(res,404,{error:'Run not found'});
  const state=continuations.get(run.id),pending=run.pendingApproval;
  if(run.status!=='needs-approval'||!state||!pending)return send(res,409,{error:'This run is not waiting for a permission decision.'});
  if(isBusy(run.cwd,run.id))return send(res,409,{error:'Another run is active for this project.'});
  if(state.permissionRetries>3)return send(res,409,{error:'Permission retry limit reached. Review the stage and its external CLI settings before starting a new run.'});
  const request=await readBody(req);
  const approved=Array.isArray(request.approvedRules)?request.approvedRules:[];
  const available=new Set([...pending.requests.map(x=>x.rule).filter(Boolean),...(pending.presetCommands||[]).map(x=>x.rule)]);
  if(approved.length>12||approved.some(rule=>typeof rule!=='string'||!available.has(rule)))return send(res,400,{error:'Only explicitly reviewed, scoped permission rules can be approved.'});
  const guidance=String(request.guidance||'').trim();
  if(!approved.length&&guidance.length<5)return send(res,400,{error:'Approve a scoped operation or supply guidance explaining how to proceed without the denied tools.'});
  if(guidance.length>4000)return send(res,400,{error:'Guidance is too long'});
  run.pendingApproval=null;
  run.permissionGuidance=guidance;
  continuations.delete(run.id);
  const currentStage=run.stageResults[run.stageResults.length-1];
  if(currentStage?.status==='awaiting-approval')currentStage.status='paused-for-approval';
  emit(run,'approval',`User approved ${approved.length} scoped rule(s) for one resumed attempt. ${guidance?'Additional instructions provided.':''} Existing completed stages remain saved.`,{stageId:pending.stageId});
  const controller=new AbortController();abortControllers.set(run.id,controller);
  const next={...state,approvedTools:approved,previous:[state.previous,guidance?`USER GUIDANCE FOR PERMISSION BLOCK:\n${guidance}`:''].filter(Boolean).join('\n\n')};
  executeWorkflow(run,state.stages,controller.signal,next).catch(error=>{run.status=controller.signal.aborted?'canceled':'failed';emit(run,'error',String(error?.message||error));}).finally(()=>abortControllers.delete(run.id));
  return send(res,202,{run:{id:run.id,status:run.status}});
 }
 const recoverMatch=url.pathname.match(/^\/api\/runs\/([a-z\d-]+)\/retry-stage$/);
 if(req.method==='POST'&&recoverMatch){
  const run=runs.get(recoverMatch[1]);if(!run)return send(res,404,{error:'Run not found'});
  const state=continuations.get(run.id),pending=run.pendingRecovery;
  if(run.status!=='needs-attention'||!state?.recovery||!pending)return send(res,409,{error:'No recoverable stage in this run. Review the diff before starting a new task.'});
  if(isBusy(run.cwd,run.id))return send(res,409,{error:'Another run is active in the same project'});
  if(pending.attempts>=pending.maxAttempts)return send(res,409,{error:'Recovery limit reached; inspect the environment and partial changes manually.'});
  const request=await readBody(req);
  if(request.confirmNewModelCall!==true)return send(res,400,{error:'Explicitly acknowledge that retrying the stage may use additional model tokens.'});
  const guidance=String(request.guidance||'').trim();if(guidance.length>3000)return send(res,400,{error:'Guidance exceeds 3000 characters'});
  const readiness=await workflowReadiness([state.stages[state.startIndex]],run.cwd);
  if(pending.code==='DOCKER_UNAVAILABLE'&&!state.stages[state.startIndex].requiresDocker){const docker=await dockerDaemonPreflight();if(docker.status!=='ready')readiness.push(`Docker still unavailable: ${docker.detail} ${docker.raw||''}`);}
  if(readiness.length)return send(res,409,{error:'Stage environment is still blocked. No tokens used.\n'+readiness.join('\n')});
  const prior=run.stageResults.at(-1);if(['blocked','partial','interrupted'].includes(prior?.status))prior.status='blocked-previous-attempt';
  run.recoveryAttempts??={};run.recoveryAttempts[pending.stageId]=pending.attempts+1;
  run.pendingRecovery=null;continuations.delete(run.id);
  emit(run,'system',`User explicitly requested stage-only retry (${run.recoveryAttempts[pending.stageId]}/${pending.maxAttempts}). Previous completed stages remain intact; a new model request may incur cost.`,{stageId:pending.stageId});
  const controller=new AbortController();abortControllers.set(run.id,controller);
  const next={...state,previous:[state.previous,guidance?`USER RECOVERY INSTRUCTIONS:\n${guidance}`:'','Do not repeat verified completed work. Inspect partial changes in the repository, finish outstanding tests/docs, and report SBQ_STAGE_STATUS: COMPLETE only when genuinely done.'].filter(Boolean).join('\n\n')};
  executeWorkflow(run,state.stages,controller.signal,next).catch(error=>{run.status=controller.signal.aborted?'canceled':'failed';emit(run,'error',String(error?.message||error));}).finally(()=>abortControllers.delete(run.id));
  return send(res,202,{run:{id:run.id,status:run.status}});
 }
 const continueMatch=url.pathname.match(/^\/api\/runs\/([a-z\d-]+)\/continue$/);
 if(req.method==='POST'&&continueMatch){
  const run=runs.get(continueMatch[1]);if(!run)return send(res,404,{error:'Run not found'});
  const state=continuations.get(run.id);
  if(run.status!=='needs-input'||!state)return send(res,409,{error:'This run is not waiting for planning decisions. Never repeat expensive stages automatically.'});
  if(isBusy(run.cwd,run.id))return send(res,409,{error:'Another run is active for this project. Finish or cancel it first.'});
  const request=await readBody(req);const answer=String(request.answer||'').trim();
  if(answer.length<3||answer.length>8000)return send(res,400,{error:'Enter your decisions (3–8000 characters) to continue.'});
  run.confirmedAnswers=answer;run.pendingInput=null;
  continuations.delete(run.id);
  const planningStage=run.stageResults.find(x=>x.id===state.stages[state.startIndex-1]?.id);
  if(planningStage)planningStage.status='verified';
  emit(run,'message',`User confirmed decisions: ${answer.slice(0,1500)}`,{stageId:'user'});
  const controller=new AbortController();abortControllers.set(run.id,controller);
  executeWorkflow(run,state.stages,controller.signal,state).catch(error=>{run.status=controller.signal.aborted?'canceled':'failed';emit(run,'error',String(error?.message||error));}).finally(()=>abortControllers.delete(run.id));
  return send(res,202,{run:{id:run.id,status:run.status}});
 }
 const match=url.pathname.match(/^\/api\/runs\/([a-z\d-]+)(?:\/(cancel))?$/);if(match){const run=runs.get(match[1]);if(!run)return send(res,404,{error:'Run not found'});if(req.method==='GET'&&!match[2])return send(res,200,{run});if(req.method==='POST'&&match[2]==='cancel'){if(['needs-approval','needs-input'].includes(run.status)||run.pendingRecovery){continuations.delete(run.id);run.pendingApproval=null;run.pendingInput=null;run.pendingRecovery=null;run.status='canceled';emit(run,'warning','Paused workflow was canceled by the user. Existing source changes were not deleted.');}else abortControllers.get(run.id)?.abort();return send(res,200,{ok:true});}}
 return send(res,404,{error:'Not found'});}catch(e){return send(res,400,{error:String(e?.message||e)});}});
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(port,'127.0.0.1',res)});const actualPort=server.address().port;writeFileSync(DAEMON_INFO,JSON.stringify({port:actualPort,token,pid:process.pid}),{mode:0o600});if(process.platform!=='win32')chmodSync(DAEMON_INFO,0o600);return{server,port:actualPort,token};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){startEngine().then(({port})=>{console.log(`SBQ Agents Hub engine listening locally on 127.0.0.1:${port}`);console.log(`Connected desktop and extension will use ~/.sbq-agents-hub/daemon.json`);}).catch(e=>{console.error(e);process.exitCode=1;});}
