/* Durable private drafts. Keys always include origin, workspace and signed-in actor. */
(() => {
  'use strict';
  const SERVER_ORIGIN=globalThis.FountainTransport?.origin||location.origin;
  const DATABASE = 'fountain-offline-v1';
  const STORES = ['profiles', 'meta', 'snapshots', 'operations', 'drafts', 'databaseSnapshots', 'mutations', 'localPages'];
  const LOCAL_TTL = 24 * 60 * 60 * 1000;
  let connection;
  const suspendedHere=new Set(), parkedHere=new Set();
  let selected = null;
  const pointerKey = (profile = selected) => profile?.accountBinding ? 'active:' + profile.accountBinding + ':' + profile.workspaceId : 'active';
  const lastKey = (profile = selected) => profile?.accountBinding ? 'last-profile:' + profile.accountBinding + ':' + profile.workspaceId : 'last-profile';
  function selectWorkspace(scope) { selected = scope ? { workspaceId: scope.workspaceId, accountBinding: scope.accountBinding } : null; }

  const ARCHIVE_LIMIT=16*1024*1024;
  const copy = value => structuredClone(value);
  const request = operation => new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
  function identifier(value, name) {
    if (typeof value !== 'string' || !value || value.length > 1000) throw new TypeError(`Invalid ${name}`);
    return encodeURIComponent(value);
  }
  function namespace(profile) {
    if (!profile || typeof profile !== 'object') throw new TypeError('Offline profile required');
    const binding = profile.session?.cache_binding || profile.cacheBinding;
    return `${SERVER_ORIGIN}|${identifier(profile.workspaceId, 'workspace')}|${identifier(profile.memberId, 'member')}|${identifier(binding, 'session binding')}`;
  }
  function key(profile, pageId) {
    return `${namespace(profile)}|${identifier(pageId, 'page')}`;
  }
  function databaseKey(profile, databaseId) {
    return `${namespace(profile)}|database|${identifier(databaseId, 'database')}`;
  }
  function open() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('Offline storage is unavailable'));
    if (!connection) connection = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DATABASE, globalThis.FountainTransport?.outboxEnabled ? 3 : 2);
      opening.onupgradeneeded = () => {
        const database = opening.result;
        if (globalThis.FountainTransport?.outboxEnabled && !database.objectStoreNames.contains('nativeJournal')) {
          database.createObjectStore('nativeJournal', { keyPath: 'txId' });
        }
        if (!database.objectStoreNames.contains('profiles')) database.createObjectStore('profiles', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'id' });
        for (const [name, keyPath] of [['snapshots', 'key'], ['operations', ['key', 'id']], ['drafts', ['key', 'clientId']],
          ['databaseSnapshots', 'key'], ['mutations', ['profileId', 'id']], ['localPages', 'key']]) {
          if (database.objectStoreNames.contains(name)) continue;
          const store = database.createObjectStore(name, { keyPath });
          store.createIndex('profileId', 'profileId');
          if (name === 'operations' || name === 'drafts') store.createIndex('key', 'key');
          if (['databaseSnapshots', 'mutations', 'localPages'].includes(name)) store.createIndex('resourceKey', 'resourceKey');
        }
      };
      opening.onerror = () => { connection = undefined; reject(opening.error); };
      opening.onsuccess = () => {
        const database = opening.result;
        database.onversionchange = () => { database.close(); connection = undefined; };
        resolve(database);
      };
    });
    return connection;
  }
  async function transaction(names, mode, callback) {
    const database = await open();
    if (globalThis.FountainTransport?.outboxEnabled) {
      if (!globalThis.FountainNativeStorage) throw Object.assign(new Error('앱의 기기 저장소를 시작하지 못했습니다.'), { status: 503 });
      return globalThis.FountainNativeStorage.run(database, names, mode, callback);
    }
    return new Promise((resolve, reject) => {
      const tx = database.transaction(names, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Offline transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Offline transaction aborted'));
      Promise.resolve().then(() => callback(tx)).then(value => { result = value; }).catch(error => {
        try { tx.abort(); } catch { /* Already aborted by the failed request. */ }
        reject(error);
      });
    });
  }
  async function active(tx) {
    const pointer = await request(tx.objectStore('meta').get(pointerKey()));
    if (!pointer) return null;
    const profile = await request(tx.objectStore('profiles').get(pointer.profileId));
    if(profile?.accountBinding&&await request(tx.objectStore('meta').get('ended-account:'+profile.accountBinding+':'+profile.id)))return null;
    if(profile&&(parkedHere.has(profile.id)||suspendedHere.has(profile.id)||await request(tx.objectStore('meta').get('suspended:'+profile.id))||await request(tx.objectStore('meta').get('revoked:'+profile.id))))return null;
    return profile && profile.origin === SERVER_ORIGIN && Number.isFinite(profile.validUntil)
      && profile.validUntil > Date.now() ? profile : null;
  }
  function resourceType(profile, resourceKey) {
    if (!profile || typeof resourceKey !== 'string') return null;
    const parts = resourceKey.split('|');
    if (parts.slice(0, 4).join('|') !== profile.id) return null;
    if (parts.length === 5 && parts[4]) return 'page';
    if (parts.length === 6 && parts[4] === 'database' && parts[5]) return 'database';
    return null;
  }
  function matches(profile, resourceKey, kind = 'page') {
    return resourceType(profile, resourceKey) === kind;
  }
  async function scoped(resourceKey, storeName, mode, callback, fallback, kind = 'page') {
    return transaction(['profiles', 'meta', storeName], mode, async tx => {
      const profile = await active(tx);
      if (!matches(profile, resourceKey, kind)) {
        if (mode === 'readwrite') throw new DOMException('Offline profile is expired or does not match', 'SecurityError');
        return fallback;
      }
      if (await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) {
        if (mode === 'readwrite') throw new DOMException('Offline resource access was revoked for this login', 'SecurityError');
        return fallback;
      }
      return callback(tx.objectStore(storeName), profile, tx);
    });
  }
  async function saveProfile(input) {
    const id = namespace(input);
    const session = input.session;
    if (!session || session.authenticated !== true || session.member?.id !== input.memberId || session.member.active === false) {
      throw new DOMException('An authenticated profile is required', 'SecurityError');
    }
    const validUntil = session.expires_at ? Date.parse(session.expires_at)
      : session.mode === 'local' ? Date.now() + LOCAL_TTL : NaN;
    if (!Number.isFinite(validUntil) || validUntil <= Date.now()) throw new DOMException('Session has expired', 'SecurityError');
    // Persist only the public session description; never cookies, passwords or API keys.
    const safeMember = Object.fromEntries(['id', 'name', 'email', 'role', 'active'].filter(field => Object.hasOwn(session.member, field))
      .map(field => [field, session.member[field]]));
    const safeSession = Object.fromEntries(['enabled', 'required', 'authenticated', 'mode', 'identity', 'expires_at', 'workspace_id', 'cache_binding', 'account_binding']
      .filter(field => Object.hasOwn(session, field)).map(field => [field, session[field]]));
    // This optional display/navigation metadata is never part of login authority.
    if(typeof session.public_web_origin==='string'&&session.public_web_origin.length<=1024&&!/[\\\u0000-\u0020\u007f]/.test(session.public_web_origin)){
      try{const url=new URL(session.public_web_origin);if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&url.origin===session.public_web_origin)safeSession.public_web_origin=url.origin;}catch{ /* Ignore invalid optional metadata. */ }
    }
    safeSession.member = safeMember;
    const profile = { id, origin: SERVER_ORIGIN, workspaceId: input.workspaceId, memberId: input.memberId,
      cacheBinding: session.cache_binding, accountBinding: session.account_binding || null,
      session: copy(safeSession), workspace: copy(input.workspace), validUntil, updatedAt: Date.now() };
    let changed = false,suspendedPrevious=null,expiredSource=false;
    const saved = await transaction(STORES, 'readwrite', async tx => {
      if (globalThis.FountainTransport?.outboxEnabled) {
        const storage = globalThis.FountainNativeStorage;
        const expiry = storage?.validUntil;
        if (storage?.profileId !== id || !Number.isFinite(expiry) || expiry <= Date.now()) {
          throw new DOMException('A current native login grant is required', 'SecurityError');
        }
        // The native observation precedes this call, especially for no-cookie
        // local sessions. Never extend its lifetime by recomputing a fresh TTL.
        profile.validUntil = Math.min(profile.validUntil, expiry);
      }
      if(profile.accountBinding && await request(tx.objectStore('meta').get('ended-account:' + profile.accountBinding+':'+profile.id))) throw new DOMException('Account login ended', 'SecurityError');
      if(suspendedHere.has(id)||await request(tx.objectStore('meta').get('suspended:'+id)))throw Object.assign(new DOMException('Suspended login cannot become active again','SecurityError'),{fountainCode:'PROFILE_SUSPENDED'});
      if (await request(tx.objectStore('meta').get('revoked:' + id))) {
        throw new DOMException('Offline session was logged out', 'SecurityError');
      }
      const existing=await request(tx.objectStore('profiles').get(id));
      if(existing&&Number.isFinite(existing.validUntil)&&existing.validUntil<=Date.now()){await suspendStored(tx,id);expiredSource=true;return null;}
      const previous = await request(tx.objectStore('meta').get(pointerKey(profile)));
      changed = previous?.profileId !== id;
      if (previous && previous.profileId !== id) {
        await suspendStored(tx,previous.profileId);suspendedPrevious=previous.profileId;
      }
      if (Array.isArray(profile.workspace?.pages)) {
        const pages = [];
        for (const page of profile.workspace.pages) {
          if (typeof page.id === 'string' && !await request(tx.objectStore('meta').get('revoked-resource:' + key(profile, page.id)))) pages.push(page);
        }
        profile.workspace.pages = pages;
      }
      if (Array.isArray(profile.workspace?.databases)) {
        const databases = [];
        for (const database of profile.workspace.databases) {
          if (typeof database.id === 'string' && !await request(tx.objectStore('meta').get('revoked-resource:' + databaseKey(profile, database.id)))) databases.push(database);
        }
        profile.workspace.databases = databases;
      }
      tx.objectStore('profiles').put(profile);
      tx.objectStore('meta').put({ id: pointerKey(profile), profileId: id });
      tx.objectStore('meta').delete('parked:' + id);
      tx.objectStore('meta').put({id:lastKey(profile),profileId:id});
      return copy(profile);
    });
    if(expiredSource){profileChanged(null,true,id);throw Object.assign(new DOMException('Expired login was retained and cannot become active again','SecurityError'),{fountainCode:'PROFILE_SUSPENDED'});}
    parkedHere.delete(id);
    if (changed) profileChanged(id,true,suspendedPrevious, profile.accountBinding ? { accountBinding: profile.accountBinding, workspaceId: profile.workspaceId } : {});
    return saved;
  }
  function archiveError(message='보관된 기록을 안전하게 확인하지 못했습니다.',code='RECOVERY_ARCHIVE_INVALID'){return Object.assign(new Error(message),{code,status:409});}
  function sourceIdentity(profile,id){
    if(!profile||profile.id!==id||profile.origin!==SERVER_ORIGIN||namespace(profile)!==id||profile.session?.cache_binding!==profile.cacheBinding||profile.session?.member?.id!==profile.memberId)throw archiveError();
  }
  function boundedArchive(value,budget){
    const stack=[[value,0]],seen=new Set();let nodes=0;
    while(stack.length){const [item,depth]=stack.pop();if(++nodes>150000||depth>32)throw archiveError('보관된 기록이 커서 원본을 유지했습니다.','RECOVERY_ARCHIVE_LIMIT');if(item&&typeof item==='object'){if(seen.has(item)||!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw archiveError();seen.add(item);for(const name in item){if(!Object.prototype.hasOwnProperty.call(item,name))continue;if(['__proto__','prototype','constructor'].includes(name))throw archiveError();if(stack.length+nodes>=150000)throw archiveError('보관된 기록이 커서 원본을 유지했습니다.','RECOVERY_ARCHIVE_LIMIT');stack.push([item[name],depth+1]);}}else if(!['string','number','boolean'].includes(typeof item)&&item!==null&&item!==undefined)throw archiveError();else if(typeof item==='number'&&!Number.isFinite(item))throw archiveError();}
    let text;try{text=JSON.stringify(value);}catch{throw archiveError();}budget.bytes+=new TextEncoder().encode(text).byteLength;budget.nodes+=nodes;if(budget.bytes>ARCHIVE_LIMIT||budget.nodes>150000)throw archiveError('보관된 기록이 16MiB 복구 범위를 넘어 원본을 유지했습니다.','RECOVERY_ARCHIVE_LIMIT');return value;
  }
  async function suspendStored(tx,id,lastEdits){
    const meta=tx.objectStore('meta'),storedProfile=await request(tx.objectStore('profiles').get(id)),activeKey=pointerKey(storedProfile),pointer=await request(meta.get(activeKey));
    if(await request(meta.get('revoked:'+id)))return{profileId:id,lastEditsSaved:false,captured:false,reason:'revoked'};if(!await request(tx.objectStore('profiles').getKey(id)))return{profileId:id,lastEditsSaved:false,captured:false,reason:'missing'};
    const previous=await request(meta.get('suspended:'+id));
    if(!previous){
      if(lastEdits&&pointer?.profileId===id)await retainLastEdits(tx,id,lastEdits);
      const counts={};for(const name of STORES.filter(name=>!['profiles','meta'].includes(name)))counts[name]=await request(tx.objectStore(name).index('profileId').count(IDBKeyRange.only(id)));
      meta.put({id:'suspended:'+id,profileId:id,createdAt:Date.now(),counts});
    }
    if(pointer?.profileId===id){meta.put({id:lastKey(storedProfile),profileId:id});meta.delete(activeKey);}const captured=!!lastEdits&&pointer?.profileId===id&&!previous;return{profileId:id,lastEditsSaved:captured,captured,reason:previous||pointer?.profileId!==id?'inactive':'suspended'};
  }
  async function retainLastEdits(tx,id,input,parked=false){
    boundedArchive(input,{bytes:0,nodes:0});if(!input||typeof input.pageId!=='string'||!input.pageId||input.pageId.length>160||Object.keys(input).some(key=>!['pageId','draft','title'].includes(key)))throw archiveError();
    const resourceKey=id+'|'+identifier(input.pageId,'page'),now=Date.now(),nonce=crypto.randomUUID?.()||Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
    if(input.draft){if(!input.draft||typeof input.draft!=='object'||Array.isArray(input.draft)||Object.keys(input.draft).some(key=>!['epoch','seq','ops','blocks','reason','createdAt','history_pending','imported','source_digest'].includes(key))||!Array.isArray(input.draft.blocks)&&!Array.isArray(input.draft.ops))throw archiveError();tx.objectStore('drafts').put({key:resourceKey,clientId:(parked?'parked_':'suspended_')+nonce,profileId:id,draft:{...copy(input.draft),reason:parked?(input.draft.ops?.length?'pending':'workspace_parked'):'auth_suspended'},updatedAt:now});}
    if(input.title){if(typeof input.title.title!=='string'||Array.from(input.title.title).length>500||input.title.basePage?.id!==input.pageId)throw archiveError();const operationId=(parked?'parked_':'suspended_')+nonce;tx.objectStore('mutations').put({profileId:id,id:operationId,resourceKey,status:parked?'pending':'paused',sequence:now,createdAt:now,updatedAt:now,operation:{id:operationId,kind:'page.patch',target_id:input.pageId,body:{title:input.title.title},base:{fields:{title:input.title.basePage.title??null}},depends_on:[]}});}
  }
  async function suspendProfile(profile,{lastEdits}={}){
    const id=namespace(profile);suspendedHere.add(id);let result;
    try{result=await transaction(STORES,'readwrite',tx=>suspendStored(tx,id,lastEdits&&copy(lastEdits)));}
    finally{profileChanged(null,true,id);}return result;
  }
  async function suspendActiveProfile(options={}){
    let id;try{return await transaction(STORES,'readwrite',async tx=>{const pointer=await request(tx.objectStore('meta').get(pointerKey()));id=pointer?.profileId;if(options.expectedProfileId!==undefined&&id!==options.expectedProfileId){id=null;return{profileId:options.expectedProfileId,lastEditsSaved:false,captured:false,reason:'inactive'};}if(!id)return{profileId:null,lastEditsSaved:false,captured:false,reason:'missing'};suspendedHere.add(id);return suspendStored(tx,id,options.lastEdits&&copy(options.lastEdits));});}finally{if(id)profileChanged(null,true,id);}
  }
  async function recoveryOwner(tx,current){const profile=await active(tx);if(!profile||profile.id!==namespace(current)||profile.id!==current.id)throw new DOMException('Current authenticated recovery profile required','SecurityError');return profile;}
  async function listRecoveryProfiles(current,{cursor=null,limit=20}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid archive page size');
    return transaction(['profiles','meta'],'readonly',async tx=>{
      const owner=await recoveryOwner(tx,current),prefix=owner.id.split('|').slice(0,3).join('|')+'|';let after=null;if(cursor!==null){try{after=atob(cursor);}catch{throw new TypeError('Invalid recovery cursor');}if(!after.startsWith(prefix)||after.split('|').length!==4)throw new TypeError('Invalid recovery cursor');}
      const items=[];let last=null,scanned=0,next=null;const range=after?IDBKeyRange.bound(after,prefix+'\uffff',true):IDBKeyRange.bound(prefix,prefix+'\uffff');
      await new Promise((resolve,reject)=>{const op=tx.objectStore('profiles').openKeyCursor(range);op.onerror=()=>reject(op.error);op.onsuccess=async()=>{try{const row=op.result;if(!row){resolve();return;}last=row.primaryKey;const marker=await request(tx.objectStore('meta').get('suspended:'+last));if(marker&&last!==owner.id&&last.split('|').length===4){const counts={};if(marker.profileId!==last||!Number.isSafeInteger(marker.createdAt)||marker.createdAt<0)throw archiveError();for(const name of STORES.filter(name=>!['profiles','meta'].includes(name))){const value=marker.counts?.[name];if(!Number.isSafeInteger(value)||value<0)throw archiveError();counts[name]=value;}items.push({id:last,createdAt:marker.createdAt,counts});}if(items.length>=limit||++scanned>=1000){next=btoa(last);resolve();return;}row.continue();}catch(error){reject(error);}};});await recoveryOwner(tx,current);return{items,next};
    });
  }
  async function readRecoveryProfile(current,id){
    if(typeof id!=='string')throw new TypeError('Archive identifier required');
    return transaction(STORES,'readonly',async tx=>{
      const owner=await recoveryOwner(tx,current),prefix=owner.id.split('|').slice(0,3).join('|')+'|';if(id===owner.id||!id.startsWith(prefix)||id.split('|').length!==4||!await request(tx.objectStore('meta').get('suspended:'+id))||await request(tx.objectStore('meta').get('revoked:'+id)))throw new DOMException('Recovery profile does not match current actor','SecurityError');
      const source=await request(tx.objectStore('profiles').get(id));sourceIdentity(source,id);const result={profile:{id,origin:source.origin,workspaceId:source.workspaceId,memberId:source.memberId,cacheBinding:source.cacheBinding}},budget={bytes:0,nodes:0};
      for(const name of STORES.filter(name=>!['profiles','meta'].includes(name))){result[name]=[];await new Promise((resolve,reject)=>{const op=tx.objectStore(name).index('profileId').openCursor(IDBKeyRange.only(id));op.onerror=()=>reject(op.error);op.onsuccess=()=>{try{const cursor=op.result;if(!cursor){resolve();return;}const row=cursor.value;if(row.profileId!==id)throw archiveError();const resourceKey=row.resourceKey||row.key;if(!resourceType(source,resourceKey)||name==='mutations'&&(row.id!==row.operation?.id||!['page.create','page.patch','row.create','row.patch','row.delete'].includes(row.operation?.kind)))throw archiveError();const target=decodeURIComponent(resourceKey.split('|').at(-1));if(name==='mutations'&&(row.operation.kind.startsWith('row.')?row.operation.database_id!==target:row.operation.target_id!==target)||name==='operations'&&(row.id!==row.operation?.id||resourceType(source,resourceKey)!=='page')||name==='drafts'&&(!row.draft||typeof row.clientId!=='string'||!row.clientId)||name==='localPages'&&row.metadata?.page?.id!==target)throw archiveError();if(name==='snapshots'&&row.snapshot?.page?.id!==target||name==='databaseSnapshots'&&row.snapshot?.database?.id!==target)throw archiveError();if(row.snapshot)for(const [field,expected]of [['workspace_id',source.workspaceId],['current_member_id',source.memberId],['session_binding',source.cacheBinding]])if(row.snapshot[field]!==undefined&&row.snapshot[field]!==expected)throw archiveError();result[name].push(copy(boundedArchive(row,budget)));cursor.continue();}catch(error){reject(error);}};});}
      await recoveryOwner(tx,current);return result;
    });
  }
  function getProfile() {
    return transaction(['profiles', 'meta'], 'readonly', active);
  }
  async function offlineWorkspaces(accountBinding) {
    return transaction(['profiles','meta'],'readonly',async tx=>{const profiles=await request(tx.objectStore('profiles').getAll()),seen=new Set(),items=[];for(const profile of profiles.sort((a,b)=>b.updatedAt-a.updatedAt)){if(suspendedHere.has(profile.id)||profile.accountBinding!==accountBinding||profile.validUntil<=Date.now()||seen.has(profile.workspaceId)||await request(tx.objectStore('meta').get('suspended:'+profile.id))||await request(tx.objectStore('meta').get('revoked:'+profile.id))||await request(tx.objectStore('meta').get('ended-account:'+accountBinding+':'+profile.id)))continue;seen.add(profile.workspaceId);items.push(copy(profile));}return items;});
  }
  async function offlineWorkspace(workspaceId) {
    return transaction(['profiles','meta'],'readonly',async tx=>{
      const profiles=(await request(tx.objectStore('profiles').getAll())).filter(profile=>profile.accountBinding&&profile.workspaceId===workspaceId&&profile.validUntil>Date.now()).sort((a,b)=>b.updatedAt-a.updatedAt);
      for(const profile of profiles){if(suspendedHere.has(profile.id)||await request(tx.objectStore('meta').get('suspended:'+profile.id))||await request(tx.objectStore('meta').get('revoked:'+profile.id))||await request(tx.objectStore('meta').get('ended-account:'+profile.accountBinding+':'+profile.id)))continue;return copy(profile);}return null;
    });
  }
  async function workspaceProfile(accountBinding, workspaceId) {
    return transaction(['profiles', 'meta'], 'readonly', async tx => {
      const pointer = await request(tx.objectStore('meta').get('active:' + accountBinding + ':' + workspaceId));
      if (!pointer) return null;
      const profile = await request(tx.objectStore('profiles').get(pointer.profileId));
      if (!profile || suspendedHere.has(profile.id) || profile.accountBinding !== accountBinding || profile.workspaceId !== workspaceId || profile.validUntil <= Date.now() || await request(tx.objectStore('meta').get('suspended:' + profile.id)) || await request(tx.objectStore('meta').get('revoked:' + profile.id)) || await request(tx.objectStore('meta').get('ended-account:' + accountBinding+':'+profile.id))) return null;
      return copy(profile);
    });
  }
  async function parkProfile(profile, { lastEdits, forms = [] } = {}) {
    const id = namespace(profile);
    const result = await transaction(STORES, 'readwrite', async tx => {
      const current = await active(tx);
      if (!current || current.id !== id || !current.accountBinding) throw new DOMException('Current workspace is required', 'SecurityError');
      boundedArchive({ lastEdits, forms }, { bytes: 0, nodes: 0 });
      if (lastEdits) {
        await retainLastEdits(tx, id, lastEdits, true);
      }
      tx.objectStore('meta').put({ id: 'parked:' + id, profileId: id, accountBinding: current.accountBinding, createdAt: Date.now() });
      tx.objectStore('meta').put({ id: 'workspace-input:' + id, profileId: id, forms: copy(forms), updatedAt: Date.now() });
      return { profileId: id, lastEditsSaved: !!lastEdits, captured: true };
    });
    parkedHere.add(id);
    return result;
  }
  async function workspaceInput(profile) { return transaction(['profiles', 'meta'], 'readonly', async tx => { const current = await active(tx); if (!current || current.id !== namespace(profile)) return null; return (await request(tx.objectStore('meta').get('workspace-input:' + current.id)))?.forms || []; }); }
  async function clearWorkspaceInput(profile,kind) { return transaction(['profiles','meta'],'readwrite',async tx=>{const current=await active(tx);if(!current||current.id!==namespace(profile))return;const key='workspace-input:'+current.id,previous=await request(tx.objectStore('meta').get(key));if(previous)tx.objectStore('meta').put({...previous,forms:(previous.forms||[]).filter(form=>form.kind!==kind),updatedAt:Date.now()});}); }
  async function endAccount(accountBinding) {
    if (typeof accountBinding !== 'string') return;
    const ids = await transaction(STORES, 'readwrite', async tx => {
      const profiles = await request(tx.objectStore('profiles').getAll()), ended = [];
      for (const profile of profiles) if (profile.accountBinding === accountBinding) { suspendedHere.add(profile.id); await suspendStored(tx, profile.id); tx.objectStore('meta').put({id:'ended-account:'+accountBinding+':'+profile.id,profileId:profile.id,createdAt:Date.now()}); ended.push(profile.id); }
      return ended;
    });
    for (const id of ids) announce(id, true, { profileIds: ids, accountBinding });
  }
  async function selectSnapshot(store, profile, resourceKey, value) {
    if (value && (value.workspace_id !== undefined && value.workspace_id !== profile.workspaceId
        || value.current_member_id !== undefined && value.current_member_id !== profile.memberId
        || value.session_binding !== undefined && value.session_binding !== profile.cacheBinding
        || value.page?.id !== undefined && value.page.id !== decodeURIComponent(resourceKey.split('|')[4]))) {
      throw new DOMException('Page snapshot identity does not match', 'SecurityError');
    }
    const previous = (await request(store.get(resourceKey)))?.snapshot;
    if (previous && value) {
      const previousAccess = Number.isSafeInteger(previous.access_revision) ? previous.access_revision : 0;
      const nextAccess = Number.isSafeInteger(value.access_revision) ? value.access_revision : 0;
      if (nextAccess < previousAccess) return previous;
      // A native reconciliation may have installed a newer envelope while the
      // same document response was waiting to persist. Keep that canonical floor.
      if (Number.isSafeInteger(previous.data_revision)
          && (!Number.isSafeInteger(value.data_revision) || value.data_revision < previous.data_revision)) return previous;
      if (previous.epoch === value.epoch && Number.isSafeInteger(previous.seq)
          && Number.isSafeInteger(value.seq) && value.seq < previous.seq) return previous;
      if (Number.isSafeInteger(previous.page?.revision) && Number.isSafeInteger(value.page?.revision)
          && value.page.revision < previous.page.revision) return previous;
    }
    await request(store.put({ key: resourceKey, profileId: profile.id, snapshot: value, updatedAt: Date.now() }));
    return value;
  }
  function saveSnapshot(resourceKey, snapshot) {
    const value = copy(snapshot);
    return scoped(resourceKey, 'snapshots', 'readwrite', (store, profile) => selectSnapshot(store, profile, resourceKey, value));
  }
  function requireAckSnapshot(profile, resourceKey, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.epoch !== 'string' || !value.epoch
        || !Number.isSafeInteger(value.seq) || value.seq < 0 || !Array.isArray(value.blocks)
        || !value.page || typeof value.page !== 'object' || Array.isArray(value.page)
        || !value.state || typeof value.state !== 'object' || Array.isArray(value.state) || value.state.version !== 1
        || !value.state.blocks || typeof value.state.blocks !== 'object'
        || Array.isArray(value.state.blocks) || !value.state.seen || typeof value.state.seen !== 'object' || Array.isArray(value.state.seen)) {
      throw new TypeError('Canonical collaboration snapshot required');
    }
    if (typeof value.workspace_id !== 'string' || value.workspace_id !== profile.workspaceId
        || typeof value.current_member_id !== 'string' || value.current_member_id !== profile.memberId
        || typeof value.session_binding !== 'string' || value.session_binding !== profile.cacheBinding
        || value.page.id !== decodeURIComponent(resourceKey.split('|')[4])) {
      throw new DOMException('Page snapshot identity does not match', 'SecurityError');
    }
  }
  function commitOperationsAck(resourceKey, snapshot, ids) {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id && id.length <= 1000)) {
      return Promise.reject(new TypeError('Operation IDs required'));
    }
    const value = copy(snapshot), candidates = [...new Set(ids)];
    if (!value || typeof value.epoch !== 'string' || !value.state?.seen || typeof value.state.seen !== 'object') {
      return Promise.reject(new TypeError('Canonical collaboration snapshot required'));
    }
    return transaction(['profiles', 'meta', 'snapshots', 'operations'], 'readwrite', async tx => {
      const profile = await active(tx);
      if (!matches(profile, resourceKey) || await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) {
        throw new DOMException('Offline profile or resource does not match or was revoked', 'SecurityError');
      }
      requireAckSnapshot(profile, resourceKey, value);
      const selected = await selectSnapshot(tx.objectStore('snapshots'), profile, resourceKey, value);
      requireAckSnapshot(profile, resourceKey, selected);
      const acknowledged = [], operations = tx.objectStore('operations');
      // A stale ACK may use the newer persisted canonical, never a newer RAM
      // view. Crossing epochs cannot prove that the submitted operation lives.
      if (selected?.epoch === value.epoch && selected.state?.seen) for (const id of candidates) {
        if (!Object.hasOwn(selected.state.seen, id)) continue;
        const row = await request(operations.get([resourceKey, id]));
        if (row && (row.operation?._epoch ?? value.epoch) !== selected.epoch) continue;
        if (row) await request(operations.delete([resourceKey, id]));
        acknowledged.push(id);
      }
      return { snapshot: selected, acknowledged };
    });
  }
  function getSnapshot(resourceKey) {
    return scoped(resourceKey, 'snapshots', 'readonly', async store => (await request(store.get(resourceKey)))?.snapshot ?? null, null);
  }
  function listSnapshots(profile) {
    const id = namespace(profile);
    return transaction(['profiles', 'meta', 'snapshots'], 'readonly', async tx => {
      const current = await active(tx);
      if (!current || current.id !== id) return [];
      const records = await request(tx.objectStore('snapshots').index('profileId').getAll(id));
      const snapshots = [];
      for (const { key: resourceKey, snapshot, updatedAt } of records) {
        if (!await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) snapshots.push({ key: resourceKey, snapshot, updatedAt });
      }
      return snapshots;
    });
  }
  function saveDatabase(resourceKey, snapshot) {
    const value = copy(snapshot);
    return scoped(resourceKey, 'databaseSnapshots', 'readwrite', async (store, profile) => {
      const databaseId = decodeURIComponent(resourceKey.split('|')[5]);
      if (!value || value.database?.id !== databaseId || value.workspace_id !== profile.workspaceId
          || value.current_member_id !== profile.memberId || value.session_binding !== profile.cacheBinding) {
        throw new DOMException('Database snapshot identity does not match', 'SecurityError');
      }
      if (!Number.isSafeInteger(value.access_revision) || value.access_revision < 0
          || !Number.isSafeInteger(value.data_revision) || value.data_revision < 0) throw new TypeError('Database revisions required');
      const previous = (await request(store.get(resourceKey)))?.snapshot;
      if (previous && (value.access_revision < previous.access_revision || value.data_revision < previous.data_revision)) return;
      store.put({ key: resourceKey, resourceKey, profileId: profile.id, snapshot: value, updatedAt: Date.now() });
    }, undefined, 'database');
  }
  function getDatabase(resourceKey) {
    return scoped(resourceKey, 'databaseSnapshots', 'readonly', async store => (await request(store.get(resourceKey)))?.snapshot ?? null, null, 'database');
  }
  function listDatabases(profile) {
    const id = namespace(profile);
    return transaction(['profiles', 'meta', 'databaseSnapshots'], 'readonly', async tx => {
      const current = await active(tx);
      if (!current || current.id !== id) return [];
      const records = await request(tx.objectStore('databaseSnapshots').index('profileId').getAll(id));
      const snapshots = [];
      for (const { key: resourceKey, snapshot, updatedAt } of records) {
        if (!await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) snapshots.push({ key: resourceKey, snapshot, updatedAt });
      }
      return snapshots;
    });
  }
  function putOperations(resourceKey, operations) {
    if (!Array.isArray(operations)) return Promise.reject(new TypeError('Operations must be an array'));
    const values = copy(operations);
    return scoped(resourceKey, 'operations', 'readwrite', async (store, profile) => {
      for (const operation of values) {
        if (!operation || typeof operation !== 'object' || typeof operation.id !== 'string' || !operation.id || operation.id.length > 1000) {
          throw new TypeError('Operation ID required');
        }
        // First write wins for an immutable op ID. Two tabs never replace the other's queue.
        if (!await request(store.get([resourceKey, operation.id]))) {
          store.add({ key: resourceKey, id: operation.id, profileId: profile.id, operation: copy(operation) });
        }
      }
    });
  }
  function pendingOperations(resourceKey) {
    return scoped(resourceKey, 'operations', 'readonly', async store => {
      const rows = await request(store.index('key').getAll(resourceKey));
      return rows.map(row => row.operation).sort((a, b) => (a.clock || 0) - (b.clock || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }, []);
  }
  function acknowledge(resourceKey, ids) {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) return Promise.reject(new TypeError('Operation IDs required'));
    return scoped(resourceKey, 'operations', 'readwrite', store => {
      for (const id of ids) store.delete([resourceKey, id]);
    });
  }
  function saveDraft(resourceKey, clientId, draft) {
    identifier(clientId, 'draft client');
    const value = copy(draft);
    return scoped(resourceKey, 'drafts', 'readwrite', (store, profile) => {
      if (value === null) store.delete([resourceKey, clientId]);
      else store.put({ key: resourceKey, clientId, profileId: profile.id, draft: value, updatedAt: Date.now() });
    });
  }
  function getDrafts(resourceKey) {
    return scoped(resourceKey, 'drafts', 'readonly', async store => {
      const rows = await request(store.index('key').getAll(resourceKey));
      return rows.map(({ clientId, draft, updatedAt }) => ({ clientId, draft, updatedAt }));
    }, []);
  }
  function canonical(value) {
    const normalized = JSON.parse(JSON.stringify(value));
    const encode = item => {
      if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
      if (item && typeof item === 'object') return '{' + Object.keys(item).sort().map(name => JSON.stringify(name) + ':' + encode(item[name])).join(',') + '}';
      return JSON.stringify(item);
    };
    return encode(normalized);
  }
  async function profileScoped(profile, mode, callback, fallback) {
    const id = namespace(profile);
    return transaction(STORES, mode, async tx => {
      const current = await active(tx);
      if (!current || current.id !== id) {
        if (mode === 'readwrite') throw new DOMException('Offline profile is expired or does not match', 'SecurityError');
        return fallback;
      }
      return callback(tx, current);
    });
  }
  async function permittedResource(tx, profile, resourceKey) {
    if (!resourceType(profile, resourceKey) || await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) {
      throw new DOMException('Offline resource does not match or was revoked', 'SecurityError');
    }
  }
  async function writeMutations(tx, profile, resourceKey, operations) {
    await permittedResource(tx, profile, resourceKey);
    const store = tx.objectStore('mutations');
    const counterKey = 'mutation-sequence:' + profile.id;
    let sequence = (await request(tx.objectStore('meta').get(counterKey)))?.value || 0;
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object' || typeof operation.id !== 'string' || !operation.id || operation.id.length > 1000) throw new TypeError('Mutation ID required');
      const previous = await request(store.get([profile.id, operation.id]));
      if (previous) {
        if (previous.resourceKey !== resourceKey || canonical(previous.operation) !== canonical(operation)) throw new DOMException('Mutation IDs are immutable', 'ConstraintError');
        continue;
      }
      sequence++;
      if (!Number.isSafeInteger(sequence)) throw new RangeError('Mutation sequence exhausted');
      const now = Date.now();
      store.add({ profileId: profile.id, id: operation.id, resourceKey, operation: copy(operation), status: 'pending', sequence, createdAt: now, updatedAt: now });
    }
    tx.objectStore('meta').put({ id: counterKey, value: sequence });
  }
  async function putMutations(profile, resourceKey, operations) {
    if (!Array.isArray(operations)) throw new TypeError('Mutations must be an array');
    const values = copy(operations);
    await profileScoped(profile, 'readwrite', (tx, current) => writeMutations(tx, current, resourceKey, values));
    mutationsChanged(namespace(profile));
  }
  function putMutation(profile, resourceKey, operation) {
    return putMutations(profile, resourceKey, [operation]);
  }
  function listMutations(profile, filters = {}) {
    return profileScoped(profile, 'readonly', async (tx, current) => {
      const records = await request(tx.objectStore('mutations').index('profileId').getAll(current.id));
      const result = [];
      for (const record of records) {
        if (!resourceType(current, record.resourceKey)) continue;
        const revoked = await request(tx.objectStore('meta').get('revoked-resource:' + record.resourceKey));
        // Own rejected edits remain exportable recovery data; they never replay.
        if (revoked && !PAUSED_MUTATIONS.has(record.status)) continue;
        if (filters.resourceKey && record.resourceKey !== filters.resourceKey) continue;
        if (filters.status && !(Array.isArray(filters.status) ? filters.status : [filters.status]).includes(record.status)) continue;
        result.push(record);
      }
      return result.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }, []);
  }
  function pendingMutations(profile) {
    return listMutations(profile, { status: ['pending', 'deferred'] });
  }
  const MUTATION_STATUSES = new Set(['pending', 'deferred', 'conflict', 'denied', 'invalid', 'paused', 'applied']);
  const PAUSED_MUTATIONS = new Set(['conflict', 'denied', 'invalid', 'paused']);
  function appliedResult(record) {
    return record.status === 'applied' && record.result?.id === record.id
      && record.result.status === 'applied' && record.result.resource_id === record.operation.target_id
      && Number.isSafeInteger(record.result.data_revision) && record.result.data_revision >= 0;
  }
  async function confirmLocalPage(tx, record) {
    if (record.operation.kind !== 'page.create' || !appliedResult(record)) return;
    const local = await request(tx.objectStore('localPages').get(record.resourceKey));
    if (local?.metadata.create_operation_id === record.id) {
      local.metadata.localOnly = false;
      local.metadata.creation_result = copy(record.result ?? null);
      local.updatedAt = Date.now();
      tx.objectStore('localPages').put(local);
    }
  }
  async function updateMutation(profile, id, patch) {
    identifier(id, 'mutation');
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(name => !['status', 'result', 'error'].includes(name))) throw new TypeError('Invalid mutation status update');
    const changes = copy(patch);
    await profileScoped(profile, 'readwrite', async (tx, current) => {
      const store = tx.objectStore('mutations');
      const previous = await request(store.get([current.id, id]));
      if (!previous) return;
      await permittedResource(tx, current, previous.resourceKey);
      const status = changes.status ?? previous.status;
      if (!MUTATION_STATUSES.has(status)) throw new TypeError('Invalid mutation status');
      if ((PAUSED_MUTATIONS.has(previous.status) && ['pending', 'deferred'].includes(status))
          || previous.status === 'applied' && status !== 'applied') throw new DOMException('Reapply requires a new mutation ID', 'InvalidStateError');
      const updated = { ...previous, ...changes, status, updatedAt: Date.now() };
      if (status === 'applied' && !appliedResult(updated)) throw new TypeError('An applied result must match its mutation and resource');
      store.put(updated);
      if (status === 'applied') await confirmLocalPage(tx, updated);
    });
    mutationsChanged(namespace(profile));
  }
  async function acknowledgeMutations(profile, ids) {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new TypeError('Mutation IDs required');
    await profileScoped(profile, 'readwrite', async (tx, current) => {
      const store = tx.objectStore('mutations');
      const records=await request(store.index('profileId').getAll(current.id));
      // Retain accepted immutable predecessors while a queued operation still refers to them.
      // Rewriting dependencies under the same mutation ID would change a lost-ACK retry body.
      const acknowledged=new Set(),dependencies=record=>[...(record.operation.depends_on||[]),...Object.values(record.operation.base_rows||{}).map(base=>base?.after_operation).filter(Boolean)];
      for (const id of ids) {
        const record = await request(store.get([current.id, id]));
        if (!record) continue;
        await permittedResource(tx, current, record.resourceKey);
        if (!appliedResult(record)) throw new DOMException('Only applied mutations can be acknowledged', 'InvalidStateError');
        const kind = resourceType(current, record.resourceKey);
        const cached = await request(tx.objectStore(kind === 'database' ? 'databaseSnapshots' : 'snapshots').get(record.resourceKey));
        const snapshot = cached?.snapshot;
        if (!snapshot || snapshot.workspace_id !== current.workspaceId || snapshot.current_member_id !== current.memberId
            || snapshot.session_binding !== current.cacheBinding || !Number.isSafeInteger(snapshot.data_revision)
            || snapshot.data_revision < record.result.data_revision) {
          throw new DOMException('Cache the canonical snapshot before acknowledging a mutation', 'InvalidStateError');
        }
        await confirmLocalPage(tx, record);
        acknowledged.add(id);
      }
      const retained=new Set(records.filter(record=>!acknowledged.has(record.id)).flatMap(dependencies).filter(id=>acknowledged.has(id)));
      const byId=new Map(records.map(record=>[record.id,record])),pending=[...retained];
      for(let index=0;index<pending.length;index++)for(const id of dependencies(byId.get(pending[index])))if(acknowledged.has(id)&&!retained.has(id)){retained.add(id);pending.push(id);}
      for(const id of acknowledged)if(!retained.has(id))store.delete([current.id,id]);
    });
    mutationsChanged(namespace(profile));
  }
  async function removeMutation(profile, id) {
    identifier(id, 'mutation');
    await profileScoped(profile, 'readwrite', (tx, current) => { tx.objectStore('mutations').delete([current.id, id]); });
    mutationsChanged(namespace(profile));
  }
  function completeClosure(records, ids) {
    if (records.some(record => !ids.has(record.id) && [...(record.operation.depends_on || []),
      ...Object.values(record.operation.base_rows || {}).map(base => base?.after_operation)].some(id => ids.has(id)))) {
      throw new DOMException('Include every dependent mutation before replacing or discarding changes', 'ConstraintError');
    }
  }
  async function replaceMutations(profile, replacements) {
    if (!Array.isArray(replacements) || !replacements.length || replacements.length > 1000) throw new TypeError('Mutation replacements required');
    const values = copy(replacements), pages = [];
    await profileScoped(profile, 'readwrite', async (tx, current) => {
      const store = tx.objectStore('mutations');
      const records = await request(store.index('profileId').getAll(current.id));
      const previousIds = new Set(values.map(value => value.previousId));
      const nextIds = new Set(values.map(value => value.operation?.id));
      if (previousIds.size !== values.length || nextIds.size !== values.length) throw new TypeError('Replacement IDs must be unique');
      completeClosure(records, previousIds);
      for (const value of values) {
        const previous = records.find(record => record.id === value.previousId), operation = value.operation;
        if (!previous || previous.status === 'applied' || !operation || previousIds.has(operation.id)
            || records.some(record => record.id === operation.id)
            || operation.kind !== previous.operation.kind || operation.target_id !== previous.operation.target_id
            || operation.database_id !== previous.operation.database_id
            || (operation.depends_on || []).some(id => previousIds.has(id))
            || Object.values(operation.base_rows || {}).some(base => previousIds.has(base?.after_operation))) {
          throw new DOMException('Reapply requires fresh IDs and matching resources for the complete dependency group', 'InvalidStateError');
        }
        await permittedResource(tx, current, previous.resourceKey);
        if (operation.kind === 'page.create') {
          const local = await request(tx.objectStore('localPages').get(previous.resourceKey));
          if (!local || local.metadata.localOnly !== true || local.metadata.create_operation_id !== previous.id
              || operation.document_epoch !== local.metadata.initial_epoch) throw new DOMException('Page creation identity changed', 'InvalidStateError');
          local.metadata.create_operation_id = operation.id;
          local.updatedAt = Date.now();
          tx.objectStore('localPages').put(local);
          pages.push(previous.resourceKey);
        }
        await writeMutations(tx, current, previous.resourceKey, [operation]);
        store.delete([current.id, previous.id]);
      }
    });
    mutationsChanged(namespace(profile));
    for (const key of pages) localPagesChanged(key);
    return { operationIds: values.map(value => value.operation.id) };
  }
  async function discardMutations(profile, ids) {
    if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string')) throw new TypeError('Mutation IDs required');
    const selected = new Set(ids), pages = [];
    await profileScoped(profile, 'readwrite', async (tx, current) => {
      const store = tx.objectStore('mutations');
      const records = await request(store.index('profileId').getAll(current.id));
      completeClosure(records, selected);
      for (const record of records.filter(record => selected.has(record.id))) {
        if (record.status === 'applied') throw new DOMException('Applied changes require a canonical snapshot acknowledgement', 'InvalidStateError');
        if (record.operation.kind === 'page.create') {
          const local = await request(tx.objectStore('localPages').get(record.resourceKey));
          if (local?.metadata.localOnly === true) {
            if (records.some(other => other.resourceKey === record.resourceKey && !selected.has(other.id))) throw new DOMException('Include every change to this local page', 'ConstraintError');
            tx.objectStore('meta').put({ id: 'revoked-resource:' + record.resourceKey, revokedAt: Date.now() });
            tx.objectStore('snapshots').delete(record.resourceKey);
            tx.objectStore('localPages').delete(record.resourceKey);
            for (const name of ['operations', 'drafts']) await removeIndexed(tx.objectStore(name), record.resourceKey, 'key');
            if (Array.isArray(current.workspace?.pages)) {
              current.workspace.pages = current.workspace.pages.filter(page => page.id !== record.operation.target_id);
              tx.objectStore('profiles').put(current);
            }
            pages.push(record.resourceKey);
          }
        }
        store.delete([current.id, record.id]);
      }
    });
    mutationsChanged(namespace(profile));
    for (const key of pages) { resourcePurged(key); localPagesChanged(key); }
    return { droppedIds: [...selected] };
  }
  async function writeLocalPage(tx, profile, resourceKey, metadata) {
    if (!matches(profile, resourceKey)) throw new DOMException('A page key is required', 'SecurityError');
    await permittedResource(tx, profile, resourceKey);
    if (!metadata || typeof metadata !== 'object' || typeof metadata.initial_epoch !== 'string' || !metadata.initial_epoch
        || typeof metadata.create_operation_id !== 'string' || !metadata.create_operation_id) throw new TypeError('Local page creation metadata required');
    const store = tx.objectStore('localPages');
    const previous = await request(store.get(resourceKey));
    if (previous && (previous.metadata.initial_epoch !== metadata.initial_epoch || previous.metadata.create_operation_id !== metadata.create_operation_id)) throw new DOMException('Local page creation IDs are immutable', 'ConstraintError');
    const value = copy(metadata);
    value.localOnly = previous?.metadata.localOnly === false ? false : true;
    store.put({ key: resourceKey, resourceKey, profileId: profile.id, metadata: value, updatedAt: Date.now() });
  }
  async function saveLocalPage(resourceKey, metadata) {
    const value = copy(metadata);
    await transaction(STORES, 'readwrite', async tx => {
      const profile = await active(tx);
      await writeLocalPage(tx, profile, resourceKey, value);
    });
    localPagesChanged(resourceKey);
  }
  function getLocalPage(resourceKey) {
    return scoped(resourceKey, 'localPages', 'readonly', async store => (await request(store.get(resourceKey)))?.metadata ?? null, null);
  }
  function listLocalPages(profile) {
    return profileScoped(profile, 'readonly', async (tx, current) => {
      const records = await request(tx.objectStore('localPages').index('profileId').getAll(current.id));
      const result = [];
      for (const { key: resourceKey, metadata, updatedAt } of records) {
        if (!await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) result.push({ key: resourceKey, metadata, updatedAt });
      }
      return result;
    }, []);
  }
  async function deleteLocalPage(resourceKey) {
    await scoped(resourceKey, 'localPages', 'readwrite', store => { store.delete(resourceKey); });
    localPagesChanged(resourceKey);
  }
  async function stageLocalPage(profile, resourceKey, { metadata, snapshot, operation }) {
    const value = copy({ metadata, snapshot, operation });
    if (value.operation?.kind !== 'page.create' || value.operation.id !== value.metadata?.create_operation_id
        || value.snapshot?.epoch !== value.metadata.initial_epoch
        || value.operation.target_id !== decodeURIComponent(resourceKey.split('|')[4])
        || value.snapshot.page?.id !== value.operation.target_id) throw new TypeError('Local page staging identities do not match');
    await profileScoped(profile, 'readwrite', async (tx, current) => {
      const staged = await request(tx.objectStore('localPages').get(resourceKey));
      await writeLocalPage(tx, current, resourceKey, value.metadata);
      if (staged?.metadata.localOnly !== false) await writeMutations(tx, current, resourceKey, [value.operation]);
      const previous = await request(tx.objectStore('snapshots').get(resourceKey));
      if (previous && previous.snapshot.epoch !== value.snapshot.epoch) throw new DOMException('Local page epoch already exists', 'ConstraintError');
      if (!previous) tx.objectStore('snapshots').put({ key: resourceKey, profileId: current.id, snapshot: value.snapshot, updatedAt: Date.now() });
    });
    mutationsChanged(namespace(profile));
    localPagesChanged(resourceKey);
  }
  async function stageRecoveryImport(profile, bundle, { isCurrent = () => true, verifiedEditablePageIds = [] } = {}) {
    if (!Array.isArray(verifiedEditablePageIds) || verifiedEditablePageIds.length > 2000
        || !verifiedEditablePageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 160)) throw new TypeError('Invalid verified recovery targets');
    // Caller supplies only targets rechecked against the current server, never imported file fields.
    const verifiedTargets = new Set(verifiedEditablePageIds);
    const check = () => {
      if (typeof isCurrent !== 'function' || isCurrent() !== true) throw new DOMException('Recovery preview is no longer current', 'AbortError');
    };
    check();
    let nodes = 0;
    const inspect = (value, depth = 0, ancestors = new Set()) => {
      if (++nodes > 500000 || depth > 64) throw new RangeError('Recovery staging is too large or deeply nested');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (!value || typeof value !== 'object' || ancestors.has(value)
          || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Recovery staging must contain JSON values');
      const next = new Set(ancestors); next.add(value);
      for (const field of Object.keys(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(field)) throw new TypeError('Unsafe recovery field');
        inspect(value[field], depth + 1, next);
      }
    };
    inspect(bundle);
    if (!bundle || Array.isArray(bundle) || Object.keys(bundle).some(field => !['digest', 'mutations', 'localPages', 'drafts'].includes(field))
        || typeof bundle.digest !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.digest)
        || !['mutations', 'localPages', 'drafts'].every(field => Array.isArray(bundle[field]) && bundle[field].length <= 1000)) throw new TypeError('Invalid recovery staging bundle');
    if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > 64 * 1024 * 1024) throw new RangeError('Recovery staging exceeds its byte limit');
    const value = copy(bundle), id = namespace(profile), pages = [], drafts = [];
    const opFields = new Set(['id', 'kind', 'target_id', 'database_id', 'depends_on', 'body', 'base', 'document_epoch', 'base_rows']);
    const privatePermissions = acl => acl && typeof acl === 'object' && !Array.isArray(acl)
      && Object.keys(acl).length === 4 && Object.keys(acl).every(field => ['default', 'inherit', 'members', 'groups'].includes(field))
      && acl.default === 'private' && acl.inherit === false
      && ['members', 'groups'].every(field => acl[field] && typeof acl[field] === 'object' && !Array.isArray(acl[field]) && Object.keys(acl[field]).length === 0);
    const operations = new Map(), created = new Map(), localPages = new Map(), draftIDs = new Set();
    const fail = message => { throw new DOMException(message, 'ConstraintError'); };
    const resourceID = resourceKey => {
      const parts = resourceKey.split('|'), encoded = parts.at(-1), decoded = decodeURIComponent(encoded);
      if (!decoded || encodeURIComponent(decoded) !== encoded) throw new TypeError('Noncanonical recovery resource key');
      return decoded;
    };
    for (const item of value.mutations) {
      if (!item || Object.keys(item).some(field => !['resourceKey', 'operation'].includes(field))) throw new TypeError('Invalid imported mutation');
      const op = item.operation, kind = resourceType({ id }, item.resourceKey);
      if (!op || Object.keys(op).some(field => !opFields.has(field)) || typeof op.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(op.id)
          || !['page.create', 'page.patch', 'row.create', 'row.patch', 'row.delete'].includes(op.kind)
          || typeof op.target_id !== 'string' || !op.target_id || !op.body || Array.isArray(op.body)
          || !Array.isArray(op.depends_on || []) || (op.depends_on || []).length > 50
          || operations.has(op.id)) throw new TypeError('Invalid fresh recovery mutation');
      const bodyFields = op.kind === 'page.create' ? ['id', 'title', 'icon', 'cover', 'parent_id', 'teamspace_id', 'permissions']
        : op.kind === 'page.patch' ? ['title', 'icon', 'cover', 'favorite']
        : op.kind === 'row.create' ? ['id', 'properties', 'parent_row_id', 'depends_on']
        : op.kind === 'row.patch' ? ['properties', 'parent_row_id', 'depends_on'] : [];
      if (Object.keys(op.body).some(field => !bodyFields.includes(field))) throw new TypeError('Recovery mutations cannot import authority or receipts');
      if (op.kind === 'page.create' && !privatePermissions(op.body.permissions)) throw new TypeError('Recovered pages must use fixed private permissions');
      if (kind !== (op.kind.startsWith('page.') ? 'page' : 'database') || resourceID(item.resourceKey) !== (kind === 'page' ? op.target_id : op.database_id)) throw new DOMException('Recovery mutation scope does not match', 'SecurityError');
      if (op.kind.endsWith('.create')) {
        if (created.has(op.target_id) || op.body.id !== op.target_id) fail('Recovery creation IDs must be new and unique');
        created.set(op.target_id, op);
      }
      operations.set(op.id, item);
    }
    const dependencies = op => [...(op.depends_on || []), ...Object.values(op.base_rows || {}).map(base => base?.after_operation).filter(Boolean)];
    const visited = new Set(), visiting = new Set();
    const visit = identity => {
      if (visiting.has(identity)) fail('Recovery dependencies contain a cycle');
      if (visited.has(identity)) return;
      const item = operations.get(identity); if (!item) fail('Recovery dependencies must be complete and fresh');
      visiting.add(identity);
      for (const dependency of dependencies(item.operation)) visit(dependency);
      visiting.delete(identity); visited.add(identity);
    };
    for (const identity of operations.keys()) visit(identity);
    const ancestors = op => {
      const result = new Set(), pending = [...dependencies(op)];
      while (pending.length) { const identity = pending.pop(); if (result.has(identity)) continue; result.add(identity); pending.push(...dependencies(operations.get(identity).operation)); }
      return result;
    };
    for (const { operation: op } of value.mutations) {
      const references = [op.body.parent_id, op.body.parent_row_id, ...(op.body.depends_on || [])];
      for (const [field, property] of Object.entries(op.base?.schema || {})) {
        if (property?.type === 'relation') references.push(...(Array.isArray(op.body.properties?.[field]) ? op.body.properties[field] : [op.body.properties?.[field]]));
      }
      const previous = ancestors(op);
      for (const target of references) if (created.has(target) && !previous.has(created.get(target).id)) fail('Imported references require their complete creation dependencies');
    }
    for (const item of value.localPages) {
      if (!item || Object.keys(item).some(field => !['resourceKey', 'metadata', 'snapshot', 'operations', 'drafts'].includes(field))
          || !matches({ id }, item.resourceKey) || localPages.has(item.resourceKey)) throw new TypeError('Invalid imported local page');
      const metadata = item.metadata, snapshot = item.snapshot, target = resourceID(item.resourceKey), create = created.get(target);
      const pageFields = new Set(['id', 'title', 'icon', 'cover', 'parent_id', 'teamspace_id', 'permissions', 'owner_id', 'access_level', 'revision', 'blocks', 'locked', 'archived', 'favorite', 'created_at', 'updated_at']);
      if (!metadata || Object.keys(metadata).some(field => !['page', 'initial_epoch', 'create_operation_id', 'localOnly'].includes(field))
          || !create || create.kind !== 'page.create' || metadata.create_operation_id !== create.id || metadata.localOnly !== true
          || typeof metadata.initial_epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata.initial_epoch)
          || create.document_epoch !== metadata.initial_epoch || snapshot?.epoch !== metadata.initial_epoch || snapshot.seq !== 0
          || snapshot.workspace_id !== profile.workspaceId || snapshot.current_member_id !== profile.memberId
          || snapshot.session_binding !== (profile.session?.cache_binding || profile.cacheBinding)
          || snapshot.page?.id !== target || metadata.page?.id !== target || metadata.page.owner_id !== profile.memberId
          || Object.keys(metadata.page).some(field => !pageFields.has(field)) || Object.keys(snapshot.page).some(field => !pageFields.has(field))
          || metadata.page.revision !== 0 || !Array.isArray(metadata.page.blocks) || metadata.page.blocks.length
          || metadata.page.access_level !== 4 || metadata.page.locked !== false || metadata.page.archived !== false
          || snapshot.access_level !== 4 || snapshot.page.owner_id !== profile.memberId || snapshot.page.access_level !== 4
          || snapshot.page.locked !== false || snapshot.page.archived !== false || snapshot.page.revision !== 0
          || !Array.isArray(snapshot.blocks) || snapshot.blocks.length || !Array.isArray(snapshot.page.blocks) || snapshot.page.blocks.length
          || !Array.isArray(item.operations) || item.operations.length > 10000 || !Array.isArray(item.drafts)
          || !globalThis.FountainCollaboration || canonical(snapshot.state) !== canonical(FountainCollaboration.seedState([]))) throw new TypeError('Recovery local page requires a matching empty creation seed');
      for (const field of ['id', 'title', 'icon', 'cover', 'parent_id', 'teamspace_id', 'permissions']) if (Object.hasOwn(create.body, field) && canonical(create.body[field]) !== canonical(metadata.page[field])) fail('Recovery page metadata differs from creation');
      if (!privatePermissions(metadata.page.permissions) || !privatePermissions(snapshot.page.permissions)) throw new TypeError('Recovery page snapshots must retain fixed private permissions');
      let state = snapshot.state;
      const bodyIDs = new Set();
      for (let offset = 0; offset < item.operations.length; offset += 1000) {
        const batch = item.operations.slice(offset, offset + 1000).map(operation => {
          if (operation._epoch !== metadata.initial_epoch || bodyIDs.has(operation.id)) fail('Recovery body operations require fresh identities in the new epoch');
          bodyIDs.add(operation.id); const wire = { ...operation }; delete wire._epoch; return wire;
        });
        state = FountainCollaboration.applyOperations(state, batch);
      }
      if (FountainCollaboration.project(state).length > 2000) throw new RangeError('Recovery page contains too many blocks');
      localPages.set(item.resourceKey, item); pages.push(target);
      for (const draft of item.drafts) drafts.push({ resourceKey: item.resourceKey, ...draft });
    }
    for (const item of value.mutations) if (item.operation.kind === 'page.create' && !localPages.has(item.resourceKey)) fail('Every imported page creation requires its matching local document');
    drafts.push(...value.drafts);
    if (drafts.length > 2000 || !operations.size && !drafts.length) throw new TypeError('Recovery bundle has no staged work or too many drafts');
    for (const draft of drafts) {
      if (!draft || Object.keys(draft).some(field => !['resourceKey', 'clientId', 'draft'].includes(field)) || !matches({ id }, draft.resourceKey)
          || typeof draft.clientId !== 'string' || !draft.clientId || draft.clientId.length > 1000 || !draft.draft || Array.isArray(draft.draft)) throw new TypeError('Invalid imported recovery draft');
      const identity = canonical([draft.resourceKey, draft.clientId]);
      if (draftIDs.has(identity)) fail('Recovery draft IDs must be unique');
      draftIDs.add(identity);
    }
    let imported = false;
    const result = await profileScoped(profile, 'readwrite', async (tx, current) => {
      const currentCheck = () => {
        check();
        if (current.validUntil <= Date.now() || current.session.authenticated !== true || current.session.member?.id !== current.memberId
            || current.session.member?.active === false || pages.length && current.session.member?.role === 'guest') throw new DOMException('A current recovery login is required', 'SecurityError');
      };
      currentCheck();
      const read = async operation => { const result = await request(operation); currentCheck(); return result; };
      if (await read(tx.objectStore('meta').get('revoked:' + id))) throw new DOMException('Recovery login was revoked', 'SecurityError');
      const receiptID = 'recovery-import:' + id + ':' + value.digest;
      const receipt = await read(tx.objectStore('meta').get(receiptID));
      if (receipt) {
        if (receipt.profileId !== id || receipt.digest !== value.digest || !['operationIds', 'pageIds', 'draftKeys'].every(field => Array.isArray(receipt[field]))) fail('Recovery import receipt is malformed');
        return { duplicate: true, operationIds: copy(receipt.operationIds), pageIds: copy(receipt.pageIds), draftKeys: copy(receipt.draftKeys) };
      }
      for (const resourceKey of new Set([...value.mutations.map(item => item.resourceKey), ...localPages.keys(), ...drafts.map(item => item.resourceKey)])) {
        await permittedResource(tx, current, resourceKey); check();
      }
      const existing = await read(tx.objectStore('mutations').index('profileId').getAll(id));
      const snapshots = await read(tx.objectStore('snapshots').index('profileId').getAll(id));
      const databases = await read(tx.objectStore('databaseSnapshots').index('profileId').getAll(id));
      const existingEpochs = new Set(snapshots.map(row => row.snapshot?.epoch));
      for (const draft of drafts) if (!localPages.has(draft.resourceKey)
          && !current.workspace?.pages?.some(page => page.id === resourceID(draft.resourceKey))
          && !snapshots.some(row => row.key === draft.resourceKey)
          && !verifiedTargets.has(resourceID(draft.resourceKey))) throw new DOMException('Recovery draft requires a current target page', 'SecurityError');
      for (const item of value.mutations) {
        const op = item.operation;
        if (existing.some(row => row.id === op.id)) fail('Recovery operation ID already exists');
        if (op.kind.endsWith('.create') && (existing.some(row => row.operation?.target_id === op.target_id)
            || current.workspace?.pages?.some(page => page.id === op.target_id)
            || snapshots.some(row => row.snapshot?.page?.id === op.target_id)
            || databases.some(row => row.snapshot?.rows?.some(candidate => candidate.id === op.target_id)))) fail('Recovery target already exists');
      }
      for (const [resourceKey, item] of localPages) {
        if (existingEpochs.has(item.metadata.initial_epoch)) fail('Recovery document epoch already exists');
        existingEpochs.add(item.metadata.initial_epoch);
        for (const name of ['snapshots', 'localPages']) if (await read(tx.objectStore(name).get(resourceKey))) fail('Recovery document already exists');
        for (const name of ['operations', 'drafts']) if ((await read(tx.objectStore(name).index('key').getAllKeys(resourceKey))).length) fail('Recovery document already has local edits');
      }
      for (const draft of drafts) if (await read(tx.objectStore('drafts').get([draft.resourceKey, draft.clientId]))) fail('Recovery draft already exists');
      const counterID = 'mutation-sequence:' + id;
      let sequence = (await read(tx.objectStore('meta').get(counterID)))?.value || 0;
      const now = Date.now();
      for (const item of value.mutations) {
        currentCheck(); if (!Number.isSafeInteger(++sequence)) throw new RangeError('Mutation sequence exhausted');
        await read(tx.objectStore('mutations').add({ profileId: id, id: item.operation.id, resourceKey: item.resourceKey,
          operation: item.operation, status: 'paused', sequence, createdAt: now, updatedAt: now }));
      }
      for (const [resourceKey, item] of localPages) {
        currentCheck(); await read(tx.objectStore('localPages').add({ key: resourceKey, resourceKey, profileId: id, metadata: item.metadata, updatedAt: now }));
        await read(tx.objectStore('snapshots').add({ key: resourceKey, profileId: id, snapshot: item.snapshot, updatedAt: now }));
        for (const operation of item.operations) await read(tx.objectStore('operations').add({ key: resourceKey, id: operation.id, profileId: id, operation }));
      }
      for (const draft of drafts) { currentCheck(); await read(tx.objectStore('drafts').add({ key: draft.resourceKey, clientId: draft.clientId, profileId: id, draft: draft.draft, updatedAt: now })); }
      const result = { operationIds: [...operations.keys()], pageIds: pages, draftKeys: drafts.map(draft => [draft.resourceKey, draft.clientId]) };
      currentCheck(); await read(tx.objectStore('meta').put({ id: counterID, value: sequence }));
      await read(tx.objectStore('meta').add({ id: receiptID, profileId: id, digest: value.digest, ...result, createdAt: now }));
      currentCheck(); imported = true; return { duplicate: false, ...result };
    });
    if (imported) {
      mutationsChanged(id, true, true);
      for (const resourceKey of localPages.keys()) localPagesChanged(resourceKey);
    }
    return result;
  }
  function removeIndexed(store, value, index = 'profileId') {
    return new Promise((resolve, reject) => {
      const cursor = store.index(index).openCursor(IDBKeyRange.only(value));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) { resolve(); return; }
        store.delete(cursor.result.primaryKey);
        cursor.result.continue();
      };
    });
  }
  async function purge(tx, profileId) {
    for (const name of STORES.filter(name => !['profiles', 'meta'].includes(name))) await removeIndexed(tx.objectStore(name), profileId);
    tx.objectStore('profiles').delete(profileId);
    await new Promise((resolve, reject) => {
      const cursor = tx.objectStore('meta').openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) { resolve(); return; }
        if (cursor.result.value.id.startsWith('recovery-import:' + profileId + ':')) tx.objectStore('meta').delete(cursor.result.primaryKey);
        cursor.result.continue();
      };
    });
    const pointer = await request(tx.objectStore('meta').get(pointerKey()));
    if (pointer?.profileId === profileId) tx.objectStore('meta').delete(pointerKey());
  }
  const logoutChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fountain-offline') : null;
  function announce(profileId, broadcast = true, detail = {}) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-profile-cleared', { detail: { ...detail,profileId } }));
    if (broadcast) logoutChannel?.postMessage({ ...detail,type: 'profile-cleared', profileId });
  }
  function profileChanged(profileId, broadcast = true, suspendedProfileId = null, scope = {}) {
    if(suspendedProfileId)suspendedHere.add(suspendedProfileId);
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-profile-changed', { detail: { ...scope, profileId, ...(suspendedProfileId?{suspendedProfileId}:{}) } }));
    if (broadcast) logoutChannel?.postMessage({ ...scope, type: 'profile-changed', profileId, ...(suspendedProfileId?{suspendedProfileId}:{}) });
  }
  function resourcePurged(resourceKey, broadcast = true) {
    const parts = resourceKey.split('|'), kind = parts.length === 6 && parts[4] === 'database' ? 'database' : 'page';
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-resource-purged', { detail: { key: resourceKey, kind } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'resource-purged', key: resourceKey });
  }
  function mutationsChanged(profileId, broadcast = true, recoveryImport = false) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-mutations-changed', { detail: { profileId, ...(recoveryImport ? { recoveryImport: true } : {}) } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'mutations-changed', profileId, ...(recoveryImport ? { recoveryImport: true } : {}) });
  }
  function localPagesChanged(resourceKey, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-local-pages-changed', { detail: { key: resourceKey } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'local-pages-changed', key: resourceKey });
  }
  if (logoutChannel) logoutChannel.onmessage = event => {
    if (event.data?.type === 'profile-cleared' && typeof event.data.profileId === 'string') announce(event.data.profileId, false,event.data);
    if (event.data?.type === 'resource-purged' && typeof event.data.key === 'string') resourcePurged(event.data.key, false);
    if (event.data?.type === 'profile-changed' && (typeof event.data.profileId === 'string'||event.data.profileId===null)) { if (!event.data.accountBinding || selected?.accountBinding === event.data.accountBinding && selected?.workspaceId === event.data.workspaceId) profileChanged(event.data.profileId, false,event.data.suspendedProfileId,event.data); }
    if (event.data?.type === 'mutations-changed' && typeof event.data.profileId === 'string') mutationsChanged(event.data.profileId, false, event.data.recoveryImport === true);
    if (event.data?.type === 'local-pages-changed' && typeof event.data.key === 'string') localPagesChanged(event.data.key, false);
  };
  async function purgeResource(resourceKey) {
    await transaction(STORES, 'readwrite', async tx => {
      const profile = await active(tx);
      const kind = resourceType(profile, resourceKey);
      if (!kind) throw new DOMException('Offline profile does not match', 'SecurityError');
      // Durable fence: another tab's late network response cannot recreate this resource.
      tx.objectStore('meta').put({ id: 'revoked-resource:' + resourceKey, revokedAt: Date.now() });
      tx.objectStore('snapshots').delete(resourceKey);
      tx.objectStore('databaseSnapshots').delete(resourceKey);
      tx.objectStore('localPages').delete(resourceKey);
      for (const [name, index] of [['operations', 'key'], ['drafts', 'key']]) {
        await new Promise((resolve, reject) => {
          const cursor = tx.objectStore(name).index(index).openCursor(IDBKeyRange.only(resourceKey));
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            if (!cursor.result) { resolve(); return; }
            tx.objectStore(name).delete(cursor.result.primaryKey);
            cursor.result.continue();
          };
        });
      }
      await new Promise((resolve, reject) => {
        const cursor = tx.objectStore('mutations').index('resourceKey').openCursor(IDBKeyRange.only(resourceKey));
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          if (!cursor.result) { resolve(); return; }
          const record = cursor.result.value;
          tx.objectStore('mutations').put({ ...record, status: 'denied', recovery: { reason: 'resource_revoked', at: Date.now() }, updatedAt: Date.now() });
          cursor.result.continue();
        };
      });
      const collection = kind === 'database' ? 'databases' : 'pages';
      if (Array.isArray(profile.workspace?.[collection])) {
        const resourceId = decodeURIComponent(resourceKey.split('|').at(-1));
        profile.workspace[collection] = profile.workspace[collection].filter(resource => resource.id !== resourceId);
        tx.objectStore('profiles').put(profile);
      }
    });
    resourcePurged(resourceKey);
    mutationsChanged(resourceKey.split('|').slice(0, 4).join('|'));
    if (resourceKey.split('|').length === 5) localPagesChanged(resourceKey);
  }
  async function purgeActor(tx, profileId) {
    const prefix = profileId.split('|').slice(0, 3).join('|') + '|';
    const ids=new Set([profileId]);await new Promise((resolve,reject)=>{const op=tx.objectStore('profiles').openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));op.onerror=()=>reject(op.error);op.onsuccess=()=>{if(!op.result){resolve();return;}ids.add(op.result.primaryKey);op.result.continue();};});
    for (const id of ids) {
      tx.objectStore('meta').put({ id: 'revoked:' + id, revokedAt: Date.now() });
      await purge(tx, id);
    }
    return [...ids];
  }
  async function clearProfile(profile) {
    const id = namespace(profile);
    await transaction(STORES, 'readwrite', async tx => {
      tx.objectStore('meta').put({ id: 'revoked:' + id, revokedAt: Date.now() });
      await purge(tx, id);
    });
    announce(id);
  }
  async function clearActiveProfile(profile) {
    const result=await transaction(STORES,'readwrite',async tx=>{const pointer=await request(tx.objectStore('meta').get(pointerKey())),last=await request(tx.objectStore('meta').get(lastKey()));const id=profile?namespace(profile):pointer?.profileId||last?.profileId;if(!id)return null;const profileIds=await purgeActor(tx,id);if(last&&profileIds.includes(last.profileId))tx.objectStore('meta').delete(lastKey());return{profileId:id,profileIds,scope:'actor',actorPrefix:id.split('|').slice(0,3).join('|')+'|'};});if(result)announce(result.profileId,true,result);
  }
  const serviceWorkerReady = !globalThis.FountainTransport?.native && globalThis.isSecureContext && 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);
  globalThis.FountainOffline = Object.freeze({ available: !!globalThis.indexedDB,
    key, databaseKey, saveProfile, getProfile, selectWorkspace, offlineWorkspaces, offlineWorkspace, workspaceProfile, parkProfile, workspaceInput, clearWorkspaceInput, endAccount, saveSnapshot, getSnapshot, listSnapshots,
    saveDatabase, getDatabase, listDatabases, putMutation, putMutations, listMutations, pendingMutations,
    updateMutation, acknowledgeMutations, removeMutation, replaceMutations, discardMutations, stageLocalPage, stageRecoveryImport,
    saveLocalPage, getLocalPage, listLocalPages, deleteLocalPage,
    putOperations, pendingOperations, acknowledge, commitOperationsAck, saveDraft, getDrafts,
    suspendProfile,suspendActiveProfile,listRecoveryProfiles,readRecoveryProfile,clearProfile, clearActiveProfile, purgeResource, serviceWorkerReady });
})();
