(()=>{'use strict';
 const $=id=>document.getElementById(id);
 const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const vscode=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;
 const NAMES={claude:'Claude Code',codex:'Codex',agy:'Antigravity',opencode:'OpenCode',gemini:'Gemini CLI',kilo:'Kilo Code',freebuff:'Freebuff (interactive)'};
 const AGENTS=Object.entries(NAMES).filter(([id])=>id!=='freebuff').map(([value,label])=>({value,label}));
 const INSTALL_GUIDES={claude:'https://code.claude.com/docs/en/overview',codex:'https://developers.openai.com/codex/cli',agy:'https://antigravity.google/docs/getting-started?tab=cli',opencode:'https://opencode.ai/docs',gemini:'https://geminicli.com/docs/get-started/',kilo:'https://kilo.ai/docs/code-with-ai/platforms/cli',freebuff:'https://github.com/CodebuffAI/freebuff'};
 const ROLES=[{value:'plan',label:'Planning'},{value:'implement',label:'Implementation'},{value:'review',label:'Review / Audit'},{value:'support',label:'Support / Automation'},{value:'release',label:'Release preparation (no push)'}];
 const VERIFY_COMMANDS=[{value:'',label:'File change check only'},{value:'npm test',label:'npm test'},{value:'npm run test',label:'npm run test'},{value:'npm run build',label:'npm run build'},{value:'npm run lint',label:'npm run lint'},{value:'pnpm test',label:'pnpm test'},{value:'pnpm build',label:'pnpm build'},{value:'dotnet test',label:'dotnet test'},{value:'php artisan test',label:'php artisan test'},{value:'composer test',label:'composer test'},{value:'pytest',label:'pytest'}];
 const EFFORT=[{value:'default',label:'CLI default (safest)'},{value:'low',label:'Low'},{value:'medium',label:'Medium'},{value:'high',label:'High'},{value:'xhigh',label:'Extra high (only if supported)'}];
 let seq=0,workflow=[],providers=[],currentRun=null,runTimer=null,activeTab='chat',selectedFile=null,authPoll=null;
 let preflightInProgress=false;
 const pending=new Map(),modelCache=new Map();
 // The stage editor is a persistent right column on wide desktop screens, but a
 // dismissible drawer in narrow desktop windows and VS Code webviews.
 const narrowInspector=window.matchMedia('(max-width: 1220px)');
 function setInspectorOpen(open){
  const enabled=Boolean(open&&narrowInspector.matches);
  document.body.classList.toggle('inspector-open',enabled);
  $('inspectorBackdrop').hidden=!enabled;
  $('toggleInspector').setAttribute('aria-expanded',String(enabled));
  if(enabled){$('stageInspector').setAttribute('role','dialog');$('stageInspector').setAttribute('aria-modal','true');}
  else{$('stageInspector').removeAttribute('role');$('stageInspector').removeAttribute('aria-modal');}
  if(enabled)$('closeInspector').focus();
 }
 $('toggleInspector').addEventListener('click',()=>setInspectorOpen(!document.body.classList.contains('inspector-open')));
 $('closeInspector').addEventListener('click',()=>{setInspectorOpen(false);$('toggleInspector').focus();});
 $('inspectorBackdrop').addEventListener('click',()=>setInspectorOpen(false));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('inspector-open'))setInspectorOpen(false);});
 narrowInspector.addEventListener('change',()=>setInspectorOpen(false));
 if(vscode)window.addEventListener('message',event=>{const m=event.data;if(m?.type==='response'&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else p.resolve(m.data);}});
 const bridge=(method,path,body)=>{if(window.sbqDesktop)return window.sbqDesktop.request(method,path,body);if(vscode)return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});vscode.postMessage({type:'api',id,method,path,body});});return Promise.reject(new Error('Open SBQ from Desktop or VS Code.'));};
 const nativeConnect=(id,cmd,profile)=>{if(window.sbqDesktop)return window.sbqDesktop.connect(id,profile);if(vscode){vscode.postMessage({type:'login',agent:id,profile});return Promise.resolve();}return navigator.clipboard.writeText(cmd);};
 async function copy(text){try{await navigator.clipboard.writeText(text);toast('Copied to clipboard');}catch{toast('Clipboard unavailable; please copy it from the terminal.');}}
 function toast(message){const n=$('toast');n.className='toast';n.textContent=message;clearTimeout(toast.t);toast.t=setTimeout(()=>{n.textContent='';n.className='';},5500);}
 function tab(name){setInspectorOpen(false);activeTab=name;document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab===name));document.querySelectorAll('.panel').forEach(n=>n.classList.toggle('active',n.id==='tab-'+name));$('pageName').textContent=({chat:'Chat',workflow:'Workflows',accounts:'Connections',changes:'Code changes'})[name];if(name==='accounts')loadAccounts();if(name==='changes')loadChanges();if(name==='chat'){renderFlowStrip();renderInspector();loadMiniChanges();}}
 document.querySelectorAll('.nav').forEach(n=>n.addEventListener('click',()=>tab(n.dataset.tab)));
 $('quickConnections').onclick=()=>tab('accounts');$('goWorkflow').onclick=()=>tab('workflow');$('goWorkflowWelcome').onclick=()=>tab('workflow');$('goChanges').onclick=()=>tab('changes');$('openFullChanges').onclick=()=>tab('changes');$('refresh').onclick=refreshAll;$('checkAccounts').onclick=loadAccounts;$('refreshRuns').onclick=loadRuns;$('refreshChanges').onclick=loadChanges;
 function setOnline(online){$('engineDot').classList.toggle('on',online);$('engineText').textContent=online?'Engine connected':'Engine unavailable';}
 function field(label,value,handler,type='input',options=[]){const wrap=document.createElement('div');wrap.className='field';const lbl=document.createElement('label');lbl.textContent=label;wrap.appendChild(lbl);const input=document.createElement(type==='textarea'?'textarea':type==='select'?'select':'input');if(type==='select')for(const option of options){const item=document.createElement('option');item.value=option.value;item.textContent=option.label;input.appendChild(item);}input.value=value??'';input.addEventListener(type==='select'?'change':'input',event=>handler(event.target.value));wrap.appendChild(input);return wrap;}
 async function loadWorkflow(){const {stages}=await bridge('GET','/api/workflow');workflow=stages.map(s=>({...s,modelMode:s.modelMode||(s.model?'catalog':'default')}));$('stageCount').textContent=`${stages.length} stages configured`;renderWorkflow();renderFlowStrip();renderInspector();renderRunOverview();}
 async function catalogFor(agent,force=false){const cwd=$('cwd')?.value?.trim()||'';const key=agent+'|'+cwd;if(force)modelCache.delete(key);if(!modelCache.has(key))modelCache.set(key,bridge('GET',`/api/models?agent=${encodeURIComponent(agent)}${cwd?'&cwd='+encodeURIComponent(cwd):''}${force?'&refresh=1':''}`).catch(e=>({agent,models:[],source:'unavailable',note:e.message})));return modelCache.get(key);}
 function renderWorkflow(){const list=$('stageList');list.replaceChildren();$('workflowCount').textContent=`${workflow.length} customizable stage${workflow.length===1?'':'s'}`;
 workflow.forEach((stage,index)=>{
  const card=document.createElement('div');card.className='stage';card.dataset.stage=stage.id;
  const top=document.createElement('div');top.className='stage-top';top.innerHTML=`<div><span class="stage-number">${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(stage.name)}</strong></div>`;
  const controls=document.createElement('div');controls.className='stage-actions';
  for(const [icon,title,fn] of [['↑','Move up',()=>move(index,-1)],['↓','Move down',()=>move(index,1)],['⧉','Duplicate',()=>{workflow.splice(index+1,0,{...stage,id:crypto.randomUUID(),name:stage.name+' Copy'});renderWorkflow();}],['×','Remove',()=>{workflow.splice(index,1);renderWorkflow();}]]){const b=document.createElement('button');b.className='mini'+(title==='Remove'?' delete':'');b.textContent=icon;b.title=title;b.setAttribute('aria-label',title);b.onclick=fn;controls.appendChild(b);}
  top.appendChild(controls);card.appendChild(top);
  card.appendChild(field('Stage name',stage.name,v=>{stage.name=v;top.querySelector('strong').textContent=v;}));
  const pair=document.createElement('div');pair.className='grid-two';pair.appendChild(field('Role / purpose',stage.role,v=>{stage.role=v;stage.requireChanges=['implement','support'].includes(v);if(v!=='review')stage.reviewLoop=false;renderWorkflow();},'select',ROLES));pair.appendChild(field('Agent / runner',stage.agent,v=>{stage.agent=v;stage.model='';stage.modelMode='default';stage.effort='default';renderWorkflow();},'select',AGENTS));card.appendChild(pair);
  const pair2=document.createElement('div');pair2.className='grid-two';
  const modelField=document.createElement('div');modelField.className='field';const modelLabel=document.createElement('label');modelLabel.textContent='Model for '+NAMES[stage.agent];modelField.appendChild(modelLabel);
  const select=document.createElement('select');select.innerHTML='<option value="default">Loading model choices…</option>';select.disabled=true;modelField.appendChild(select);
  const hint=document.createElement('div');hint.className='model-hint';hint.textContent='Checking the local CLI model choices…';modelField.appendChild(hint);
  const custom=field('Exact custom model ID (advanced)',stage.modelMode==='custom'?stage.model:'',v=>stage.model=v);custom.classList.add('custom-model');custom.hidden=stage.modelMode!=='custom';modelField.appendChild(custom);
  const refresh=document.createElement('button');refresh.className='text-button';refresh.textContent='↻ Refresh this agent’s models';refresh.onclick=()=>{hint.textContent='Refreshing CLI model catalog…';populate(true);};modelField.appendChild(refresh);
  pair2.appendChild(modelField);pair2.appendChild(field('Reasoning effort',stage.effort||'default',v=>stage.effort=v,'select',EFFORT));card.appendChild(pair2);
  const instructions=field('Stage instructions and expected result',stage.instructions,v=>stage.instructions=v,'textarea');instructions.classList.add('wide');card.appendChild(instructions);
  const validation=document.createElement('div');validation.className='stage-verification';
  const title=document.createElement('strong');title.textContent='Verified execution · evidence & checks';validation.appendChild(title);
  const mandatory=document.createElement('label');mandatory.className='inline-check';
  const check=document.createElement('input');check.type='checkbox';check.checked=typeof stage.requireChanges==='boolean'?stage.requireChanges:['implement','support'].includes(stage.role);check.onchange=e=>stage.requireChanges=e.target.checked;
  mandatory.append(check,document.createTextNode(' Require actual project file changes to pass this stage'));validation.appendChild(mandatory);
  validation.appendChild(field('Optional verification command',stage.verifyCommand||'',v=>stage.verifyCommand=v,'select',VERIFY_COMMANDS));
  if(stage.agent==='claude'&&['implement','support'].includes(stage.role)){
   const perms=document.createElement('div');perms.className='verification-permissions';
   const permTitle=document.createElement('small');permTitle.textContent='Pre-approved Claude tool commands — opt-in, only for this stage (may run without asking)';perms.appendChild(permTitle);
   for(const command of ['php artisan test','vendor/bin/pint','vendor/bin/pint --test','npm test','npm run test','npm run lint','npm run build','composer test','dotnet test','pytest']){
    const label=document.createElement('label');label.className='inline-check';const check=document.createElement('input');check.type='checkbox';
    check.checked=(stage.allowedCommands||[]).includes(command);
    check.onchange=()=>{const current=new Set(stage.allowedCommands||[]);if(check.checked)current.add(command);else current.delete(command);stage.allowedCommands=[...current];};
    label.append(check,document.createTextNode(' Allow exactly: '+command));perms.appendChild(label);
   }
   validation.appendChild(perms);
  }

  if(stage.role==='review'){
   const enabled=document.createElement('label');enabled.className='inline-check';const cb=document.createElement('input');cb.type='checkbox';cb.checked=!!stage.reviewLoop;cb.onchange=e=>{stage.reviewLoop=e.target.checked;renderWorkflow();};
   enabled.append(cb,document.createTextNode(' Enable automatic FIX → Implementation → Review loop'));validation.appendChild(enabled);
   if(stage.reviewLoop){
    const previous=workflow.slice(0,index).filter(x=>['implement','support'].includes(x.role)).map(x=>({value:x.id,label:x.name}));
    validation.appendChild(field('Return FIX to stage',stage.returnTo||previous.at(-1)?.value||'',v=>stage.returnTo=v,'select',previous));
    if(!stage.returnTo&&previous.length)stage.returnTo=previous.at(-1).value;
    const attempts=field('Maximum fix attempts (0–5)',String(stage.maxRetries??2),v=>stage.maxRetries=Math.max(0,Math.min(5,Number(v)||0)));attempts.querySelector('input').type='number';attempts.querySelector('input').min='0';attempts.querySelector('input').max='5';validation.appendChild(attempts);
   }
  }
  const note=document.createElement('small');note.className='model-hint';note.textContent='SBQ compares real local files before/after this stage. No changes = no success for write stages. Read-only stages may not modify files.';validation.appendChild(note);card.appendChild(validation);
  list.appendChild(card);
  async function populate(force=false){const catalog=await catalogFor(stage.agent,force);if(!card.isConnected||workflow.find(x=>x.id===stage.id)?.agent!==stage.agent)return;
   select.replaceChildren();const opts=[{value:'default',label:'Provider / CLI default (recommended)'},...catalog.models.map(m=>({value:m.id,label:(m.free?'✦ Free · ':'')+(m.label||m.id)})),{value:'__custom__',label:'Custom model ID… (manual override)'}];
   const selected=stage.modelMode==='custom'?'__custom__':stage.modelMode==='default'||!stage.model?'default':stage.model;
   if(selected!=='__custom__'&&!opts.some(o=>o.value===selected)){opts.splice(1,0,{value:'__invalid__',label:`⚠ Previously saved model not found: ${stage.model}`});}
   for(const o of opts){const option=document.createElement('option');option.value=o.value;option.textContent=o.label;select.appendChild(option);}
   select.disabled=false;select.value=opts.some(o=>o.value===selected)?selected:'__invalid__';
   hint.textContent=select.value==='__invalid__'?'This saved model cannot be verified for this runner. Choose a model or CLI default before running.':catalog.note;
   custom.hidden=stage.modelMode!=='custom';
  }
  select.onchange=()=>{const v=select.value;if(v==='default'){stage.modelMode='default';stage.model='';}else if(v==='__custom__'){stage.modelMode='custom';stage.model='';}else if(v!=='__invalid__'){stage.modelMode='catalog';stage.model=v;}custom.hidden=stage.modelMode!=='custom';if(stage.modelMode==='custom')custom.querySelector('input').focus();};
  populate();
 });}
 function move(i,d){const j=i+d;if(j<0||j>=workflow.length)return;[workflow[i],workflow[j]]=[workflow[j],workflow[i]];renderWorkflow();renderFlowStrip();renderInspector();}
 $('useVerifiedTemplate').onclick=async()=>{if(!confirm('Replace the in-memory workflow with the 6-stage template? Your saved workflow will stay unchanged until you click Save workflow.'))return;try{const result=await bridge('GET','/api/workflow/template');workflow=result.stages.map(s=>({...s}));inspectedStageId=null;renderWorkflow();renderFlowStrip();renderInspector();toast('6-stage template loaded. Review agent choices, then click Save workflow.');}catch(e){toast(e.message);}};
 $('addStage').onclick=()=>{workflow.push({id:crypto.randomUUID(),name:'New stage',role:'support',agent:'claude',model:'',modelMode:'default',effort:'default',requireChanges:true,verifyCommand:'',instructions:'Describe exactly which files and tests should be produced.'});renderWorkflow();renderFlowStrip();renderInspector();};
 $('saveWorkflow').onclick=async()=>{if(!workflow.length)return toast('Add at least one stage first');
  if(workflow.some(s=>s.modelMode==='custom'&&!s.model.trim()))return toast('Enter an exact model ID for custom model stages, or choose CLI default.');
  try{const out=await bridge('PUT','/api/workflow',{stages:workflow});workflow=out.stages;$('stageCount').textContent=`${workflow.length} stages configured`;toast('Workflow saved');renderWorkflow();renderFlowStrip();renderInspector();}catch(e){toast(e.message);}};
 let pollingAccounts=false;
 async function loadAccounts(){if(pollingAccounts)return;pollingAccounts=true;const root=$('accountList');root.innerHTML='<div class="loading">Checking installed CLIs and existing local sessions…</div>';
  try{const response=await bridge('GET','/api/providers');providers=response.providers;root.replaceChildren();for(const p of providers){
   const item=document.createElement('article');item.className='account';const state=p.auth==='connected'?'Connected':p.auth==='not-installed'?'CLI not installed':p.auth==='not-connected'?'Not connected':p.auth==='user-confirmed'?'Signed in (you confirmed)':'Session unverified';
   item.innerHTML=`<div class="account-top"><span class="provider-name">${NAMES[p.id]}</span><span class="status ${escapeHtml(p.auth)}">● ${state}</span></div><p class="account-note">${escapeHtml(p.detail||'Check your existing local sign-in before creating a new one.')}</p>`;
   const footer=document.createElement('div');footer.className='account-footer';
   const recheck=document.createElement('button');recheck.className='outline';recheck.textContent='↻ Use existing session';recheck.onclick=()=>loadAccounts();
   const connect=document.createElement('button');connect.className='primary';connect.textContent=p.id==='opencode'?'Manage providers / Sign in':p.id==='agy'?'Open Antigravity CLI':p.id==='freebuff'?'Open Freebuff':p.id==='kilo'?'Open Kilo / Connect':'Sign in / Reconnect';connect.disabled=!p.installed;
   connect.onclick=async()=>{try{await nativeConnect(p.id,response.loginCommands[p.id],p.accounts?.active);toast(`Opened ${NAMES[p.id]} official CLI. Complete sign-in there if required.`);startAuthChecks();}catch(e){toast(e.message);}};
   const copyCmd=document.createElement('button');copyCmd.className='outline';copyCmd.textContent='Copy command';copyCmd.onclick=()=>copy(response.loginCommands[p.id]);
   footer.append(recheck,connect);if(!p.accounts||p.accounts.active==='default')footer.append(copyCmd);const docs=document.createElement('a');docs.href=INSTALL_GUIDES[p.id];docs.target='_blank';docs.rel='noopener noreferrer';docs.className='docs-link';docs.textContent='Install / help ↗';footer.appendChild(docs);item.appendChild(footer);
   if(p.accounts){const row=document.createElement('div');row.className='account-footer';const label=document.createElement('label');label.textContent='Active account ';const select=document.createElement('select');select.setAttribute('aria-label',NAMES[p.id]+' active account');for(const a of [{id:'default',name:'Default CLI session'},...p.accounts.profiles]){const option=document.createElement('option');option.value=a.id;option.textContent=a.name;option.selected=a.id===p.accounts.active;select.appendChild(option);}label.appendChild(select);select.onchange=async()=>{select.disabled=true;try{await bridge('POST',`/api/providers/${p.id}/accounts/select`,{id:select.value});await loadAccounts();}catch(e){toast(e.message);select.value=p.accounts.active;}finally{select.disabled=false;}};const add=document.createElement('button');add.className='outline';add.textContent='+ Add account';add.onclick=async()=>{const name=prompt('Name this account (for example, Work or Personal):');if(name===null||!name.trim())return;add.disabled=true;try{await bridge('POST',`/api/providers/${p.id}/accounts/create`,{name:name.trim()});await loadAccounts();toast('Account created. Select Sign in / Reconnect to authenticate it.');}catch(e){toast(e.message);}finally{add.disabled=false;}};row.append(label,add);item.appendChild(row);}
   const note=document.createElement('div');note.className='connection-extra';
   if(p.id==='agy')note.textContent='Antigravity uses shared OS-keyring login across IDE/App/CLI. Sign-in confirmation is free but self-reported. Live verification makes a real model request (possible quota use), only when you click the verification button. Credentials are never imported.';
   else if(p.id==='opencode')note.textContent='Already signed in to OpenCode IDE/Desktop? Local CLI normally shares its service. For ChatGPT, choose OpenAI → Sign in with ChatGPT. For Claude Agent, connect its existing Claude Code login in OpenCode. No API key required for those supported flows.';
   else if(p.id==='freebuff')note.textContent='Freebuff supports free, ad-funded models and an existing browser login. The CLI is interactive-only, so launch it in its own terminal; it cannot run automatic SBQ stages yet. Review Freebuff data-use disclosures for private repositories.';
   else if(p.id==='kilo')note.textContent='Kilo Code supports CLI workflow runs and the documented kilo-auto/free model. Open the Kilo CLI once for account setup. Models can be refreshed from Kilo automatically.';
   else if(p.id==='gemini')note.textContent='Already use Gemini CLI? Open it once to choose the official Google sign-in method. SBQ does not ask you to enter credentials or inspect local token storage.';
   else if(p.id==='codex')note.textContent='Named accounts use separate Codex configuration directories. Sign in to each account after adding it; the selected account is used for workflow stages.';
   else note.textContent='Named accounts use separate Claude configuration directories. Sign in to each account after adding it; the selected account is used for workflow stages.';
   if(p.id==='codex'){
    const diagnose=document.createElement('button');diagnose.className='outline';diagnose.textContent='Test Codex (no tokens)';
    diagnose.onclick=async()=>{diagnose.disabled=true;diagnose.textContent='Checking…';try{const d=await bridge('GET','/api/diagnostics?agent=codex');note.textContent=`Codex ${d.version} · Login: ${d.auth} · Sandbox: ${d.sandbox?.status||'unknown'} · ${d.advice}`;toast('Codex diagnostics complete — no model tokens used');}catch(e){note.textContent=`Codex diagnostics failed: ${e.message}`;}finally{diagnose.disabled=false;diagnose.textContent='Test Codex (no tokens)';}};
    item.appendChild(diagnose);
   }
   if(p.id==='agy'&&p.installed){
    const connectionActions=document.createElement('div');connectionActions.className='account-footer agy-actions';
    const manual=document.createElement('button');manual.className='outline';
    manual.textContent=p.auth==='user-confirmed'||p.auth==='connected'?'Clear local confirmation':'I have signed in (no tokens)';
    manual.onclick=async()=>{manual.disabled=true;try{
      const confirmed=!(p.auth==='user-confirmed'||p.auth==='connected');
      await bridge('POST','/api/providers/agy/confirm',{confirmed});
      toast(confirmed?'Sign-in recorded as user-confirmed, not independently verified.':'Local Antigravity confirmation cleared.');
      await loadAccounts();
     }catch(e){toast(e.message);}finally{manual.disabled=false;}};
    const verify=document.createElement('button');verify.className='outline';verify.textContent='Verify with small model request';
    verify.onclick=async()=>{
     if(!confirm('This verification sends one small read-only request through your existing Antigravity CLI account and MAY CONSUME TOKENS / QUOTA. Continue?'))return;
     verify.disabled=true;verify.textContent='Verifying…';
     try{const out=await bridge('POST','/api/providers/agy/verify',{acknowledgeQuota:true});
      const usage=out.usage?.totalTokens?` (${out.usage.totalTokens} tokens reported)`:'';
      toast('Antigravity execution verified'+usage);await loadAccounts();
     }catch(e){note.textContent='Verification unsuccessful: '+e.message+' Your existing login was not changed.';toast('Antigravity probe failed; see Connections for details.');}
     finally{verify.disabled=false;verify.textContent='Verify with small model request';}
    };
    connectionActions.append(manual,verify);item.appendChild(connectionActions);
   }
   item.appendChild(note);root.appendChild(item);
  }}catch(e){root.innerHTML='<div class="loading">'+escapeHtml(e.message)+'</div>';}finally{pollingAccounts=false;}}
 function startAuthChecks(){clearInterval(authPoll);let count=0;authPoll=setInterval(async()=>{if(++count>8){clearInterval(authPoll);return;}if(activeTab==='accounts')await loadAccounts();},4000);}
 async function openArtifact(runId,filename){
  try{
   const artifact=await bridge('GET',`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(filename)}`);
   const shade=document.createElement('div');shade.className='sbq-artifact-shade';shade.setAttribute('role','presentation');
   const dialog=document.createElement('section');dialog.className='sbq-artifact-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Full stage output');
   const heading=document.createElement('div');heading.className='sbq-artifact-heading';
   const title=document.createElement('strong');title.textContent='Stage output · '+filename;
   const close=document.createElement('button');close.className='outline';close.textContent='Close';
   close.onclick=()=>shade.remove();shade.addEventListener('click',e=>{if(e.target===shade)shade.remove();});
   heading.append(title,close);
   const body=document.createElement('pre');body.className='sbq-artifact-text';body.textContent=artifact.text;
   dialog.append(heading,body);shade.appendChild(dialog);document.body.appendChild(shade);close.focus();
  }catch(error){toast('Cannot open stage output: '+error.message);}
 }
 function labelForState(value){return ({'running':'Running','queued':'Queued','completed':'Completed','needs-attention':'Needs attention','needs-approval':'Needs approval','needs-input':'Needs input','needs-review':'Needs review','failed':'Failed','canceled':'Stopped','interrupted':'Interrupted'})[value]||'Not started';}
 function currentStageResult(id){return [...(currentRun?.stageResults||[])].reverse().find(r=>r.id===id);}
 function stagePresentation(stage,i){
  const latest=currentStageResult(stage.id),runStatus=currentRun?.status;
  if(!latest)return {label:'Pending',cls:'pending',glyph:String(i+1)};
  const status=latest.status;
  if(status==='verified')return{label:'Passed',cls:'passed',glyph:'✓'};
  if(status==='skipped')return{label:'Skipped',cls:'skipped',glyph:'–'};
  if(['blocked','partial','blocked-previous-attempt','unverified','failed','interrupted'].includes(status))return{label:status==='blocked'?'Blocked':'Needs attention',cls:'blocked',glyph:'!'};
  if(status==='fix-required')return{label:'Fix required',cls:'needs-fix',glyph:'↻'};
  if(['awaiting-approval','paused-for-approval'].includes(status))return{label:'Approval needed',cls:'needs-fix',glyph:'!'};
  if(runStatus==='running'||runStatus==='queued')return{label:'Running',cls:'running',glyph:'◌'};
  return{label:'Pending',cls:'pending',glyph:String(i+1)};
 }
 function renderRunOverview(){
  const title=$('runTitle'),subtitle=$('runSubtitle'),badge=$('runProgressBadge');
  if(!title)return;
  const cwd=currentRun?.cwd||$('cwd').value.trim();
  const project=cwd?cwd.replace(/[\/]+$/,'').split(/[\/]/).at(-1):'SBQ Agent Workspace';
  title.textContent=project+' — Multi-stage workflow';
  subtitle.textContent=workflow.map(x=>x.name).join(' → ');
  const target=$('runDirectory');if(target){target.textContent=cwd?`Project directory: ${cwd}`:'Choose the target project folder before running';target.title=cwd;}
  badge.textContent=labelForState(currentRun?.status);
  badge.className='sbq-progress-badge '+(currentRun?.status||'idle');
  const status=$('verificationState'),evidence=$('stageEvidence');
  const results=currentRun?.stageResults||[];
  const files=[...new Map(results.flatMap(x=>x.changedFiles||[]).map(f=>[f.path,f])).entries()];
  const passes=results.flatMap(x=>x.checks||[]).filter(x=>x.exitCode===0).length;
  const failed=results.flatMap(x=>x.checks||[]).filter(x=>x.exitCode!=null&&x.exitCode!==0).length;
  const blocked=results.some(x=>['blocked','partial','failed','unverified'].includes(x.status));
  status.textContent=currentRun?.status==='completed'?`${passes>0?'✓ Checks passed':'◌ Tests not run'} · ${files.length} changed file(s)`:(blocked?`! Partial work · ${files.length} changed file(s)`:`${files.length} changed file(s) · verification pending`);
  status.className='sbq-verification-state '+(currentRun?.status==='completed'&&passes>0&&failed===0?'passed':blocked?'blocked':'pending');
  evidence.textContent=results.length?`${passes} verification command(s) passed${failed?`, ${failed} failed`:''} · ${results.filter(x=>x.status==='verified').length} verified stage(s). ${blocked?'The run is NOT approved; review partial changes.':'No automatic Git push.'}`:'No executed stages yet. Checks are shown only when actually run.';
 }
 async function loadPreflight(){
  if(preflightInProgress)return;preflightInProgress=true;
  const b=$('retryPreflight'),container=$('preflightResults');b.disabled=true;container.textContent='Checking local tools (no model tokens)…';
  try{
   const data=await bridge('GET','/api/preflight?cwd='+encodeURIComponent(currentRun?.cwd||$('cwd').value.trim()));
   container.replaceChildren();for(const item of data.checks||[]){
    const el=document.createElement('div');el.className='sbq-preflight-item '+(['blocked','invalid'].includes(item.status)?'blocked':item.status);
    const glyph=document.createElement('span');glyph.textContent=item.status==='ready'?'✓':['blocked','invalid'].includes(item.status)?'!':item.status==='warning'?'⚠':'◌';
    const details=document.createElement('div');const label=document.createElement('strong');label.textContent=item.label;const state=document.createElement('small');state.textContent=item.status==='ready'?'Ready':['blocked','invalid'].includes(item.status)?'Blocked':item.status==='not-applicable'?'Not needed':item.status==='warning'?'Warning':'Unverified';
    details.append(label,state);if(['blocked','invalid','warning'].includes(item.status)&&item.detail){const hint=document.createElement('small');hint.className='sbq-preflight-hint';hint.textContent=item.detail;details.appendChild(hint);}el.title=item.detail||'';el.append(glyph,details);container.appendChild(el);
   }
  }catch(e){container.textContent='Could not check agents: '+e.message;}finally{preflightInProgress=false;b.disabled=false;}
 }
 $('retryPreflight').onclick=loadPreflight;
 function renderRun(){const root=$('conversation');renderRunOverview();if(!currentRun){root.innerHTML='<div class="welcome"><img class="welcome-symbol" src="./assets/sbq-symbol.svg" alt=""><h2>What shall we build?</h2><p>Enter a task. Follow each stage and inspect the actual Git diff below.</p><button id="openWorkflow" class="outline">Customize workflow ↗</button></div>';$('openWorkflow').onclick=()=>tab('workflow');return;}
  const previousCount=root.dataset.count;root.replaceChildren();let lastText=null;
  const timeline=document.createElement('section');timeline.className='sbq-stage-timeline';
  for(const [index,stage] of workflow.entries()){
   const view=stagePresentation(stage,index),latest=currentStageResult(stage.id);
   const card=document.createElement('article');card.className='sbq-timeline-card '+view.cls;
   const dot=document.createElement('span');dot.className='sbq-timeline-dot';dot.textContent=view.glyph;
   const text=document.createElement('div');text.className='sbq-timeline-text';
   const name=document.createElement('strong');name.textContent=`Stage ${index+1} — ${stage.name} (${NAMES[stage.agent]||stage.agent})`;
   const sub=document.createElement('small');sub.textContent=latest?`${latest.changedFiles?.length||0} file change(s) recorded · ${latest.checks?.length||0} check(s)`:(stage.instructions||'Pending').slice(0,110);
   text.append(name,sub);const pill=document.createElement('span');pill.className='sbq-stage-pill '+view.cls;pill.textContent=view.label;card.append(dot,text,pill);timeline.appendChild(card);
  }
  root.appendChild(timeline);
  const eventsTitle=document.createElement('div');eventsTitle.className='sbq-activity-heading';eventsTitle.textContent='Execution activity · real CLI events';root.appendChild(eventsTitle);
  for(const event of currentRun.events){if(event.type==='message'&&lastText?.agent===event.agent&&lastText.stageId===event.stageId){lastText.element.textContent+=event.text;continue;}
   const row=document.createElement('article');row.className='message '+event.type;const glyph=document.createElement('div');glyph.className='message-icon';glyph.textContent=({stage:'◇',message:'✦',result:'✓',tool:'⚙',error:'!',warning:'!',question:'?',success:'✓',system:'●',changes:'±',evidence:'✓',output:'›'})[event.type]||'·';
   const body=document.createElement('div');body.className='message-body';const header=document.createElement('div');header.className='message-head';const who=document.createElement('span');who.textContent=event.agent?NAMES[event.agent]:({stage:'Stage',error:'Error',success:'Completed',tool:'Tool activity',changes:'Git changes',evidence:'File verification',output:'CLI output'})[event.type]||'Orchestrator';const when=document.createElement('span');when.className='meta';when.textContent=new Date(event.ts).toLocaleTimeString();header.append(who,when);const content=document.createElement('div');content.className='message-content';content.textContent=event.text;body.append(header,content);
   if(event.type==='artifact'&&event.artifact){const b=document.createElement('button');b.className='outline mini-review';b.textContent='View full stage output ↗';b.onclick=()=>openArtifact(currentRun.id,event.artifact);body.appendChild(b);}
   if(event.type==='changes'){const b=document.createElement('button');b.className='outline mini-review';b.textContent='Review changed files ↗';b.onclick=()=>tab('changes');body.appendChild(b);}
   row.append(glyph,body);root.appendChild(row);lastText=event.type==='message'?{agent:event.agent,stageId:event.stageId,element:content}:null;
  }
  if(currentRun.status==='needs-attention'&&currentRun.pendingRecovery){
   const r=currentRun.pendingRecovery;
   const card=document.createElement('section');card.className='sbq-blocked-card';
   const heading=document.createElement('strong');heading.textContent='⚠ '+r.title;
   const detail=document.createElement('p');detail.textContent=r.detail;
   const context=document.createElement('small');context.textContent=`${r.changedFiles?.length||0} partial file(s) retained · Retry ${r.attempts}/${r.maxAttempts} · The next retry may use model tokens.`;
   const guidance=document.createElement('textarea');guidance.rows=2;guidance.placeholder='Optional instructions, e.g. skip Docker-dependent packaging or finish outstanding tests after fixing the Docker daemon';
   const actions=document.createElement('div');actions.className='sbq-recovery-actions';
   const connections=document.createElement('button');connections.className='outline';connections.textContent='Open Connections';connections.onclick=()=>tab('accounts');
   const diff=document.createElement('button');diff.className='outline';diff.textContent='Review partial changes';diff.onclick=()=>tab('changes');
   const retry=document.createElement('button');retry.className='primary';retry.textContent='Continue this stage after fix';retry.disabled=r.attempts>=r.maxAttempts;
   retry.onclick=async()=>{
    if(!confirm('Retry ONLY the blocked stage? This creates a new agent request and may consume tokens. Completed planning and earlier stages will NOT run again.'))return;
    retry.disabled=true;try{await bridge('POST',`/api/runs/${currentRun.id}/retry-stage`,{confirmNewModelCall:true,guidance:guidance.value.trim()});showNewRun();}catch(e){retry.disabled=false;toast(e.message);}
   };
   actions.append(connections,diff,retry);card.append(heading,detail,context,guidance,actions);root.appendChild(card);
  }
  if(currentRun.status==='needs-approval'&&currentRun.pendingApproval){
   const pending=currentRun.pendingApproval;
   const card=document.createElement('section');card.className='approval-card';
   const title=document.createElement('h3');title.textContent=`Approval needed · ${pending.agent}`;card.appendChild(title);
   const explanation=document.createElement('p');explanation.textContent=`${pending.partialChangedCount} changed file(s) preserved. Approve only the operations you recognize. A continued model session may consume more tokens.`;card.appendChild(explanation);
   const fields=[];
   for(const [index,req] of pending.requests.entries()){
    const row=document.createElement('label');row.className='approval-operation';
    const input=document.createElement('input');input.type='checkbox';input.value=req.rule||'';input.disabled=!req.rule;
    const detail=document.createElement('span');const main=document.createElement('strong');main.textContent=req.tool+' · '+(req.command||req.path||'Unspecified operation');detail.appendChild(main);
    const note=document.createElement('small');note.textContent=req.rule?'One-run scoped rule: '+req.rule:'Requires manual configuration or alternative guidance; cannot safely grant automatically.';detail.appendChild(note);
    row.append(input,detail);card.appendChild(row);fields.push(input);
   }
   if(pending.presetCommands?.length){
    const heading=document.createElement('p');heading.textContent='If Claude did not report its exact Bash command, you can explicitly approve one of these exact verification commands instead:';card.appendChild(heading);
    for(const choice of pending.presetCommands){
     if(fields.some(field=>field.value===choice.rule))continue;
     const item=document.createElement('label');item.className='approval-operation';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=choice.rule;
     const description=document.createElement('span');const name=document.createElement('strong');name.textContent=choice.command;const note=document.createElement('small');note.textContent='Exact command only · may run without a prompt in the resumed stage';description.append(name,note);
     item.append(checkbox,description);card.appendChild(item);fields.push(checkbox);
    }
   }
   const label=document.createElement('label');label.textContent='Instructions to the agent (optional if approving a rule)';card.appendChild(label);
   const instructions=document.createElement('textarea');instructions.rows=2;instructions.placeholder='Example: Skip reading my external Claude plan; use the specifications already provided.';card.appendChild(instructions);
   const approve=document.createElement('button');approve.className='primary';approve.textContent='Continue with selected permissions ↗';approve.onclick=async()=>{
    const approvedRules=fields.filter(x=>x.checked).map(x=>x.value);
    if(!approvedRules.length&&instructions.value.trim().length<5)return toast('Select a safe permission or provide guidance to continue without it.');
    approve.disabled=true;try{await bridge('POST',`/api/runs/${currentRun.id}/approve`,{approvedRules,guidance:instructions.value.trim()});showNewRun();toast('Stage resumed; earlier completed stages are not being repeated.');}catch(error){approve.disabled=false;toast(error.message);}
   };card.appendChild(approve);root.appendChild(card);
  }
  if(previousCount!==String(currentRun.events.length)){root.scrollTop=root.scrollHeight;root.dataset.count=String(currentRun.events.length);}
  $('runStatus').textContent=currentRun.status;
  $('sendTask').textContent=currentRun.status==='needs-input'?'Continue with my answers ↗':'Run workflow ↗';
  $('task').placeholder=currentRun.status==='needs-input'?'Answer the planning questions here to continue without re-running Claude…':currentRun.status==='needs-approval'?'Use the approval panel above to continue this run.':'Message SBQ — describe a feature, fix, or review…';
  renderFlowStrip();$('cancelRun').classList.toggle('hidden',!['running','queued','needs-approval','needs-input'].includes(currentRun.status));$('sendTask').disabled=['running','queued','needs-approval'].includes(currentRun.status);
 }
 async function pollRun(){if(!currentRun)return;try{const {run}=await bridge('GET',`/api/runs/${currentRun.id}`);currentRun=run;renderRun();if(['completed','failed','canceled','needs-attention','needs-review','needs-input','needs-approval','interrupted'].includes(run.status)){clearInterval(runTimer);runTimer=null;loadRuns();loadMiniChanges();}}catch(e){toast(e.message);clearInterval(runTimer);}}
 function showNewRun(){inspectedStageId=workflow[currentRun?.stageIndex??0]?.id||inspectedStageId;tab('chat');renderRun();renderInspector();clearInterval(runTimer);runTimer=setInterval(pollRun,1100);pollRun();loadRuns();}
 let submittingRun=false;
 function showPreflightError(message){
  tab('chat');const notice=$('preflightNotice');notice.replaceChildren();notice.hidden=false;
  const title=document.createElement('strong');title.textContent='Run stopped before any model requests';
  const description=document.createElement('pre');description.textContent=message;
  const actions=document.createElement('div');actions.className='stage-actions';
  const connections=document.createElement('button');connections.className='outline';connections.textContent='Open Connections ↗';connections.onclick=()=>tab('accounts');
  const dismiss=document.createElement('button');dismiss.className='outline';dismiss.textContent='Dismiss';dismiss.onclick=()=>{notice.hidden=true;};
  actions.append(connections,dismiss);notice.append(title,description,actions);
 }
 function showModelValidationError(message){
  const match=String(message).match(/Stage (\d+) \(([^)]+)\): model "([^"]+)"/);
  if(!match)return false;
  const index=Number(match[1])-1,stage=workflow[index];
  if(!stage)return false;
  const list=$('stageList'),card=[...list.querySelectorAll('.stage')].find(x=>x.dataset.stage===stage.id);
  const panel=document.createElement('div');panel.className='model-validation-error';panel.setAttribute('role','alert');
  const title=document.createElement('strong');title.textContent=`Model selection needs attention: Stage ${index+1} · ${stage.name}`;
  const desc=document.createElement('p');desc.textContent=String(message);panel.append(title,desc);
  const actions=document.createElement('div');actions.className='stage-actions';
  const makeButton=(label,handler)=>{const b=document.createElement('button');b.className='outline';b.textContent=label;b.onclick=handler;actions.appendChild(b);};
  makeButton('Use CLI default (save)',async()=>{
   stage.modelMode='default';stage.model='';stage.effort='default';
   try{const saved=await bridge('PUT','/api/workflow',{stages:workflow});workflow=saved.stages;renderWorkflow();renderFlowStrip();renderInspector();toast('CLI default saved for '+stage.name+'. You can now start the workflow.');}
   catch(e){toast(e.message);}
  });
  makeButton('Refresh agent models',async()=>{
   await catalogFor(stage.agent,true);renderWorkflow();renderInspector();
   toast('Model catalog refreshed. Choose a listed model, CLI default, or Custom model ID.');
  });
  makeButton('Keep ID as custom (save)',async()=>{
   stage.modelMode='custom';
   try{const saved=await bridge('PUT','/api/workflow',{stages:workflow});workflow=saved.stages;renderWorkflow();renderFlowStrip();renderInspector();toast('Custom model ID saved. Provider may still reject it when executed.');}
   catch(e){toast(e.message);}
  });
  panel.append(actions);
  if(card){card.prepend(panel);card.scrollIntoView({behavior:'smooth',block:'start'});}else list.prepend(panel);
  return true;
 }
 async function startRun(){if(submittingRun)return;const task=$('task').value.trim(),cwd=$('cwd').value.trim();if(!task)return toast(currentRun?.status==='needs-input'?'Answer the planning questions first':'Enter a task first');
  if(currentRun?.status==='needs-input'){
   try{const d=await bridge('POST',`/api/runs/${currentRun.id}/continue`,{answer:task});$('task').value='';showNewRun();toast('Decisions recorded. Continuing without repeating planning.');}
   catch(e){toast(e.message);}return;
  }
  if(!cwd)return toast('Enter an existing project directory');
  submittingRun=true;$('sendTask').disabled=true;
  try{const d=await bridge('POST','/api/runs',{task,cwd});$('preflightNotice').hidden=true;currentRun={...d.run,events:[]};$('task').value='';localStorage.setItem('sbq-cwd',cwd);showNewRun();}
  catch(e){if(String(e.message).includes('Workflow preflight blocked'))showPreflightError(e.message);else {tab('workflow');if(!showModelValidationError(e.message))toast(e.message);}}
  finally{submittingRun=false;$('sendTask').disabled=!!currentRun&&['running','queued','needs-approval'].includes(currentRun.status);}}
 $('sendTask').onclick=startRun;$('cancelRun').onclick=async()=>{if(currentRun)await bridge('POST',`/api/runs/${currentRun.id}/cancel`);pollRun();};$('task').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();startRun();}});
 async function loadRuns(){try{const data=await bridge('GET','/api/runs');$('runList').replaceChildren();if(!data.runs.length){$('runList').innerHTML='<p class="muted small">No runs yet</p>';return;}for(const r of data.runs){const b=document.createElement('button');b.className='run-link'+(currentRun?.id===r.id?' selected':'');b.textContent=r.task.slice(0,36);const sub=document.createElement('small');sub.textContent=`${r.status} · ${new Date(r.createdAt).toLocaleTimeString()}`;b.appendChild(sub);b.onclick=()=>{currentRun={...r,events:[]};inspectedStageId=workflow[r.stageIndex??0]?.id||inspectedStageId;tab('chat');renderInspector();clearInterval(runTimer);runTimer=setInterval(pollRun,1100);pollRun();};$('runList').appendChild(b);}}catch{}}
 function renderPatch(diff){const target=$('diffPreview');target.replaceChildren();if(!diff){target.textContent='No stored text diff for this selection; file evidence may still be available.';return;}
  const fragment=document.createDocumentFragment();for(const line of diff.split('\n').slice(0,5000)){const row=document.createElement('div');row.className='diff-line '+(line.startsWith('+')&&!line.startsWith('+++')?'diff-add':line.startsWith('-')&&!line.startsWith('---')?'diff-remove':line.startsWith('@@')||line.startsWith('diff --git')||line.startsWith('diff --local')||line.startsWith('---')||line.startsWith('+++')?'diff-meta':'');row.textContent=line||' ';fragment.appendChild(row);}target.appendChild(fragment);
 }
 async function loadChanges(file=null){selectedFile=file;const cwd=currentRun?.cwd||$('cwd').value.trim();if(!cwd){$('changesSummary').textContent='Choose a project directory in Agent chat.';$('fileList').replaceChildren();renderPatch('');return;}
  $('changesSummary').textContent='Reading local and Git changes…';try{const endpoint=currentRun?`/api/runs/${currentRun.id}/changes`:'/api/changes';const params=new URLSearchParams();if(!currentRun)params.set('cwd',cwd);if(file)params.set('file',file);const suffix=params.size?'?'+params.toString():'';
   const data=await bridge('GET',endpoint+suffix);if(!data.isGitRepo&&!data.files?.length){$('changesSummary').textContent=data.note;$('fileList').replaceChildren();renderPatch('');return;}
   $('changesSummary').textContent=`${data.files.length} changed file${data.files.length===1?'':'s'} · ${data.source?.startsWith('local-')?'Local project evidence · ':'Git changes · '}${data.note}`;
   if(!file){const list=$('fileList');list.replaceChildren();const all=document.createElement('button');all.className='file-chip selected';all.textContent=`All changes (${data.files.length})`;all.onclick=()=>loadChanges();list.appendChild(all);
    for(const f of data.files){const button=document.createElement('button');button.className='file-chip';button.innerHTML=`<span class="file-status">${escapeHtml(f.status)}</span><span>${escapeHtml(f.path)}</span>`;button.onclick=()=>loadChanges(f.path);list.appendChild(button);}}
   else{document.querySelectorAll('.file-chip').forEach(b=>b.classList.remove('selected'));$('selectedFile').textContent=file;}
   $('selectedFile').textContent=file||'All changes';renderPatch(data.diff);
  }catch(e){$('changesSummary').textContent=e.message;renderPatch('');}}
 async function refreshAll(){try{await Promise.all([loadWorkflow(),loadRuns()]);setOnline(true);if(activeTab==='accounts')await loadAccounts();if(activeTab==='changes')await loadChanges();if(activeTab==='chat'){await loadMiniChanges();await loadPreflight();}}catch(e){setOnline(false);toast(e.message);}}

 // SBQ chat-side stage inspector: edits the very same workflow configuration as the full builder.
 let inspectedStageId=null,inspectorGeneration=0;
 function populateOptions(select,options,value){select.replaceChildren();for(const o of options){const e=document.createElement('option');e.value=o.value;e.textContent=o.label;select.appendChild(e);}select.value=value;}
 function currentStage(){return workflow.find(s=>s.id===inspectedStageId)||workflow[0];}
 function renderFlowStrip(){const root=$('flowStrip');root.replaceChildren();
  workflow.forEach((stage,i)=>{const item=document.createElement('button');const view=stagePresentation(stage,i);item.className='flow-chip '+view.cls+(stage.id===inspectedStageId?' selected':'');
    const number=document.createElement('span');number.className='chip-num';number.textContent=view.glyph;
    const label=document.createElement('span');label.className='chip-copy';const strong=document.createElement('strong');strong.textContent=stage.name;const sub=document.createElement('small');sub.textContent=(NAMES[stage.agent]||stage.agent)+' · '+view.label;label.append(strong,sub);item.append(number,label);
    item.title=`Configure ${stage.name}`;item.onclick=()=>{inspectedStageId=stage.id;renderFlowStrip();renderInspector();if(narrowInspector.matches)setInspectorOpen(true);};root.appendChild(item);
    if(i<workflow.length-1){const arrow=document.createElement('span');arrow.className='flow-arrow';arrow.textContent='→';root.appendChild(arrow);}
  });}
 function renderInspector(){if(!workflow.length)return;const s=currentStage();if(!s)return;inspectedStageId=s.id;
  const select=$('inspectStage');populateOptions(select,workflow.map((st,i)=>({value:st.id,label:`${i+1}. ${st.name}`})),s.id);
  populateOptions($('inspectRole'),ROLES,s.role);
  populateOptions($('inspectAgent'),AGENTS,s.agent);
  populateOptions($('inspectEffort'),EFFORT,s.effort||'default');
  $('inspectInstructions').value=s.instructions||'';
  populateOptions($('inspectVerifyCommand'),VERIFY_COMMANDS,s.verifyCommand||'');$('inspectRequireChanges').checked=!!s.requireChanges;$('inspectRequiresDocker').checked=!!s.requiresDocker;const writableStage=['implement','support'].includes(s.role);$('inspectAllowNetworkRow').hidden=!writableStage;$('inspectAllowNetwork').checked=writableStage&&s.allowNetwork!==false;
  const myGeneration=++inspectorGeneration;const currentId=s.id;
  const modelSelect=$('inspectModel');populateOptions(modelSelect,[{value:'default',label:'Loading model catalog…'}],'default');modelSelect.disabled=true;
  $('inspectModelHint').textContent='Checking the local runner model catalog…';
  catalogFor(s.agent).then(catalog=>{if(myGeneration!==inspectorGeneration||currentId!==inspectedStageId)return;
   const choices=[{value:'default',label:'CLI default (recommended)'},...catalog.models.map(m=>({value:m.id,label:(m.free?'✦ Free · ':'')+(m.label||m.id)})),{value:'__custom__',label:'Custom model ID…'}];
   const selected=s.modelMode==='custom'?'__custom__':s.modelMode==='default'||!s.model?'default':s.model;
   if(selected!=='__custom__'&&!choices.some(x=>x.value===selected))choices.splice(1,0,{value:'__unknown__',label:'⚠ Saved model unavailable: '+s.model});
   populateOptions(modelSelect,choices,choices.some(x=>x.value===selected)?selected:'__unknown__');modelSelect.disabled=false;
   $('inspectModelHint').textContent=catalog.note||'No CLI models detected. Use CLI default or an exact custom ID.';
   $('inspectCustomWrap').hidden=s.modelMode!=='custom';$('inspectCustom').value=s.modelMode==='custom'?s.model:'';
  }).catch(e=>{$('inspectModelHint').textContent=e.message;});
  $('inspectCustomWrap').hidden=s.modelMode!=='custom';$('inspectCustom').value=s.modelMode==='custom'?s.model:'';
 }
 $('inspectStage').onchange=e=>{inspectedStageId=e.target.value;renderFlowStrip();renderInspector();};
 $('inspectRole').onchange=e=>{const s=currentStage();if(s){s.role=e.target.value;s.requireChanges=['implement','support'].includes(s.role);if(s.role!=='review')s.reviewLoop=false;$('inspectAllowNetworkRow').hidden=!s.requireChanges;$('inspectAllowNetwork').checked=s.requireChanges&&s.allowNetwork!==false;}};
 $('inspectAgent').onchange=e=>{const s=currentStage();if(s){s.agent=e.target.value;s.modelMode='default';s.model='';s.effort='default';renderFlowStrip();renderInspector();}};
 $('inspectModel').onchange=e=>{const s=currentStage();if(!s)return;const v=e.target.value;
  if(v==='default'){s.modelMode='default';s.model='';}else if(v==='__custom__'){s.modelMode='custom';s.model='';}else if(v!=='__unknown__'){s.modelMode='catalog';s.model=v;}
  $('inspectCustomWrap').hidden=s.modelMode!=='custom';if(s.modelMode==='custom')$('inspectCustom').focus();};
 $('inspectCustom').oninput=e=>{const s=currentStage();if(s)s.model=e.target.value;};
 $('inspectEffort').onchange=e=>{const s=currentStage();if(s)s.effort=e.target.value;};
 $('inspectInstructions').oninput=e=>{const s=currentStage();if(s)s.instructions=e.target.value;};
 $('inspectVerifyCommand').onchange=e=>{const s=currentStage();if(s)s.verifyCommand=e.target.value;};
 $('inspectRequireChanges').onchange=e=>{const s=currentStage();if(s)s.requireChanges=e.target.checked;};
 $('inspectRequiresDocker').onchange=e=>{const s=currentStage();if(s)s.requiresDocker=e.target.checked;};
 $('inspectAllowNetwork').onchange=e=>{const s=currentStage();if(s)s.allowNetwork=e.target.checked;};
 $('inspectorSave').onclick=async()=>{if(workflow.some(x=>x.modelMode==='custom'&&!x.model.trim()))return toast('A custom model needs an exact CLI ID.');
  try{const out=await bridge('PUT','/api/workflow',{stages:workflow});workflow=out.stages;toast('Stage configuration saved');renderWorkflow();renderFlowStrip();renderInspector();$('stageCount').textContent=`${workflow.length} stages configured`;}catch(e){toast(e.message);}};
 async function loadMiniChanges(){const cwd=currentRun?.cwd||$('cwd').value.trim();const list=$('miniChangesFiles'),diff=$('miniDiff');if(!cwd){list.textContent='Select a project to see local changes.';diff.textContent='No diff loaded.';return;}
  try{const url=currentRun?`/api/runs/${currentRun.id}/changes`:`/api/changes?cwd=${encodeURIComponent(cwd)}`;const data=await bridge('GET',url);list.replaceChildren();
   if(!data.isGitRepo&&!data.files?.length){list.textContent='No recorded local changes';diff.textContent=data.note||'';return;}
   if(!data.files?.length){list.textContent='No recorded changes';diff.textContent=data.note||'No changed files detected yet.';return;}
   for(const f of data.files.slice(0,8)){const button=document.createElement('button');button.className='mini-file';button.textContent=`${f.status}  ${f.path}`;button.title=f.path;button.onclick=()=>{tab('changes');loadChanges(f.path);};list.appendChild(button);}
   diff.textContent=(data.diff||'').split('\n').slice(0,48).join('\n')||'No text diff preview available; check files and run evidence.';
  }catch(e){list.textContent='Unable to load changes';diff.textContent=e.message;}}
 $('cwd').addEventListener('change',()=>{localStorage.setItem('sbq-cwd',$('cwd').value.trim());loadMiniChanges();renderRunOverview();});

 const reviewAgent=$('reviewAgent'),reviewModel=$('reviewModel');
 for(const a of AGENTS){const o=document.createElement('option');o.value=a.value;o.textContent=a.label;reviewAgent.appendChild(o);}
 reviewAgent.value='claude';
 async function reviewModels(){const agent=reviewAgent.value;reviewModel.disabled=true;reviewModel.replaceChildren();const item=document.createElement('option');item.value='default';item.textContent='Loading…';reviewModel.appendChild(item);
  const catalog=await catalogFor(agent);
  if(reviewAgent.value!==agent)return;
  reviewModel.replaceChildren();for(const opt of [{value:'default',label:'CLI default (recommended)'},...catalog.models.map(m=>({value:m.id,label:(m.free?'✦ Free · ':'')+(m.label||m.id)}))]){const option=document.createElement('option');option.value=opt.value;option.textContent=opt.label;reviewModel.appendChild(option);}reviewModel.disabled=false;
  $('reviewHint').textContent=catalog.note;
 }
 reviewAgent.onchange=reviewModels;
 $('startReview').onclick=async()=>{const cwd=currentRun?.cwd||$('cwd').value.trim();if(!cwd)return toast('Choose your project directory in Agent chat first.');
  try{const model=reviewModel.value;const v=await bridge('POST','/api/reviews',{cwd,agent:reviewAgent.value,modelMode:model==='default'?'default':'catalog',model:model==='default'?'':model,effort:'default',instructions:$('reviewInstructions').value.trim()});currentRun={...v.run,events:[]};showNewRun();toast('AI review started. Monitor its findings in Agent chat.');}
  catch(e){toast(e.message);}};
 reviewModels();
 $('cwd').value=localStorage.getItem('sbq-cwd')||localStorage.getItem('agentflow-cwd')||'';
 refreshAll();
 // Discover current CLI models when the app regains focus and every 2 minutes.
 // Only query the installed local tools; subscriptions and entitlements remain their responsibility.
 let lastCatalogRefresh=Date.now();
 async function refreshVisibleCatalogs(){if(document.hidden)return;const now=Date.now();if(now-lastCatalogRefresh<110000)return;lastCatalogRefresh=now;
   const visible=activeTab==='workflow'?new Set(workflow.map(s=>s.agent)):activeTab==='chat'?new Set([currentStage()?.agent].filter(Boolean)):new Set();
   await Promise.all([...visible].map(a=>catalogFor(a,true)));
   if(activeTab==='chat')renderInspector();
   // Avoid resetting editable workflow form fields while a user is typing.
   if(activeTab==='workflow'&&!document.activeElement?.matches('input,textarea,select'))renderWorkflow();
 }
 document.addEventListener('visibilitychange',refreshVisibleCatalogs);window.addEventListener('focus',refreshVisibleCatalogs);setInterval(refreshVisibleCatalogs,120000);
})();
