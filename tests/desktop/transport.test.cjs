'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../static/transport.js'),'utf8');
function transport(origin){const context={location:{origin},URL};vm.runInNewContext(source,context);return context.FountainTransport;}
test('ordinary web sharing keeps the existing public app address',()=>{
 const value=transport('https://notes.example.com');
 assert.equal(value.shareURL('page/family'),'https://notes.example.com/#page/family');
 assert.equal(value.appURL('page/family'),'https://notes.example.com/#page/family');
});
test('bundled desktop navigation is separate from unavailable public share addresses',()=>{
 const value=transport('https://fountain.desktop.invalid');
 assert.equal(value.shareURL('database/projects'),null);
 assert.equal(value.appURL('database/projects'),'https://fountain.desktop.invalid/#database/projects');
 assert.equal(value.apiURL('/api/session'),'https://fountain.desktop.invalid/api/session');
});
test('share address rejection still validates the logical route before reporting unavailable',()=>{
 for(const origin of ['https://fountain.desktop.invalid','https://notes.example.com'])for(const route of ['page/../secret','page/%252e%252e','page/x#secret','//outside.invalid'])assert.throws(()=>transport(origin).shareURL(route));
});
test('primary frontend links are stateless while desktop previews stay at the local UI origin',()=>{
 for(const origin of ['https://notes.example.com','https://fountain.desktop.invalid']){
  const value=transport(origin),desktop=origin==='https://fountain.desktop.invalid';
  for(const primary of ['https://share.example','https://share.example:8443','https://xn--bcher-kva.example','https://[::1]']){
   assert.equal(value.shareURL('page/한글',primary),primary+'/#page/한글');
   assert.equal(value.publicShareURL('/forms/family?view=%2F',primary),primary+'/forms/family?view=%2F');
   assert.equal(value.publicURL('/sites/family',primary),(desktop?origin:primary)+'/sites/family');
  }
  for(const unset of [null,undefined]){
   assert.equal(value.shareURL('home',unset),desktop?null:origin+'/#home');
   assert.equal(value.publicShareURL('/sites/family',unset),desktop?null:origin+'/sites/family');
   assert.equal(value.publicURL('/sites/family',unset),origin+'/sites/family');
  }
  assert.equal(value.appURL('page/family'),origin+'/#page/family');assert.equal(value.apiURL('/api/session'),origin+'/api/session');
 }
});
test('share and preview helpers reject noncanonical primary origins without URL normalization',()=>{
 const malformed=['',false,0,{},new URL('https://share.example'),'http://share.example','HTTPS://share.example','https://SHARE.example','https://share.example:443','https://share.example:08443','https://share.example/','https://share.example/.','https://share.example/%2e','https://user:secret@share.example','https://share.example?','https://share.example#','https://share.example?q=1','https://share.example#fragment','https://%73hare.example','https://bücher.example','https://[0:0:0:0:0:0:0:1]','https://share.example\\path',' https://share.example','https://share.example\n'];
 for(const origin of ['https://notes.example.com','https://fountain.desktop.invalid']){
  const value=transport(origin);
  for(const primary of malformed){
   assert.throws(()=>value.shareURL('home',primary));assert.throws(()=>value.publicShareURL('/forms/family',primary));assert.throws(()=>value.publicURL('/forms/family',primary));
  }
  for(const primary of [null,'https://share.example'])for(const method of ['publicURL','publicShareURL'])for(const path of ['/api/session','/forms/../private','/sites/%252e%252e','/sites/a%252f%252fb','/forms/id#fragment','//outside.invalid/forms/id'])assert.throws(()=>value[method](path,primary));
  for(const primary of [null,'https://share.example'])for(const route of ['page/../secret','page/%252e%252e','page/x#secret','//outside.invalid'])assert.throws(()=>value.shareURL(route,primary));
 }
});
