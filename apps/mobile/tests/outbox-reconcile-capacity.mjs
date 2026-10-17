/** Production JS + real Chrome IDB against a SCRIPTED protocol boundary.
 * No actual native planner, authorization, SQLite policy, or network timing is proven. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source=await readFile(new URL('../web/native-outbox.js',import.meta.url));let server,browser;
try{
  server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/adapter.js'?'application/javascript':'text/html');res.end(req.url==='/adapter.js'?source:'<!doctype html><script src=/adapter.js></script>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'chrome',headless:true});
  for(const [resources,expectedReads]of [[601,1202],[1000,2000],[1001,1000]]){
    const context=await browser.newContext(),page=await context.newPage();await page.goto(origin);
    const result=await page.evaluate(async resources=>{
      const origin='https://capacity.invalid',profileId=origin+'|workspace|actor|binding',expiresAt=Date.now()+110000,lease='current-owner',planId='opaque-plan',checksum='a'.repeat(64),descriptors=[{kind:'workspace',id:'workspace'},...Array.from({length:resources-1},(_,index)=>({kind:'page',id:'page-'+index}))];
      let sweep=1,position=0,head=0,commits=0,cancels=0,reads=0,continuations=0;
      const profile={id:profileId,origin,workspaceId:'workspace',memberId:'actor',cacheBinding:'binding',validUntil:Date.now()+1000000,workspace:{pages:[],databases:[]},session:{authenticated:true,member:{id:'actor',role:'member'},workspace_id:'workspace',cache_binding:'binding'}};
      const counts={refresh:3,keep:0,acknowledge:0,quarantine:0,import:0};
      const bridge={
        outboxOpen:async()=>({generation:1,lease,head,proofEpoch:0,resourceAccess:head?'ready':'required',identityState:'verified',profileId,validUntil:profile.validUntil,accessIssues:[],accessIssuesTruncated:false,reconciliationHandles:[]}),
        async outboxReconcile(input){
          if(input.phase==='cancel'){cancels++;return{generation:1,state:'cancelled',planId};}
          if(input.phase==='commit'){commits++;head++;return{generation:1,state:'committed',planId,lease,head,proofEpoch:0,checksum,receipt:{version:1,planId,checksum,sourceHead:0,targetHead:1,mode:'current',counts}};}
          if(input.phase!=='prepare')throw Error('unexpected protocol phase');continuations++;
          if(position===descriptors.length){sweep++;position=0;}
          if(sweep>2)return{generation:1,state:'ready',planId,lease,baseHead:0,proofEpoch:0,expiresAt,checksum,counts,reasons:[],requiresConfirmation:false};
          const needed=position===0?[descriptors[position++]]:descriptors.slice(position,position+=Math.min(32,descriptors.length-position));return{generation:1,state:'collecting',planId,lease,expiresAt,sweep,needed};
        },
        async readPage(){const values=[['profiles',profileId,profile],['meta','active',{id:'active',profileId}],['meta','last-profile',{id:'last-profile',profileId}]];return{generation:1,head,proofEpoch:0,next:null,fragments:values.map(([bucket,key,value])=>{const bytes=new TextEncoder().encode(JSON.stringify(value));return{bucket,key,offset:0,total:bytes.length,bytesBase64:btoa(String.fromCharCode(...bytes))};})};}
      };
      const driver={scope:()=>({scopeEpoch:1}),current:()=>true,pause(){},resume(){},session:async()=>new Response('{}',{status:200}),canonical:async()=>{reads++;return 200;}};
      const storage=FountainNativeOutbox.create(bridge,{origin,generation:1,driver});let code=null;try{await storage.initialize();}catch(error){code=error.code;}const ready=storage.ready;storage.close();return{code,ready,reads,commits,cancels,continuations};
    },resources);
    assert.equal(result.reads,expectedReads);if(resources<=1000){assert.equal(result.code,null);assert.equal(result.ready,true);assert.equal(result.commits,1);assert.ok(result.continuations>0&&result.continuations<=2001);if(resources===1000)assert.ok(result.continuations>64,'legal Android batch32/two-sweep pagination exceeds the old 64-reply cap');}else{assert.equal(result.code,'OUTBOX_INVALID_PLAN');assert.equal(result.ready,false);assert.equal(result.commits,0);assert.equal(result.cancels,1);}await context.close();
  }
  console.log('PASS production JS/Chrome protocol capacity: 601x2=1202 and 1000x2=2000 descriptors; >1000 in one sweep denies before COMMIT; bounded pagination/TTL remain; no actual native policy/SDK timing proof');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
