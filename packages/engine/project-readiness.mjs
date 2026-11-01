// Read-only dependency readiness. This never runs install scripts or AI models.
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';

const WORKSPACE_DIRS=['apps','packages','services'];
const TOP_LEVEL_DIRS=['api','web','frontend','backend','client','server'];
const LIMIT_MANIFESTS=50, LIMIT_DEPENDENCIES=400;
function isDirectory(file){try{return lstatSync(file).isDirectory();}catch{return false;}}
function manifest(dir){
 const file=join(dir,'package.json');if(!existsSync(file))return null;
 try{return {dir,file,pkg:JSON.parse(readFileSync(file,'utf8'))};}
 catch{return {dir,file,invalid:true};}
}
function findManifests(root){
 const found=[],seen=new Set();
 function add(dir){if(found.length>=LIMIT_MANIFESTS)return;const m=manifest(dir);if(m&&!seen.has(m.file)){found.push(m);seen.add(m.file);}}
 add(root);
 for(const name of TOP_LEVEL_DIRS)if(isDirectory(join(root,name)))add(join(root,name));
 for(const group of WORKSPACE_DIRS){
  const folder=join(root,group);if(!isDirectory(folder))continue;
  let entries=[];try{entries=readdirSync(folder,{withFileTypes:true});}catch{continue;}
  for(const item of entries){if(item.isDirectory()&&!item.name.startsWith('.')&&item.name!=='node_modules')add(join(folder,item.name));}
 }
 return found;
}
function isLocalSpec(spec){return /^(?:workspace:|file:|link:)/.test(String(spec||''));}
function dependencyFound(base,root,name){
 // Dependencies may be hoisted to the repository root by npm workspaces.
 let dir=base;
 while(true){
  if(isDirectory(join(dir,'node_modules',...name.split('/'))))return true;
  if(dir===root)break;
  const next=dirname(dir);if(next===dir||relative(root,next)==='..'||relative(root,next).startsWith('..'+sep))break;
  dir=next;
 }
 return false;
}
export function checkProjectDependencies(cwd){
 const root=resolve(cwd);
 if(!isDirectory(root))return{status:'invalid',detail:'Project directory does not exist.',missing:[],manifests:[]};
 const all=findManifests(root);
 if(!all.length)return{status:'not-applicable',detail:'No existing Node.js package manifests. New projects can define dependencies during implementation.',missing:[],manifests:[]};
 const invalid=all.filter(x=>x.invalid);
 if(invalid.length)return{status:'invalid',detail:`Invalid package.json: ${invalid.map(x=>relative(root,x.file)).join(', ')}`,missing:[],manifests:all.map(x=>relative(root,x.file))};
 const missing=[];let checked=0;
 for(const m of all){
  const deps={...m.pkg.dependencies,...m.pkg.devDependencies};
  for(const [name,version] of Object.entries(deps)){
   if(isLocalSpec(version))continue;
   if(!/^(?:@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/i.test(name))return{status:'invalid',detail:`Invalid package dependency name in ${relative(root,m.file)}; correct the manifest before execution.`,missing,manifests:all.map(x=>relative(root,x.file))};
   checked++;
   if(checked>LIMIT_DEPENDENCIES)return{status:'unverified',detail:'Too many dependencies for the bounded preflight. Inspect locally before running AI.',missing,manifests:all.map(x=>relative(root,x.file))};
   if(!dependencyFound(m.dir,root,name))missing.push({manifest:relative(root,m.file),dependency:name});
  }
 }
 // Yarn Plug'n'Play deliberately has no node_modules.
 if(existsSync(join(root,'.pnp.cjs'))||existsSync(join(root,'.pnp.js')))
  return{status:'ready',detail:'Yarn Plug’n’Play installation detected. Individual modules not probed.',missing:[],checked,manifests:all.map(x=>relative(root,x.file))};
 if(missing.length){
  const manager=existsSync(join(root,'pnpm-lock.yaml'))?'pnpm':existsSync(join(root,'yarn.lock'))?'yarn':existsSync(join(root,'bun.lock'))||existsSync(join(root,'bun.lockb'))?'bun':'npm';
  const installHint=manager==='npm'?(existsSync(join(root,'package-lock.json'))?'npm ci':'npm install'):`${manager} install`;
  return{status:'blocked',code:'PROJECT_DEPENDENCIES_MISSING',detail:`${missing.length} required package(s) not installed. Install dependencies on the HOST with your permission before using AI tokens. Suggested command in ${root}: ${installHint}. Review package scripts before running it; do not use sudo.`,manager,installHint,missing:missing.slice(0,20),missingCount:missing.length,checked,manifests:all.map(x=>relative(root,x.file))};
 }
 return{status:'ready',detail:`Checked ${checked} existing Node.js dependencies in ${all.length} manifest(s). This does not prove build or tests pass.`,missing:[],checked,manifests:all.map(x=>relative(root,x.file))};
}
