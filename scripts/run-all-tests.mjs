// Complete local/offline test matrix. No external agent login or model request.
import { spawnSync } from 'node:child_process';
const files=[
 'smoke-test.mjs','integration-test.mjs','test-sbq.mjs','test-hub.mjs',
 'test-responsive.mjs','test-verified-workflow.mjs','test-codex-bridge.mjs',
 'test-claude-planning.mjs','test-antigravity-connection.mjs','test-permission-workflow.mjs',
 'test-codex-sandbox.mjs','test-model-recovery.mjs','test-orchestration-contract.mjs',
 'test-stage-recovery.mjs','test-gitless-changes.mjs','test-project-readiness.mjs'
];
let passed=0;
for(const file of files){
 process.stdout.write(`\n=== ${file} ===\n`);
 const result=spawnSync(process.execPath,['scripts/'+file],{cwd:process.cwd(),encoding:'utf8',timeout:90000});
 if(result.stdout)process.stdout.write(result.stdout);
 if(result.stderr)process.stderr.write(result.stderr);
 if(result.error||result.status!==0){console.error(`FAIL ${file}: ${result.error?.message||`exit ${result.status}`}`);process.exitCode=1;break;}
 passed++;
}
console.log(`\nSBQ offline suite result: ${passed}/${files.length} passed`);
