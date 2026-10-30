'use strict';
const {app,BrowserWindow,ipcMain,shell}=require('electron');
const {spawn}=require('node:child_process');
const {readFileSync,existsSync,readdirSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const {homedir}=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..');
// GUI apps launched from Dock/Finder/Start Menu can inherit a minimal PATH.
// Expose common *local binary folders*, never read or copy provider credentials.
function includeCommonCliPaths(){
 const h=homedir(); const candidate=[
  path.join(h,'.local','bin'),path.join(h,'bin'),path.join(h,'.bun','bin'),
  path.join(h,'.volta','bin'),path.join(h,'.npm-global','bin'),
  '/opt/homebrew/bin','/usr/local/bin'
 ];
 const nvm=path.join(h,'.nvm','versions','node');
 if(existsSync(nvm))try{for(const v of readdirSync(nvm).sort().reverse().slice(0,5))candidate.push(path.join(nvm,v,'bin'));}catch{}
 const original=String(process.env.PATH||'').split(path.delimiter).filter(Boolean);
 process.env.PATH=[...new Set([...candidate.filter(x=>existsSync(x)),...original])].join(path.delimiter);
}
includeCommonCliPaths();
const LOGIN={claude:'claude auth login',codex:'codex login',agy:'agy',opencode:'opencode auth login',gemini:'gemini',kilo:'kilo',freebuff:'freebuff'};
let connection,ownedServer;
async function connectEngine(){const p=path.join(homedir(),'.sbq-agents-hub','daemon.json');if(existsSync(p))try{const cfg=JSON.parse(readFileSync(p,'utf8'));const r=await fetch(`http://127.0.0.1:${cfg.port}/api/health`,{headers:{authorization:`Bearer ${cfg.token}`},signal:AbortSignal.timeout(1200)});if(r.ok){const info=await r.json();if(info.version!=='0.5.0')throw new Error(`SBQ Agents Hub engine v${info.version||'unknown'} is still running. Close the old SBQ app / npm run engine and restart to use v0.5.`);return cfg;}}catch(e){if(String(e.message).includes('engine v'))throw e;}
 const {startEngine}=await import(pathToFileURL(path.join(ROOT,'packages/engine/server.mjs')).href);const started=await startEngine();ownedServer=started.server;return started;}
function openNativeTerminal(command){return new Promise((resolve,reject)=>{let bin,args;
 if(process.platform==='darwin'){bin='osascript';const escaped=command.replace(/\\/g,'\\\\').replace(/"/g,'\\"');args=['-e',`tell application "Terminal" to do script "${escaped}"`];}
 else if(process.platform==='win32'){bin='cmd.exe';args=['/c','start','"SBQ Agents Hub sign-in"','cmd.exe','/k',command];}
 else{
  const bashCommand=`${command}; echo; echo 'You may close this window.'; exec bash`;
  const candidates=[['x-terminal-emulator',['-e','bash','-lc',bashCommand]],['gnome-terminal',['--','bash','-lc',bashCommand]],['konsole',['-e','bash','-lc',bashCommand]],['xfce4-terminal',['--command',`bash -lc ${JSON.stringify(bashCommand)}`]],['xterm',['-e','bash','-lc',bashCommand]]];
  const found=candidates.find(([name])=>spawnSync('sh',['-c',`command -v ${name}`],{stdio:'ignore'}).status===0);
  if(!found)return reject(new Error(`No graphical terminal found. Run this in your own terminal: ${command}`));
  [bin,args]=found;
 }
 const proc=spawn(bin,args,{detached:true,stdio:'ignore',windowsHide:false});proc.once('error',err=>reject(new Error(`Failed to open a terminal (${err.message}). Run manually: ${command}`)));proc.once('spawn',()=>{proc.unref();resolve(true)});
 });}
async function boot(){connection=await connectEngine();const win=new BrowserWindow({width:1280,height:850,minWidth:400,minHeight:420,title:'SBQ Agents Hub — The Wise AI Workspace',icon:path.join(ROOT,'build/icon.png'),backgroundColor:'#080d13',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:false}});await win.loadFile(path.join(ROOT,'packages/ui/index.html'));win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return{action:'deny'};});win.webContents.on('will-navigate',(e,url)=>{if(url!==win.webContents.getURL())e.preventDefault()});}
ipcMain.handle('sbq:request',async(_,method,p,body)=>{if(!['GET','POST','PUT'].includes(method)||typeof p!=='string'||p.length>5000)throw new Error('API request rejected');const u=new URL(p,'http://localhost');if(!u.pathname.startsWith('/api/')||u.pathname.includes('..')||u.origin!=='http://localhost'||!/^\/api\/[a-z0-9/-]+$/.test(u.pathname)||[...u.searchParams.keys()].some(k=>!['agent','cwd','file','refresh'].includes(k)))throw new Error('Invalid local API route');const r=await fetch(`http://127.0.0.1:${connection.port}${p}`,{method,headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body||{})});const j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j;});
ipcMain.handle('sbq:connect',async(_,id)=>{if(!(id in LOGIN))throw new Error('Invalid agent');return openNativeTerminal(LOGIN[id]);});
app.whenReady().then(boot).catch(e=>{console.error('Desktop startup failed:',e);app.quit()});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});app.on('before-quit',()=>{ownedServer?.close()});
