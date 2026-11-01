import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workspaceSnapshot,compareSnapshots,localChangeReport} from '../packages/engine/workspace.mjs';
const dir=mkdtempSync(join(tmpdir(),'sbq-gitless-'));
try {
 mkdirSync(join(dir,'src'));
 writeFileSync(join(dir,'src','feature.ts'),'export const answer = 1;\n');
 writeFileSync(join(dir,'.env'),'SECRET=VERY_PRIVATE');
 writeFileSync(join(dir,'secret-token.json'),'{"key":"VERY_PRIVATE"}');
 const before=await workspaceSnapshot(dir,{includeText:true});
 writeFileSync(join(dir,'src','feature.ts'),'export const answer = 42;\n');
 writeFileSync(join(dir,'src','new.test.ts'),'describe("ok", () => {});\n');
 const after=await workspaceSnapshot(dir,{includeText:true});
 const report=localChangeReport(before,after);
 assert.equal(report.source,'local-snapshot');
 assert.equal(report.files.length,2);
 assert.match(report.diff,/-export const answer = 1;/);
 assert.match(report.diff,/\+export const answer = 42;/);
 assert.match(report.diff,/\+describe\("ok"/);
 assert.doesNotMatch(report.diff,/VERY_PRIVATE/);
 assert.equal(compareSnapshots(before,after).verified,true);
 console.log('PASS: Git-less workspace snapshots, meaningful modified/added diff, sensitive preview restrictions');
}finally{rmSync(dir,{recursive:true,force:true});}
