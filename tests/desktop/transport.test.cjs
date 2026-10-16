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
