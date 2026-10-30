'use strict';const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sbqDesktop',{
 request:(method,path,body)=>ipcRenderer.invoke('sbq:request',method,path,body),
 connect:id=>ipcRenderer.invoke('sbq:connect',id)
});
