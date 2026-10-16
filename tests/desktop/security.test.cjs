'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {normalizeServer,sameOrigin,downloadAllowed,resourceAllowed,partitionFor,popupAllowed,isSetupSender}=require('../../apps/desktop/src/security.cjs');
const config=require('../../apps/desktop/src/config.cjs');

test('server roots allow only HTTPS or exact HTTP loopback spellings',()=>{
  const cases=new Map([['https://example.com','https://example.com/'],['https://EXAMPLE.com:443/','https://example.com/'],
    ['http://localhost:8787','http://localhost:8787/'],['http://127.0.0.1:8080/','http://127.0.0.1:8080/'],['http://[::1]:8787','http://[::1]:8787/']]);
  for(const [input,expected]of cases)assert.equal(normalizeServer(input),expected);
  for(const input of ['http://example.com','http://localhost.evil','http://127.0.0.2','http://127.1','http://2130706433',
    'http://0x7f000001','http://localhost.','http://[0:0:0:0:0:0:0:1]','https://user:pass@example.com','https://@example.com',
    'https://example.com/route','https://example.com/.','https://example.com/%2e','https://example.com?','https://example.com#',
    'https://example.com/?q=secret','https://example.com/#/page','https://example.com\\@evil','javascript:alert(1)','file:///tmp/app',
    'data:text/html,x','https://example.com:','https://example.com:99999','https://example.com\n',' https://example.com','']){
    assert.throws(()=>normalizeServer(input),undefined,input);
  }
});
test('navigation and download checks compare parsed origins, credentials and schemes',()=>{
  const root='https://notes.example/';assert.ok(sameOrigin(root+'#/page',root));assert.ok(sameOrigin(root+'api/pages?id=x',root));
  for(const target of ['https://notes.example.evil/','https://evil@notes.example/','http://notes.example/','file:///etc/passwd','mailto:a@b','javascript:alert(1)'])assert.equal(sameOrigin(target,root),false,target);
  assert.ok(downloadAllowed('blob:https://notes.example/a',root));assert.equal(downloadAllowed('blob:https://evil.example/a',root),false);
  assert.equal(resourceAllowed('file:///tmp/secret',root),false);assert.equal(resourceAllowed('https://evil.example/tracker',root),false);
  assert.ok(resourceAllowed('data:image/png;base64,AA',root));assert.equal(resourceAllowed('data:text/html,x',root),false);
});
test('IPC sender must be exact live setup main frame and exact file URL',()=>{
  const mainFrame={url:'file:///app/setup.html'},contents={mainFrame,isDestroyed:()=>false},event={sender:undefined,senderFrame:mainFrame};
  event.sender=contents;assert.ok(isSetupSender(event,contents,mainFrame.url));
  for(const forged of [{...event,sender:{}},{...event,senderFrame:{url:mainFrame.url}},{...event,senderFrame:{url:mainFrame.url+'#x'}},{...event,senderFrame:{url:'https://server/'}}])assert.equal(isSetupSender(forged,contents,mainFrame.url),false);
  assert.equal(isSetupSender(event,{...contents,isDestroyed:()=>true},mainFrame.url),false);
});
test('only exact same-origin public form/site GET popups are permitted',()=>{
  const server='https://notes.example/';
  for(const pathname of ['forms/abc-123','sites/family_notes'])assert.equal(popupAllowed({url:server+pathname},server),true);
  for(const url of [server+'api/workspace',server+'forms/a?token=x',server+'forms/a#fragment',server+'forms/a/extra',
    server+'forms/%2e%2e',server+'forms/%2fsecret','https://evil.example/forms/a','file:///forms/a','javascript:alert(1)'])assert.equal(popupAllowed({url},server),false,url);
  assert.equal(popupAllowed({url:server+'forms/a',postBody:{data:[]}},server),false);
});
test('server origin partitions preserve canonical equivalents and separate ports/hosts',()=>{
  assert.equal(partitionFor('https://server'),partitionFor('https://server:443/'));
  assert.notEqual(partitionFor('http://127.0.0.1:8080'),partitionFor('http://127.0.0.1:8081'));
  assert.notEqual(partitionFor('https://server'),partitionFor('https://other'));
});
test('configuration is private, atomic, validated and repairable without following symlinks',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fountain-desktop-unit-'));
  try{
    config.prepare(directory);assert.equal(config.readConfig(directory),null);
    assert.equal(config.saveConfig(directory,'https://example.com'),'https://example.com/');
    assert.equal(config.readConfig(directory),'https://example.com/');
    if(process.platform!=='win32')assert.equal(fs.statSync(config.configPath(directory)).mode&0o777,0o600);
    fs.writeFileSync(config.configPath(directory),'broken JSON');
    assert.throws(()=>config.readConfig(directory));config.saveConfig(directory,'https://repaired.example/');
    assert.equal(config.readConfig(directory),'https://repaired.example/');
    fs.unlinkSync(config.configPath(directory));fs.symlinkSync(path.join(directory,'missing'),config.configPath(directory));
    assert.throws(()=>config.readConfig(directory));assert.throws(()=>config.saveConfig(directory,'https://example.com/'));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
