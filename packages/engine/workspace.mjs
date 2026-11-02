// SBQ's evidence layer measures real local workspace changes. No GitHub account or
// Git commit is required. It never trusts an agent's self-reported "done" text.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { lstat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';

const IGNORED_DIRS = new Set(['.git','.svn','.hg','node_modules','.next','.nuxt','dist','build','out','coverage','.turbo','.cache','.venv','venv','__pycache__','bin','obj','.idea','.sbq-agents-hub','.pnpm-store','.yarn-cache','.npm-cache','.parcel-cache','.svelte-kit','.vite','.angular','.gradle','.pytest_cache','.mypy_cache','.ruff_cache']);
const IGNORED_FILES = new Set(['.DS_Store','Thumbs.db']);
const MAX_FILES = 30000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Text previews are deliberately bounded and never leave the local engine.
const MAX_PREVIEW_BYTES = 90_000;
const MAX_PREVIEW_TOTAL = 1_000_000;
const SAFE_EXTENSIONS = /\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte|css|scss|html|md|txt|json|jsonc|yaml|yml|toml|xml|py|php|cs|java|kt|rs|go|rb|sh|sql|swift|dart|gradle|properties)$/i;
const SECRET_NAME = /(?:^|[\/._-])(?:secret|secrets|credential|credentials|password|passwords|private|token|tokens|key|keys|id_rsa|id_ed25519|auth\.json|\.env)(?:$|[\/._-])/i;
function previewAllowed(rel, size) {
 return size<=MAX_PREVIEW_BYTES && SAFE_EXTENSIONS.test(rel) && !SECRET_NAME.test(rel) && !rel.split('/').some(x=>x.startsWith('.'));
}
async function previewText(abs){
 try{const b=await readFile(abs);if(b.includes(0))return null;const value=b.toString('utf8');if(value.includes('\ufffd'))return null;return value;}catch{return null;}
}


function gitFiles(cwd){return new Promise(resolvePromise=>{
 const child=spawn('git',['ls-files','-co','--exclude-standard','-z'],{cwd,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','pipe','ignore'],windowsHide:true});
 const buffers=[];let size=0,exceeded=false;
 child.stdout.on('data',c=>{size+=c.length;if(size>12_000_000){exceeded=true;child.kill();}else buffers.push(c);});
 child.on('error',()=>resolvePromise(null));
 child.on('close',code=>resolvePromise(code===0&&!exceeded?Buffer.concat(buffers).toString('utf8').split('\0').filter(Boolean):null));
 });}
async function filesystemFiles(root){
 const out=[];const pending=[''];
 while(pending.length){
  const parent=pending.pop();let entries;
  try{entries=await readdir(join(root,parent),{withFileTypes:true});}catch{continue;}
  for(const entry of entries){
   const name=entry.name,rel=parent?join(parent,name):name;
   if(entry.isDirectory()){
    if(!IGNORED_DIRS.has(name))pending.push(rel);
   }else if(entry.isFile()&&!IGNORED_FILES.has(name)&&name!=='.env'&&!name.startsWith('.env.'))out.push(rel);
   if(out.length>MAX_FILES)throw new Error(`Workspace contains over ${MAX_FILES} files; cannot verify changes reliably. Reduce the project scope.`);
  }
 }
 return out;
}
async function hashFile(file){
 return new Promise((done,reject)=>{
  const hash=createHash('sha256');const stream=createReadStream(file);
  stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>done(hash.digest('hex')));
 });
}
export async function workspaceSnapshot(cwd,{includeText=false}={}){
 const root=resolve(cwd), index=new Map(),previews=new Map();let previewBytes=0;
 const git=await gitFiles(root);
 const names=git??await filesystemFiles(root);
 if(names.length>MAX_FILES)throw new Error(`Workspace contains over ${MAX_FILES} files; verification refused.`);
 let ignored=0;
 for(const name of [...new Set(names)]){
  const abs=resolve(root,name), rel=relative(root,abs);
  if(rel.startsWith('..'+sep)||rel==='..'||rel.startsWith(sep))continue;
  if(rel.split(sep).some(p=>IGNORED_DIRS.has(p)))continue;
  let st;try{st=await lstat(abs);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!st.isFile())continue; // Never follow symlinks outside the project.
  if(st.size>MAX_FILE_BYTES){ignored++;continue;}
  const safeRel=rel.replaceAll('\\','/');
  try{
   index.set(safeRel,await hashFile(abs));
   if(includeText&&previewAllowed(safeRel,st.size)&&previewBytes+st.size<=MAX_PREVIEW_TOTAL){
    const text=await previewText(abs);
    if(text!==null){previews.set(safeRel,text);previewBytes+=st.size;}
   }
  }catch(e){if(e.code==='ENOENT')continue;throw e;}
 }
 if(ignored)throw new Error(`${ignored} files exceed snapshot size limit; cannot guarantee that the stage modified the workspace.`);
 return {root,method:git?'git-index-and-untracked':'local-filesystem',files:index,previews};
}
export function compareSnapshots(before,after){
 if(before.root!==after.root)throw new Error('Workspace snapshot roots do not match.');
 const changed=[];
 for(const [path,hash] of after.files){
  if(!before.files.has(path))changed.push({path,status:'added'});
  else if(before.files.get(path)!==hash)changed.push({path,status:'modified'});
 }
 for(const path of before.files.keys())if(!after.files.has(path))changed.push({path,status:'deleted'});
 changed.sort((a,b)=>a.path.localeCompare(b.path));
 return {changed,changedCount:changed.length,verified:changed.length>0,method:after.method};
}

// Produces a bounded, honest per-stage diff without requiring a Git repository.
// For large/binary/sensitive files only the file name/status is shown.
function renderLocalPatch(file,status,oldText,newText){
 const header=`diff --local a/${file} b/${file}\n`;
 if(status==='deleted'&&oldText==null)return header+'# Deleted file (text baseline unavailable)\n';
 if(status==='added'&&newText==null)return header+'# Added file (preview unavailable or sensitive)\n';
 if(status==='modified'&&(oldText==null||newText==null))return header+'# Modified file (text preview unavailable or sensitive)\n';
 const before=(oldText||'').split('\n'),after=(newText||'').split('\n');
 if(status==='added')return header+'--- /dev/null\n+++ b/'+file+'\n'+after.map(x=>'+'+x).join('\n')+'\n';
 if(status==='deleted')return header+'--- a/'+file+'\n+++ /dev/null\n'+before.map(x=>'-'+x).join('\n')+'\n';
 // Small files: LCS produces a real line diff; cap complexity for safety.
 if(before.length*after.length<=130000){
  const dp=Array.from({length:before.length+1},()=>new Uint16Array(after.length+1));
  for(let i=before.length-1;i>=0;i--)for(let j=after.length-1;j>=0;j--)
   dp[i][j]=before[i]===after[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const out=[];let i=0,j=0;
  while(i<before.length||j<after.length){
   if(i<before.length&&j<after.length&&before[i]===after[j]){out.push(' '+before[i]);i++;j++;}
   else if(j<after.length&&(i===before.length||dp[i][j+1]>=dp[i+1][j]))out.push('+'+after[j++]);
   else out.push('-'+before[i++]);
  }
  return header+'--- a/'+file+'\n+++ b/'+file+'\n@@ local changes @@\n'+out.join('\n')+'\n';
 }
 return header+'# Large file diff not expanded; compare externally for exact lines\n';
}
export function localChangeReport(before,after,{maxDiff=180000,maxFiles=300}={}){
 const result=compareSnapshots(before,after);
 const files=result.changed.slice(0,maxFiles).map(x=>({path:x.path,status:x.status}));
 let diff='';
 for(const f of files){
  const patch=renderLocalPatch(f.path,f.status,before.previews?.get(f.path),after.previews?.get(f.path));
  if(diff.length+patch.length>maxDiff){diff+='\n# Diff truncated; file list is preserved\n';break;}
  diff+=patch+'\n';
 }
 return {source:'local-snapshot',isGitRepo:false,files,diff,truncated:result.changed.length>maxFiles||diff.includes('# Diff truncated'),
  note:`${result.changed.length} file(s) changed in this SBQ stage. Local snapshots, no Git required. Binary/large/sensitive file previews omitted. Changes are NOT proof of passing tests.`,
  changedCount:result.changed.length};
}
