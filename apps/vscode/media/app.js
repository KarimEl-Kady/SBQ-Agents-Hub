(()=>{'use strict';
 const $=id=>document.getElementById(id);
 const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const vscode=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;
 const NAMES={claude:'Claude Code',codex:'Codex',agy:'Antigravity',opencode:'OpenCode',gemini:'Gemini CLI',kilo:'Kilo Code',freebuff:'Freebuff (interactive)'};
 const AGENTS=Object.entries(NAMES).filter(([id])=>id!=='freebuff').map(([value,label])=>({value,label}));
 const INSTALL_GUIDES={claude:'https://code.claude.com/docs/en/overview',codex:'https://developers.openai.com/codex/cli',agy:'https://antigravity.google/docs/getting-started?tab=cli',opencode:'https://opencode.ai/docs',gemini:'https://geminicli.com/docs/get-started/',kilo:'https://kilo.ai/docs/code-with-ai/platforms/cli',freebuff:'https://github.com/CodebuffAI/freebuff'};
 const ROLES=[{value:'plan',label:'Planning'},{value:'implement',label:'Implementation'},{value:'review',label:'Review / Audit'},{value:'support',label:'Support / Automation'}];
 const EFFORT=[{value:'default',label:'CLI default (safest)'},{value:'low',label:'Low'},{value:'medium',label:'Medium'},{value:'high',label:'High'},{value:'xhigh',label:'Extra high (only if supported)'}];
 let seq=0,workflow=[],providers=[],currentRun=null,runTimer=null,activeTab='chat',selectedFile=null,authPoll=null;
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
 const nativeConnect=(id,cmd)=>{if(window.sbqDesktop)return window.sbqDesktop.connect(id);if(vscode){vscode.postMessage({type:'login',agent:id});return Promise.resolve();}return navigator.clipboard.writeText(cmd);};
 async function copy(text){try{await navigator.clipboard.writeText(text);toast('Copied to clipboard');}catch{toast('Clipboard unavailable; please copy it from the terminal.');}}
 function toast(message){const n=$('toast');n.className='toast';n.textContent=message;clearTimeout(toast.t);toast.t=setTimeout(()=>{n.textContent='';n.className='';},5500);}
 function tab(name){setInspectorOpen(false);activeTab=name;document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab===name));document.querySelectorAll('.panel').forEach(n=>n.classList.toggle('active',n.id==='tab-'+name));$('pageName').textContent=({chat:'Chat',workflow:'Workflows',accounts:'Connections',changes:'Code changes'})[name];if(name==='accounts')loadAccounts();if(name==='changes')loadChanges();if(name==='chat'){renderFlowStrip();renderInspector();loadMiniChanges();}}
 document.querySelectorAll('.nav').forEach(n=>n.addEventListener('click',()=>tab(n.dataset.tab)));
 $('quickConnections').onclick=()=>tab('accounts');$('goWorkflow').onclick=()=>tab('workflow');$('goWorkflowWelcome').onclick=()=>tab('workflow');$('goChanges').onclick=()=>tab('changes');$('openFullChanges').onclick=()=>tab('changes');$('refresh').onclick=refreshAll;$('checkAccounts').onclick=loadAccounts;$('refreshRuns').onclick=loadRuns;$('refreshChanges').onclick=loadChanges;
 function setOnline(online){$('engineDot').classList.toggle('on',online);$('engineText').textContent=online?'Engine connected':'Engine unavailable';}
 function field(label,value,handler,type='input',options=[]){const wrap=document.createElement('div');wrap.className='field';const lbl=document.createElement('label');lbl.textContent=label;wrap.appendChild(lbl);const input=document.createElement(type==='textarea'?'textarea':type==='select'?'select':'input');if(type==='select')for(const option of options){const item=document.createElement('option');item.value=option.value;item.textContent=option.label;input.appendChild(item);}input.value=value??'';input.addEventListener(type==='select'?'change':'input',event=>handler(event.target.value));wrap.appendChild(input);return wrap;}
 async function loadWorkflow(){const {stages}=await bridge('GET','/api/workflow');workflow=stages.map(s=>({...s,modelMode:s.modelMode||(s.model?'catalog':'default')}));$('stageCount').textContent=`${stages.length} stages configured`;renderWorkflow();renderFlowStrip();renderInspector();}
 async function catalogFor(agent,force=false){const cwd=$('cwd')?.value?.trim()||'';const key=agent+'|'+cwd;if(force)modelCache.delete(key);if(!modelCache.has(key))modelCache.set(key,bridge('GET',`/api/models?agent=${encodeURIComponent(agent)}${cwd?'&cwd='+encodeURIComponent(cwd):''}${force?'&refresh=1':''}`).catch(e=>({agent,models:[],source:'unavailable',note:e.message})));return modelCache.get(key);}
 function renderWorkflow(){const list=$('stageList');list.replaceChildren();$('workflowCount').textContent=`${workflow.length} customizable stage${workflow.length===1?'':'s'}`;
 workflow.forEach((stage,index)=>{
  const card=document.createElement('div');card.className='stage';card.dataset.stage=stage.id;
  const top=document.createElement('div');top.className='stage-top';top.innerHTML=`<div><span class="stage-number">${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(stage.name)}</strong></div>`;
  const controls=document.createElement('div');controls.className='stage-actions';
  for(const [icon,title,fn] of [['↑','Move up',()=>move(index,-1)],['↓','Move down',()=>move(index,1)],['⧉','Duplicate',()=>{workflow.splice(index+1,0,{...stage,id:crypto.randomUUID(),name:stage.name+' Copy'});renderWorkflow();}],['×','Remove',()=>{workflow.splice(index,1);renderWorkflow();}]]){const b=document.createElement('button');b.className='mini'+(title==='Remove'?' delete':'');b.textContent=icon;b.title=title;b.setAttribute('aria-label',title);b.onclick=fn;controls.appendChild(b);}
  top.appendChild(controls);card.appendChild(top);
  card.appendChild(field('Stage name',stage.name,v=>{stage.name=v;top.querySelector('strong').textContent=v;}));
  const pair=document.createElement('div');pair.className='grid-two';pair.appendChild(field('Role / purpose',stage.role,v=>stage.role=v,'select',ROLES));pair.appendChild(field('Agent / runner',stage.agent,v=>{stage.agent=v;stage.model='';stage.modelMode='default';stage.effort='default';renderWorkflow();},'select',AGENTS));card.appendChild(pair);
  const pair2=document.createElement('div');pair2.className='grid-two';
  const modelField=document.createElement('div');modelField.className='field';const modelLabel=document.createElement('label');modelLabel.textContent='Model for '+NAMES[stage.agent];modelField.appendChild(modelLabel);
  const select=document.createElement('select');select.innerHTML='<option value="default">Loading model choices…</option>';select.disabled=true;modelField.appendChild(select);
  const hint=document.createElement('div');hint.className='model-hint';hint.textContent='Checking the local CLI model choices…';modelField.appendChild(hint);
  const custom=field('Exact custom model ID (advanced)',stage.modelMode==='custom'?stage.model:'',v=>stage.model=v);custom.classList.add('custom-model');custom.hidden=stage.modelMode!=='custom';modelField.appendChild(custom);
  const refresh=document.createElement('button');refresh.className='text-button';refresh.textContent='↻ Refresh this agent’s models';refresh.onclick=()=>{hint.textContent='Refreshing CLI model catalog…';populate(true);};modelField.appendChild(refresh);
  pair2.appendChild(modelField);pair2.appendChild(field('Reasoning effort',stage.effort||'default',v=>stage.effort=v,'select',EFFORT));card.appendChild(pair2);
  const instructions=field('Stage instructions and expected result',stage.instructions,v=>stage.instructions=v,'textarea');instructions.classList.add('wide');card.appendChild(instructions);
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
 $('addStage').onclick=()=>{workflow.push({id:crypto.randomUUID(),name:'New stage',role:'support',agent:'claude',model:'',modelMode:'default',effort:'default',instructions:'Describe what the agent should do, and what a successful result looks like.'});renderWorkflow();renderFlowStrip();renderInspector();};
 $('saveWorkflow').onclick=async()=>{if(!workflow.length)return toast('Add at least one stage first');
  if(workflow.some(s=>s.modelMode==='custom'&&!s.model.trim()))return toast('Enter an exact model ID for custom model stages, or choose CLI default.');
  try{const out=await bridge('PUT','/api/workflow',{stages:workflow});workflow=out.stages;$('stageCount').textContent=`${workflow.length} stages configured`;toast('Workflow saved');renderWorkflow();renderFlowStrip();renderInspector();}catch(e){toast(e.message);}};
 let pollingAccounts=false;
 async function loadAccounts(){if(pollingAccounts)return;pollingAccounts=true;const root=$('accountList');root.innerHTML='<div class="loading">Checking installed CLIs and existing local sessions…</div>';
  try{const response=await bridge('GET','/api/providers');providers=response.providers;root.replaceChildren();for(const p of providers){
   const item=document.createElement('article');item.className='account';const state=p.auth==='connected'?'Connected':p.auth==='not-installed'?'CLI not installed':p.auth==='not-connected'?'Not connected':'Session unverified';
   item.innerHTML=`<div class="account-top"><span class="provider-name">${NAMES[p.id]}</span><span class="status ${escapeHtml(p.auth)}">● ${state}</span></div><p class="account-note">${escapeHtml(p.detail||'Check your existing local sign-in before creating a new one.')}</p>`;
   const footer=document.createElement('div');footer.className='account-footer';
   const recheck=document.createElement('button');recheck.className='outline';recheck.textContent='↻ Use existing session';recheck.onclick=()=>loadAccounts();
   const connect=document.createElement('button');connect.className='primary';connect.textContent=p.id==='opencode'?'Manage providers / Sign in':p.id==='agy'?'Open Antigravity CLI':p.id==='freebuff'?'Open Freebuff':p.id==='kilo'?'Open Kilo / Connect':'Sign in / Reconnect';connect.disabled=!p.installed;
   connect.onclick=async()=>{try{await nativeConnect(p.id,response.loginCommands[p.id]);toast(`Opened ${NAMES[p.id]} official CLI. Complete sign-in there if required.`);startAuthChecks();}catch(e){toast(e.message);}};
   const copyCmd=document.createElement('button');copyCmd.className='outline';copyCmd.textContent='Copy command';copyCmd.onclick=()=>copy(response.loginCommands[p.id]);
   footer.append(recheck,connect,copyCmd);const docs=document.createElement('a');docs.href=INSTALL_GUIDES[p.id];docs.target='_blank';docs.rel='noopener noreferrer';docs.className='docs-link';docs.textContent='Install / help ↗';footer.appendChild(docs);item.appendChild(footer);
   const note=document.createElement('div');note.className='connection-extra';
   if(p.id==='agy')note.textContent='Signed in to Antigravity IDE or App? agy normally reuses that account through the OS keyring. If no CLI is installed, install the official agy CLI first. No manual token import.';
   else if(p.id==='opencode')note.textContent='Already signed in to OpenCode IDE/Desktop? Local CLI normally shares its service. For ChatGPT, choose OpenAI → Sign in with ChatGPT. For Claude Agent, connect its existing Claude Code login in OpenCode. No API key required for those supported flows.';
   else if(p.id==='freebuff')note.textContent='Freebuff supports free, ad-funded models and an existing browser login. The CLI is interactive-only, so launch it in its own terminal; it cannot run automatic SBQ stages yet. Review Freebuff data-use disclosures for private repositories.';
   else if(p.id==='kilo')note.textContent='Kilo Code supports CLI workflow runs and the documented kilo-auto/free model. Open the Kilo CLI once for account setup. Models can be refreshed from Kilo automatically.';
   else if(p.id==='gemini')note.textContent='Already use Gemini CLI? Open it once to choose the official Google sign-in method. SBQ does not ask you to enter credentials or inspect local token storage.';
   else if(p.id==='codex')note.textContent='Existing Codex CLI / ChatGPT login is checked; a separate OpenAI API key is not required for supported ChatGPT login.';
   else note.textContent='Reuses your existing Claude Code session. No API key is requested by SBQ.';
   item.appendChild(note);root.appendChild(item);
  }}catch(e){root.innerHTML='<div class="loading">'+escapeHtml(e.message)+'</div>';}finally{pollingAccounts=false;}}
 function startAuthChecks(){clearInterval(authPoll);let count=0;authPoll=setInterval(async()=>{if(++count>8){clearInterval(authPoll);return;}if(activeTab==='accounts')await loadAccounts();},4000);}
 function renderRun(){const root=$('conversation');if(!currentRun){root.innerHTML='<div class="welcome"><img class="welcome-symbol" src="./assets/sbq-symbol.svg" alt=""><h2>What shall we build?</h2><p>Enter a task. Follow each stage and inspect the actual Git diff below.</p><button id="openWorkflow" class="outline">Customize workflow ↗</button></div>';$('openWorkflow').onclick=()=>tab('workflow');return;}
  const previousCount=root.dataset.count;root.replaceChildren();let lastText=null;
  for(const event of currentRun.events){if(event.type==='message'&&lastText?.agent===event.agent&&lastText.stageId===event.stageId){lastText.element.textContent+=event.text;continue;}
   const row=document.createElement('article');row.className='message '+event.type;const glyph=document.createElement('div');glyph.className='message-icon';glyph.textContent=({stage:'◇',message:'✦',result:'✓',tool:'⚙',error:'!',warning:'!',success:'✓',system:'●',changes:'±'})[event.type]||'·';
   const body=document.createElement('div');body.className='message-body';const header=document.createElement('div');header.className='message-head';const who=document.createElement('span');who.textContent=event.agent?NAMES[event.agent]:({stage:'Stage',error:'Error',success:'Completed',tool:'Tool activity',changes:'Git changes'})[event.type]||'Orchestrator';const when=document.createElement('span');when.className='meta';when.textContent=new Date(event.ts).toLocaleTimeString();header.append(who,when);const content=document.createElement('div');content.className='message-content';content.textContent=event.text;body.append(header,content);
   if(event.type==='changes'){const b=document.createElement('button');b.className='outline mini-review';b.textContent='Review changed files ↗';b.onclick=()=>tab('changes');body.appendChild(b);}
   row.append(glyph,body);root.appendChild(row);lastText=event.type==='message'?{agent:event.agent,stageId:event.stageId,element:content}:null;
  }
  if(previousCount!==String(currentRun.events.length)){root.scrollTop=root.scrollHeight;root.dataset.count=String(currentRun.events.length);}
  $('runStatus').textContent=currentRun.status;renderFlowStrip();$('cancelRun').classList.toggle('hidden',!['running','queued'].includes(currentRun.status));$('sendTask').disabled=['running','queued'].includes(currentRun.status);
 }
 async function pollRun(){if(!currentRun)return;try{const {run}=await bridge('GET',`/api/runs/${currentRun.id}`);currentRun=run;renderRun();if(['completed','failed','canceled'].includes(run.status)){clearInterval(runTimer);runTimer=null;loadRuns();loadMiniChanges();}}catch(e){toast(e.message);clearInterval(runTimer);}}
 function showNewRun(){tab('chat');renderRun();clearInterval(runTimer);runTimer=setInterval(pollRun,1100);pollRun();loadRuns();}
 async function startRun(){const task=$('task').value.trim(),cwd=$('cwd').value.trim();if(!task)return toast('Enter a task first');if(!cwd)return toast('Enter an existing project directory');
  try{const d=await bridge('POST','/api/runs',{task,cwd});currentRun={...d.run,events:[]};$('task').value='';localStorage.setItem('sbq-cwd',cwd);showNewRun();}catch(e){toast(e.message);tab('workflow');}}
 $('sendTask').onclick=startRun;$('cancelRun').onclick=async()=>{if(currentRun)await bridge('POST',`/api/runs/${currentRun.id}/cancel`);pollRun();};$('task').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();startRun();}});
 async function loadRuns(){try{const data=await bridge('GET','/api/runs');$('runList').replaceChildren();if(!data.runs.length){$('runList').innerHTML='<p class="muted small">No runs yet</p>';return;}for(const r of data.runs){const b=document.createElement('button');b.className='run-link'+(currentRun?.id===r.id?' selected':'');b.textContent=r.task.slice(0,36);const sub=document.createElement('small');sub.textContent=`${r.status} · ${new Date(r.createdAt).toLocaleTimeString()}`;b.appendChild(sub);b.onclick=()=>{currentRun={...r,events:[]};tab('chat');clearInterval(runTimer);runTimer=setInterval(pollRun,1100);pollRun();};$('runList').appendChild(b);}}catch{}}
 function renderPatch(diff){const target=$('diffPreview');target.replaceChildren();if(!diff){target.textContent='No tracked changes or untracked text previews for this selection.';return;}
  const fragment=document.createDocumentFragment();for(const line of diff.split('\n').slice(0,5000)){const row=document.createElement('div');row.className='diff-line '+(line.startsWith('+')&&!line.startsWith('+++')?'diff-add':line.startsWith('-')&&!line.startsWith('---')?'diff-remove':line.startsWith('@@')||line.startsWith('diff --git')||line.startsWith('---')||line.startsWith('+++')?'diff-meta':'');row.textContent=line||' ';fragment.appendChild(row);}target.appendChild(fragment);
 }
 async function loadChanges(file=null){selectedFile=file;const cwd=currentRun?.cwd||$('cwd').value.trim();if(!cwd){$('changesSummary').textContent='Choose a project directory in Agent chat.';$('fileList').replaceChildren();renderPatch('');return;}
  $('changesSummary').textContent='Reading Git status…';try{const endpoint=currentRun?`/api/runs/${currentRun.id}/changes`:'/api/changes';const suffix=file?`?file=${encodeURIComponent(file)}`:currentRun?'':`?cwd=${encodeURIComponent(cwd)}`;
   const data=await bridge('GET',endpoint+suffix);if(!data.isGitRepo){$('changesSummary').textContent=data.note;$('fileList').replaceChildren();renderPatch('');return;}
   $('changesSummary').textContent=`${data.files.length} changed file${data.files.length===1?'':'s'} · ${data.note}`;
   if(!file){const list=$('fileList');list.replaceChildren();const all=document.createElement('button');all.className='file-chip selected';all.textContent=`All changes (${data.files.length})`;all.onclick=()=>loadChanges();list.appendChild(all);
    for(const f of data.files){const button=document.createElement('button');button.className='file-chip';button.innerHTML=`<span class="file-status">${escapeHtml(f.status)}</span><span>${escapeHtml(f.path)}</span>`;button.onclick=()=>loadChanges(f.path);list.appendChild(button);}}
   else{document.querySelectorAll('.file-chip').forEach(b=>b.classList.remove('selected'));$('selectedFile').textContent=file;}
   $('selectedFile').textContent=file||'All changes';renderPatch(data.diff);
  }catch(e){$('changesSummary').textContent=e.message;renderPatch('');}}
 async function refreshAll(){try{await Promise.all([loadWorkflow(),loadRuns()]);setOnline(true);if(activeTab==='accounts')await loadAccounts();if(activeTab==='changes')await loadChanges();if(activeTab==='chat')await loadMiniChanges();}catch(e){setOnline(false);toast(e.message);}}

 // SBQ chat-side stage inspector: edits the very same workflow configuration as the full builder.
 let inspectedStageId=null,inspectorGeneration=0;
 function populateOptions(select,options,value){select.replaceChildren();for(const o of options){const e=document.createElement('option');e.value=o.value;e.textContent=o.label;select.appendChild(e);}select.value=value;}
 function currentStage(){return workflow.find(s=>s.id===inspectedStageId)||workflow[0];}
 function renderFlowStrip(){const root=$('flowStrip');root.replaceChildren();const active=currentRun?.stageIndex??-1;
  workflow.forEach((stage,i)=>{const item=document.createElement('button');item.className='flow-chip'+(stage.id===inspectedStageId?' selected':'')+(currentRun&&i<active?' complete':'');
    const number=document.createElement('span');number.className='chip-num';number.textContent=currentRun&&i<active?'✓':String(i+1);
    const label=document.createElement('span');label.className='chip-copy';const strong=document.createElement('strong');strong.textContent=stage.name;const sub=document.createElement('small');sub.textContent=NAMES[stage.agent]||stage.agent;label.append(strong,sub);item.append(number,label);
    item.title=`Configure ${stage.name}`;item.onclick=()=>{inspectedStageId=stage.id;renderFlowStrip();renderInspector();if(narrowInspector.matches)setInspectorOpen(true);};root.appendChild(item);
    if(i<workflow.length-1){const arrow=document.createElement('span');arrow.className='flow-arrow';arrow.textContent='→';root.appendChild(arrow);}
  });}
 function renderInspector(){if(!workflow.length)return;const s=currentStage();if(!s)return;inspectedStageId=s.id;
  const select=$('inspectStage');populateOptions(select,workflow.map((st,i)=>({value:st.id,label:`${i+1}. ${st.name}`})),s.id);
  populateOptions($('inspectRole'),ROLES,s.role);
  populateOptions($('inspectAgent'),AGENTS,s.agent);
  populateOptions($('inspectEffort'),EFFORT,s.effort||'default');
  $('inspectInstructions').value=s.instructions||'';
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
 $('inspectRole').onchange=e=>{const s=currentStage();if(s)s.role=e.target.value;};
 $('inspectAgent').onchange=e=>{const s=currentStage();if(s){s.agent=e.target.value;s.modelMode='default';s.model='';s.effort='default';renderFlowStrip();renderInspector();}};
 $('inspectModel').onchange=e=>{const s=currentStage();if(!s)return;const v=e.target.value;
  if(v==='default'){s.modelMode='default';s.model='';}else if(v==='__custom__'){s.modelMode='custom';s.model='';}else if(v!=='__unknown__'){s.modelMode='catalog';s.model=v;}
  $('inspectCustomWrap').hidden=s.modelMode!=='custom';if(s.modelMode==='custom')$('inspectCustom').focus();};
 $('inspectCustom').oninput=e=>{const s=currentStage();if(s)s.model=e.target.value;};
 $('inspectEffort').onchange=e=>{const s=currentStage();if(s)s.effort=e.target.value;};
 $('inspectInstructions').oninput=e=>{const s=currentStage();if(s)s.instructions=e.target.value;};
 $('inspectorSave').onclick=async()=>{if(workflow.some(x=>x.modelMode==='custom'&&!x.model.trim()))return toast('A custom model needs an exact CLI ID.');
  try{const out=await bridge('PUT','/api/workflow',{stages:workflow});workflow=out.stages;toast('Stage configuration saved');renderWorkflow();renderFlowStrip();renderInspector();$('stageCount').textContent=`${workflow.length} stages configured`;}catch(e){toast(e.message);}};
 async function loadMiniChanges(){const cwd=currentRun?.cwd||$('cwd').value.trim();const list=$('miniChangesFiles'),diff=$('miniDiff');if(!cwd){list.textContent='Select a project to see the Git changes.';diff.textContent='No diff loaded.';return;}
  try{const url=currentRun?`/api/runs/${currentRun.id}/changes`:`/api/changes?cwd=${encodeURIComponent(cwd)}`;const data=await bridge('GET',url);list.replaceChildren();
   if(!data.isGitRepo){list.textContent='Not a Git repository.';diff.textContent=data.note||'';return;}
   if(!data.files?.length){list.textContent='Working tree clean';diff.textContent='No local changes to review.';return;}
   for(const f of data.files.slice(0,8)){const button=document.createElement('button');button.className='mini-file';button.textContent=`${f.status}  ${f.path}`;button.title=f.path;button.onclick=()=>{tab('changes');loadChanges(f.path);};list.appendChild(button);}
   diff.textContent=data.diff.split('\n').slice(0,48).join('\n')||'No text diff available.';
  }catch(e){list.textContent='Unable to load changes';diff.textContent=e.message;}}
 $('cwd').addEventListener('change',()=>{localStorage.setItem('sbq-cwd',$('cwd').value.trim());loadMiniChanges();});

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
