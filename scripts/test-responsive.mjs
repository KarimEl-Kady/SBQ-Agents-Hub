import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(path,'utf8');
const html=read('packages/ui/index.html');
const js=read('packages/ui/app.js');
const css=read('packages/ui/app.css');
const desktop=read('apps/desktop/main.cjs');
for (const id of ['toggleInspector','closeInspector','inspectorBackdrop','stageInspector'])
 assert.match(html,new RegExp(`id="${id}"`),`Missing responsive control: ${id}`);
for (const value of ['inspector-open','setInspectorOpen','matchMedia',"e.key==='Escape'"])
 assert.ok(js.includes(value),`Missing drawer interaction: ${value}`);
for (const bp of ['max-width:1220px','max-width:980px','max-width:650px','max-width:370px'])
 assert.ok(css.includes(bp),`Missing breakpoint: ${bp}`);
assert.match(css,/\[hidden\]\{display:none!important\}/);
assert.match(css,/\.sidebar\s+\.nav-label\s*\{display:block/,'Missing labels on narrow nav');
assert.match(desktop,/minWidth:400,minHeight:420/);
for(const resource of ['index.html','app.css','app.js'])
 assert.equal(read(`packages/ui/${resource}`),read(`apps/vscode/media/${resource}`),`VS Code ${resource} not synced`);
console.log('PASS: responsive controls, keyboard dismissal, breakpoints, compact navigation, and synced VS Code assets');
