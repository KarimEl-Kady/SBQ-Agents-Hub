'use strict';
const vscode=require('vscode');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const url=require('node:url');
const LOGIN={claude:'claude auth login',codex:'codex login',agy:'agy',opencode:'opencode auth login',gemini:'gemini',kilo:'kilo',freebuff:'freebuff'};
class SBQProvider {
 constructor(context){this.context=context;this.view=null;}
 resolveWebviewView(view){this.view=view;const w=view.webview;w.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};const css=w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','app.css'));const js=w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','app.js'));let html=fs.readFileSync(path.join(this.context.extensionPath,'media','index.html'),'utf8');const logo=w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','assets','sbq-logo.svg'));const symbol=w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','assets','sbq-symbol.svg'));html=html.replace('./assets/sbq-logo.svg',logo.toString()).replace('./assets/sbq-symbol.svg',symbol.toString());html=html.replace('./app.css',css.toString()).replace('./app.js',js.toString()).replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src '+w.cspSource+'; img-src '+w.cspSource+' data:; script-src '+w.cspSource+';">');w.html=html;
 w.onDidReceiveMessage(async m=>{if(m.type==='login'){const cmd=LOGIN[m.agent];if(!cmd)return;const term=vscode.window.createTerminal(`SBQ Agents Hub: ${m.agent} sign-in`);term.show();term.sendText(cmd);return;}
 if(m.type!=='api')return;try{const data=await queryEngine(m.method,m.path,m.body);w.postMessage({type:'response',id:m.id,data});}catch(e){w.postMessage({type:'response',id:m.id,error:String(e.message||e)});}});
 }
 show(){this.view?.show?.(true)}
}
// Use a running engine (desktop app or `npm run engine`); otherwise start the
// copy bundled into the extension by `npm run sync:extension`.
const DAEMON=path.join(os.homedir(),'.sbq-agents-hub','daemon.json');
let extensionRoot=null,owned=null,connecting=null,cached=null;
function readDaemon(){try{return JSON.parse(fs.readFileSync(DAEMON,'utf8'));}catch{return null;}}
async function healthy(cfg){try{const r=await fetch(`http://127.0.0.1:${cfg.port}/api/health`,{headers:{authorization:`Bearer ${cfg.token}`},signal:AbortSignal.timeout(1500)});return r.ok;}catch{return false;}}
async function connect(){
 const cfg=readDaemon();if(cfg&&await healthy(cfg))return cfg;
 const entry=path.join(extensionRoot,'engine','server.mjs');
 if(!fs.existsSync(entry))throw new Error('Local engine not running. Start the desktop app or run npm run engine from the source checkout (or run npm run sync:extension so the extension can start it).');
 const {startEngine}=await import(url.pathToFileURL(entry).href);
 owned=await startEngine();return {port:owned.port,token:owned.token};
}
async function engine(){if(cached)return cached;connecting??=connect().finally(()=>{connecting=null;});cached=await connecting;return cached;}
async function queryEngine(method,p,body,retry=true){if(!['GET','POST','PUT'].includes(method)||typeof p!=='string'||p.length>5000)throw new Error('Invalid API path');const u=new URL(p,'http://localhost');if(!u.pathname.startsWith('/api/')||u.pathname.includes('..')||u.origin!=='http://localhost'||!/^\/api\/[a-z0-9/-]+$/.test(u.pathname)||[...u.searchParams.keys()].some(k=>!['agent','cwd','file','refresh'].includes(k)))throw new Error('Invalid API route');
 const cfg=await engine();
 let response;try{response=await fetch(`http://127.0.0.1:${cfg.port}${p}`,{method,headers:{authorization:`Bearer ${cfg.token}`,'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body||{}),signal:AbortSignal.timeout(60000)});}
 catch{cached=null;if(retry)return queryEngine(method,p,body,false);throw new Error('Could not reach local engine. Restart it and try again.');}
 const j=await response.json();if(response.status===401&&retry){cached=null;return queryEngine(method,p,body,false);}if(!response.ok)throw new Error(j.error||`HTTP ${response.status}`);return j;}
function activate(context){extensionRoot=context.extensionPath;const provider=new SBQProvider(context);context.subscriptions.push(vscode.window.registerWebviewViewProvider('sbqAgentsHub.chat',provider,{webviewOptions:{retainContextWhenHidden:true}}));context.subscriptions.push(vscode.commands.registerCommand('sbqAgentsHub.open',()=>vscode.commands.executeCommand('workbench.view.extension.sbqAgentsHub')));}
function deactivate(){owned?.server?.close();}
module.exports={activate,deactivate};
