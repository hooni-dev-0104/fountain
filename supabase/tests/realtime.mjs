// Production subscriber over fake sockets/fake time plus an actual loopback WS
// handshake. Not a deployed Supabase/RLS/publication/runtime verification.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRealtime} from '../functions/_shared/realtime.ts';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt=(claims={},header={alg:'HS256',typ:'JWT'})=>encode(header)+'.'+encode({iss:'supabase',role:'service_role',ref:'fixture',exp:Math.floor(Date.now()/1000)+3600,...claims})+'.'+'A'.repeat(43);
const pub='sb_publishable_fixture_public_key',secret='sb_secret_fixture_server_only_key';
class FakeSocket extends EventTarget {
 readyState=0;sent=[];closed=0;throws=false;listeners=new Set();
 addEventListener(type,callback,...rest){this.listeners.add(type);super.addEventListener(type,callback,...rest);}
 removeEventListener(type,callback,...rest){this.listeners.delete(type);super.removeEventListener(type,callback,...rest);}
 send(text){if(this.throws)throw new Error('PRIVATE '+jwt());this.sent.push(JSON.parse(text));}
 close(){this.closed++;this.readyState=3;}
 open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
 frame(value){this.dispatchEvent(new MessageEvent('message',{data:typeof value==='string'?value:JSON.stringify(value)}));}
 error(){this.dispatchEvent(new Event('error'));}
}
function fixture(t,overrides={}){
 const socket=new FakeSocket(),config={url:'https://fixture.supabase.co',publishableKey:pub,serverToken:jwt(),workspaceId:'family-1',socketFactory:url=>{socket.url=url;return socket;},...overrides},subscriber=createRealtime(config);t.after(()=>subscriber.close());return {socket,subscriber,config};
}
function ack(socket,options={}){
 const join=socket.sent[0];assert.equal(join.event,'phx_join');const entry=join.payload.config.postgres_changes[0];
 socket.frame({topic:join.topic,event:'phx_reply',ref:'1',join_ref:'1',payload:{status:'ok',response:{postgres_changes:[{...entry,id:42,...options}]}}});
}
function system(socket,status='ok'){socket.frame({topic:socket.sent[0].topic,event:'system',payload:{extension:'postgres_changes',status}});}
function change(socket,revision=1,options={}){const join=socket.sent[0];socket.frame({topic:join.topic,event:'postgres_changes',payload:{ids:[42],data:{schema:'fountain_cloud',table:'workspace_signals',type:'UPDATE',record:{workspace_id:'family-1',revision},errors:null,...options}}});}
async function pending(subscriber,signal=new AbortController().signal,timeout=1000){let resolved=false;const promise=subscriber.wait(signal,timeout).then(()=>{resolved=true;});await Promise.resolve();return {promise,resolved:()=>resolved};}

test('strict pinned configuration keeps private JWT only in join payload, fixed narrow subscription requires both confirmations',async t=>{
 const {socket,subscriber,config}=fixture(t);socket.open();socket.open();assert.equal(socket.sent.length,1);const url=new URL(socket.url),join=socket.sent[0];assert.equal(url.protocol,'wss:');assert.equal(url.pathname,'/realtime/v1/websocket');assert.equal(url.searchParams.get('apikey'),pub);assert.equal(url.searchParams.get('vsn'),'1.0.0');assert(!socket.url.includes(config.serverToken));
 assert.equal(join.payload.access_token,config.serverToken);assert.deepEqual(join.payload.config,{private:true,broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[{event:'*',schema:'fountain_cloud',table:'workspace_signals',filter:'workspace_id=eq.family-1',select:['workspace_id','revision']}]});assert.equal(join.join_ref,'1');
 let ready=null;subscriber.ready.then(value=>{ready=value;});ack(socket);await Promise.resolve();assert.equal(ready,null);system(socket);assert.equal(await subscriber.ready,true);assert.deepEqual(Object.keys(subscriber).sort(),['close','ready','wait']);
});
test('invalid origins, public/private token substitution, user JWT, expired token and workspace mismatch fail before socket creation',()=>{
 const base={url:'https://fixture.supabase.co',publishableKey:pub,serverToken:jwt(),workspaceId:'family-1',socketFactory:()=>{throw Error('must not connect');}};
 for(const changed of [{url:'http://elsewhere.test'},{url:'https://fixture.supabase.co/path'},{url:'https://user:pass@fixture.supabase.co'},{url:'https://fixture.supabase.co?secret=1'},{url:'https://fixture.supabase.co:444'},{publishableKey:jwt()},{publishableKey:'sb_secret_not_public'},{serverToken:'sb_secret_not_jwt'},{serverToken:jwt({role:'authenticated'})},{serverToken:jwt({exp:0})},{serverToken:jwt({ref:'other'})},{serverToken:jwt({}, {alg:'none'})},{workspaceId:'x\nfilter'},{workspaceId:'x\\y'},{workspaceId:'\ud800'}])assert.throws(()=>createRealtime({...base,...changed}),error=>error.status===500&&error.message==='Realtime configuration is unavailable');
});
test('quoted fixed workspace filter cannot expand into another subscription',async t=>{
 const workspace='가족,"x),workspace_id=neq.other',f=fixture(t,{workspaceId:workspace});f.socket.open();assert.equal(f.socket.sent[0].payload.config.postgres_changes.length,1);assert.equal(f.socket.sent[0].payload.config.postgres_changes[0].filter,'workspace_id=eq.'+JSON.stringify(workspace));ack(f.socket);system(f.socket);assert.equal(await f.subscriber.ready,true);
});
test('only joined schema/table/workspace plus valid monotonic revisions wake, dirty signal survives late waiter',async t=>{
 const {socket,subscriber}=fixture(t);socket.open();change(socket);ack(socket);system(socket);assert.equal(await subscriber.ready,true);
 const waiting=await pending(subscriber);assert.equal(waiting.resolved(),false);
 for(const invalid of [{schema:'public'},{table:'entities'},{type:'DELETE'},{record:{workspace_id:'other',revision:10}},{record:{workspace_id:'family-1',revision:-1}},{record:{workspace_id:'family-1',revision:1.5}},{record:{workspace_id:'family-1',revision:Number.MAX_SAFE_INTEGER+1}},{record:{workspace_id:'family-1',revision:10,body:'PRIVATE'}},{errors:['private server problem']}])change(socket,10,invalid);
 socket.frame({topic:socket.sent[0].topic,event:'broadcast',payload:{record:{workspace_id:'family-1',revision:10}}});await Promise.resolve();assert.equal(waiting.resolved(),false);change(socket,'10');await waiting.promise;assert.equal(waiting.resolved(),true);
 change(socket,11);await subscriber.wait(new AbortController().signal,1000);const again=await pending(subscriber);change(socket,11);change(socket,9);await Promise.resolve();assert.equal(again.resolved(),false);change(socket,12);await again.promise;
});
test('abort removes waiter without consuming future dirty signal; multi-waiter wake and close cleanup are bounded',async t=>{
 const {socket,subscriber}=fixture(t);socket.open();ack(socket);system(socket);await subscriber.ready;
 const controller=new AbortController(),aborted=subscriber.wait(controller.signal,30000);controller.abort();await assert.rejects(aborted,e=>e.name==='AbortError');change(socket,1);await subscriber.wait(new AbortController().signal,30000);
 const a=await pending(subscriber),b=await pending(subscriber);change(socket,2);await Promise.all([a.promise,b.promise]);assert(a.resolved()&&b.resolved());
 const c=await pending(subscriber);subscriber.close();await c.promise;assert.equal(socket.listeners.size,0);assert.equal(socket.closed,1);subscriber.close();assert.equal(socket.closed,1);
});
test('wrong join ACK, subscription error, provider exception and malformed/binary/oversized frames fail closed without secret errors',async t=>{
 for(const fault of ['wrongfilter','systemerror','parse','binary','large','utf8large','send','factory']){
  const socket=new FakeSocket();const f=fixture(t,{socketFactory:()=>{if(fault==='factory')throw Error('PRIVATE '+jwt());return socket;}});socket.throws=fault==='send';socket.open();
  if(fault==='wrongfilter')ack(socket,{filter:'workspace_id=eq.other'});if(fault==='systemerror'){ack(socket);system(socket,'error');}if(fault==='parse')socket.frame('{');if(fault==='binary')socket.dispatchEvent(new MessageEvent('message',{data:new Uint8Array(1)}));if(fault==='large')socket.frame('x'.repeat(65537));if(fault==='utf8large')socket.frame('😀'.repeat(20000));
  assert.equal(await f.subscriber.ready,false);assert.equal(socket.listeners.size,0);if(fault!=='factory')assert.equal(socket.closed,1);
 }
});
test('join timeout and lost heartbeat ACK close resources; disconnected waits keep bounded poll sleep',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
 const a=fixture(t);a.socket.open();t.mock.timers.tick(10000);assert.equal(await a.subscriber.ready,false);await a.subscriber.wait(new AbortController().signal,1000); // consume one disconnect dirty hint
 const asleep=await pending(a.subscriber,undefined,500);assert.equal(asleep.resolved(),false);t.mock.timers.tick(499);await Promise.resolve();assert.equal(asleep.resolved(),false);t.mock.timers.tick(1);await asleep.promise;
 const b=fixture(t);b.socket.open();ack(b.socket);system(b.socket);assert.equal(await b.subscriber.ready,true);t.mock.timers.tick(25000);const heartbeat=b.socket.sent.at(-1);assert.equal(heartbeat.event,'heartbeat');assert.equal(heartbeat.topic,'phoenix');assert.equal(heartbeat.join_ref,null);assert.deepEqual(heartbeat.payload,{});assert(!JSON.stringify(heartbeat).includes(b.config.serverToken));t.mock.timers.tick(25000);assert.equal(b.socket.closed,1);
});
test('valid heartbeat reply keeps connection alive and credential expiry stops future activity',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});const f=fixture(t,{serverToken:jwt({exp:Math.floor(Date.now()/1000)+65})});f.socket.open();ack(f.socket);system(f.socket);await f.subscriber.ready;
 for(let i=0;i<2;i++){t.mock.timers.tick(25000);const heart=f.socket.sent.at(-1);f.socket.frame({topic:'phoenix',event:'phx_reply',ref:heart.ref,payload:{status:'ok',response:{}}});assert.equal(f.socket.closed,0);}t.mock.timers.tick(25000);assert.equal(f.socket.closed,1);
});

// Minimal RFC6455 fixture uses only Node builtins; it verifies real network text
// framing/client masking, not server JWT signature verification or Supabase RLS.
function wireFrame(value){const bytes=Buffer.from(JSON.stringify(value)),head=bytes.length<126?Buffer.from([0x81,bytes.length]):Buffer.from([0x81,126,bytes.length>>8,bytes.length&255]);return Buffer.concat([head,bytes]);}
async function networkHandshake(t,modern=false){
 const expectedKey=modern?secret:pub;
 let connection,networkJoin,sub,topic;const server=createServer();const observed=[];let readyJoin;const joinSeen=new Promise(resolve=>{readyJoin=resolve;});
 server.on('upgrade',(req,socket)=>{
  connection=socket;const url=new URL(req.url,'http://local');assert.equal(url.searchParams.get('apikey'),expectedKey);assert.equal(url.searchParams.get('vsn'),'1.0.0');assert(!req.url.includes('eyJ'));
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let buffer=Buffer.alloc(0);socket.on('data',part=>{buffer=Buffer.concat([buffer,part]);for(;;){if(buffer.length<2)return;const opcode=buffer[0]&15,masked=(buffer[1]&128)!==0;let size=buffer[1]&127,offset=2;if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}assert(size<65536);if(buffer.length<offset+(masked?4:0)+size)return;const mask=masked?buffer.subarray(offset,offset+4):null;offset+=masked?4:0;const body=Buffer.from(buffer.subarray(offset,offset+size));buffer=buffer.subarray(offset+size);if(mask)for(let i=0;i<body.length;i++)body[i]^=mask[i%4];if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}assert.equal(opcode,1);const value=JSON.parse(body);observed.push(value);if(value.event==='phx_join'){networkJoin=value;topic=value.topic;const entry=value.payload.config.postgres_changes[0];socket.write(wireFrame({topic,event:'phx_reply',ref:'1',join_ref:'1',payload:{status:'ok',response:{postgres_changes:[{...entry,id:7}]}}}));socket.write(wireFrame({topic,event:'system',payload:{extension:'postgres_changes',status:'ok'}}));readyJoin();}}});
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{sub?.close();connection?.destroy();server.close();await once(server,'close');});
 sub=createRealtime({url:'http://127.0.0.1:'+server.address().port,workspaceId:'family-1',...(modern?{serverKey:secret}:{publishableKey:pub,serverToken:jwt()})});await joinSeen;assert.equal(await sub.ready,true);if(modern){assert.equal(Object.hasOwn(networkJoin.payload,'access_token'),false);assert(!JSON.stringify(observed).includes(secret));}else assert.equal(networkJoin.payload.access_token.split('.').length,3);
 const wait=await pending(sub);connection.write(wireFrame({topic,event:'postgres_changes',payload:{ids:[7],data:{schema:'fountain_cloud',table:'workspace_signals',type:'UPDATE',record:{workspace_id:'family-1',revision:3},errors:null}}}));assert.equal(await wait.promise,undefined);assert.equal(observed.length,1);
}
test('actual loopback WebSocket completes Phoenix JSON handshake and wakes with no payload forwarding',{timeout:3000},t=>networkHandshake(t));
test('actual loopback modern-secret WebSocket upgrade carries one server key and no join access_token',{timeout:3000},t=>networkHandshake(t,true));
test('applied migration source is scalar-only forced RLS/service SELECT and narrow private revision trigger/publication',()=>{
 const sql=readFileSync(new URL('../migrations/20261016103910_fountain_cloud_realtime_signals.sql',import.meta.url),'utf8');assert.match(sql,/FORCE ROW LEVEL SECURITY/);assert.match(sql,/REVOKE ALL ON TABLE[^;]+PUBLIC,anon,authenticated,service_role/);assert.match(sql,/GRANT SELECT ON TABLE[^;]+service_role/);assert.match(sql,/FOR SELECT TO service_role USING \(true\)/);assert.match(sql,/SECURITY DEFINER SET search_path=pg_catalog/);assert.match(sql,/AFTER INSERT OR UPDATE OF key,data ON fountain_private.meta/);assert.match(sql,/WHEN \(NEW.key='_entity_revision'\)/);assert.match(sql,/REVOKE ALL ON FUNCTION[^;]+PUBLIC,anon,authenticated,service_role/);assert.match(sql,/ALTER PUBLICATION supabase_realtime ADD TABLE fountain_cloud.workspace_signals/);assert(!/ADD TABLE fountain_private\./.test(sql));assert(!/CREATE FUNCTION public\./.test(sql));
});

test('modern-secret mode pins the private upgrade key and completely omits all join token fields',async t=>{
 const socket=new FakeSocket(),config={url:'https://fixture.supabase.co',workspaceId:'family-1',serverKey:secret,socketFactory:url=>{socket.url=url;return socket;}},subscriber=createRealtime(config);t.after(()=>subscriber.close());
 config.serverKey='sb_secret_changed_after_configuration';config.workspaceId='other';socket.open();const url=new URL(socket.url),join=socket.sent[0];
 assert.equal(url.searchParams.get('apikey'),secret);assert.equal(url.searchParams.getAll('apikey').length,1);assert.equal(url.searchParams.get('vsn'),'1.0.0');assert.deepEqual(Object.keys(join.payload),['config']);assert.equal(join.payload.config.postgres_changes[0].filter,'workspace_id=eq.family-1');assert.equal(join.payload.config.private,true);assert(!JSON.stringify(socket.sent).includes(secret));
 ack(socket);system(socket);assert.equal(await subscriber.ready,true);change(socket,1);assert.equal(await subscriber.wait(new AbortController().signal,1000),undefined);assert(!JSON.stringify(subscriber).includes(secret));
});
test('modern credentials cannot mix with either legacy field or accept a public/JWT key as a secret',()=>{
 let connections=0;const base={url:'https://fixture.supabase.co',workspaceId:'family-1',serverKey:secret,socketFactory:()=>{connections++;return new FakeSocket();}};
 for(const change of [{publishableKey:pub},{serverToken:jwt()},{publishableKey:undefined},{serverToken:undefined},{serverKey:pub},{serverKey:jwt()},{serverKey:''},{serverKey:undefined},{serverKey:secret+'\n'},{serverKey:'sb_secret_'+ 'a'.repeat(4096)}])assert.throws(()=>createRealtime({...base,...change}),error=>error.status===500&&error.message==='Realtime configuration is unavailable'&&!error.message.includes(secret));
 assert.throws(()=>createRealtime({...base,publishableKey:pub,serverToken:jwt()}),error=>error.status===500);assert.equal(connections,0);
});
test('modern handshake/provider failures redact credentials and disconnected fallback sleeps boundedly',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
 const failed=createRealtime({url:'https://fixture.supabase.co',workspaceId:'family-1',serverKey:secret,socketFactory:url=>{throw Error('private provider diagnostic '+url);}});t.after(()=>failed.close());assert.equal(await failed.ready,false);assert(!JSON.stringify(failed).includes(secret));await failed.wait(new AbortController().signal,1000);
 const asleep=await pending(failed,undefined,500);assert.equal(asleep.resolved(),false);t.mock.timers.tick(499);await Promise.resolve();assert.equal(asleep.resolved(),false);t.mock.timers.tick(1);await asleep.promise;
 const socket=new FakeSocket(),subscriber=createRealtime({url:'https://fixture.supabase.co',workspaceId:'family-1',serverKey:secret,socketFactory:()=>socket});t.after(()=>subscriber.close());socket.open();ack(socket);system(socket,'error');assert.equal(await subscriber.ready,false);assert.equal(socket.closed,1);assert.equal(socket.listeners.size,0);assert(!JSON.stringify(socket.sent).includes(secret));
});
