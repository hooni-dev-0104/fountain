'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
function fixture(){
 const windows=[],sessions=new Map(),state={saved:null,fail:false,answer:1,cloudClients:[],cloudOptions:[]};
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
  session:{fromPartition(key){if(!sessions.has(key)){const value=new EventEmitter();Object.assign(value,{webRequest:{onBeforeRequest(_filter,handler){value.requestGuard=handler;}},protocol:{handle(scheme,handler){value.protocolScheme=scheme;value.protocolHandler=handler;}},fetch:async()=>new Response('{}'),setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){}});sessions.set(key,value);}return sessions.get(key);}}};
 const source=fs.readFileSync(path.join(__dirname,'../../apps/desktop/src/main.cjs'),'utf8');
 const context={require(name){if(name==='electron')return electron;if(name==='./config.cjs')return {saveConfig(_directory,url){if(state.fail){state.fail=false;throw new Error('simulated config failure');}state.saved=url;}};
  if(name==='./cloud.cjs')return {UI_ORIGIN:'https://fountain.desktop.invalid',isCloudServer:value=>/^https:\/\/[a-z0-9]{20}\.supabase\.co\/$/.test(value),cloudPartitions:value=>({frontend:'cloud-ui:'+value,network:'cloud-network:'+value}),networkAllowed:(target,value)=>target.startsWith(value+'functions/v1/fountain-api/api/'),async createCloudClient(options){state.cloudOptions.push(options);const client={enabled:false,resumes:0,suspends:0,handle(){},resume(){this.enabled=true;this.resumes++;},suspend(){this.enabled=false;this.suspends++;}};state.cloudClients.push(client);return client;}};
  if(name==='./security.cjs')return require('../../apps/desktop/src/security.cjs');return require(name);},
  __dirname:path.resolve(__dirname,'../../apps/desktop/src'),process:{env:{},platform:'darwin'},setImmediate,console};
 vm.runInNewContext(source+'\nglobalThis.fixtureAPI={openServer,guardRemoteWindow,status:()=>({server,switching})};',context);
 return {api:context.fixtureAPI,state,windows,Window,sessions};
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
test('Supabase selection boots bundled UI with a separate private network session',async()=>{
 const {api,state,windows,sessions}=fixture(),server='https://ehnovtfadpkwtubmwltl.supabase.co/';
 await api.openServer(server);
 assert.equal(windows[0].webContents.getURL(),'https://fountain.desktop.invalid/#home');
 assert.equal(state.saved,server);assert.equal(api.status().server,server);
 const frontend=sessions.get('cloud-ui:'+server),network=sessions.get('cloud-network:'+server);
 assert.equal(windows[0].webContents.session,frontend);assert.notEqual(frontend,network);
 assert.equal(frontend.protocolScheme,'https');assert.equal(typeof frontend.protocolHandler,'function');
 assert.equal(state.cloudClients.length,1);assert.equal(state.cloudClients[0].enabled,true);
 assert.equal(windows[0].options.webPreferences.preload,undefined);
 assert.equal(state.cloudOptions[0].server,server);assert.equal(path.basename(state.cloudOptions[0].bundleRoot),'bundle');
 await api.openServer(server);
 assert.equal(state.cloudClients.length,1);assert.equal(state.cloudClients[0].enabled,true);
 assert.equal(windows.filter(value=>!value.destroyed).length,1);
});
test('cloud work remains live on refused switch and suspends after the last owning window closes',async()=>{
 const {api,state,windows,Window}=fixture(),server='https://ehnovtfadpkwtubmwltl.supabase.co/';
 await api.openServer(server);const client=state.cloudClients[0];assert.ok(client);
 windows[0].block=true;state.answer=0;assert.equal(await api.openServer('https://other.example/'),false);assert.equal(client.enabled,true);
 windows[0].block=false;
 const popup=new Window({webPreferences:{session:windows[0].webContents.session}});api.guardRemoteWindow(popup,'https://fountain.desktop.invalid/');
 await new Promise(done=>{windows[0].once('closed',done);windows[0].close();});assert.equal(client.enabled,true);
 await new Promise(done=>{popup.once('closed',done);popup.close();});assert.equal(client.enabled,false);
 await api.openServer(server);assert.equal(client.enabled,true);
 await api.openServer('https://other.example/');assert.equal(client.enabled,false);assert.equal(state.saved,'https://other.example/');
});
