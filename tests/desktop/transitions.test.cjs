'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
function fixture(){
 const windows=[],sessions=new Map(),state={saved:null,fail:false,answer:1};
 class Contents extends EventEmitter{
  constructor(owner){super();this.owner=owner;this.session=owner.options.webPreferences.session;this.mainFrame={url:''};}
  setWindowOpenHandler(handler){this.windowOpen=handler;}loadURL(url){this.mainFrame.url=url;return Promise.resolve();}
  getURL(){return this.mainFrame.url;}isDestroyed(){return this.owner.destroyed;}reload(){}
 }
 class Window extends EventEmitter{
  constructor(options){super();this.options=options;this.destroyed=false;this.webContents=new Contents(this);windows.push(this);}
  loadURL(url){return this.webContents.loadURL(url);}isDestroyed(){return this.destroyed;}
  close(){setImmediate(()=>{if(this.destroyed)return;if(this.block){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};this.webContents.emit('will-prevent-unload',event);if(!event.defaultPrevented)return;}
   this.destroyed=true;this.emit('closed');});}
 }
 const app=new EventEmitter();Object.assign(app,{setName(){},enableSandbox(){},getPath(){return '/fixture/private';},whenReady(){return new Promise(()=>{});}});
 const electron={app,BrowserWindow:Window,Menu:{},ipcMain:{handle(){}},dialog:{showMessageBoxSync(){return state.answer;}},
  session:{fromPartition(key){if(!sessions.has(key)){const value=new EventEmitter();Object.assign(value,{webRequest:{onBeforeRequest(){}},setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){}});sessions.set(key,value);}return sessions.get(key);}}};
 const source=fs.readFileSync(path.join(__dirname,'../../apps/desktop/src/main.cjs'),'utf8');
 const context={require(name){if(name==='electron')return electron;if(name==='./config.cjs')return {saveConfig(_directory,url){if(state.fail){state.fail=false;throw new Error('simulated config failure');}state.saved=url;}};
  if(name==='./security.cjs')return require('../../apps/desktop/src/security.cjs');return require(name);},
  __dirname:path.resolve(__dirname,'../../apps/desktop/src'),process:{env:{},platform:'darwin'},setImmediate,console};
 vm.runInNewContext(source+'\nglobalThis.fixtureAPI={openServer,guardRemoteWindow,status:()=>({server,switching})};',context);
 return {api:context.fixtureAPI,state,windows,Window};
}
test('real main transition source serializes concurrent requests and closes public popups',async()=>{
 const {api,state,windows,Window}=fixture();await api.openServer('https://a.example/');
 const popup=new Window({webPreferences:{session:windows[0].webContents.session}});api.guardRemoteWindow(popup,'https://a.example/');
 await Promise.all([api.openServer('https://b.example/'),api.openServer('https://c.example/')]);
 assert.deepEqual(windows.filter(window=>!window.destroyed).map(window=>window.webContents.getURL()),['https://c.example/']);
 assert.equal(state.saved,'https://c.example/');assert.equal(api.status().server,'https://c.example/');assert.equal(api.status().switching,false);
});
test('failed or canceled transitions release queue and preserve selected state',async()=>{
 const {api,state,windows}=fixture();await api.openServer('https://a.example/');windows[0].block=true;state.answer=0;
 assert.equal(await api.openServer('https://b.example/'),false);assert.equal(state.saved,'https://a.example/');assert.equal(api.status().switching,false);
 state.answer=1;state.fail=true;
 const results=await Promise.allSettled([api.openServer('https://b.example/'),api.openServer('https://c.example/')]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(state.saved,'https://c.example/');
 assert.deepEqual(windows.filter(window=>!window.destroyed).map(window=>window.webContents.getURL()),['https://c.example/']);assert.equal(api.status().switching,false);
});
