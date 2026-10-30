import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

function git(args,cwd,timeout=7000){return new Promise(done=>{
  let p,stdout=Buffer.alloc(0),stderr='';let settled=false;
  const finish=x=>{if(settled)return;settled=true;clearTimeout(timer);done(x);};
  try{p=spawn('git',args,{cwd,shell:false,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_PAGER:'cat'},stdio:['ignore','pipe','pipe']});}
  catch(e){done({code:127,stdout:Buffer.alloc(0),stderr:String(e)});return;}
  const timer=setTimeout(()=>{p.kill('SIGTERM');finish({code:124,stdout,stderr:'Git timed out'});},timeout);
  p.stdout.on('data',d=>{stdout=Buffer.concat([stdout,d]).subarray(0,450000);});
  p.stderr.on('data',d=>stderr=(stderr+d.toString()).slice(-2000));
  p.on('error',e=>finish({code:127,stdout,stderr:String(e)}));p.on('close',code=>finish({code:code??1,stdout,stderr}));
});}

function parseStatus(buffer){const entries=buffer.toString('utf8').split('\0');const files=[];
 for(let i=0;i<entries.length;i++){
  const row=entries[i];if(!row||row.length<4)continue;
  const status=row.slice(0,2),path=row.slice(3);
  files.push({path,status:status.trim()||'M',untracked:status==='??'});
  if(status.includes('R')||status.includes('C'))i++; // porcelain -z includes old name next
 }
 return files.slice(0,500);
}
function safeFile(cwd,name){if(!name||name.includes('\0')||isAbsolute(name))return null;const abs=resolve(cwd,name);if(abs===resolve(cwd)||relative(resolve(cwd),abs).startsWith('..'))return null;return abs;}
function previewUntracked(cwd,file){const full=safeFile(cwd,file);if(!full)return '';
 try{const st=lstatSync(full);if(!st.isFile()||st.size>75_000)return `# Untracked: ${file} (binary, large, or not a regular file; preview skipped)\n`;
 const bytes=readFileSync(full);if(bytes.includes(0))return `# Untracked binary: ${file}\n`;
 const value=bytes.toString('utf8');return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${value.split('\n').length} @@\n`+value.split('\n').map(l=>'+'+l).join('\n')+'\n';
 }catch{return '';}
}
export async function repositoryChanges(cwd,{file}={}){
 const root=await git(['rev-parse','--show-toplevel'],cwd);
 if(root.code!==0)return {isGitRepo:false,files:[],diff:'',note:'This directory is not a Git repository. Initialize Git to review changes.'};
 const repoRoot=root.stdout.toString().trim();
 if(file&&!safeFile(repoRoot,file))throw new Error('Invalid file path');
 const [status,patch]=await Promise.all([
  git(['status','--porcelain=v1','-z','--untracked-files=normal'],cwd),
  git(['-c','core.quotepath=false','diff','--no-ext-diff','--no-color','--unified=3','HEAD','--',...(file?[file]:[])],cwd)
 ]);
 if(status.code!==0||patch.code!==0)return {isGitRepo:true,files:[],diff:'',note:'Could not inspect Git status or HEAD. Make an initial commit first.'};
 const files=parseStatus(status.stdout).filter(x=>!file||x.path===file);
 let diff=patch.stdout.toString('utf8');let previewCount=0;
 for(const entry of files){if(entry.untracked&&previewCount++<8)diff+='\n'+previewUntracked(repoRoot,entry.path);}
 const truncated=diff.length>210000;
 if(truncated)diff=diff.slice(0,210000)+'\n\n--- Diff truncated for display ---\n';
 return {isGitRepo:true,repoRoot,files,diff,truncated,note:'Includes current working tree changes, including changes that existed before SBQ Agents Hub started. Untracked text previews are limited.'};
}
export function changesFingerprint(result){return createHash('sha256').update(result.diff||'').update(JSON.stringify(result.files||[])).digest('hex');}
