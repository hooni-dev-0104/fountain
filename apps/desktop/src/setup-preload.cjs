'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('fountainSetup',Object.freeze({
  get:()=>ipcRenderer.invoke('desktop:server:get'),
  save:server=>ipcRenderer.invoke('desktop:server:save',server)
}));
