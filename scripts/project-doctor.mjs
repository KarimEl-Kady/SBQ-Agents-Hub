#!/usr/bin/env node
// Usage: npm run doctor:project -- /absolute/path/to/project [--network]
// Read-only by default. --network sends a short npm registry ping, not an install.
import { checkProjectDependencies } from '../packages/engine/project-readiness.mjs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const args=process.argv.slice(2);
const cwd=resolve(args.find(x=>!x.startsWith('--'))||process.cwd());
const status=checkProjectDependencies(cwd);
console.log(`SBQ project readiness: ${cwd}`);
console.log(`Dependency status: ${status.status}`);
console.log(status.detail);
if(status.missing?.length)console.log('Missing examples:\n'+status.missing.slice(0,12).map(x=>`  ${x.manifest}: ${x.dependency}`).join('\n'));
if(args.includes('--network')){
 console.log('\nChecking host npm registry access (read-only, no agent tokens)...');
 const result=await new Promise(done=>{
  let data='';const child=spawn('npm',['ping','--registry=https://registry.npmjs.org/','--fetch-retries=0','--fetch-timeout=10000'],{cwd,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGTERM'),15000);
  child.stdout.on('data',v=>{data+=v.toString();});child.stderr.on('data',v=>{data+=v.toString();});
  child.on('error',e=>{clearTimeout(timer);done({exit:127,log:e.message});});
  child.on('close',code=>{clearTimeout(timer);done({exit:code??124,log:data.slice(-1600)});});
 });
 console.log(`Host npm registry: ${result.exit===0?'reachable':'unavailable'}\n${result.log}`);
 if(result.exit!==0)process.exitCode=1;
}
if(['blocked','invalid'].includes(status.status))process.exitCode=1;
