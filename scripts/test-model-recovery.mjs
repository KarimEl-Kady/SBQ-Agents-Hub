import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelCatalog, validateStagesForRun} from '../packages/engine/models.mjs';

const root=mkdtempSync(join(tmpdir(),'sbq-model-recovery-'));
const bin=join(root,'bin');mkdirSync(bin);
const exe=join(bin,'codex');
writeFileSync(exe,`#!/bin/sh
if [ "$1" = "app-server" ]; then exit 2; fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then cat "$SBQ_MODEL_TEST_DIR/catalog.json"; exit 0; fi
if [ "$1" = "exec" ]; then echo paid >> "$SBQ_MODEL_TEST_DIR/model-calls"; exit 9; fi
exit 2
`);chmodSync(exe,0o755);
const original=process.env.PATH;
process.env.PATH=bin+':'+original;process.env.SBQ_MODEL_TEST_DIR=root;
const stage={agent:'codex',name:'Implementation',model:'gpt-6.1-terra',modelMode:'catalog'};
try{
 writeFileSync(join(root,'catalog.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1 Sol'}]}));
 const first=await modelCatalog('codex',{cwd:root,refresh:true});
 assert.equal(first.source,'cli-debug');assert.deepEqual(first.models.map(x=>x.id),['gpt-6.1-sol']);
 const error=await validateStagesForRun([stage],{cwd:root});
 assert.equal(error.length,1);assert.match(error[0],/Stage 1 \(Implementation\)/);assert.match(error[0],/CLI Default/);
 const override=await validateStagesForRun([{...stage,modelMode:'custom'}],{cwd:root});
 assert.deepEqual(override,[],'Explicit custom overrides are permitted; CLI controls actual access.');
 writeFileSync(join(root,'catalog.json'),JSON.stringify({models:[{slug:'gpt-6.1-terra',display_name:'GPT-6.1 Terra'}]}));
 const newCatalog=await validateStagesForRun([stage],{cwd:root});
 assert.deepEqual(newCatalog,[],'A fresh catalog should accept a newly listed model.');
 assert.equal(existsSync(join(root,'model-calls')),false,'No paid model request should be sent during validation');
 console.log('PASS: Codex catalog fallback, stale/missing model recovery, manual custom override, no model tokens');
}finally{process.env.PATH=original;delete process.env.SBQ_MODEL_TEST_DIR;rmSync(root,{recursive:true,force:true});}
