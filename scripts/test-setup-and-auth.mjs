// Offline regression tests for real-CLI integration bugs found on Ubuntu 24.04:
// tab-separated `agy models`, OpenCode plain-text auth lists, Codex sandbox
// network/cache access for package installs, Claude plan files and model
// validation when a CLI catalog cannot be read. No model requests.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelCatalog,validateStagesForRun} from '../packages/engine/models.mjs';
import {makeCommand,parseOpenCodeAuthList,claudePlanFromOutput,dependencySetupHint} from '../packages/engine/server.mjs';
import {checkProjectDependencies,detectPackageManager} from '../packages/engine/project-readiness.mjs';
import {workspaceSnapshot,compareSnapshots} from '../packages/engine/workspace.mjs';

const tmp=mkdtempSync(join(tmpdir(),'sbq-setup-auth-'));
const bin=join(tmp,'bin');mkdirSync(bin);
const originalPath=process.env.PATH;
try{
 // 1. agy models prints "id<TAB>label". Every model must be discovered.
 writeFileSync(join(bin,'agy'),'#!/bin/sh\nif [ "$1" = "models" ]; then printf "Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)\\ngpt-oss-120b-medium\\tGPT-OSS 120B (Medium)\\n"; exit 0; fi\nexit 2\n');
 chmodSync(join(bin,'agy'),0o755);
 process.env.PATH=bin+':'+originalPath;
 const agy=await modelCatalog('agy',{refresh:true});
 assert.deepEqual(agy.models.map(m=>m.id),['gemini-3.8-flash-high','claude-sonnet-4-6','gpt-oss-120b-medium']);
 assert.equal(agy.models[0].label,'Gemini 3.8 Flash (High)');
 assert.deepEqual(await validateStagesForRun([{agent:'agy',name:'Support',model:'claude-sonnet-4-6',modelMode:'catalog'}]),[]);

 // 2. An unreadable catalog is not proof that a model is invalid.
 writeFileSync(join(bin,'agy'),'#!/bin/sh\nexit 1\n');
 const unreadable=await validateStagesForRun([{agent:'agy',name:'Support',model:'gemini-3.8-flash-high',modelMode:'catalog'}]);
 assert.deepEqual(unreadable,[],'empty catalog must not block the run');

 // 3. OpenCode plain-text auth list with a provider outside any fixed list.
 const opencode='\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  DeepSeek \x1b[90mapi\n│\n└  1 credentials\n';
 assert.equal(parseOpenCodeAuthList(opencode),1);
 assert.equal(parseOpenCodeAuthList('┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic oauth\n●  Moonshot api\n│\n└  2 credentials\n'),2);
 assert.equal(parseOpenCodeAuthList('┌  Credentials\n│\n└  0 credentials\n'),0);
 assert.equal(parseOpenCodeAuthList(''),0);

 // 4. Codex writable stages may reach the package registry and a private SBQ cache.
 const cacheDir=join(tmp,'cache');
 const [,writeArgs,io]=makeCommand({agent:'codex',role:'implement',modelMode:'default'},'p',{cwd:'/repo',cacheDir});
 assert.ok(writeArgs.includes('sandbox_workspace_write.network_access=true'),writeArgs.join(' '));
 assert.equal(writeArgs[writeArgs.indexOf('--add-dir')+1],cacheDir);
 assert.equal(writeArgs.at(-1),'-');assert.equal(io.input,'p');
 assert.equal(io.env.npm_config_cache,join(cacheDir,'npm'));
 // pnpm 11 only reads pnpm_config_*; npm warns about unknown npm_config_store_dir.
 assert.equal(io.env.pnpm_config_store_dir,join(cacheDir,'pnpm-store'));
 assert.equal(io.env.npm_config_store_dir,undefined);
 // Tools such as Prisma, node-gyp and Playwright cache under ~/.cache (read-only in the sandbox).
 assert.equal(io.env.XDG_CACHE_HOME,join(cacheDir,'xdg-cache'));
 assert.equal(io.env.COREPACK_HOME,join(cacheDir,'corepack'));
 assert.equal(io.env.COREPACK_ENABLE_DOWNLOAD_PROMPT,'0');
 const [,offline]=makeCommand({agent:'codex',role:'implement',modelMode:'default',allowNetwork:false},'p',{cwd:'/repo',cacheDir});
 assert.ok(!offline.join(' ').includes('network_access'),'stage opt-out keeps network off');
 const [,readOnly]=makeCommand({agent:'codex',role:'review',modelMode:'default',allowNetwork:true},'p',{cwd:'/repo',cacheDir});
 assert.ok(!readOnly.join(' ').includes('network_access')&&!readOnly.includes('--add-dir'),'read-only roles never get network');
 const [,claudeArgs]=makeCommand({agent:'claude',role:'implement',modelMode:'default'},'p',{cwd:'/repo'});
 assert.ok(claudeArgs.includes('Bash(npm install)'),'Claude writable stages may install project packages');
 const [,claudeOff]=makeCommand({agent:'claude',role:'implement',modelMode:'default',allowNetwork:false},'p',{cwd:'/repo'});
 assert.ok(!claudeOff.includes('Bash(npm install)'));

 // 5. Claude plan mode stores the full plan in ~/.claude/plans; use that file.
 const home=join(tmp,'home'),plans=join(home,'.claude','plans');mkdirSync(plans,{recursive:true});
 const full='# Full plan\n'+'AC-1 detailed acceptance criteria\n'.repeat(300);
 writeFileSync(join(plans,'user-task-crm.md'),full);
 const since=Date.now()-1000;
 const summary=`I've written the plan to \`${join(plans,'user-task-crm.md')}\`. Summary: build a CRM.`;
 assert.equal(claudePlanFromOutput(summary,{home,since}),full);
 // Old files, files outside the plans folder and missing files are ignored.
 const old=join(plans,'old.md');writeFileSync(old,'stale');utimesSync(old,new Date(since-60000),new Date(since-60000));
 assert.equal(claudePlanFromOutput(`See ${old}`,{home,since}),null);
 writeFileSync(join(home,'secret.md'),'nope');
 assert.equal(claudePlanFromOutput(`See ${join(plans,'..','..','secret.md')}`,{home,since}),null);
 assert.equal(claudePlanFromOutput(`See ${join(plans,'missing.md')}`,{home,since}),null);
 assert.equal(claudePlanFromOutput('Plain plan in the reply.',{home,since}),null);
 const profileDir=join(home,'profiles','work'),profilePlans=join(profileDir,'plans');mkdirSync(profilePlans,{recursive:true});const profilePlan=join(profilePlans,'plan.md');writeFileSync(profilePlan,full);assert.equal(claudePlanFromOutput(`See ${profilePlan}`,{home,configDir:profileDir,since}),full);
 // 7. The project's own package manager is detected and named in the stage prompt.
 const pm=join(tmp,'pm');mkdirSync(pm);
 writeFileSync(join(pm,'package.json'),JSON.stringify({name:'x',packageManager:'pnpm@11.5.2',dependencies:{zod:'1'}}));
 writeFileSync(join(pm,'package-lock.json'),'{}');
 assert.equal(detectPackageManager(pm),'pnpm','packageManager field wins over a stray npm lockfile');
 const deps=checkProjectDependencies(pm);assert.equal(deps.installHint,'pnpm install');
 const ws=join(tmp,'ws');mkdirSync(ws);writeFileSync(join(ws,'package.json'),'{"name":"w"}');writeFileSync(join(ws,'pnpm-workspace.yaml'),'packages:\n  - apps/*\n');
 assert.equal(detectPackageManager(ws),'pnpm','pnpm-workspace.yaml means pnpm');
 const plain=join(tmp,'plain');mkdirSync(plain);writeFileSync(join(plain,'package.json'),'{}');assert.equal(detectPackageManager(plain),'npm');
 const hint=dependencySetupHint(deps);
 assert.match(hint,/relevant to this task/);assert.match(hint,/package manager/);assert.match(dependencySetupHint(deps,{allowInstall:false}),/not enabled/);
 // 6. Package-manager caches inside a project are not reported as code changes.
 const proj=join(tmp,'proj');mkdirSync(proj);writeFileSync(join(proj,'a.js'),'1');
 const before=await workspaceSnapshot(proj);
 mkdirSync(join(proj,'.pnpm-store','v11'),{recursive:true});writeFileSync(join(proj,'.pnpm-store','v11','index.db'),'x');writeFileSync(join(proj,'b.js'),'2');
 assert.deepEqual(compareSnapshots(before,await workspaceSnapshot(proj)).changed.map(f=>f.path),['b.js']);
 console.log('PASS: package caches ignored in change evidence, agy tab catalog, unreadable catalog allowed, OpenCode any-provider auth, Codex network+cache for writable stages only, Claude plan file handoff');
}finally{process.env.PATH=originalPath;rmSync(tmp,{recursive:true,force:true});}
