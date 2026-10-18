/** Generate real production-native-transport preview/share outputs; no network/Auth claim. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
const transportSource=await readFile(new URL('../../web/native-transport.js',import.meta.url),'utf8');
const scopeSource=await readFile(new URL('../../../../static/workspace-scope.js',import.meta.url),'utf8');
const events=new EventTarget(),document=new EventTarget();document.visibilityState='visible';
const context=vm.createContext({URL,URLSearchParams,Headers,Response,Blob,ArrayBuffer,Uint8Array,TextEncoder,DOMException,EventTarget,Event,MessageEvent,CustomEvent,AbortController,structuredClone,setTimeout,clearTimeout,queueMicrotask,btoa,atob,document,navigator:{onLine:true},location:{origin:'https://localhost',pathname:'/',href:'https://localhost/'},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
vm.runInContext(scopeSource,context);vm.runInContext(transportSource,context);
const expires=Date.now()+3600000,binding='0123456789abcdef0123456789abcdef',accountBinding='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const session={enabled:true,required:true,authenticated:true,mode:'accounts',workspace_id:'workspace-A',cache_binding:binding,account_binding:accountBinding,expires_at:new Date(expires).toISOString(),member:{id:'member-A',role:'owner',active:true}};
const bridge={getConfiguration:async()=>({origin:'https://ehnovtfadpkwtubmwltl.supabase.co',generation:1,workspaceVersion:1}),activateWorkspace:async()=>({generation:1,workspaceEpoch:1,workspace:{workspaceId:'workspace-A',memberId:'member-A',binding,accountBinding,expiresAt:expires,session}})};
const T=context.FountainNativeTransport.create(bridge);await T.initialize();await T.setWorkspace({workspaceId:'workspace-A',memberId:'member-A',binding,accountBinding,expiresAt:expires,workspaceEpoch:0});
const urls=[];for(const [path,route] of [['/forms/family-form','form/family-form'],['/sites/family-site','site/family-site']])for(const name of ['publicURL','publicShareURL']){const url=T[name](path,'https://family.example');assert.equal(url,'https://family.example/#w/workspace-A/'+route);assert.equal(url.includes(binding),false);urls.push(url);}
assert.ok(process.argv[2]);await writeFile(process.argv[2],urls.join('\n')+'\n',{flag:'wx'});
