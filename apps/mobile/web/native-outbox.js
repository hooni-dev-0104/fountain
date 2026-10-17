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
  function create(bridge,{origin,generation,driver=null,confirm=null}){
    if(typeof origin!=='string'||!origin.startsWith('https://')||!Number.isSafeInteger(generation))throw new TypeError('Native outbox configuration required');
    let queue=Promise.resolve(),initialized=false,blocked=null,identity=null,databases=[],closed=false,pause=null,activeOperation=null,reconciliations=0,preservedInputs=0,lastSummary=null;
    let owner;
    const serialize=callback=>{const result=queue.catch(()=>{}).then(callback);queue=result.catch(()=>{});return result;};
    const txId=()=>{if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);};
    owner=txId();
    const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
    const natural=value=>Number.isSafeInteger(value)&&value>=0;
    const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=512;
    const reasonCodes=['missing','expired','revision_changed','epoch_changed','local_dependency','denied','schema_changed','dependency_conflict','unconfirmed_input','binding_changed','legacy_cache','unsupported_input'];
    function scopeCheck(expected){if(closed||!driver.current(expected))throw failure('로그인이나 서버 연결 범위가 변경되었습니다.','OUTBOX_SCOPE_CHANGED');}
    function acquirePause(operation){
      if(operation.pause)return operation.pause.acknowledgement;
      if(!pause||!driver.current(pause.expected)){
        const expected=driver.scope(),token=txId(),waits=[];
        driver.pause();const detail={owner,token,origin,generation,scopeEpoch:expected.scopeEpoch,waitUntil:promise=>waits.push(Promise.resolve(promise))};
        root.dispatchEvent(new CustomEvent('fountain-native-outbox-pause',{detail}));
        let timer;const acknowledgement=Promise.race([Promise.all(waits).then(values=>{if(values.some(value=>!exact(value,['owner','token'])||value.owner!==owner||value.token!==token))throw failure('편집 화면 일시 정지를 확인하지 못했습니다.','OUTBOX_PAUSE');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('편집 화면을 안전하게 멈추지 못했습니다.','OUTBOX_PAUSE')),5000);})]).finally(()=>clearTimeout(timer));
        pause={expected,token,acknowledgement,revision:reconciliations,preserved:preservedInputs,users:0};
      }
      operation.pause=pause;pause.users++;return pause.acknowledgement;
    }
    async function pauseOperation(){if(driver){if(!activeOperation)throw failure('기기 저장 작업 범위를 확인하지 못했습니다.','OUTBOX_SCOPE_CHANGED');await acquirePause(activeOperation);scopeCheck(activeOperation.expected);}}
    async function releasePause(captured){
        if(--captured.users===0&&pause===captured){pause=null;const waits=[];root.dispatchEvent(new CustomEvent('fountain-native-outbox-resume',{detail:{owner,token:captured.token,origin,generation,scopeEpoch:captured.expected.scopeEpoch,committed:initialized&&!blocked,blocked:!!blocked,terminal:captured.terminal===true,reconciled:captured.revision!==reconciliations||captured.preserved!==preservedInputs,preservedInput:captured.preserved!==preservedInputs,summary:lastSummary,readCurrent:async descriptor=>{scopeCheck(captured.expected);if(blocked||!initialized||identity.identityState!=='verified'||identity.validUntil<=Date.now())throw accessRequired();const current=await opened();if(current.head!==identity.head||current.lease!==identity.lease||current.proofEpoch!==identity.proofEpoch||current.profileId!==identity.profileId||current.resourceAccess!=='ready')throw accessRequired();const profile=await raw(databases[0],['profiles'],'readonly',tx=>request(tx.objectStore('profiles').get(identity.profileId)));let snapshot=null;if(descriptor&&['page','database'].includes(descriptor.kind)&&typeof descriptor.id==='string'){const bucket=descriptor.kind==='page'?'snapshots':'databaseSnapshots',key=identity.profileId+'|'+(descriptor.kind==='database'?'database|':'')+encodeURIComponent(descriptor.id);snapshot=await raw(databases[0],[bucket],'readonly',tx=>request(tx.objectStore(bucket).get(key)));}scopeCheck(captured.expected);return{profile:clone(profile),snapshot:clone(snapshot?.snapshot||null)};},waitUntil:promise=>waits.push(Promise.resolve(promise))}}));try{await Promise.all(waits);}catch(error){if(driver.current(captured.expected))blocked=storageError(error);throw error;}finally{if(!pause)driver.resume();}}
    }
    function coordinated(callback,{force=false}={}){
      if(!driver)return serialize(callback);
      const operation={expected:driver.scope(),pause:null};
      const execute=async()=>{
        // This metadata read only avoids needless DOM/IME disruption. It never authorizes
        // business reads/writes: recover and native final fences still run inside serialize.
        try{
          let required=force||!!pause||!initialized||!!blocked;
          if(!required){const next=await opened();scopeCheck(operation.expected);required=!identity||next.identityState!==identity.identityState||next.profileId!==identity.profileId||next.lease!==identity.lease||next.head!==identity.head||next.proofEpoch!==identity.proofEpoch||next.resourceAccess!==identity.resourceAccess||next.identityState==='verified'&&next.resourceAccess!=='ready';}
          if(required)await acquirePause(operation);
        }catch(error){if(driver.current(operation.expected)){blocked=storageError(error);await acquirePause(operation);}throw error;}
        return serialize(async()=>{scopeCheck(operation.expected);activeOperation=operation;try{const result=await callback();scopeCheck(operation.expected);return result;}finally{if(activeOperation===operation)activeOperation=null;}});
      };
      return execute().finally(async()=>{if(operation.pause)await releasePause(operation.pause);});
    }
    function validateHandles(handles){return Array.isArray(handles)&&handles.length<=100&&handles.every(handle=>exact(handle,['handle','kind','count','expiresAt'])&&opaque(handle.handle)&&['upgrade','recovery'].includes(handle.kind)&&natural(handle.count)&&handle.count<=100000&&Number.isSafeInteger(handle.expiresAt)&&handle.expiresAt>Date.now()&&handle.expiresAt<=Date.now()+120000)&&new Set(handles.map(handle=>handle.handle)).size===handles.length;}
    function check(){if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');if(blocked)throw blocked;}
    function checkReply(value){if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');if(!value||value.generation!==generation)throw failure('서버 연결 범위가 변경되었습니다.','OUTBOX_SCOPE_CHANGED');return value;}
    function accessRequired(){return failure('문서의 현재 접근 권한을 확인해야 합니다. 기기 기록은 보관했습니다.','OUTBOX_ACCESS_REQUIRED');}
    async function opened(){
      const result=checkReply(await bridge.outboxOpen({generation}));
      const reasons=reasonCodes;
      if(typeof result.lease!=='string'||!result.lease||!Number.isSafeInteger(result.head)||result.head<0||!Number.isSafeInteger(result.proofEpoch)||result.proofEpoch<0||!['ready','required'].includes(result.resourceAccess)||!['verified','blocked','unknown'].includes(result.identityState)||!Array.isArray(result.accessIssues)||result.accessIssues.length>100||typeof result.accessIssuesTruncated!=='boolean'||result.accessIssues.some(issue=>!issue||!['workspace','page','database'].includes(issue.kind)||typeof issue.id!=='string'||!issue.id||issue.id.length>160||!reasons.includes(issue.reason)||Object.keys(issue).some(key=>!['kind','id','reason'].includes(key))))throw failure('기기 저장 상태를 확인하지 못했습니다.','OUTBOX_INVALID_OPEN');
      if(result.identityState==='verified'&&(typeof result.profileId!=='string'||!result.profileId.startsWith(origin+'|')||!Number.isSafeInteger(result.validUntil)||result.validUntil<=Date.now()))throw failure('기기 저장 로그인 범위가 일치하지 않습니다.','OUTBOX_IDENTITY');
      if(result.reconciliationHandles!==undefined&&(!validateHandles(result.reconciliationHandles)||result.reconciliationHandles.some(handle=>handle.expiresAt>result.validUntil)||result.identityState!=='verified'&&result.reconciliationHandles.length))throw failure('복구 선택 범위를 확인하지 못했습니다.','OUTBOX_INVALID_OPEN');
      if(result.identityState!=='verified'&&(result.accessIssues.length||result.accessIssuesTruncated))throw failure('확인되지 않은 로그인에 리소스 정보가 있습니다.','OUTBOX_INVALID_OPEN');
      return result;
    }
    async function commit(intent){
      if(!Number.isSafeInteger(intent.proofEpoch)||intent.proofEpoch<0)throw accessRequired();
      const bytes=new TextEncoder().encode(intent.deltaJSON);if(bytes.length>TRANSACTION)throw failure('기기 저장 작업이 너무 큽니다.','OUTBOX_LIMIT');const hash=intent.digest||await digest(intent.deltaJSON);
      for(let offset=0,part=0;offset<bytes.length;offset+=PART,part++){const result=checkReply(await bridge.stageDelta({generation,lease:identity.lease,txId:intent.txId,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch,part,bytesBase64:base64(bytes.subarray(offset,offset+PART))}));if(result.part!==part)throw failure('기기 저장 조각 확인이 일치하지 않습니다.');}
      const receipt=checkReply(await bridge.commitDelta({generation,lease:identity.lease,txId:intent.txId,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch,digest:hash}));if(receipt.txId!==intent.txId||receipt.proofEpoch!==intent.proofEpoch||!Number.isSafeInteger(receipt.head)||receipt.head<=intent.baseHead)throw failure('기기 저장 완료를 확인하지 못했습니다.');identity={...identity,head:Math.max(identity.head,receipt.head)};return receipt;
    }
    async function checkpoints(database,removeId,profileId=identity.profileId||null){await raw(database,[JOURNAL],'readwrite',tx=>{const store=tx.objectStore(JOURNAL);if(removeId)store.delete(removeId);store.put({txId:CHECKPOINT,kind:'checkpoint',origin,head:identity.head,profileId,lease:identity.lease});});}
    function readJournals(tx){return new Promise((resolve,reject)=>{const store=tx.objectStore(JOURNAL),cursor=store.openKeyCursor(),rows=[];let pending=0,ended=false;const finish=()=>{if(ended&&!pending)resolve(rows);};cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{const item=cursor.result;if(!item){ended=true;finish();return;}if(!retainedKey(item.primaryKey)){pending++;const read=store.get(item.primaryKey);read.onsuccess=()=>{rows.push(read.result);pending--;finish();};read.onerror=()=>reject(read.error);}item.continue();};});}
    async function journalEntries(database){return raw(database,[JOURNAL],'readonly',readJournals);}
    async function firstRecord(database,bucket,after){return raw(database,[bucket],'readonly',tx=>new Promise((resolve,reject)=>{const operation=tx.objectStore(bucket).openCursor(after===undefined?undefined:IDBKeyRange.lowerBound(after,true));operation.onerror=()=>reject(operation.error);operation.onsuccess=()=>{const cursor=operation.result;resolve(cursor?{key:clone(cursor.primaryKey),value:clone(cursor.value)}:null);};}));}
    const RETAIN='__native_retained_source__:',MANIFEST='__native_retention_manifest__',ITEMS=100000;
    let continuedRetention=null,retentionPending=null,hydrationFence=null;
    const retainedKey=key=>typeof key==='string'&&(key===MANIFEST||/^__native_retained_source__:[a-f0-9]{64}$/.test(key));
    function profileShape(value){if(typeof value!=='string'||value.length>8192)return false;const parts=value.split('|');if(parts.length!==4||parts[0]!==origin)return false;try{return parts.slice(1).every(part=>{const decoded=decodeURIComponent(part);return part&&decoded.length<=1000&&!/[\u0000-\u001f\u007f]/.test(decoded)&&encodeURIComponent(decoded)===part;});}catch{return false;}}
    function sourceProfile(bucket,key,value){
      if(!value||typeof value!=='object'||Array.isArray(value)||json(keyFor(bucket,value))!==json(key))throw failure('로그인 범위를 확인할 수 없는 기기 원본을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
      let profile=bucket==='profiles'?value.id:value.profileId;
      if(bucket==='meta'&&!profileShape(profile)){
        const id=value.id;
        if(typeof id==='string'){
          if(id.startsWith('revoked-resource:'))profile=id.slice('revoked-resource:'.length).split('|').slice(0,4).join('|');
          else for(const prefix of ['revoked:','suspended:','mutation-sequence:','recovery-import:'])if(id.startsWith(prefix)){profile=id.slice(prefix.length);if(prefix==='recovery-import:')profile=profile.slice(0,profile.lastIndexOf(':'));break;}
        }
      }
      if(!profileShape(profile))throw failure('로그인 범위를 확인할 수 없는 기기 원본을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');return profile;
    }
    async function inventory(database,index){
      const names=[...Object.keys(schemas[index].stores),JOURNAL];return raw(database,names,'readonly',tx=>new Promise((resolve,reject)=>{
        const rows=[];let remaining=names.length,total=0;
        for(const bucket of names){const cursor=tx.objectStore(bucket).openCursor();cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{try{const item=cursor.result;if(!item){if(!--remaining)resolve(rows);return;}const text=json(item.value),size=new TextEncoder().encode(text).length;total+=size;if(rows.length>=ITEMS||total>TRANSACTION||size>(bucket===JOURNAL?TRANSACTION:RECORD))throw failure('이전 기록이 보관 한도를 넘어 원본을 유지했습니다.','OUTBOX_LIMIT');rows.push({bucket,key:clone(item.primaryKey),value:clone(item.value),text,size});item.continue();}catch(error){reject(error);try{tx.abort();}catch{}}};}
      }));
    }
    async function retentionState(rows,index){
      const sources=[],foreign=[],business=[],allBusiness=[],unattributed=[],current=[];let manifest=null,checkpoint=null;
      for(const row of rows){
        if(row.bucket!==JOURNAL){allBusiness.push(row);if(sourceProfile(row.bucket,row.key,row.value)!==identity.profileId)business.push(row);continue;}
        if(row.key===MANIFEST){
          manifest=row.value;
          const descriptors=values=>Array.isArray(values)&&values.length<=ITEMS&&values.every(value=>exact(value,['id','sha256','size'])&&typeof value.id==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&natural(value.size));
          if(!exact(manifest,['txId','kind','version','origin','profileId','sources','foreign','sourceDigest'])||manifest.txId!==MANIFEST||manifest.kind!=='retention-manifest'||manifest.version!==1||manifest.origin!==origin||!profileShape(manifest.profileId)||!descriptors(manifest.sources)||!descriptors(manifest.foreign)||!/^[a-f0-9]{64}$/.test(manifest.sourceDigest))throw failure('이전 원본 보관 기준을 확인하지 못했습니다.','OUTBOX_RECOVERY_REQUIRED');
          const body={version:1,origin,profileId:manifest.profileId,sources:manifest.sources,foreign:manifest.foreign};if(await digest(json(body))!==manifest.sourceDigest)throw failure('이전 원본 보관 기준이 달라졌습니다.','OUTBOX_RECOVERY_REQUIRED');continue;
        }
        if(retainedKey(row.key)){
          const value=row.value,source=value?.source;
          if(!exact(value,['txId','kind','version','origin','database','source'])||value.txId!==row.key||value.kind!=='retained-source'||value.version!==1||value.origin!==origin||value.database!==schemas[index].name||!exact(source,['bucket','key','value'])||!validKey(source.key)||!(buckets.has(source.bucket)||source.bucket===JOURNAL&&source.key===CHECKPOINT)||row.size>RECORD)throw failure('이전 원본 보관 정보를 확인하지 못했습니다.','OUTBOX_RECOVERY_REQUIRED');
          const hash=await digest(json({version:1,origin,database:schemas[index].name,source}));if(row.key!==RETAIN+hash)throw failure('보관된 원본이 달라져 그대로 유지했습니다.','OUTBOX_RECOVERY_REQUIRED');sources.push(row);continue;
        }
        const value=row.value;
        // One historical terminal-cleanup producer emitted this exact metadata
        // shape. Preserve it explicitly; null never identifies an owner/receipt.
        if(row.key===CHECKPOINT&&exact(value,['txId','kind','origin','head','profileId','lease'])&&value.txId===CHECKPOINT&&value.kind==='checkpoint'&&value.origin===origin&&value.profileId===null&&natural(value.head)&&value.head<=identity.head&&opaque(value.lease)){unattributed.push(row);continue;}
        if(!validKey(row.key)||typeof row.key!=='string'||value?.txId!==row.key||value.origin!==origin||!profileShape(value.profileId))throw failure('확인할 수 없는 이전 저장 저널을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
        if(value.kind==='checkpoint'){
          if(row.key!==CHECKPOINT||!natural(value.head)||!opaque(value.lease))throw failure('기기 저장 기준을 확인하지 못했습니다.','OUTBOX_RECOVERY_REQUIRED');
          if(value.profileId===identity.profileId)checkpoint=value;else foreign.push(row);continue;
        }
        if(!['quarantine','quarantined','reconcile'].includes(value.kind)&&!(value.version===1&&typeof value.deltaJSON==='string'))throw failure('확인할 수 없는 이전 저장 저널을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
        if(value.profileId===identity.profileId)current.push(value);else foreign.push(row);
      }
      const originalForeign=foreign.filter(row=>row.key!==CHECKPOINT),pending=[...(unattributed.length?allBusiness:business),...foreign.filter(row=>row.key===CHECKPOINT),...unattributed];
      const descriptors=async entries=>{const result=[];for(const row of entries)result.push({id:row.key,sha256:await digest(row.text),size:row.size});return result.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);};
      const sourceDescriptors=await descriptors(sources),foreignDescriptors=await descriptors(originalForeign);
      const body={version:1,origin,profileId:identity.profileId,sources:sourceDescriptors,foreign:foreignDescriptors};
      const expected={txId:MANIFEST,kind:'retention-manifest',...body,sourceDigest:await digest(json(body))};
      return{rows,sources,foreign:originalForeign,pending,current,checkpoint,manifest,expected,valid:!pending.length&&json(manifest??null)===json(expected)};
    }
    async function preserveDatabase(database,index,state){
      const writes=[];const keys=new Map(state.sources.map(row=>[row.key,row.text]));let budget=state.rows.reduce((total,row)=>total+row.size,0);
      for(const row of state.pending){
        const source={bucket:row.bucket,key:row.key,value:row.value},hash=await digest(json({version:1,origin,database:schemas[index].name,source}));
        const value={txId:RETAIN+hash,kind:'retained-source',version:1,origin,database:schemas[index].name,source},text=json(value),size=new TextEncoder().encode(text).length;
        if(size>RECORD)throw failure('이전 기록이 보관 한도를 넘어 원본을 유지했습니다.','OUTBOX_LIMIT');
        if(keys.has(value.txId)){if(keys.get(value.txId)!==text)throw failure('원본 보관 키가 일치하지 않습니다.','OUTBOX_RECOVERY_REQUIRED');}
        else{keys.set(value.txId,text);writes.push({bucket:JOURNAL,key:value.txId,value,text,size});budget+=size;}
      }
      const predicted=state.rows.filter(row=>!state.pending.includes(row)&&!(row.bucket===JOURNAL&&row.key===MANIFEST)).concat(writes);
      const next=await retentionState(predicted,index),manifest=next.expected,text=json(manifest);budget+=new TextEncoder().encode(text).length;
      if(budget>TRANSACTION||predicted.length+1>ITEMS||new TextEncoder().encode(text).length>RECORD)throw failure('이전 기록이 보관 한도를 넘어 원본을 유지했습니다.','OUTBOX_LIMIT');
      const expected=new Map(state.rows.map(row=>[json([row.bucket,row.key]),row.text])),names=[...Object.keys(schemas[index].stores),JOURNAL];
      await raw(database,names,'readwrite',tx=>new Promise((resolve,reject)=>{
        let remaining=names.length,seen=0;
        const fail=error=>{reject(error);try{tx.abort();}catch{}};
        const finish=()=>{try{if(seen!==expected.size)throw failure('보관 도중 원본이 달라져 다시 확인해야 합니다.','OUTBOX_SOURCE_CHANGED');for(const row of writes)tx.objectStore(JOURNAL).add(row.value);for(const row of state.pending)tx.objectStore(row.bucket).delete(row.key);tx.objectStore(JOURNAL).put(manifest);resolve();}catch(error){fail(error);}};
        for(const bucket of names){const cursor=tx.objectStore(bucket).openCursor();cursor.onerror=()=>fail(cursor.error);cursor.onsuccess=()=>{try{const row=cursor.result;if(!row){if(!--remaining)finish();return;}if(++seen>ITEMS||expected.get(json([bucket,row.primaryKey]))!==json(row.value))throw failure('보관 도중 원본이 달라져 다시 확인해야 합니다.','OUTBOX_SOURCE_CHANGED');row.continue();}catch(error){fail(error);}};}
      }));
    }
    async function retainForeign({initial,explicit,mode}){
      const states=[];for(let i=0;i<databases.length;i++)states.push(await retentionState(await inventory(databases[i],i),i));
      const active=states.some(state=>state.foreign.length||state.pending.length||state.sources.length||state.manifest);
      if(!active){retentionPending=null;return states.map(state=>[...(state.checkpoint?[state.checkpoint]:[]),...state.current]);}
      const fingerprint=states.map(state=>state.expected.sourceDigest).join('|'),same=continuedRetention===identity.profileId+'|'+fingerprint;
      const complete=states.every(state=>state.valid&&state.checkpoint?.profileId===identity.profileId&&state.checkpoint.head<=identity.head);
      const reusable=initial&&identity.resourceAccess==='ready'&&complete;
      if(!explicit&&!(initialized&&same&&states.every(state=>state.valid))&&!reusable)throw failure('이전 로그인 기록을 보관한 채 최신 상태로 계속할지 확인해 주세요.','OUTBOX_RECOVERY_REQUIRED');
      if(explicit){
        if(mode!=='current'&&(!same||!states.every(state=>state.valid)))throw failure('먼저 원본을 보관하고 최신 상태로 계속해 주세요.','OUTBOX_RECOVERY_REQUIRED');
        for(let i=0;i<databases.length;i++)await preserveDatabase(databases[i],i,states[i]);
      }
      const final=[];for(let i=0;i<databases.length;i++)final.push(await retentionState(await inventory(databases[i],i),i));
      if(!final.every(state=>state.valid))throw failure('원본 보관 상태가 달라져 다시 확인해야 합니다.','OUTBOX_SOURCE_CHANGED');
      retentionPending=identity.profileId+'|'+final.map(state=>state.expected.sourceDigest).join('|');return final.map(state=>[...(state.checkpoint?[state.checkpoint]:[]),...state.current]);
    }
    async function completeRetainedProfile(){
      return raw(databases[0],['profiles','meta'],'readonly',tx=>Promise.all([request(tx.objectStore('profiles').get(identity.profileId)),request(tx.objectStore('meta').get('active')),request(tx.objectStore('meta').get('last-profile'))]).then(([profile,active,last])=>profile?.id===identity.profileId&&profile.origin===origin&&profile.validUntil>Date.now()&&active?.profileId===identity.profileId&&last?.profileId===identity.profileId));
    }
    async function captureRetentionFence(){
      if(!retentionPending)return null;const rows=[],states=[];
      for(let i=0;i<databases.length;i++){rows.push(await inventory(databases[i],i));states.push(await retentionState(rows[i],i));}
      if(!states.every(state=>state.valid)||retentionPending!==identity.profileId+'|'+states.map(state=>state.expected.sourceDigest).join('|'))throw failure('보관 중인 원본이 달라져 다시 확인해야 합니다.','OUTBOX_SOURCE_CHANGED');return rows;
    }
    async function checkRetentionFence(fence){
      if(!fence)return;for(let i=0;i<databases.length;i++){const current=await inventory(databases[i],i),expected=new Map(fence[i].map(row=>[json([row.bucket,row.key]),row.text]));if(current.length!==expected.size||current.some(row=>expected.get(json([row.bucket,row.key]))!==row.text))throw failure('문서 확인 중 기기 원본이 달라졌습니다.','OUTBOX_SOURCE_CHANGED');}
    }
    async function clearHydratedDatabase(database,index,fence){
      const names=Object.keys(schemas[index].stores);if(!fence)return raw(database,names,'readwrite',tx=>{for(const bucket of names)tx.objectStore(bucket).clear();});
      const expected=new Map(fence.map(row=>[json([row.bucket,row.key]),row.text]));
      return raw(database,[...names,JOURNAL],'readwrite',tx=>new Promise((resolve,reject)=>{let pending=names.length+1,seen=0;const fail=error=>{reject(error);try{tx.abort();}catch{}};for(const bucket of [...names,JOURNAL]){const cursor=tx.objectStore(bucket).openCursor();cursor.onerror=()=>fail(cursor.error);cursor.onsuccess=()=>{try{const value=cursor.result;if(!value){if(!--pending){if(seen!==expected.size)throw failure('기기 원본이 달라졌습니다.','OUTBOX_SOURCE_CHANGED');for(const name of names)tx.objectStore(name).clear();resolve();}return;}if(++seen>ITEMS||expected.get(json([bucket,value.primaryKey]))!==json(value.value))throw failure('기기 원본이 달라졌습니다.','OUTBOX_SOURCE_CHANGED');value.continue();}catch(error){fail(error);}};}}));
    }
    function quarantineMarker(intent,receipt){return{txId:intent.txId,kind:'quarantined',origin,bucket:intent.bucket,key:intent.key,profileId:driver?identity.profileId:null,receiptHead:receipt.head,...(driver?{digest:intent.digest,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch}:{})};}
    async function verifyQuarantined(database,marker){
      if(!buckets.has(marker.bucket)||!validKey(marker.key)||marker.profileId!==identity.profileId)throw failure('확인할 수 없는 이전 복구 기록은 그대로 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
      const value=await quarantineStatus(marker);if(value.status!=='accepted'||value.head!==marker.receiptHead)throw failure('복구 원본 보관을 확인하지 못했습니다.','OUTBOX_RECOVERY_REQUIRED');
      const current=await raw(database,[marker.bucket],'readonly',tx=>request(tx.objectStore(marker.bucket).get(marker.key)));
      if(current!==undefined&&await digest(json({version:1,origin,mode:'quarantine',changes:[{op:'put',bucket:marker.bucket,key:marker.key,value:current}]}))!==marker.digest)throw failure('보관 후 달라진 원본이 있어 그대로 유지했습니다.','OUTBOX_RECOVERY_REQUIRED');
    }
    async function quarantineRecord(database,bucket,record){
      if(driver&&identity.identityState!=='verified')throw failure('현재 계정으로 로그인한 뒤 기기 기록을 확인해 주세요.','OUTBOX_IDENTITY_REQUIRED');
      const delta=encoded({version:1,origin,mode:'quarantine',changes:[{op:'put',bucket,key:record.key,value:record.value}]});if(new TextEncoder().encode(json(record.value)).length>RECORD)throw failure('기존 기록이 너무 커 자동으로 옮기지 않았습니다.','OUTBOX_RECOVERY_REQUIRED');
      const intent={txId:txId(),kind:'quarantine',origin,bucket,key:record.key,profileId:driver?identity.profileId:null,baseHead:identity.head,proofEpoch:identity.proofEpoch,deltaJSON:delta.text,digest:driver?await digest(delta.text):null,createdAt:Date.now()};
      await raw(database,[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put(intent));
      const receipt=await commit(intent);await raw(database,[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put(quarantineMarker(intent,receipt)));
    }
    async function quarantineLegacy(database,schema){const completed=new Set((await journalEntries(database)).filter(record=>record.kind==='quarantined').map(record=>json([record.bucket,record.key])));for(const bucket of Object.keys(schema.stores)){let after;while(true){const record=await firstRecord(database,bucket,after);if(!record)break;if(!completed.has(json([bucket,record.key])))await quarantineRecord(database,bucket,record);after=record.key;}}}
    function validateHydrated(bucket,key,value){if(!value||typeof value!=='object'||Array.isArray(value)||json(keyFor(bucket,value))!==json(key))throw failure('기기 저장 키가 일치하지 않습니다.','OUTBOX_INVALID_PAGE');if(bucket==='profiles'&&(value.id!==identity.profileId||value.origin!==origin)||bucket==='meta'&&value.id==='active'&&value.profileId!==identity.profileId||!['profiles','meta'].includes(bucket)&&(value.profileId!==identity.profileId||typeof value.key==='string'&&!value.key.startsWith(identity.profileId+'|')))throw failure('다른 로그인 범위의 기기 기록을 차단했습니다.','OUTBOX_INVALID_PAGE');}
    async function hydrate(){
      if(identity.identityState!=='verified')return;
      const fence=hydrationFence||await captureRetentionFence();await checkRetentionFence(fence);
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
        if(first){for(let i=0;i<databases.length;i++)await clearHydratedDatabase(databases[i],i,fence?.[i]);first=false;}
        for(const {bucket,value}of values){const database=databases[schemas.findIndex(schema=>Object.hasOwn(schema.stores,bucket))];await raw(database,[bucket],'readwrite',tx=>tx.objectStore(bucket).put(value));}cursor=page.next;
      }while(cursor!==null);
      if(pending)throw failure('기기 저장 기록을 끝까지 읽지 못했습니다.','OUTBOX_INVALID_PAGE');if(retentionPending)await captureRetentionFence();hydrationFence=null;
    }
    async function quarantineStatus(intent){
      if(identity.identityState!=='verified'||intent.profileId!==identity.profileId||intent.origin!==origin||!natural(intent.baseHead)||!natural(intent.proofEpoch))throw failure('현재 계정으로 확인할 수 없는 복구 기록은 그대로 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
      const hash=typeof intent.deltaJSON==='string'?await digest(intent.deltaJSON):intent.digest;if(typeof hash!=='string'||!/^([a-f0-9]{64})$/.test(hash)||intent.digest!==null&&intent.digest!==undefined&&intent.digest!==hash)throw failure('복구 원본이 변경되어 그대로 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
      const descriptor={txId:intent.txId,digest:hash,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch},reply=checkReply(await bridge.outboxReconcile({generation,phase:'settle',lease:identity.lease,journals:[descriptor]}));
      if(!exact(reply,['generation','state','lease','settlements'])||reply.state!=='settled'||reply.lease!==identity.lease||!Array.isArray(reply.settlements)||reply.settlements.length!==1)throw failure('복구 보관 완료를 확인하지 못했습니다.','OUTBOX_INVALID_SETTLEMENT');
      const value=reply.settlements[0];if(!exact(value,value?.status==='accepted'?['txId','digest','status','head','proofEpoch']:['txId','digest','status'])||value.txId!==intent.txId||value.digest!==hash||!['accepted','unaccepted'].includes(value.status)||value.status==='accepted'&&(!natural(value.head)||value.head!==intent.baseHead+1||value.head>identity.head||value.proofEpoch!==intent.proofEpoch))throw failure('복구 보관 완료 범위가 일치하지 않습니다.','OUTBOX_INVALID_SETTLEMENT');
      return value;
    }
    async function refreshQuarantine(intent){
      const value=await quarantineStatus(intent);if(value.status==='accepted')return{intent:{...intent,digest:typeof intent.deltaJSON==='string'?await digest(intent.deltaJSON):intent.digest},receipt:value};
      identity=await opened();if(identity.identityState!=='verified'||identity.profileId!==intent.profileId)throw accessRequired();
      // The old transaction was privately fenced. Keep every original put byte while giving
      // the replacement its own immutable ID/current caps; never rewrite an old transaction.
      return{intent:{...intent,txId:txId(),baseHead:identity.head,proofEpoch:identity.proofEpoch,digest:await digest(intent.deltaJSON),createdAt:Date.now()},receipt:null};
    }
    async function settle(records){
      const active=records.flatMap((entries,index)=>entries.filter(intent=>!['checkpoint','quarantined','quarantine','reconcile'].includes(intent.kind)).map(intent=>({intent,index})));
      for(let offset=0;offset<active.length;offset+=100){
        const batch=active.slice(offset,offset+100),journals=[];
        for(const {intent} of batch){
          if(intent.origin!==origin||intent.profileId!==identity.profileId||identity.identityState!=='verified'||typeof intent.deltaJSON!=='string'||!natural(intent.baseHead)||!natural(intent.proofEpoch))throw failure('이전 로그인에서 확인되지 않은 변경을 보관하고 있습니다.','OUTBOX_RECOVERY_REQUIRED');
          const hash=await digest(intent.deltaJSON);if(intent.digest!==null&&intent.digest!==undefined&&intent.digest!==hash)throw failure('확인되지 않은 저장 기록이 변경되었습니다.','OUTBOX_RECOVERY_REQUIRED');
          journals.push({txId:intent.txId,digest:hash,baseHead:intent.baseHead,proofEpoch:intent.proofEpoch});
        }
        const result=checkReply(await bridge.outboxReconcile({generation,phase:'settle',lease:identity.lease,journals}));
        if(!exact(result,['generation','state','lease','settlements'])||result.state!=='settled'||result.lease!==identity.lease||!Array.isArray(result.settlements)||result.settlements.length!==journals.length)throw failure('저장 완료 기록을 확인하지 못했습니다.','OUTBOX_INVALID_SETTLEMENT');
        for(let i=0;i<batch.length;i++){
          const value=result.settlements[i],expected=journals[i],{intent,index}=batch[i];
          if(!exact(value,value?.status==='accepted'?['txId','digest','status','head','proofEpoch']:['txId','digest','status'])||value.txId!==expected.txId||value.digest!==expected.digest||!['accepted','unaccepted'].includes(value.status)||value.status==='accepted'&&(!natural(value.head)||value.head<=intent.baseHead||value.head>identity.head||value.proofEpoch!==intent.proofEpoch))throw failure('저장 완료 범위가 일치하지 않습니다.','OUTBOX_INVALID_SETTLEMENT');
          if(value.status==='accepted'){identity={...identity,head:Math.max(identity.head,value.head)};await checkpoints(databases[index],intent.txId);continue;}
          let delta;try{delta=JSON.parse(intent.deltaJSON);}catch{throw failure('확인되지 않은 변경 원본을 읽지 못했습니다.','OUTBOX_RECOVERY_REQUIRED');}
          if(delta.version!==1||delta.origin!==origin||delta.mode!=='active'||!Array.isArray(delta.changes))throw failure('확인되지 않은 변경 원본을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
          const changes=delta.changes.filter(change=>change.op==='put').map(clone),deletes=delta.changes.filter(change=>change.op==='delete');
          if(deletes.length){
            if(!Array.isArray(intent.beforeImages))throw failure('삭제 전 원본을 확인할 수 없어 기록을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
            for(const change of deletes){const images=intent.beforeImages.filter(value=>value.bucket===change.bucket&&json(value.key)===json(change.key));if(images.length!==1||typeof images[0].present!=='boolean'||!exact(images[0],images[0].present?['bucket','key','present','value']:['bucket','key','present']))throw failure('삭제 전 원본을 확인할 수 없어 기록을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');if(images[0].present)changes.push({op:'put',bucket:change.bucket,key:clone(change.key),value:clone(images[0].value)});}
          }
          // The original transaction has been privately fenced by settle. Never replay it active.
          // Persist the replacement intent before its first native call so lost ACK retries use one ID.
          let archive=intent.archive,archiveReceipt=null;
          if(archive){const result=await refreshQuarantine({...archive,profileId:intent.profileId});archive=result.intent;archiveReceipt=result.receipt;if(!archiveReceipt)await raw(databases[index],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put({...intent,archive}));}
          else{const deltaJSON=json({version:1,origin,mode:'quarantine',changes});archive={txId:txId(),origin,profileId:identity.profileId,baseHead:identity.head,proofEpoch:identity.proofEpoch,deltaJSON,digest:await digest(deltaJSON)};if(encoded({archive,beforeImages:intent.beforeImages||[]}).bytes.length>TRANSACTION)throw failure('복구할 변경이 너무 큽니다.','OUTBOX_LIMIT');await raw(databases[index],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put({...intent,archive}));}
          if(changes.length&&!archiveReceipt){await commit(archive);}preservedInputs++;await checkpoints(databases[index],intent.txId);
        }
      }
    }
    function validateReady(value){
      if(!exact(value,['generation','state','planId','lease','baseHead','proofEpoch','expiresAt','checksum','counts','reasons','requiresConfirmation'])||value.state!=='ready'||!opaque(value.planId)||value.lease!==identity.lease||!natural(value.baseHead)||!natural(value.proofEpoch)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+120000||value.expiresAt>identity.validUntil||typeof value.checksum!=='string'||!/^([a-f0-9]{64})$/.test(value.checksum)||!exact(value.counts,['refresh','keep','acknowledge','quarantine','import'])||!Object.values(value.counts).every(count=>natural(count)&&count<=100000)||!Array.isArray(value.reasons)||value.reasons.some(reason=>!reasonCodes.includes(reason))||json(value.reasons)!==json([...new Set(value.reasons)].sort())||typeof value.requiresConfirmation!=='boolean')throw failure('복구 계획의 확인 정보가 올바르지 않습니다.','OUTBOX_INVALID_PLAN');
    }
    function receiptMatches(receipt,record,head,proofEpoch){
      const ready=record.ready;
      return exact(receipt,['version','planId','checksum','sourceHead','targetHead','mode','counts'])&&receipt.version===1&&receipt.planId===ready.planId&&receipt.checksum===ready.checksum&&receipt.sourceHead===ready.baseHead&&receipt.targetHead===head&&head===ready.baseHead+1&&proofEpoch===ready.proofEpoch&&receipt.mode===record.mode&&exact(receipt.counts,['refresh','keep','acknowledge','quarantine','import'])&&Object.keys(ready.counts).every(key=>receipt.counts[key]===ready.counts[key]);
    }
    async function settleReconciliations(records){
      let fenced=false;const pending=records.flatMap((entries,index)=>entries.filter(record=>record.kind==='reconcile').map(record=>({record,index})));
      for(let offset=0;offset<pending.length;offset+=100){
        const batch=pending.slice(offset,offset+100),descriptors=[];
        for(const {record}of batch){const input=record.input,ready=record.ready;
          if(record.origin!==origin||record.profileId!==identity.profileId||identity.identityState!=='verified'||!['current','upgrade','promote'].includes(record.mode)||!exact(input,['generation','phase','lease','baseHead','proofEpoch','planId','checksum','confirm'])||input.phase!=='commit'||!natural(input.generation)||!opaque(input.lease)||!opaque(input.planId)||!natural(input.baseHead)||!natural(input.proofEpoch)||!/^([a-f0-9]{64})$/.test(input.checksum)||typeof input.confirm!=='boolean'||!ready||input.planId!==ready.planId||input.checksum!==ready.checksum||input.lease!==ready.lease||input.baseHead!==ready.baseHead||input.proofEpoch!==ready.proofEpoch||!exact(ready.counts,['refresh','keep','acknowledge','quarantine','import'])||!Object.values(ready.counts).every(count=>natural(count)&&count<=100000))throw failure('이전 로그인에서 확인되지 않은 복구 완료 기록을 보관했습니다.','OUTBOX_RECOVERY_REQUIRED');
          descriptors.push({planId:input.planId,checksum:input.checksum,lease:input.lease,baseHead:input.baseHead,proofEpoch:input.proofEpoch});
        }
        // Only the current transport generation/current owner lease is used for settlement.
        // The logical original caps remain immutable and can never authorize a new commit.
        const result=checkReply(await bridge.outboxReconcile({generation,phase:'settle',lease:identity.lease,journals:[],reconciliations:descriptors}));
        if(!exact(result,['generation','state','lease','settlements','reconciliations'])||result.state!=='settled'||result.lease!==identity.lease||!Array.isArray(result.settlements)||result.settlements.length||!Array.isArray(result.reconciliations)||result.reconciliations.length!==batch.length)throw failure('복구 완료 기록을 확인하지 못했습니다.','OUTBOX_INVALID_SETTLEMENT');
        for(let index=0;index<batch.length;index++){
          const {record,index:database}=batch[index],expected=descriptors[index],value=result.reconciliations[index];
          if(!exact(value,value?.status==='accepted'?['planId','checksum','status','head','proofEpoch','receipt']:['planId','checksum','status'])||value.planId!==expected.planId||value.checksum!==expected.checksum||!['accepted','unaccepted'].includes(value.status)||value.status==='accepted'&&(!natural(value.head)||value.head>identity.head||!receiptMatches(value.receipt,record,value.head,value.proofEpoch)))throw failure('복구 완료 범위가 일치하지 않습니다.','OUTBOX_INVALID_SETTLEMENT');
          if(value.status==='unaccepted')fenced=true;
          if(value.status==='accepted'){reconciliations++;lastSummary={mode:record.mode,counts:clone(record.ready.counts),reasons:[...(record.ready.reasons||[])]};}
          // Unaccepted means the private native ready-registry fenced the original plan.
          // Unknown/foreign outcomes above retain this exact journal instead of guessing.
          await raw(databases[database],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).delete(record.txId));
        }
      }
      if(pending.length)identity=await opened();return fenced;
    }
    async function commitPlan(record){
      let response,error;
      // A rejected/lost callback cannot establish whether SQLite COMMIT happened. Retry the
      // identical durable request once; on continued uncertainty retain it for an explicit retry.
      for(let attempt=0;attempt<2;attempt++){try{response=checkReply(await bridge.outboxReconcile({...record.input,generation}));error=null;break;}catch(problem){error=problem;if(closed||!driver.current(record.scope))break;}}
      if(error)throw error;
      const ready=record.ready,receipt=response.receipt;
      if(!exact(response,['generation','state','planId','lease','head','proofEpoch','checksum','receipt'])||response.state!=='committed'||response.planId!==ready.planId||response.lease!==ready.lease||response.checksum!==ready.checksum||response.head!==ready.baseHead+1||response.proofEpoch!==ready.proofEpoch||!receiptMatches(receipt,record,response.head,response.proofEpoch))throw failure('기기 저장 완료를 확인하지 못했습니다.','OUTBOX_INVALID_RECEIPT');
      scopeCheck(record.scope);reconciliations++;lastSummary={mode:record.mode,counts:clone(ready.counts),reasons:[...ready.reasons]};await raw(databases[0],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).delete(record.txId));return response;
    }
    async function reconcileNative({mode='current',handles=[],explicit=false,signal}={}){
      const sourceFence=await captureRetentionFence();
      const expected=driver.scope(),alive=()=>{scopeCheck(expected);if(signal?.aborted)throw new DOMException('복구 확인을 취소했습니다.','AbortError');};alive();
      const session=await driver.session(signal);if(!session.ok)throw failure('현재 로그인을 확인하지 못했습니다.','OUTBOX_IDENTITY');await session.json();alive();
      identity=await opened();if(identity.identityState!=='verified')return;
      if(!['current','upgrade','promote'].includes(mode)||mode==='current'&&handles.length||mode!=='current'&&(!handles.length||handles.some(handle=>!(identity.reconciliationHandles||[]).some(item=>item.handle===handle&&item.kind===(mode==='upgrade'?'upgrade':'recovery')))))throw failure('현재 계정의 복구 대상을 다시 선택해 주세요.','OUTBOX_RECOVERY_REQUIRED');
      let planId=null,committing=false;
      try{
        let result=checkReply(await bridge.outboxReconcile({generation,phase:'prepare',lease:identity.lease,baseHead:identity.head,proofEpoch:identity.proofEpoch,mode,...(mode==='current'?{}:{handles:[...handles]})}));
        let seen=new Set(),lastSweep=0;const totals={1:0,2:0};
        for(let pages=0;result.state==='collecting';pages++){
          alive();
          if(pages>=2000||!exact(result,['generation','state','planId','lease','expiresAt','sweep','needed'])||!opaque(result.planId)||planId&&result.planId!==planId||result.lease!==identity.lease||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=Date.now()||result.expiresAt>Date.now()+120000||result.expiresAt>identity.validUntil||![1,2].includes(result.sweep)||result.sweep<lastSweep||!Array.isArray(result.needed)||!result.needed.length||result.needed.length>100)throw failure('기기 저장 권한 확인이 진행되지 않습니다.','OUTBOX_INVALID_PLAN');
          if(pages===0&&(result.sweep!==1||result.needed.length!==1||result.needed[0]?.kind!=='workspace'||result.needed[0]?.id!=='workspace'))throw failure('현재 워크스페이스 확인이 먼저 필요합니다.','OUTBOX_INVALID_PLAN');
          planId=result.planId;lastSweep=result.sweep;
          for(const descriptor of result.needed){if(!exact(descriptor,['kind','id'])||!['workspace','page','database','attachment'].includes(descriptor.kind)||typeof descriptor.id!=='string'||!descriptor.id||Array.from(descriptor.id).length>160||descriptor.kind==='workspace'&&descriptor.id!=='workspace')throw failure('기기 저장 확인 대상이 올바르지 않습니다.','OUTBOX_INVALID_PLAN');const key=result.sweep+':'+json([descriptor.kind,descriptor.id]);if(seen.has(key)||++totals[result.sweep]>1000)throw failure('기기 저장 확인 대상이 올바르지 않습니다.','OUTBOX_INVALID_PLAN');seen.add(key);await driver.canonical(clone(descriptor),signal);alive();}
          result=checkReply(await bridge.outboxReconcile({generation,phase:'prepare',lease:identity.lease,planId}));
        }
        alive();validateReady(result);if(planId&&result.planId!==planId||result.requiresConfirmation!==(mode!=='current'||result.counts.quarantine>0))throw failure('복구 확인 범위가 일치하지 않습니다.','OUTBOX_INVALID_PLAN');planId=result.planId;
        if(result.requiresConfirmation){if(typeof confirm!=='function'||await confirm({mode,counts:clone(result.counts),reasons:[...result.reasons],expiresAt:result.expiresAt})!==true)throw failure('복구를 취소했습니다. 원본은 그대로 보관했습니다.','OUTBOX_CONFIRMATION_REQUIRED');alive();}
        await checkRetentionFence(sourceFence);hydrationFence=sourceFence;
        const input={generation,phase:'commit',lease:result.lease,baseHead:result.baseHead,proofEpoch:result.proofEpoch,planId,checksum:result.checksum,confirm:result.requiresConfirmation};
        const record={txId:txId(),kind:'reconcile',origin,profileId:identity.profileId,scope:expected,mode,ready:result,input};await raw(databases[0],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).add(record));committing=true;await commitPlan(record);identity=await opened();
        if(identity.identityState!=='verified'||identity.resourceAccess!=='ready')throw accessRequired();
      }finally{if(planId&&!committing)try{checkReply(await bridge.outboxReconcile({generation,phase:'cancel',planId}));}catch{/* Cancellation never proves a commit was absent. */}}
    }
    async function recover({initial=false,mode='current',handles=[],explicit=false,signal}={}){
      hydrationFence=null;
      const next=await opened(),previous=identity;
      if(driver&&(initial||explicit||!initialized||!previous||next.identityState!==previous.identityState||next.profileId!==previous.profileId||next.lease!==previous.lease||next.head!==previous.head||next.proofEpoch!==previous.proofEpoch||next.identityState==='verified'&&next.resourceAccess!=='ready'))await pauseOperation();identity=next;
      let records=await Promise.all(databases.map(journalEntries));
      if(driver&&identity.identityState!=='verified')throw failure('현재 계정으로 로그인한 뒤 기기 기록을 확인해 주세요.','OUTBOX_IDENTITY_REQUIRED');
      if(driver){records=await retainForeign({initial,explicit,mode});}
      if(driver&&records.some(entries=>entries.some(record=>record.kind!=='checkpoint')))await pauseOperation();
      for(const entries of records){const checkpoint=entries.find(record=>record.kind==='checkpoint'&&record.origin===origin);if(checkpoint&&(!Number.isSafeInteger(checkpoint.head)||checkpoint.head<0||checkpoint.head>next.head))throw failure('네이티브 저장 이력이 이전 상태로 바뀌어 기존 앱 기록을 보존했습니다.','OUTBOX_RECOVERY_REQUIRED');}
      let reconcileFenced=false;
      if(driver){
        reconcileFenced=await settleReconciliations(records);
        await settle(records);
      }
      let preserved=false;
      for(let index=0;index<records.length;index++)for(const intent of records[index].filter(record=>record.kind!=='checkpoint')){
        if(intent.kind==='reconcile')continue;
        if(intent.kind==='quarantined'){if(driver)await verifyQuarantined(databases[index],intent);preserved=true;continue;}
        if(driver&&intent.kind!=='quarantine')continue;
        if(intent.kind==='quarantine'){
          if(intent.origin!==origin)throw failure('다른 서버의 복구 기록을 보관하고 있습니다.','OUTBOX_RECOVERY_REQUIRED');
          let current=intent,receipt=null;
          if(driver){const result=await refreshQuarantine(intent);current=result.intent;receipt=result.receipt;if(!receipt)await raw(databases[index],[JOURNAL],'readwrite',tx=>{tx.objectStore(JOURNAL).put(current);tx.objectStore(JOURNAL).delete(intent.txId);});}
          receipt||=await commit(current);await raw(databases[index],[JOURNAL],'readwrite',tx=>tx.objectStore(JOURNAL).put(quarantineMarker(current,receipt)));preserved=true;continue;
        }
        if(intent.origin!==origin||intent.profileId!==next.profileId||next.identityState!=='verified')throw failure('이전 로그인에서 확인되지 않은 변경을 보관하고 있습니다. 자동으로 새 계정에 적용하지 않았습니다.','OUTBOX_RECOVERY_REQUIRED');
        await commit(intent);await checkpoints(databases[index],intent.txId);
      }
      for(let index=0;index<databases.length;index++){
        const checkpoint=await raw(databases[index],[JOURNAL],'readonly',tx=>request(tx.objectStore(JOURNAL).get(CHECKPOINT)));
        if(!checkpoint||checkpoint.kind!=='checkpoint'||checkpoint.origin!==origin){let legacy=false;for(const bucket of Object.keys(schemas[index].stores))if(await firstRecord(databases[index],bucket)){legacy=true;break;}if(legacy){await quarantineLegacy(databases[index],schemas[index]);preserved=true;}}
      }
      if(preserved&&!explicit)throw failure('기존 앱 캐시를 복구용으로 보관했습니다. 확인되지 않은 변경은 자동으로 덮어쓰지 않습니다.','OUTBOX_RECOVERY_REQUIRED');
      let reusable=false;
      if(driver&&initial&&!explicit&&!reconcileFenced&&identity.identityState==='verified'&&identity.resourceAccess==='ready'){
        // Offline cold start may reuse only a complete currently native-verified profile.
        // Empty/new grants still require actual canonical collection before controllers start.
        await hydrate();reusable=!!await raw(databases[0],['profiles'],'readonly',tx=>request(tx.objectStore('profiles').get(identity.profileId)));
        if(retentionPending){reusable=reusable&&await completeRetainedProfile();if(!reusable)throw failure('최신 문서를 확인한 뒤 이전 기록을 보관하고 계속해 주세요.','OUTBOX_RECOVERY_REQUIRED');}
      }
      if(driver&&!reusable&&identity.identityState==='verified'&&(reconcileFenced||explicit||initial||!initialized||!previous||previous.profileId!==identity.profileId||previous.lease!==identity.lease||previous.head!==identity.head||previous.proofEpoch!==identity.proofEpoch||identity.resourceAccess==='required'))await reconcileNative({mode,handles,explicit,signal});
      if(initial||explicit||!initialized||!previous||previous.profileId!==next.profileId||previous.lease!==next.lease||previous.head!==identity.head||previous.proofEpoch!==next.proofEpoch||next.resourceAccess==='required'){
        if(identity.identityState==='verified'){if(!reusable)await hydrate();}
        else for(let index=0;index<databases.length;index++)await raw(databases[index],Object.keys(schemas[index].stores),'readwrite',tx=>{for(const bucket of Object.keys(schemas[index].stores))tx.objectStore(bucket).clear();});
        if(retentionPending&&!await completeRetainedProfile())throw failure('최신 문서의 로그인 범위를 확인하지 못했습니다.','OUTBOX_RECOVERY_REQUIRED');
        for(const database of databases)await checkpoints(database);
      }
      if(explicit)for(const database of databases)await raw(database,[JOURNAL],'readwrite',async tx=>{const store=tx.objectStore(JOURNAL);for(const record of await readJournals(tx))if(record.kind==='quarantined'&&record.profileId===identity.profileId&&record.origin===origin)store.delete(record.txId);});
      initialized=true;if(retentionPending)continuedRetention=retentionPending;
    }
    async function initialize(){return coordinated(async()=>{if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');try{for(const database of databases)database.close();databases=await Promise.all(schemas.map(open));await recover({initial:true});blocked=null;return{ready:true,identityState:identity.identityState};}catch(error){blocked=storageError(error);throw blocked;}});}
    async function refreshAuth(){return coordinated(async()=>{if(closed)throw failure('기기 저장 연결이 종료되었습니다.','OUTBOX_CLOSED');if(blocked&&!driver&&blocked.code!=='OUTBOX_ACCESS_REQUIRED')throw blocked;try{await recover();blocked=null;}catch(error){blocked=storageError(error);throw blocked;}});}
    function run(database,names,mode,callback){return coordinated(async()=>{
      if(blocked&&driver)blocked=null;check();if(!initialized)throw failure('기기 저장 준비가 끝나지 않았습니다.','OUTBOX_NOT_READY');if(!Array.isArray(names))names=[names];const schema=schemas.find(schema=>schema.name===database.name);if(!schema||!names.every(name=>Object.hasOwn(schema.stores,name))||!['readonly','readwrite'].includes(mode))throw new TypeError('Unsupported native business transaction');
      try{await recover();}catch(error){blocked=storageError(error);throw blocked;}
      if(mode==='readonly'){const expected={head:identity.head,lease:identity.lease,proofEpoch:identity.proofEpoch,profileId:identity.profileId},result=await raw(database,names,mode,callback);check();const current=await opened();if(current.head!==expected.head||current.lease!==expected.lease||current.proofEpoch!==expected.proofEpoch||current.profileId!==expected.profileId||current.resourceAccess!=='ready'){blocked=accessRequired();throw blocked;}return result;}
      if(identity.identityState!=='verified')throw new DOMException('확인된 네이티브 로그인 후 기기에 저장할 수 있습니다.','SecurityError');
      const intent={txId:txId(),version:1,origin,profileId:identity.profileId,baseHead:identity.head,lease:identity.lease,proofEpoch:identity.proofEpoch,createdAt:Date.now(),digest:null};let committedIntent=null;
      const result=await raw(database,[...names,JOURNAL],mode,tx=>new Promise((resolve,reject)=>{
        const objectStore=tx.objectStore.bind(tx),changes=[],beforeImages=[],beforeKeys=new Set(),decorated=new Map();let callbackDone=false,pending=0,revision=0,written=-1,result;
        const finalize=()=>{if(!callbackDone||pending||revision===written)return;try{const ordered=changes.filter(Boolean);if(ordered.length){const delta=encoded({version:1,origin,mode:'active',changes:ordered});if(delta.bytes.length>TRANSACTION)throw failure('기기 저장 작업이 너무 큽니다.','OUTBOX_LIMIT');committedIntent={...intent,deltaJSON:delta.text,beforeImages};if(encoded(committedIntent).bytes.length>TRANSACTION)throw failure('삭제 전 원본을 포함한 저장 기록이 너무 큽니다.','OUTBOX_LIMIT');objectStore(JOURNAL).put(committedIntent);}written=revision;resolve(result);}catch(error){reject(error);try{tx.abort();}catch{}}};
        tx.objectStore=name=>{const store=objectStore(name);if(name===JOURNAL)throw new DOMException('내부 저장 저널에는 직접 접근할 수 없습니다.','SecurityError');if(decorated.has(name))return store;decorated.set(name,store);
          for(const method of ['put','add','delete']){const original=store[method].bind(store);store[method]=(...args)=>{let value;if(method!=='delete'){value=JSON.parse(json(args[0]));if(new TextEncoder().encode(json(value)).length>RECORD)throw failure('기기 저장 기록이 너무 큽니다.','OUTBOX_LIMIT');args[0]=value;}if(method==='delete'){
              const key=clone(args[0]),imageKey=json([name,key]);if(!beforeKeys.has(imageKey)){beforeKeys.add(imageKey);pending++;const read=store.get(key);read.addEventListener('success',()=>{try{const present=read.result!==undefined;if(present&&encoded(read.result).bytes.length>RECORD)throw failure('삭제 전 원본이 너무 큽니다.','OUTBOX_LIMIT');beforeImages.push({bucket:name,key,present,...(present?{value:clone(read.result)}:{})});pending--;finalize();}catch(error){reject(error);try{tx.abort();}catch{}}},{once:true});read.addEventListener('error',()=>{reject(read.error);try{tx.abort();}catch{}},{once:true});}
            }const position=changes.length;changes.push(null);pending++;const operation=original(...args);operation.addEventListener('success',()=>{const key=method==='delete'?args[0]:operation.result;if(!validKey(key)){reject(failure('기기 저장 키가 올바르지 않습니다.','OUTBOX_INVALID_RECORD'));try{tx.abort();}catch{}return;}changes[position]={op:method==='delete'?'delete':'put',bucket:name,key:clone(key),...(method==='delete'?{}:{value})};pending--;revision++;finalize();},{once:true});operation.addEventListener('error',()=>{pending--;finalize();},{once:true});return operation;};}
          const cursors=target=>{for(const method of ['openCursor','openKeyCursor'])if(typeof target[method]==='function'){const original=target[method].bind(target);target[method]=(...args)=>{const operation=original(...args);operation.addEventListener('success',()=>{const cursor=operation.result;if(cursor)for(const write of ['update','delete'])cursor[write]=()=>{throw failure('커서 변경은 저장소 put/delete로 처리해야 합니다.','OUTBOX_UNTRACKED_WRITE');};});return operation;};}};
          cursors(store);const index=store.index.bind(store),indexes=new Set();store.index=name=>{const value=index(name);if(!indexes.has(value)){indexes.add(value);cursors(value);}return value;};
          store.clear=()=>{throw failure('전체 저장소 삭제는 명시적인 기록 삭제로 처리해야 합니다.','OUTBOX_UNTRACKED_WRITE');};return store;};
        Promise.resolve().then(()=>callback(tx)).then(value=>{result=value;callbackDone=true;finalize();}).catch(reject);
      }));
      if(committedIntent){try{
        const privateProfile=identity.profileId;let terminalProfile=null;await commit(committedIntent);await checkpoints(database,committedIntent.txId);
        const changes=JSON.parse(committedIntent.deltaJSON).changes,control=changes.some(change=>change.op==='put'&&change.bucket==='meta'&&typeof change.value.id==='string'&&/^revoked(?:-resource)?:/.test(change.value.id));
        if(control){
          identity=await opened();if(identity.identityState==='verified')await hydrate();
          else{
            for(let index=0;index<databases.length;index++)await raw(databases[index],Object.keys(schemas[index].stores),'readwrite',tx=>{for(const bucket of Object.keys(schemas[index].stores))tx.objectStore(bucket).clear();});
            // Only an exact acknowledged own-profile revocation plus the private
            // blocked header completes this terminal transition. It grants no read.
            if(driver&&identity.identityState==='blocked'&&changes.some(change=>change.op==='put'&&change.bucket==='meta'&&change.key==='revoked:'+privateProfile&&change.value.id===change.key)){
              terminalProfile=privateProfile;initialized=false;if(activeOperation?.pause)activeOperation.pause.terminal=true;
            }
          }
        }
        for(const other of databases)await checkpoints(other,undefined,terminalProfile||identity.profileId||null);
      }catch(error){blocked=error?.code==='OUTBOX_ACCESS_REQUIRED'?storageError(error):failure('기기 저장 완료를 확인하지 못했습니다. 변경을 보관하고 앱을 다시 열어 확인해 주세요.');if(blocked!==error)blocked.cause=error;throw blocked;}}
      return result;
    });}
    async function reconcile(options={}){return coordinated(async()=>{try{await recover({...options,initial:true,explicit:true});blocked=null;return{ready:true};}catch(error){blocked=storageError(error);throw blocked;}},{force:true});}
    async function recoveryHandles(){return coordinated(async()=>{const result=await opened();return clone(result.reconciliationHandles||[]);});}
    function close(){closed=true;for(const database of databases)database.close();}
    return Object.freeze({initialize,refreshAuth,reconcile,recoveryHandles,run,close,get ready(){return initialized&&!blocked&&!closed;},get resourceAccess(){return blocked?.code==='OUTBOX_ACCESS_REQUIRED'?'required':identity?.resourceAccess||'required';},get accessIssues(){return clone(identity?.accessIssues||[]);},get identityState(){return identity?.identityState||'unknown';},get profileId(){return initialized&&!blocked&&!closed&&identity?.identityState==='verified'?identity.profileId:null;},get validUntil(){return initialized&&!blocked&&!closed&&identity?.identityState==='verified'?identity.validUntil:null;}});
  }
  root.FountainNativeOutbox=Object.freeze({create});
})(globalThis);
