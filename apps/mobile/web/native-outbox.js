/* Opt-in native durability foundation. No cookie, native identity grant or SQL is accepted from JavaScript. */
(function(root){
  'use strict';
  const PART=256*1024,RECORD=16*1024*1024,TRANSACTION=64*1024*1024;
  const JOURNAL='nativeJournal',CHECKPOINT='__native_checkpoint__';
  const schemas=[{name:'fountain-offline-v1',version:3,stores:{profiles:'id',meta:'id',snapshots:'key',operations:['key','id'],drafts:['key','clientId'],databaseSnapshots:'key',mutations:['profileId','id'],localPages:'key'}},{name:'fountain-upload-metadata-v1',version:2,stores:{transfers:'key'}}];
  const buckets=new Map(schemas.flatMap(schema=>Object.entries(schema.stores)));
  const request=operation=>new Promise((resolve,reject)=>{operation.addEventListener('success',()=>resolve(operation.result),{once:true});operation.addEventListener('error',()=>reject(operation.error),{once:true});});
  function failure(message,code='OUTBOX_UNCONFIRMED'){const error=new Error(message);error.code=code;error.status=503;return error;}
  function storageError(error){if(error?.code==='OUTBOX_ACCESS_REQUIRED')return failure('문서의 현재 접근 권한을 확인해야 합니다. 기기 기록은 보관했습니다.','OUTBOX_ACCESS_REQUIRED');if(typeof error?.code==='string'&&error.code.startsWith('OUTBOX_')){error.status=503;return error;}const wrapped=failure('기기 저장 상태를 확인하지 못했습니다. 확인되지 않은 변경은 보관했습니다.');wrapped.cause=error;return wrapped;}
  function clone(value){return structuredClone(value);}
  function json(value){return JSON.stringify(value,(_,item)=>{if(item===undefined||typeof item==='bigint'||typeof item==='function'||typeof item==='symbol'||typeof item==='number'&&!Number.isFinite(item)||item instanceof Blob||item instanceof Map||item instanceof Set||item instanceof Date)throw failure('기기 저장에 지원하지 않는 값이 있습니다.','OUTBOX_INVALID_RECORD');return item;});}
  function keyFor(bucket,value){const keyPath=buckets.get(bucket);return Array.isArray(keyPath)?keyPath.map(key=>value[key]):value[keyPath];}
  function validKey(key){if(typeof key==='string')return !!key;if(Array.isArray(key))return key.length>0&&key.every(value=>typeof value==='string'&&!!value);return false;}
  function encoded(value){const text=json(value),bytes=new TextEncoder().encode(text);return{text,bytes};}
  function base64(bytes){let value='';for(let offset=0;offset<bytes.length;offset+=32768)value+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(value);}
  function fromBase64(value){if(typeof value!=='string'||value.length>Math.ceil(PART/3)*4)throw failure('기기 저장 조각이 올바르지 않습니다.','OUTBOX_INVALID_PAGE');let binary;try{binary=atob(value);}catch{throw failure('기기 저장 조각을 읽지 못했습니다.','OUTBOX_INVALID_PAGE');}if(binary.length>PART)throw failure('기기 저장 조각이 너무 큽니다.','OUTBOX_INVALID_PAGE');const bytes=new Uint8Array(binary.length);for(let i=0;i<bytes.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}
  async function digest(text){if(!crypto.subtle){if(typeof root.FountainCollaboration?.sha256==='function')return root.FountainCollaboration.sha256(text);throw failure('기기 저장 검증 기능을 사용할 수 없습니다.','OUTBOX_UNAVAILABLE');}const bytes=new TextEncoder().encode(text),hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');}
  function raw(database,names,mode,callback){return new Promise((resolve,reject)=>{const tx=database.transaction(names,mode);let result,problem;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(problem||tx.error||failure('기기 저장 작업이 중단되었습니다.'));tx.onerror=()=>{};Promise.resolve().then(()=>callback(tx)).then(value=>result=value).catch(error=>{problem=error;try{tx.abort();}catch{reject(error);}});});}
  function open(schema){return new Promise((resolve,reject)=>{const operation=indexedDB.open(schema.name,schema.version);operation.onupgradeneeded=()=>{const db=operation.result;for(const [name,keyPath] of Object.entries(schema.stores)){if(db.objectStoreNames.contains(name))continue;const store=db.createObjectStore(name,{keyPath});if(!['profiles','meta'].includes(name)){store.createIndex('profileId','profileId');if(['operations','drafts'].includes(name))store.createIndex('key','key');if(['databaseSnapshots','mutations','localPages'].includes(name))store.createIndex('resourceKey','resourceKey');if(name==='transfers')store.createIndex('scopeId','scopeId');}}if(!db.objectStoreNames.contains(JOURNAL))db.createObjectStore(JOURNAL,{keyPath:'txId'});};operation.onerror=()=>reject(operation.error);operation.onblocked=()=>reject(failure('다른 창의 기기 저장소가 열려 있습니다. 앱을 다시 열어 주세요.','OUTBOX_DB_BLOCKED'));operation.onsuccess=()=>{operation.result.onversionchange=()=>operation.result.close();resolve(operation.result);};});}
  function create(bridge,{origin,generation}){
    if(typeof origin!=='string'||!origin.startsWith('https://')||!Number.isSafeInteger(generation))throw new TypeError('Native outbox configuration required');
    let queue=Promise.resolve(),initialized=false,blocked=null,identity=null,databases=[],closed=false;
    const serialize=callback=>{const result=queue.catch(()=>{}).then(callback);queue=result.catch(()=>{});return result;};
    const txId=()=>{if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);};
    function check(){if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');if(blocked)throw blocked;}
    function checkReply(value){if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');if(!value||value.generation!==generation)throw failure('서버 연결 범위가 변경되었습니다.','OUTBOX_SCOPE_CHANGED');return value;}
    function accessRequired(){return failure('문서의 현재 접근 권한을 확인해야 합니다. 기기 기록은 보관했습니다.','OUTBOX_ACCESS_REQUIRED');}
    async function opened(){
      const result=checkReply(await bridge.outboxOpen({generation}));
      const reasons=['missing','expired','revision_changed','epoch_changed','local_dependency','denied'];
      if(typeof result.lease!=='string'||!result.lease||!Number.isSafeInteger(result.head)||result.head<0||!Number.isSafeInteger(result.proofEpoch)||result.proofEpoch<0||!['ready','required'].includes(result.resourceAccess)||!['verified','blocked','unknown'].includes(result.identityState)||!Array.isArray(result.accessIssues)||result.accessIssues.length>100||typeof result.accessIssuesTruncated!=='boolean'||result.accessIssues.some(issue=>!issue||!['workspace','page','database'].includes(issue.kind)||typeof issue.id!=='string'||!issue.id||issue.id.length>160||!reasons.includes(issue.reason)||Object.keys(issue).some(key=>!['kind','id','reason'].includes(key))))throw failure('기기 저장 상태를 확인하지 못했습니다.','OUTBOX_INVALID_OPEN');
      if(result.identityState==='verified'&&(typeof result.profileId!=='string'||!result.profileId.startsWith(origin+'|')||!Number.isFinite(result.validUntil)||result.validUntil<=Date.now()))throw failure('기기 저장 로그인 범위가 일치하지 않습니다.','OUTBOX_IDENTITY');
      if(result.identityState!=='verified'&&(result.accessIssues.length||result.accessIssuesTruncated))throw failure('확인되지 않은 로그인에 리소스 정보가 있습니다.','OUTBOX_INVALID_OPEN');
      return result;
    }
    async function commit(intent){
      if(!Number.isSafeInteger(intent.proofEpoch)||intent.proofEpoch<0)throw accessRequired();
      const bytes=new TextEncoder().encode(intent.deltaJSON);if(bytes.length>TRANSACTION)throw failure('기기 저장 작업이 너무 큽니다.','OUTBOX_LIMIT');const hash=intent.digest||await digest(intent.deltaJSON);
      for(let offset=0,part=0;offset<bytes.length;offset+=PART,part++){const result=checkReply(await bridge.stageDelta({generation,lease:identity.lease,txId:intent.txId,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch,part,bytesBase64:base64(bytes.subarray(offset,offset+PART))}));if(result.part!==part)throw failure('기기 저장 조각 확인이 일치하지 않습니다.');}
      const receipt=checkReply(await bridge.commitDelta({generation,lease:identity.lease,txId:intent.txId,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch,digest:hash}));if(receipt.txId!==intent.txId||receipt.proofEpoch!==intent.proofEpoch||!Number.isSafeInteger(receipt.head)||receipt.head<=intent.baseHead)throw failure('기기 저장 완료를 확인하지 못했습니다.');identity={...identity,head:Math.max(identity.head,receipt.head)};return receipt;
    }
    async function checkpoints(database,removeId){await raw(database,[JOURNAL],'readwrite',tx=>{const store=tx.objectStore(JOURNAL);if(removeId)store.delete(removeId);store.put({txId:CHECKPOINT,kind:'checkpoint',origin,head:identity.head,profileId:identity.profileId||null,lease:identity.lease});});}
    async function journalEntries(database){return raw(database,[JOURNAL],'readonly',tx=>request(tx.objectStore(JOURNAL).getAll()));}
    async function firstRecord(database,bucket,after){return raw(database,[bucket],'readonly',tx=>new Promise((resolve,reject)=>{const operation=tx.objectStore(bucket).openCursor(after===undefined?undefined:IDBKeyRange.lowerBound(after,true));operation.onerror=()=>reject(operation.error);operation.onsuccess=()=>{const cursor=operation.result;resolve(cursor?{key:clone(cursor.primaryKey),value:clone(cursor.value)}:null);};}));}
    async function quarantineRecord(database,bucket,record){
      const delta=encoded({version:1,origin,mode:'quarantine',changes:[{op:'put',bucket,key:record.key,value:record.value}]});if(new TextEncoder().encode(json(record.value)).length>RECORD)throw failure('기존 기록이 너무 커 자동으로 옮기지 않았습니다.','OUTBOX_RECOVERY_REQUIRED');
      const intent={txId:txId(),kind:'quarantine',origin,bucket,key:record.key,profileId:null,baseHead:identity.head,proofEpoch:identity.proofEpoch,deltaJSON:delta.text,digest:null,createdAt:Date.now()};
      await raw(database,[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put(intent));
      const receipt=await commit(intent);await raw(database,[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put({txId:intent.txId,kind:'quarantined',origin,bucket:intent.bucket,key:intent.key,profileId:null,receiptHead:receipt.head}));
    }
    async function quarantineLegacy(database,schema){const completed=new Set((await journalEntries(database)).filter(record=>record.kind==='quarantined').map(record=>json([record.bucket,record.key])));for(const bucket of Object.keys(schema.stores)){let after;while(true){const record=await firstRecord(database,bucket,after);if(!record)break;if(!completed.has(json([bucket,record.key])))await quarantineRecord(database,bucket,record);after=record.key;}}}
    function validateHydrated(bucket,key,value){if(!value||typeof value!=='object'||Array.isArray(value)||json(keyFor(bucket,value))!==json(key))throw failure('기기 저장 키가 일치하지 않습니다.','OUTBOX_INVALID_PAGE');if(bucket==='profiles'&&(value.id!==identity.profileId||value.origin!==origin)||bucket==='meta'&&value.id==='active'&&value.profileId!==identity.profileId||!['profiles','meta'].includes(bucket)&&(value.profileId!==identity.profileId||typeof value.key==='string'&&!value.key.startsWith(identity.profileId+'|')))throw failure('다른 로그인 범위의 기기 기록을 차단했습니다.','OUTBOX_INVALID_PAGE');}
    async function hydrate(){
      if(identity.identityState!=='verified')return;
      const expectedHead=identity.head,lease=identity.lease,proofEpoch=identity.proofEpoch,seenCursors=new Set(),completed=new Set();let cursor=null,pending=null,first=true;
      do{
        const page=checkReply(await bridge.readPage({generation,lease,head:expectedHead,proofEpoch,cursor,byteLimit:PART}));if(page.proofEpoch!==proofEpoch||identity.resourceAccess!=='ready')throw accessRequired();if(identity.proofEpoch!==proofEpoch||identity.lease!==lease||identity.validUntil<=Date.now())throw accessRequired();if(page.head!==expectedHead||!Array.isArray(page.fragments))throw failure('기기 저장 읽기 범위가 변경되었습니다.','OUTBOX_INVALID_PAGE');let pageBytes=0;const values=[];
        for(const fragment of page.fragments){
          if(!buckets.has(fragment.bucket)||!validKey(fragment.key)||!Number.isSafeInteger(fragment.offset)||!Number.isSafeInteger(fragment.total)||fragment.total<=0||fragment.total>RECORD)throw failure('기기 저장 기록이 올바르지 않습니다.','OUTBOX_INVALID_PAGE');
          const part=fromBase64(fragment.bytesBase64);if(!part.length)throw failure('기기 저장 조각이 진행되지 않습니다.','OUTBOX_INVALID_PAGE');pageBytes+=part.length;if(pageBytes>PART)throw failure('기기 저장 페이지가 너무 큽니다.','OUTBOX_INVALID_PAGE');
          if(!pending){if(completed.has(json([fragment.bucket,fragment.key])))throw failure('기기 저장 기록이 중복되었습니다.','OUTBOX_INVALID_PAGE');if(fragment.offset!==0)throw failure('기기 저장 기록의 시작을 찾지 못했습니다.','OUTBOX_INVALID_PAGE');pending={bucket:fragment.bucket,key:fragment.key,total:fragment.total,offset:0,bytes:new Uint8Array(fragment.total)};}
          if(fragment.bucket!==pending.bucket||json(fragment.key)!==json(pending.key)||fragment.total!==pending.total||fragment.offset!==pending.offset||pending.offset+part.length>pending.total)throw failure('기기 저장 조각 순서가 일치하지 않습니다.','OUTBOX_INVALID_PAGE');pending.bytes.set(part,pending.offset);pending.offset+=part.length;
          if(pending.offset===pending.total){let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.bytes));}catch{throw failure('기기 저장 기록의 UTF8 JSON이 올바르지 않습니다.','OUTBOX_INVALID_PAGE');}validateHydrated(pending.bucket,pending.key,value);values.push({bucket:pending.bucket,value});completed.add(json([pending.bucket,pending.key]));pending=null;}
        }
        if(page.next!==null&&typeof page.next!=='string')throw failure('기기 저장 읽기 위치가 올바르지 않습니다.','OUTBOX_INVALID_PAGE');if(page.next!==null&&(seenCursors.has(page.next)||!page.fragments.length))throw failure('기기 저장 읽기가 진행되지 않습니다.','OUTBOX_INVALID_PAGE');if(page.next!==null)seenCursors.add(page.next);if(page.next===null&&pending)throw failure('기기 저장 기록을 끝까지 읽지 못했습니다.','OUTBOX_INVALID_PAGE');
        // Native whole-profile preflight and the first wire page must succeed before any cache clear.
        if(first){for(let i=0;i<databases.length;i++)await raw(databases[i],Object.keys(schemas[i].stores),'readwrite',tx=>{for(const bucket of Object.keys(schemas[i].stores))tx.objectStore(bucket).clear();});first=false;}
        for(const {bucket,value}of values){const database=databases[schemas.findIndex(schema=>Object.hasOwn(schema.stores,bucket))];await raw(database,[bucket],'readwrite',tx=>tx.objectStore(bucket).put(value));}cursor=page.next;
      }while(cursor!==null);
      if(pending)throw failure('기기 저장 기록을 끝까지 읽지 못했습니다.','OUTBOX_INVALID_PAGE');
    }
    async function recover({initial=false}={}){
      const next=await opened(),previous=identity;identity=next;
      const records=await Promise.all(databases.map(journalEntries));
      for(const entries of records){const checkpoint=entries.find(record=>record.kind==='checkpoint'&&record.origin===origin);if(checkpoint&&(!Number.isSafeInteger(checkpoint.head)||checkpoint.head<0||checkpoint.head>next.head))throw failure('네이티브 저장 이력이 이전 상태로 바뀌어 기존 앱 기록을 보존했습니다.','OUTBOX_RECOVERY_REQUIRED');}
      let preserved=false;
      for(let index=0;index<records.length;index++)for(const intent of records[index].filter(record=>record.kind!=='checkpoint')){
        if(intent.kind==='quarantined'){preserved=true;continue;}
        if(intent.kind==='quarantine'){
          if(intent.origin!==origin)throw failure('다른 서버의 복구 기록을 보관하고 있습니다.','OUTBOX_RECOVERY_REQUIRED');
          const receipt=await commit(intent);await raw(databases[index],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put({txId:intent.txId,kind:'quarantined',origin,bucket:intent.bucket,key:intent.key,profileId:null,receiptHead:receipt.head}));preserved=true;continue;
        }
        if(intent.origin!==origin||intent.profileId!==next.profileId||next.identityState!=='verified')throw failure('이전 로그인에서 확인되지 않은 변경을 보관하고 있습니다. 자동으로 새 계정에 적용하지 않았습니다.','OUTBOX_RECOVERY_REQUIRED');
        await commit(intent);await checkpoints(databases[index],intent.txId);
      }
      for(let index=0;index<databases.length;index++){
        const checkpoint=await raw(databases[index],[JOURNAL],'readonly',tx=>request(tx.objectStore(JOURNAL).get(CHECKPOINT)));
        if(!checkpoint||checkpoint.kind!=='checkpoint'||checkpoint.origin!==origin){let legacy=false;for(const bucket of Object.keys(schemas[index].stores))if(await firstRecord(databases[index],bucket)){legacy=true;break;}if(legacy){await quarantineLegacy(databases[index],schemas[index]);preserved=true;}}
      }
      if(preserved)throw failure('기존 앱 캐시를 복구용으로 보관했습니다. 확인되지 않은 변경은 자동으로 덮어쓰지 않습니다.','OUTBOX_RECOVERY_REQUIRED');
      if(initial||!initialized||!previous||previous.profileId!==next.profileId||previous.lease!==next.lease||previous.head!==identity.head||previous.proofEpoch!==next.proofEpoch||next.resourceAccess==='required'){
        if(identity.identityState==='verified')await hydrate();
        else for(let index=0;index<databases.length;index++)await raw(databases[index],Object.keys(schemas[index].stores),'readwrite',tx=>{for(const bucket of Object.keys(schemas[index].stores))tx.objectStore(bucket).clear();});
        for(const database of databases)await checkpoints(database);
      }
      initialized=true;
    }
    async function initialize(){return serialize(async()=>{if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');try{for(const database of databases)database.close();databases=await Promise.all(schemas.map(open));await recover({initial:true});blocked=null;return{ready:true,identityState:identity.identityState};}catch(error){blocked=storageError(error);throw blocked;}});}
    async function refreshAuth(){return serialize(async()=>{if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');if(blocked&&blocked.code!=='OUTBOX_ACCESS_REQUIRED')throw blocked;try{await recover();blocked=null;}catch(error){blocked=storageError(error);throw blocked;}});}
    function run(database,names,mode,callback){return serialize(async()=>{
      check();if(!initialized)throw failure('기기 저장 준비가 끝나지 않았습니다.','OUTBOX_NOT_READY');if(!Array.isArray(names))names=[names];const schema=schemas.find(schema=>schema.name===database.name);if(!schema||!names.every(name=>Object.hasOwn(schema.stores,name))||!['readonly','readwrite'].includes(mode))throw new TypeError('Unsupported native business transaction');
      try{await recover();}catch(error){blocked=storageError(error);throw blocked;}
      if(mode==='readonly'){const expected={head:identity.head,lease:identity.lease,proofEpoch:identity.proofEpoch,profileId:identity.profileId},result=await raw(database,names,mode,callback);check();const current=await opened();if(current.head!==expected.head||current.lease!==expected.lease||current.proofEpoch!==expected.proofEpoch||current.profileId!==expected.profileId||current.resourceAccess!=='ready'){blocked=accessRequired();throw blocked;}return result;}
      if(identity.identityState!=='verified')throw new DOMException('확인된 네이티브 로그인 후 기기에 저장할 수 있습니다.','SecurityError');
      const intent={txId:txId(),version:1,origin,profileId:identity.profileId,baseHead:identity.head,lease:identity.lease,proofEpoch:identity.proofEpoch,createdAt:Date.now(),digest:null};let committedIntent=null;
      const result=await raw(database,[...names,JOURNAL],mode,tx=>new Promise((resolve,reject)=>{
        const objectStore=tx.objectStore.bind(tx),changes=[],decorated=new Map();let callbackDone=false,pending=0,revision=0,written=-1,result;
        const finalize=()=>{if(!callbackDone||pending||revision===written)return;try{const ordered=changes.filter(Boolean);if(ordered.length){const delta=encoded({version:1,origin,mode:'active',changes:ordered});if(delta.bytes.length>TRANSACTION)throw failure('기기 저장 작업이 너무 큽니다.','OUTBOX_LIMIT');committedIntent={...intent,deltaJSON:delta.text};objectStore(JOURNAL).put(committedIntent);}written=revision;resolve(result);}catch(error){reject(error);try{tx.abort();}catch{}}};
        tx.objectStore=name=>{const store=objectStore(name);if(name===JOURNAL)throw new DOMException('내부 저장 저널에는 직접 접근할 수 없습니다.','SecurityError');if(decorated.has(name))return store;decorated.set(name,store);
          for(const method of ['put','add','delete']){const original=store[method].bind(store);store[method]=(...args)=>{let value;if(method!=='delete'){value=JSON.parse(json(args[0]));if(new TextEncoder().encode(json(value)).length>RECORD)throw failure('기기 저장 기록이 너무 큽니다.','OUTBOX_LIMIT');args[0]=value;}const position=changes.length;changes.push(null);pending++;const operation=original(...args);operation.addEventListener('success',()=>{const key=method==='delete'?args[0]:operation.result;if(!validKey(key)){reject(failure('기기 저장 키가 올바르지 않습니다.','OUTBOX_INVALID_RECORD'));try{tx.abort();}catch{}return;}changes[position]={op:method==='delete'?'delete':'put',bucket:name,key:clone(key),...(method==='delete'?{}:{value})};pending--;revision++;finalize();},{once:true});operation.addEventListener('error',()=>{pending--;finalize();},{once:true});return operation;};}
          const cursors=target=>{for(const method of ['openCursor','openKeyCursor'])if(typeof target[method]==='function'){const original=target[method].bind(target);target[method]=(...args)=>{const operation=original(...args);operation.addEventListener('success',()=>{const cursor=operation.result;if(cursor)for(const write of ['update','delete'])cursor[write]=()=>{throw failure('커서 변경은 저장소 put/delete로 처리해야 합니다.','OUTBOX_UNTRACKED_WRITE');};});return operation;};}};
          cursors(store);const index=store.index.bind(store),indexes=new Set();store.index=name=>{const value=index(name);if(!indexes.has(value)){indexes.add(value);cursors(value);}return value;};
          store.clear=()=>{throw failure('전체 저장소 삭제는 명시적인 기록 삭제로 처리해야 합니다.','OUTBOX_UNTRACKED_WRITE');};return store;};
        Promise.resolve().then(()=>callback(tx)).then(value=>{result=value;callbackDone=true;finalize();}).catch(reject);
      }));
      if(committedIntent){try{await commit(committedIntent);await checkpoints(database,committedIntent.txId);const control=JSON.parse(committedIntent.deltaJSON).changes.some(change=>change.op==='put'&&change.bucket==='meta'&&typeof change.value.id==='string'&&/^revoked(?:-resource)?:/.test(change.value.id));if(control){identity=await opened();if(identity.identityState==='verified')await hydrate();else for(let index=0;index<databases.length;index++)await raw(databases[index],Object.keys(schemas[index].stores),'readwrite',tx=>{for(const bucket of Object.keys(schemas[index].stores))tx.objectStore(bucket).clear();});}for(const other of databases)await checkpoints(other);}catch(error){blocked=error?.code==='OUTBOX_ACCESS_REQUIRED'?storageError(error):failure('기기 저장 완료를 확인하지 못했습니다. 변경을 보관하고 앱을 다시 열어 확인해 주세요.');if(blocked!==error)blocked.cause=error;throw blocked;}}
      return result;
    });}
    function close(){closed=true;for(const database of databases)database.close();}
    return Object.freeze({initialize,refreshAuth,run,close,get ready(){return initialized&&!blocked&&!closed;},get resourceAccess(){return blocked?.code==='OUTBOX_ACCESS_REQUIRED'?'required':identity?.resourceAccess||'required';},get accessIssues(){return clone(identity?.accessIssues||[]);},get identityState(){return identity?.identityState||'unknown';},get profileId(){return initialized&&!blocked&&!closed&&identity?.identityState==='verified'?identity.profileId:null;},get validUntil(){return initialized&&!blocked&&!closed&&identity?.identityState==='verified'?identity.validUntil:null;}});
  }
  root.FountainNativeOutbox=Object.freeze({create});
})(globalThis);
