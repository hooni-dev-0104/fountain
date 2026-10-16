'use strict';
const {app,BrowserWindow,Menu,ipcMain,session,dialog}=require('electron');
const path=require('node:path');const {pathToFileURL}=require('node:url');
const {normalizeServer,sameOrigin,downloadAllowed,resourceAllowed,partitionFor,popupAllowed,isSetupSender}=require('./security.cjs');
const config=require('./config.cjs');
const cloud=require('./cloud.cjs');
app.setName('Fountain');app.enableSandbox();
if(process.env.FOUNTAIN_DESKTOP_USER_DATA){
  if(!path.isAbsolute(process.env.FOUNTAIN_DESKTOP_USER_DATA))throw new Error('Desktop user data must be absolute');
  app.setPath('userData',process.env.FOUNTAIN_DESKTOP_USER_DATA);
}
const setupFile=path.join(__dirname,'..','ui','setup.html'),setupURL=pathToFileURL(setupFile).href;
let setupWindow=null,remoteWindow=null,server=null,lastError='',switching=false;
let connectionQueue=Promise.resolve();
const secured=new WeakSet();
const remoteWindows=new Set();
const cloudConnections=new WeakMap(),cloudClients=new Set();
const preferences={nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,
  webSecurity:true,allowRunningInsecureContent:false,experimentalFeatures:false,webviewTag:false,navigateOnDragDrop:false,devTools:false};
function secureSession(value,origin=null){
  if(secured.has(value))return;secured.add(value);
  value.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  value.setPermissionCheckHandler(()=>false);value.setDevicePermissionHandler(()=>false);
  value.setDisplayMediaRequestHandler((_request,callback)=>callback(null));
  value.on('select-hid-device',(event,_details,callback)=>{event.preventDefault();callback();});
  value.on('select-usb-device',(event,_details,callback)=>{event.preventDefault();callback();});
  value.on('select-serial-port',(event,_details,callback)=>{event.preventDefault();callback('');});
  value.on('will-download',(event,item,contents)=>{
    if(!origin||![...remoteWindows].some(window=>!window.isDestroyed()&&window.webContents===contents)||!item.getURLChain().every(url=>downloadAllowed(url,origin))){event.preventDefault();return;}
    item.setSaveDialogOptions({title:'파일 저장',buttonLabel:'저장',defaultPath:path.basename(item.getFilename()).replace(/[\x00-\x1f\\/]/g,'_')||'download'});
  });
  if(origin)value.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>callback({cancel:!resourceAllowed(details.url,origin)}));
}
function guardWindow(window,allowed,popupOrigin=null){
  window.webContents.setWindowOpenHandler(details=>!switching&&popupOrigin&&popupAllowed(details,popupOrigin)?{
    action:'allow',overrideBrowserWindowOptions:{width:1000,height:820,title:'Fountain',
      webPreferences:{...preferences,session:window.webContents.session}}
  }:{action:'deny'});
  if(popupOrigin)window.webContents.on('did-create-window',child=>guardRemoteWindow(child,popupOrigin));
  for(const name of ['will-navigate','will-frame-navigate','will-redirect'])window.webContents.on(name,(event,details)=>{
    const target=typeof details==='string'?details:details?.url??event.url;if(!allowed(target))event.preventDefault();
  });
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('select-bluetooth-device',(event,_devices,callback)=>{event.preventDefault();callback('');});
  window.webContents.on('will-prevent-unload',event=>{
    const answer=dialog.showMessageBoxSync(window,{type:'question',title:'문서 나가기',
      message:'저장 중인 변경 내용이 있을 수 있습니다. 이 화면을 떠날까요?',
      buttons:['계속 편집','나가기'],defaultId:0,cancelId:0});
    if(answer===1)event.preventDefault();
  });
}
function guardRemoteWindow(window,origin){
  const selected=window.webContents.session,client=cloudConnections.get(selected)?.client;
  remoteWindows.add(window);guardWindow(window,url=>sameOrigin(url,origin),origin);
  window.on('closed',()=>{
    remoteWindows.delete(window);
    if(client&&![...remoteWindows].some(other=>!other.isDestroyed()&&other.webContents.session===selected))client.suspend();
  });
}
async function cloudConnection(normalized){
  const partitions=cloud.cloudPartitions(normalized),selected=session.fromPartition(partitions.frontend);
  let connection=cloudConnections.get(selected);if(connection)return connection;
  const network=session.fromPartition(partitions.network);
  secureSession(selected,cloud.UI_ORIGIN+'/');secureSession(network);
  network.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>callback({cancel:!cloud.networkAllowed(details.url,normalized)}));
  const bundleRoot=app.isPackaged?path.join(process.resourcesPath,'bundle'):path.join(__dirname,'..','bundle');
  const client=await cloud.createCloudClient({server:normalized,bundleRoot,fetch:(target,options)=>network.fetch(target,options)});
  selected.protocol.handle('https',request=>client.handle(request));
  connection={session:selected,client,origin:cloud.UI_ORIGIN+'/',url:cloud.UI_ORIGIN+'/#home'};
  cloudConnections.set(selected,connection);cloudClients.add(client);return connection;
}
function showSetup(message=''){
  lastError=message;
  if(setupWindow&&!setupWindow.isDestroyed()){setupWindow.webContents.reload();setupWindow.focus();return;}
  const setupSession=session.fromPartition('fountain-settings');secureSession(setupSession);
  setupWindow=new BrowserWindow({width:600,height:490,resizable:false,title:'Fountain 서버 설정',webPreferences:{...preferences,session:setupSession,preload:path.join(__dirname,'setup-preload.cjs')}});
  const window=setupWindow;guardWindow(window,url=>url===setupURL);
  window.on('closed',()=>{if(setupWindow===window)setupWindow=null;});
  window.loadFile(setupFile).catch(()=>{});
}
function closeForSwitch(window){
  return new Promise(resolve=>{
    const contents=window.webContents;
    const finished=()=>{contents.removeListener('will-prevent-unload',blocked);resolve(true);};
    const blocked=event=>{if(!event.defaultPrevented){window.removeListener('closed',finished);resolve(false);}};
    window.once('closed',finished);contents.once('will-prevent-unload',blocked);window.close();
  });
}
function openServer(address){
  const next=connectionQueue.then(()=>transitionServer(address));
  connectionQueue=next.catch(()=>{});return next;
}
async function transitionServer(address){
  const normalized=normalizeServer(address),connection=cloud.isCloudServer(normalized)?await cloudConnection(normalized):null;
  const selected=connection?.session??session.fromPartition(partitionFor(normalized)),displayOrigin=connection?.origin??normalized;
  secureSession(selected,displayOrigin);
  switching=true;
  try{
  if(remoteWindow&&!remoteWindow.isDestroyed()&&!await closeForSwitch(remoteWindow))return false;
  for(const popup of [...remoteWindows])if(!popup.isDestroyed()&&!await closeForSwitch(popup))return false;
  // Every selected server is persisted, including a reconnect queued behind a
  // settings request; the final window and next-start config stay consistent.
  config.saveConfig(app.getPath('userData'),normalized);
  const window=new BrowserWindow({width:1360,height:940,minWidth:760,minHeight:560,title:'Fountain',webPreferences:{...preferences,session:selected}});
  remoteWindow=window;server=normalized;guardRemoteWindow(window,displayOrigin);
  window.on('closed',()=>{if(remoteWindow===window)remoteWindow=null;});
  window.webContents.on('render-process-gone',()=>{connection?.client.suspend();showSetup('화면을 다시 열어 주세요.');});
  window.webContents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{
    if(isMainFrame&&code!==-3){connection?.client.suspend();showSetup('서버에 연결할 수 없습니다. 주소와 서버 상태를 확인한 뒤 다시 연결해 주세요.');}
  });
  connection?.client.resume();
  window.loadURL(connection?.url??normalized).catch(()=>{});
  if(setupWindow&&!setupWindow.isDestroyed())setupWindow.close();
  return true;
  }finally{switching=false;}
}
function requireSetup(event){if(!isSetupSender(event,setupWindow?.webContents,setupURL))throw new Error('설정 요청이 허용되지 않습니다.');}
ipcMain.handle('desktop:server:get',event=>{requireSetup(event);return {server,error:lastError};});
ipcMain.handle('desktop:server:save',(event,value)=>{
  requireSetup(event);let normalized;
  try{normalized=normalizeServer(value);}catch(error){return {ok:false,error:error.message};}
  setImmediate(()=>openServer(normalized).catch(()=>showSetup('서버 설정을 저장할 수 없습니다.')));return {ok:true};
});
app.on('certificate-error',(event,_contents,_url,_error,_certificate,callback)=>{event.preventDefault();callback(false);});
app.on('web-contents-created',(_event,contents)=>contents.on('will-attach-webview',event=>event.preventDefault()));
app.on('open-url',event=>event.preventDefault());
app.on('will-quit',()=>{for(const client of cloudClients)client.suspend();});
app.on('window-all-closed',()=>{if(!switching&&process.platform!=='darwin')app.quit();});
app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length){if(server)openServer(server).catch(()=>showSetup('서버에 연결할 수 없습니다.'));else showSetup();}});
app.whenReady().then(()=>{
  config.prepare(app.getPath('userData'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{label:'Fountain',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]}]:[]),
    {label:'파일',submenu:[{id:'server-settings',label:'서버 변경…',click:()=>showSetup()},{id:'server-reconnect',label:'다시 연결',click:()=>{if(server)openServer(server).catch(()=>showSetup('서버에 연결할 수 없습니다.'));else showSetup();}},{type:'separator'},process.platform==='darwin'?{role:'close'}:{role:'quit'}]},
    {label:'편집',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'보기',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}
  ]));
  try{server=config.readConfig(app.getPath('userData'));}catch{lastError='저장된 서버 설정을 확인해 주세요.';}
  if(server)return openServer(server);else showSetup(lastError);
}).catch(()=>{dialog.showErrorBox('Fountain','앱 설정을 열 수 없습니다.');app.quit();});
