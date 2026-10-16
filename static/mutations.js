/* Durable resource mutations. Canonical data and optimistic changes stay separate. */
(() => {
  'use strict';
  const ACTIVE = new Set(['pending', 'deferred', 'applied']);
  const PAUSED = new Set(['conflict', 'denied', 'invalid', 'paused']);
  const PAGE_FIELDS = ['title', 'icon', 'cover', 'favorite'];
  const ROW_FIELDS = ['parent_row_id', 'depends_on'];
  const ARCHIVE_TARGETS=Symbol('archive targets');
  const preparedImports = new WeakMap();
  const copy = value => structuredClone(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const uuid = () => { if(crypto.randomUUID)return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-'); };
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value ?? null);
  }
  const same = (left, right) => canonical(left) === canonical(right);
  const retryable = error => !error.status || error.status >= 500 || error.status === 429;
  function failure(message, status = 400, code) { const error = new Error(message); error.status = status; if (code) error.code = code; return error; }
  function require(condition, message, status = 400, code) { if (!condition) throw failure(message, status, code); }
  function identity(value) { require(typeof value === 'string' && Array.from(value).length > 0 && Array.from(value).length <= 160 && !/[\\/\u0000-\u001f\u007f]/.test(value) && !Array.from(value).some(point => point.codePointAt(0) >= 0xd800 && point.codePointAt(0) <= 0xdfff) && !['.', '..'].includes(value), '올바른 리소스 식별자가 필요합니다.'); return value; }
  function dependencies(operation) {
    return [...new Set([...(operation.depends_on || []), ...Object.values(operation.base_rows || {}).map(value => value.after_operation).filter(Boolean)])];
  }
  function subtree(rows, id) {
    const selected = new Set([id]); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (row.parent_row_id && selected.has(row.parent_row_id) && !selected.has(row.id)) { selected.add(row.id); changed = true; } }
    return rows.filter(row => selected.has(row.id));
  }
  class Controller {
    constructor({ profile, onChange = () => {}, onDenied = () => {}, onError = () => {} }) {
      require(profile?.id && globalThis.FountainOffline && globalThis.FountainTransport, '오프라인 저장소와 연결 프로필이 필요합니다.');
      this.profile = copy(profile); this.offline = FountainOffline; this.transport = FountainTransport;
      this.onChange = onChange; this.onDenied = onDenied; this.onError = onError;
      preparedImports.set(this,new Map()); this.importBusy=0; this.importResume=false; this.importResumeAt=Infinity; this.scheduled=false; this.scheduledAt=0;
      this.closed = false; this.writing = 0; this.requests = new Set(); this.workspaceSource = copy(profile.workspace || {}); this.pages = new Map(); this.delay = 1000;
      this.online = () => this.sync().catch(error => this.report(error));
      this.queueChanged = event => { if (!this.closed && event.detail?.profileId === this.profile.id && !this.writing) { this.changed({ reason: event.detail?.recoveryImport ? 'recovery-import' : 'queue' }).catch(error => this.report(error)); if(!event.detail?.recoveryImport)this.schedule(); } };
      this.profileCleared = event => { if (!this.closed && (event.detail?.profileId === this.profile.id||event.detail?.profileIds?.includes(this.profile.id))) { this.close(); this.denied({ status: 401, kind: 'session', message: '로그인이 종료되었습니다.' }); } };
      this.profileChanged = async () => { const current = await this.offline.getProfile().catch(() => null); if (!this.closed && current?.id !== this.profile.id) { this.close(); this.denied({ status: 401, kind: 'session', switched: true,suspended:true, message: '다른 로그인으로 전환되었습니다.' }); } };
      addEventListener('online', this.online); addEventListener('fountain-offline-mutations-changed', this.queueChanged);
      addEventListener('fountain-offline-profile-cleared', this.profileCleared); addEventListener('fountain-offline-profile-changed', this.profileChanged);
      this.schedule();
    }
    report(error) { if (this.closed || error?.name === 'AbortError' || error?.code === 'STALE_CONTROLLER') return; try { this.onError(error); } catch { /* UI errors cannot undo an already durable change. */ } }
    async denied(detail) { try { await this.onDenied(detail); } catch { /* Keep authorization decisions independent of rendering. */ } }
    async guard() {
      require(!this.closed, '이 연결은 종료되었습니다.', 401, 'STALE_CONTROLLER');
      const current = await this.offline.getProfile();
      if (!current || current.id !== this.profile.id) { const error=failure('로그인이 변경되었습니다.',401,'STALE_CONTROLLER');await this.loseSession(error,true);throw error; }
      require(!this.closed, '이 연결은 종료되었습니다.', 401, 'STALE_CONTROLLER'); return current;
    }
    bound(value, session = false) {
      return value?.workspace_id === this.profile.workspaceId && (session ? value.member?.id : value.current_member_id) === this.profile.memberId
        && (session ? value.cache_binding : value.session_binding) === this.profile.cacheBinding;
    }
    async write(callback) { this.writing++; try { await this.guard(); const result = await callback(); await this.guard(); return result; } finally { this.writing--; } }
    async request(path, body, method) {
      await this.guard(); const abort = new AbortController(); this.requests.add(abort);
      try {
        const response = await this.transport.request('/api' + path, { method: method || (body === undefined ? 'GET' : 'POST'), signal: abort.signal,
          headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const value = await response.json().catch(() => ({ error: '서버 응답을 읽을 수 없습니다.' })); await this.guard();
        if (!response.ok) { const error = failure(typeof value.error === 'string' ? value.error : '변경을 동기화하지 못했습니다.', response.status); error.data = value; throw error; }
        return value;
      } finally { this.requests.delete(abort); }
    }
    async loseSession(error, switched = false) {
      if (this.closed) return;
      this.close(); await this.denied({ status: error.status || 401, kind: 'session', switched, suspended:true, message: error.message });
      await this.offline.suspendProfile(this.profile);
    }
    async authenticate() {
      let session;
      try { session = await this.request('/session'); }
      catch (error) { if ([401, 403].includes(error.status)) await this.loseSession(error); throw error; }
      if (!session.authenticated || !this.bound(session, true)) {
        const error = failure('로그인 또는 워크스페이스가 변경되었습니다.', session.authenticated ? 403 : 401, 'SESSION_CHANGED');
        await this.loseSession(error, !!session.authenticated); throw error;
      }
      this.profile.session = copy(session);
      return session;
    }
    async records() { await this.guard(); return this.offline.listMutations(this.profile); }
    async changed(detail = {}) { if (this.closed) return; const records = await this.records(); if (!this.closed) { try { this.onChange({ ...detail, records }); } catch (error) { this.report(error); } } }
    schedule(delay = 180) {
      clearTimeout(this.timer); this.scheduled=false; if (this.closed || !navigator.onLine) return;
      if(this.importBusy){this.importResume=true;this.importResumeAt=Math.min(this.importResumeAt,Date.now()+delay);return;}
      this.scheduled=true; this.scheduledAt=Date.now()+delay; this.timer = setTimeout(async () => { this.scheduled=false; try { if ((await this.records()).some(record => ACTIVE.has(record.status))) await this.sync(); } catch (error) { this.report(error); } }, delay);
    }
    retry() { if (!this.closed) { this.schedule(this.delay); this.delay = Math.min(30000, this.delay * 2); } }
    async canonicalDatabase(id) {
      identity(id); const key = this.offline.databaseKey(this.profile, id);
      try {
        const value = await this.request('/databases/' + encodeURIComponent(id));
        require(this.bound(value) && value.database?.id === id, '다른 로그인에서 도착한 데이터베이스입니다.', 403, 'SESSION_CHANGED');
        await this.write(() => this.offline.saveDatabase(key, copy(value)));
        const durable = await this.offline.getDatabase(key); await this.guard();
        require(durable && this.bound(durable), '데이터베이스 접근 상태가 변경되었습니다.', 403); return durable;
      } catch (error) {
        if (error.code === 'SESSION_CHANGED' || error.status === 401) await this.loseSession(error, error.code === 'SESSION_CHANGED');
        else if ([403, 404].includes(error.status)) { await this.write(() => this.offline.purgeResource(key)); this.denied({ status: error.status, kind: 'database', databaseId: id, resourceKey: key, message: error.message }); }
        throw error;
      }
    }
    async canonicalPage(id) {
      identity(id); const key = this.offline.key(this.profile, id);
      const local = await this.offline.getLocalPage(key); await this.guard();
      require(local?.localOnly !== true, '서버에 새 문서가 생성될 때까지 기기에 보관합니다.', 425, 'LOCAL_PAGE_PENDING');
      try {
        const value = await this.request('/pages/' + encodeURIComponent(id) + '/collaboration');
        require(this.bound(value) && value.page?.id === id, '다른 로그인에서 도착한 문서입니다.', 403, 'SESSION_CHANGED');
        await this.write(() => this.offline.saveSnapshot(key, copy(value)));
        const durable = await this.offline.getSnapshot(key); await this.guard();
        require(durable && this.bound(durable), '문서 접근 상태가 변경되었습니다.', 403);
        this.pages.set(id, copy(durable));
        if (local) await this.write(() => this.offline.saveLocalPage(key, { ...local, page: copy(durable.page), canonical_data_revision: durable.data_revision, canonical_access_revision: durable.access_revision }));
        return durable;
      } catch (error) {
        if (error.code === 'SESSION_CHANGED' || error.status === 401) await this.loseSession(error, error.code === 'SESSION_CHANGED');
        else if ([403, 404].includes(error.status)) { await this.write(() => this.offline.purgeResource(key)); this.denied({ status: error.status, kind: 'page', pageId: id, resourceKey: key, message: error.message }); }
        throw error;
      }
    }
    projectDatabase(canonicalSnapshot, records) {
      const snapshot = copy(canonicalSnapshot), rows = new Map(snapshot.rows.map(row => [row.id, row])); let pending = false;
      const id = snapshot.database.id;
      for (const record of records) {
        const operation = record.operation; if (!ACTIVE.has(record.status) || operation.database_id !== id) continue;
        if (record.status === 'applied' && this.proof(snapshot, record)) continue;
        pending = true; const body = operation.body || {}, row = rows.get(operation.target_id);
        if (operation.kind === 'row.create') {
          if (!row) rows.set(operation.target_id, { id: operation.target_id, database_id: id, owner_id: this.profile.memberId, properties: copy(body.properties || {}), parent_row_id: body.parent_row_id || null,
            depends_on: copy(body.depends_on || []), access_level: 3, created_at: new Date(record.createdAt).toISOString(), updated_at: record.result?.updated_at || new Date(record.createdAt).toISOString(), offline_pending: true });
        } else if (operation.kind === 'row.patch' && row) {
          row.properties = Object.assign(Object.create(null), row.properties || {}, copy(body.properties || {})); for (const field of ROW_FIELDS) if (own(body, field)) row[field] = copy(body[field]);
          row.offline_pending = true; if (record.result?.updated_at) row.updated_at = record.result.updated_at;
        } else if (operation.kind === 'row.delete') for (const target of Object.keys(operation.base_rows || { [operation.target_id]: {} })) rows.delete(target);
      }
      const computed = snapshot.database.properties.some(property => ['formula', 'rollup'].includes(property.type));
      snapshot.rows = [...rows.values()].map(row => pending && computed ? { ...row, computed_pending: true } : row);
      snapshot.offline_pending = pending; snapshot.computed_pending = pending && computed; return snapshot;
    }
    async loadDatabase(id, { remote = true } = {}) {
      await this.guard(); identity(id); const key = this.offline.databaseKey(this.profile, id); let snapshot;
      if (remote && navigator.onLine) {
        try { snapshot = await this.canonicalDatabase(id); }
        catch (error) { if (error.status || error.name === 'SecurityError' || this.closed) throw error; }
      }
      if (!snapshot) snapshot = await this.offline.getDatabase(key);
      require(snapshot, '이 데이터베이스는 아직 기기에 저장되지 않았습니다.', 0, 'OFFLINE_MISS');
      await this.guard(); return this.projectDatabase(snapshot, await this.records());
    }
    async editDatabase(id) {
      let snapshot; try { snapshot = await this.loadDatabase(id, { remote: false }); }
      catch (error) { if (error.code !== 'OFFLINE_MISS' || !navigator.onLine) throw error; snapshot = await this.loadDatabase(id); }
      return snapshot;
    }
    schema(database, values) {
      const result = Object.create(null), properties = new Map(database.properties.map(property => [property.id, property]));
      for (const [id, value] of Object.entries(values)) {
        const property = properties.get(id); require(property && !['formula', 'rollup'].includes(property.type), '계산 속성이나 삭제된 속성은 변경할 수 없습니다.');
        if (value !== null) {
          if (property.type === 'number') require(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15, '숫자 속성을 확인해 주세요.');
          else if (property.type === 'checkbox') require(typeof value === 'boolean', '체크박스 값을 확인해 주세요.');
          else if (['multi_select', 'relation', 'files'].includes(property.type)) require(Array.isArray(value) && value.length <= 1000, '목록 속성을 확인해 주세요.');
          else if (property.type === 'date') require(typeof value === 'string' || value && typeof value === 'object' && !Array.isArray(value), '날짜 값을 확인해 주세요.');
          else require(typeof value === 'string' && value.length <= 100000, '문자열 속성을 확인해 주세요.');
        }
        result[id] = copy(property);
      }
      return result;
    }
    latest(records, target, databaseId) { return records.filter(record => ACTIVE.has(record.status) && record.operation.target_id === target && (databaseId === undefined || record.operation.database_id === databaseId)).at(-1); }
    rowDependencies(records, database, body, target) {
      const ids = new Set(); const add = (id, db = database.id) => { const previous = id && this.latest(records, id, db); if (previous) ids.add(previous.id); };
      add(target); add(body.parent_row_id); for (const id of body.depends_on || []) add(id);
      for (const property of database.properties) if (property.type === 'relation' && Array.isArray(body.properties?.[property.id])) for (const id of body.properties[property.id]) {
        const record = records.filter(value => ACTIVE.has(value.status) && value.operation.target_id === id && value.operation.kind === 'row.create').at(-1); if (record) ids.add(record.id);
      }
      require(ids.size <= 50, '먼저 연결된 변경을 동기화한 뒤 다시 시도해 주세요.'); return [...ids];
    }
    async enqueue(resourceKey, operation) {
      await this.write(() => this.offline.putMutation(this.profile, resourceKey, operation));
      await this.changed({ reason: 'queued', databaseIds: operation.database_id ? [operation.database_id] : [], pageIds: operation.kind.startsWith('page.') ? [operation.target_id] : [] }); this.schedule(); return operation;
    }
    async createRow(databaseId, body, { schema } = {}) {
      await this.guard(); const snapshot = await this.editDatabase(databaseId);
      require(snapshot.database.can_create_row ?? snapshot.database.access_level >= 3, '새 항목을 만들 권한이 없습니다.', 403);
      const target = identity(body.id || uuid()); require(!snapshot.rows.some(row => row.id === target), '이미 사용 중인 항목 식별자입니다.', 409);
      const values = copy(body.properties || body.values || {}), payload = { id: target, properties: values };
      for (const field of ROW_FIELDS) if (own(body, field)) payload[field] = copy(body[field]);
      const records = await this.records(), operation = { id: uuid(), kind: 'row.create', target_id: target, database_id: databaseId, body: payload,
        base: { schema: this.schema({ ...snapshot.database, properties: schema || snapshot.database.properties }, values) }, depends_on: this.rowDependencies(records, snapshot.database, payload, target) };
      await this.enqueue(this.offline.databaseKey(this.profile, databaseId), operation);
      return (await this.loadDatabase(databaseId, { remote: false })).rows.find(row => row.id === target);
    }
    async patchRow(databaseId, rowId, body, { baseline, schema } = {}) {
      identity(rowId); const snapshot = await this.editDatabase(databaseId), current = snapshot.rows.find(value => value.id === rowId);
      require(current, '항목을 찾을 수 없습니다.', 404); require((current.access_level ?? snapshot.database.access_level) >= 3, '이 항목을 편집할 권한이 없습니다.', 403);
      const row = baseline ? copy(baseline) : current; require(row.id === rowId, '폼의 원래 항목이 일치하지 않습니다.');
      const values = Object.create(null), baseValues = Object.create(null), fields = Object.create(null), payload = {};
      for (const [id, value] of Object.entries(body.properties || body.values || {})) if (!same(value, row.properties?.[id])) { values[id] = copy(value); baseValues[id] = copy(row.properties?.[id] ?? null); }
      if (Object.keys(values).length) payload.properties = values;
      for (const field of ROW_FIELDS) if (own(body, field) && !same(body[field], row[field] ?? (field === 'depends_on' ? [] : null))) { payload[field] = copy(body[field]); fields[field] = copy(row[field] ?? (field === 'depends_on' ? [] : null)); }
      if (!Object.keys(payload).length) return row;
      const records = await this.records(), operation = { id: uuid(), kind: 'row.patch', target_id: rowId, database_id: databaseId, body: payload,
        base: { schema: this.schema({ ...snapshot.database, properties: schema || snapshot.database.properties }, values), properties: baseValues, fields }, depends_on: this.rowDependencies(records, snapshot.database, payload, rowId) };
      await this.enqueue(this.offline.databaseKey(this.profile, databaseId), operation);
      return (await this.loadDatabase(databaseId, { remote: false })).rows.find(value => value.id === rowId);
    }
    deleteOperation(databaseId, rowId, snapshot, records) {
      const rows = subtree(snapshot.rows, rowId); require(rows.some(row => row.id === rowId), '항목을 찾을 수 없습니다.', 404);
      require(rows.every(row => (row.access_level ?? snapshot.database.access_level) >= 3), '하위 항목을 삭제할 권한이 없습니다.', 403);
      const bases = Object.create(null), ids = new Set();
      for (const row of rows) {
        const prior = records.filter(record => ACTIVE.has(record.status) && record.operation.database_id === databaseId && record.operation.target_id === row.id && ['row.create', 'row.patch'].includes(record.operation.kind)).at(-1);
        bases[row.id] = { updated_at: row.updated_at || new Date(0).toISOString(), ...(prior ? { after_operation: prior.id } : {}) }; if (prior) ids.add(prior.id);
      }
      return { id: uuid(), kind: 'row.delete', target_id: rowId, database_id: databaseId, body: {}, base_rows: bases, depends_on: [...ids].slice(-50) };
    }
    async deleteRow(databaseId, rowId) {
      identity(rowId); const snapshot = await this.editDatabase(databaseId), operation = this.deleteOperation(databaseId, rowId, snapshot, await this.records());
      await this.enqueue(this.offline.databaseKey(this.profile, databaseId), operation); return { operation, deletedIds: Object.keys(operation.base_rows) };
    }
    async workspace(workspace = this.workspaceSource) {
      await this.guard(); this.workspaceSource = copy(workspace || {}); const result = copy(this.workspaceSource), pages = new Map((result.pages || []).map(page => [page.id, page]));
      const authorities = new Map((result.pages || []).map(page => [page.id, this.workspaceSource]));
      const cached = await this.offline.listSnapshots(this.profile); await this.guard();
      for (const document of [...cached.map(record => record.snapshot), ...this.pages.values()]) {
        if (!document.page || !this.bound(document)) continue;
        const previous = pages.get(document.page.id), source = authorities.get(document.page.id) || {};
        const authoritative = (document.access_revision || 0) >= (source.access_revision || this.workspaceSource.access_revision || 0);
        const newerAbsent = !previous && Number.isSafeInteger(document.data_revision)
          && Number.isSafeInteger(this.workspaceSource.data_revision) && document.data_revision > this.workspaceSource.data_revision;
        if (authoritative && (newerAbsent || previous && ((document.data_revision || 0) >= (source.data_revision || 0)
            || (document.page.revision || 0) > (previous.revision || 0)))) {
          pages.set(document.page.id, copy(document.page)); authorities.set(document.page.id, document);
        }
      }
      for (const record of await this.offline.listLocalPages(this.profile)) {
        const metadata = record.metadata, previous = pages.get(metadata.page?.id);
        const created = metadata.creation_result, newerCreate = created?.status === 'applied' && created.resource_id === metadata.page?.id
          && Number.isSafeInteger(created.data_revision) && Number.isSafeInteger(this.workspaceSource.data_revision)
          && created.data_revision > this.workspaceSource.data_revision;
        const newerAbsent = !previous && (newerCreate || Number.isSafeInteger(metadata.canonical_data_revision)
          && Number.isSafeInteger(this.workspaceSource.data_revision) && metadata.canonical_data_revision > this.workspaceSource.data_revision);
        const authoritative = newerCreate || !Number.isSafeInteger(this.workspaceSource.access_revision)
          || Number.isSafeInteger(metadata.canonical_access_revision) && metadata.canonical_access_revision >= this.workspaceSource.access_revision;
        if (metadata.page && (metadata.localOnly || authoritative && (newerAbsent || previous && (metadata.page.revision || 0) > (previous.revision || 0)))) {
          pages.set(metadata.page.id, { ...copy(metadata.page), localOnly: metadata.localOnly });
          if (metadata.canonical_data_revision) authorities.set(metadata.page.id, { workspace_id: this.profile.workspaceId, current_member_id: this.profile.memberId,
            session_binding: this.profile.cacheBinding, data_revision: metadata.canonical_data_revision });
        }
      }
      for (const record of await this.records()) if (ACTIVE.has(record.status) && record.operation.kind === 'page.patch') {
        if (record.status === 'applied' && this.proof(authorities.get(record.operation.target_id), record)) continue;
        const page = pages.get(record.operation.target_id); if (page) Object.assign(page, copy(record.operation.body), { offline_pending: true });
      }
      result.pages = [...pages.values()]; return result;
    }
    async localPage(id) {
      await this.guard(); const key = this.offline.key(this.profile, identity(id)), metadata = await this.offline.getLocalPage(key);
      return metadata ? { metadata, snapshot: await this.offline.getSnapshot(key) } : null;
    }
    async pageReady(id) { return (await this.localPage(id))?.metadata.localOnly !== true; }
    async pageForEdit(id, records) {
      const local = await this.localPage(id); let page, source;
      if (local?.metadata.localOnly) { page = copy(local.metadata.page); source = local.snapshot; }
      else if (navigator.onLine) { try { source = await this.canonicalPage(id); page = copy(source.page); } catch (error) { if (error.status || this.closed) throw error; } }
      if (!page) {
        const cached = await this.offline.getSnapshot(this.offline.key(this.profile, id)), remembered = this.pages.get(id);
        source = !remembered || cached && (cached.access_revision || 0) >= (remembered.access_revision || 0)
          && (cached.data_revision || 0) >= (remembered.data_revision || 0) ? cached : remembered;
        page = copy(source?.page || this.workspaceSource.pages?.find(value => value.id === id)); source ||= this.workspaceSource;
      }
      require(page, '기기에 저장된 문서 정보가 없습니다.', 0, 'OFFLINE_MISS');
      for (const record of records) if (ACTIVE.has(record.status) && record.operation.kind === 'page.patch' && record.operation.target_id === id) {
        if (record.status === 'applied' && this.proof(source, record)) continue;
        Object.assign(page, copy(record.operation.body));
      }
      return page;
    }
    async createPage(body = {}) {
      await this.guard(); require(this.profile.session.member.role !== 'guest', '게스트는 새 문서를 만들 수 없습니다.', 403);
      const records = await this.records(), workspace = await this.workspace(), target = identity(body.id || uuid()), epoch = uuid();
      require(!workspace.pages.some(page => page.id === target), '이미 사용 중인 문서 식별자입니다.', 409);
      const payload = {}; for (const field of ['title', 'icon', 'cover', 'parent_id', 'teamspace_id', 'permissions']) if (own(body, field)) payload[field] = copy(body[field]);
      payload.title ??= '제목 없음'; payload.icon ??= '📄'; payload.cover ??= ''; payload.parent_id ??= null;
      const dependencyIds = [];
      if (payload.parent_id) {
        const parent = workspace.pages.find(page => page.id === payload.parent_id); require(parent && parent.access_level >= 3 && !parent.locked && !parent.archived, '상위 문서에 새 문서를 만들 권한이 없습니다.', 403);
        payload.teamspace_id = parent.teamspace_id ?? null; const prior = this.latest(records, parent.id); if (prior) dependencyIds.push(prior.id);
      } else {
        payload.teamspace_id ??= workspace.teamspaces?.find(space => space.id === 'general')?.id || workspace.teamspaces?.[0]?.id || null;
        require(!payload.teamspace_id || workspace.teamspaces?.some(space => space.id === payload.teamspace_id), '팀스페이스에 문서를 만들 권한이 없습니다.', 403);
      }
      require(typeof payload.title === 'string' && payload.title.length <= 500, '문서 제목을 확인해 주세요.');
      const timestamp = new Date().toISOString(), page = { id: target, ...copy(payload), owner_id: this.profile.memberId, access_level: 4, revision: 0, blocks: [], locked: false, archived: false, favorite: false, created_at: timestamp, updated_at: timestamp };
      const snapshot = { epoch, seq: 0, state: FountainCollaboration.seedState([]), page: copy(page), blocks: [], access_level: 4, access_revision: this.workspaceSource.access_revision || 0, data_revision: 0,
        workspace_id: this.profile.workspaceId, current_member_id: this.profile.memberId, session_binding: this.profile.cacheBinding };
      const operation = { id: uuid(), kind: 'page.create', target_id: target, document_epoch: epoch, body: { id: target, ...payload }, depends_on: dependencyIds };
      const metadata = { page: copy(page), initial_epoch: epoch, create_operation_id: operation.id, localOnly: true };
      await this.write(() => this.offline.stageLocalPage(this.profile, this.offline.key(this.profile, target), { metadata, snapshot, operation }));
      await this.changed({ reason: 'queued', pageIds: [target] }); this.schedule(); return { page, snapshot, operation };
    }
    async patchPage(id, body, { basePage } = {}) {
      identity(id); const records = await this.records(), current = await this.pageForEdit(id, records);
      require(current.access_level >= 3 && !current.locked && !current.archived, '문서를 편집할 권한이 없습니다.', 403);
      const page = basePage ? copy(basePage) : current; require(page.id === id, '문서의 원래 정보가 일치하지 않습니다.');
      require(Object.keys(body).every(field => PAGE_FIELDS.includes(field)), '오프라인에서 변경할 수 없는 문서 설정입니다.');
      const payload = {}, fields = {};
      for (const field of PAGE_FIELDS) if (own(body, field) && !same(body[field], page[field] ?? null)) { payload[field] = copy(body[field]); fields[field] = copy(page[field] ?? null); }
      if (!Object.keys(payload).length) return page;
      const prior = this.latest(records, id), operation = { id: uuid(), kind: 'page.patch', target_id: id, body: payload, base: { fields }, depends_on: prior ? [prior.id] : [] };
      await this.enqueue(this.offline.key(this.profile, id), operation); return { ...page, ...payload, offline_pending: true };
    }
    proof(snapshot, record) { return this.bound(snapshot) && Number.isSafeInteger(record.result?.data_revision) && record.result.data_revision >= 0 && snapshot.data_revision >= record.result.data_revision; }
    async refreshApplied() {
      const records = (await this.records()).filter(record => record.status === 'applied'), snapshots = new Map();
      for (const record of records) {
        if (this.closed) return;
        const operation = record.operation, database = operation.kind.startsWith('row.');
        const id = database ? operation.database_id : operation.target_id, key = database ? this.offline.databaseKey(this.profile, id) : this.offline.key(this.profile, id);
        try {
          let snapshot = snapshots.get(key) || await (database ? this.offline.getDatabase(key) : this.offline.getSnapshot(key));
          if (!this.proof(snapshot, record)) snapshot = await (database ? this.canonicalDatabase(id) : this.canonicalPage(id));
          snapshots.set(key, snapshot);
          if (this.proof(snapshot, record)) await this.write(() => this.offline.acknowledgeMutations(this.profile, [record.id]));
        } catch (error) { if (this.closed) throw error; if (retryable(error)) this.retry(); else if (![403, 404].includes(error.status)) this.report(error); }
      }
    }
    selectBatch(records, attempted) {
      const known = new Map(records.map(record => [record.id, record])), selected = [], ids = new Set();
      let changed = true;
      while (changed && selected.length < 50) {
        changed = false;
        for (const record of records) {
          if (selected.length >= 50) break;
          if (!['pending', 'deferred'].includes(record.status) || attempted.has(record.id) || ids.has(record.id)) continue;
          if (dependencies(record.operation).every(id => !known.has(id) || known.get(id).status === 'applied' || ids.has(id))) { selected.push(record); ids.add(record.id); changed = true; }
        }
      }
      return selected;
    }
    sync() {
      if(this.importBusy){this.importResume=true;this.importResumeAt=Math.min(this.importResumeAt,Date.now());return Promise.resolve({paused:true});}
      if (this.syncing) return this.syncing.then(async result => {
        if (!this.closed && navigator.onLine && (await this.records()).some(record => ACTIVE.has(record.status))) return this.sync();
        return result;
      });
      this.syncing = this.runSync().finally(() => { this.syncing = null; }); return this.syncing;
    }
    async runSync() {
      const attempted = new Set(); let count = 0;
      try {
        await this.guard(); if (!navigator.onLine) return { offline: true };
        await this.authenticate(); await this.refreshApplied();
        while (!this.closed) {
          const batch = this.selectBatch(await this.records(), attempted); if (!batch.length) break;
          await this.authenticate(); batch.forEach(record => attempted.add(record.id));
          const response = await this.request('/sync', { workspace_id: this.profile.workspaceId, session_binding: this.profile.cacheBinding, operations: batch.map(record => copy(record.operation)) });
          require(this.bound(response), '다른 로그인에서 도착한 변경 응답입니다.', 403, 'SESSION_CHANGED');
          const byId = new Map(batch.map(record => [record.id, record])); require(Array.isArray(response.results), '올바르지 않은 동기화 응답입니다.', 502);
          for (const result of response.results) {
            const record = byId.get(result.id); if (!record) continue;
            require(['applied', 'conflict', 'denied', 'invalid', 'deferred'].includes(result.status), '올바르지 않은 변경 상태입니다.', 502);
            if (result.status === 'applied') require(result.resource_id === record.operation.target_id && Number.isSafeInteger(result.data_revision) && result.data_revision >= 0, '변경 확인 정보가 일치하지 않습니다.', 502);
            const current = (await this.records()).find(value => value.id === record.id); if (!current) continue;
            if (current.status === 'applied' && result.status !== 'applied' || PAUSED.has(current.status) && result.status === 'deferred') continue;
            if (current.status !== result.status || !same(current.result, result)) await this.write(() => this.offline.updateMutation(this.profile, result.id, { status: result.status, result: copy(result) }));
            count++; if (result.status === 'deferred' && result.http_status >= 500) this.retry();
          }
          await this.refreshApplied();
          for (const id of new Set(response.results.filter(result => ['conflict', 'denied', 'invalid'].includes(result.status))
            .map(result => byId.get(result.id)?.operation.database_id).filter(Boolean))) {
            try { await this.canonicalDatabase(id); } catch (error) { if (this.closed) throw error; if (retryable(error)) this.retry(); }
          }
        }
        if (!(await this.records()).some(record => ACTIVE.has(record.status))) this.delay = 1000;
        await this.changed({ reason: 'synced' }); return { processed: count };
      } catch (error) {
        if ([401, 403].includes(error.status) || error.code === 'SESSION_CHANGED') await this.loseSession(error, error.code === 'SESSION_CHANGED');
        else if (retryable(error)) this.retry();
        if (!this.closed && error.status) this.report(error); throw error;
      }
    }
    closure(records, id) {
      require(records.some(record => record.id === id), '변경 기록을 찾을 수 없습니다.', 404); const ids = new Set([id]); let changed = true;
      while (changed) { changed = false; for (const record of records) if (!ids.has(record.id) && dependencies(record.operation).some(value => ids.has(value))) { ids.add(record.id); changed = true; } }
      return records.filter(record => ids.has(record.id));
    }
    async export(id) { return this.exportV2(id); }
    async exportV2(id) {
      const records = await this.records(), selected = id ? this.closure(records,id) : records, localPages = [], drafts = [];
      for (const record of selected) if (record.operation.kind === 'page.create') { const local=await this.localPage(record.operation.target_id); if(local)localPages.push({...local,operations:await this.offline.pendingOperations(record.resourceKey),drafts:await this.offline.getDrafts(record.resourceKey)}); }
      for(const {key,snapshot} of await this.offline.listSnapshots(this.profile))if(snapshot.page?.id&&!localPages.some(local=>local.metadata.page.id===snapshot.page.id)&&(!id||selected.some(record=>record.operation.kind.startsWith('page.')&&record.operation.target_id===snapshot.page.id)))for(const record of await this.offline.getDrafts(key))if(!['pending','basis'].includes(record.draft.reason))drafts.push({page_id:snapshot.page.id,draft:copy(record.draft)});
      await this.guard();return {format:'fountain-recovery-v2',origin:this.transport.origin||this.profile.origin,workspace_id:this.profile.workspaceId,member_id:this.profile.memberId,source_binding:this.profile.cacheBinding,exported_at:new Date().toISOString(),records:copy(selected),localPages,drafts};
    }
    async recoveryArchives(options={}){await this.authenticate();await this.guard();return this.offline.listRecoveryProfiles(this.profile,options);}
    async prepareArchivedRecovery(id,{isCurrent}={}){
      this.importCurrent(isCurrent);await this.authenticate();this.importCurrent(isCurrent);const source=await this.offline.readRecoveryProfile(this.profile,id);this.importCurrent(isCurrent);await this.guard();this.importCurrent(isCurrent);
      const profile=source.profile,envelope={format:'fountain-recovery-v2',origin:profile.origin,workspace_id:profile.workspaceId,member_id:profile.memberId,source_binding:profile.cacheBinding,records:copy(source.mutations),localPages:[],drafts:[]};let serial=0;
      const readable=text=>{const result=[];for(let offset=0;offset<text.length;){let end=Math.min(offset+100000,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;result.push({id:'archive_raw_'+(++serial),type:'code',language:'json',parent_id:null,text:text.slice(offset,end)});offset=end;}return result;};
      const keys=new Set([...source.operations,...source.drafts.filter(row=>row.draft?.reason!=='basis'),...source.localPages.filter(row=>row.metadata?.localOnly!==false)].map(row=>row.key));
      const creates=new Map(source.mutations.filter(row=>row.operation.kind==='page.create').map(row=>[row.resourceKey,row]));for(const key of creates.keys())keys.add(key);
      for(const resourceKey of keys){
        const pageId=decodeURIComponent(resourceKey.split('|').at(-1)),snapshot=source.snapshots.find(row=>row.key===resourceKey)?.snapshot,operations=source.operations.filter(row=>row.key===resourceKey).map(row=>row.operation),drafts=source.drafts.filter(row=>row.key===resourceKey),local=source.localPages.find(row=>row.key===resourceKey);
        if(creates.has(resourceKey)){const operation=creates.get(resourceKey).operation;envelope.localPages.push({metadata:copy(local?.metadata||{page:{id:pageId}}),snapshot:copy(snapshot||{page:{id:pageId},epoch:operation.document_epoch||'archive_unresolved',blocks:[]}),operations:copy(operations),drafts:copy(drafts)});}
        const blocks=[];
        const views=drafts.filter(row=>Array.isArray(row.draft?.blocks)&&row.draft.blocks.length&&row.draft.reason!=='basis');if(!creates.has(resourceKey)&&!views.length&&snapshot?.blocks)views.push({draft:{blocks:snapshot.blocks}});
        for(const view of views){const map=new Map(view.draft.blocks.map(block=>[block.id,'archive_view_'+(++serial)]));for(const block of view.draft.blocks)blocks.push({...copy(block),id:map.get(block.id),parent_id:map.get(block.parent_id)||null});}
        // Raw source preserves every tab, operation and basis, including unresolved or other epochs.
        if(snapshot||operations.length||drafts.length)blocks.push(...readable(JSON.stringify({snapshot:snapshot||null,ops:operations,drafts:drafts.map(row=>({clientId:row.clientId,draft:row.draft}))},null,2)));
        if(blocks.length)envelope.drafts.push({page_id:pageId,draft:{blocks,reason:'auth_suspended'}});
      }
      const text=JSON.stringify(envelope);if(new TextEncoder().encode(text).byteLength>16*1024*1024)throw failure('보관된 기록이 16MiB 복구 범위를 넘어 원본을 유지했습니다.',409,'RECOVERY_ARCHIVE_LIMIT');this.importCurrent(isCurrent);
      return this.prepareImport(text,{isCurrent,[ARCHIVE_TARGETS]:true});
    }
    importCurrent(isCurrent) {
      if (this.closed || isCurrent && !isCurrent()) { const error = failure('가져오기 미리보기가 닫혔습니다.', 409, 'STALE_REQUEST'); error.name = 'AbortError'; throw error; }
    }
    discardPrepared(token) { preparedImports.get(this)?.delete(typeof token === 'object' ? token.token : token); }
    importFingerprint(value, spec) {
      if (spec.kind === 'metadata') return canonical(value);
      if (spec.kind === 'workspace') return canonical({ teamspaces: value.teamspaces, pages: (value.pages || []).filter(page => spec.pageIds.includes(page.id)) });
      if (spec.kind === 'page') return canonical({ page: Object.fromEntries(['id','title','icon','cover','favorite','parent_id','teamspace_id','access_level','locked','archived','revision'].map(key => [key,value.page?.[key] ?? null])), epoch: value.epoch, seq: value.seq, blocks: value.blocks, access_level: value.access_level });
      const ids = new Set(spec.rowIds); for (const id of spec.deleteIds) for (const row of subtree(value.rows, id)) ids.add(row.id);
      return canonical({ database: Object.fromEntries(Object.entries(value.database).filter(([key]) => !['created_at','updated_at'].includes(key))), rows: value.rows.filter(row => ids.has(row.id)).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
    }
    async importRead(path, kind, id, isCurrent) {
      this.importCurrent(isCurrent); const value = await this.request(path); this.importCurrent(isCurrent);
      if (kind === 'metadata') require(value.id === id && value.status === 'complete' && Number.isSafeInteger(value.size) && value.size >= 0, '첨부 파일의 현재 정보를 확인할 수 없습니다.', 409);
      else require(this.bound(value) && (kind === 'workspace' || kind === 'database' ? kind === 'workspace' || value.database?.id === id : value.page?.id === id), '현재 로그인과 복구 대상이 일치하지 않습니다.', 403, 'SESSION_CHANGED');
      return value;
    }
    planRowOperation(original, snapshot, virtual) {
      const operation = copy(original), row = snapshot.rows.find(value => value.id === operation.target_id);
      if (operation.kind === 'row.create') {
        require(snapshot.database.can_create_row ?? snapshot.database.access_level >= 3, '새 항목을 만들 권한이 없습니다.', 403);
        require(!row, '같은 ID의 항목이 이미 있습니다.', 409, 'UNSUPPORTED_RECOVERY');
        operation.base = { schema: this.schema(snapshot.database, operation.body.properties || {}) };
      } else {
        require(row && (row.access_level ?? snapshot.database.access_level) >= 3, '항목을 편집할 권한이 없습니다.', row ? 403 : 404);
        if (operation.kind === 'row.patch') operation.base = { schema: this.schema(snapshot.database, operation.body.properties || {}), properties: Object.fromEntries(Object.keys(operation.body.properties || {}).map(key => [key, copy(row.properties[key] ?? null)])), fields: Object.fromEntries(ROW_FIELDS.filter(key => own(operation.body, key)).map(key => [key, copy(row[key] ?? (key === 'depends_on' ? [] : null))])) };
        else { const replacement = this.deleteOperation(operation.database_id, operation.target_id, snapshot, virtual); operation.base_rows = replacement.base_rows; operation.depends_on = [...new Set([...(operation.depends_on || []), ...replacement.depends_on])]; }
      }
      require((operation.depends_on || []).length <= 50, '연결된 복구 변경은 한 항목당 50개까지 준비할 수 있습니다.');
      return operation;
    }
    async prepareImport(text, { targetPageId, isCurrent, [ARCHIVE_TARGETS]:archiveTargets=false } = {}) {
      require(globalThis.FountainRecovery && this.offline.stageRecoveryImport, '복구 파일 가져오기를 지원하지 않는 저장소입니다.', 409, 'UNSUPPORTED_RECOVERY');
      this.importCurrent(isCurrent); if(this.scheduled){this.importResume=true;this.importResumeAt=Math.min(this.importResumeAt,this.scheduledAt);} clearTimeout(this.timer); this.scheduled=false; this.importBusy++;
      try {
        const source = FountainRecovery.parse(text, { origin: this.transport.origin || this.profile.origin, workspaceId: this.profile.workspaceId, memberId: this.profile.memberId });
        if (source.kind === 'body'&&!archiveTargets) require(targetPageId, '본문을 복사할 현재 문서를 선택해 주세요.', 400, 'TARGET_PAGE_REQUIRED');
        const digest=source.kind==='body'&&!archiveTargets?FountainCollaboration.sha256(canonical({sourceDigest:source.digest,targetPageId})):source.digest;
        await this.authenticate(); this.importCurrent(isCurrent);
        const reads = new Map(), specs = new Map();
        const read = async (kind, id) => {
          if(kind==='page'){
            const page=workspace.pages?.find(page=>page.id===id);require(page,'현재 읽을 수 있는 문서가 아닙니다.',404);
            specs.get('/workspace').pageIds.push(id);
            return {page:copy(page),blocks:copy(page.blocks||[]),access_level:page.access_level,workspace_id:this.profile.workspaceId,current_member_id:this.profile.memberId,session_binding:this.profile.cacheBinding};
          }
          const path = kind === 'workspace' ? '/workspace' : kind === 'database' ? '/databases/' + encodeURIComponent(id) : kind === 'page' ? '/pages/' + encodeURIComponent(id) + '/collaboration' : '/attachments/' + encodeURIComponent(id) + '/metadata';
          if (!reads.has(path)) { require(reads.size < 5000, '복구 파일이 참조하는 리소스가 너무 많습니다.'); reads.set(path, this.importRead(path, kind, id, isCurrent)); specs.set(path, { path, kind, id, rowIds: [], deleteIds: [], pageIds: [] }); }
          return reads.get(path);
        };
        const workspace = await read('workspace'); this.importCurrent(isCurrent);
        const databaseIds = [...new Set(source.records.map(record => record.operation.database_id).filter(Boolean))];
        const databases = new Map(await Promise.all(databaseIds.map(async id => [id, await read('database', id)]))); this.importCurrent(isCurrent);
        const used = new Set(), newId = () => { let id; for (let attempts = 0; attempts < 10; attempts++) { id = uuid(); if (!used.has(id) && !source.records.some(record => record.operation.id === id || record.operation.target_id === id)) { used.add(id); return id; } } throw failure('새 복구 식별자를 만들 수 없습니다.', 409); };
        const opIds = new Map(source.records.map(record => [record.operation.id, newId()])), pages = new Map(), rows = new Map(), createRecords = new Map();
        const rowKey = (databaseId,id) => canonical([databaseId,id]);
        for (const record of source.records) {
          const operation = record.operation;
          if (operation.kind === 'page.create') { require(!pages.has(operation.target_id), '새 문서가 중복되어 있습니다.'); pages.set(operation.target_id,newId()); createRecords.set(canonical(['page',operation.target_id]),record); }
          if (operation.kind === 'row.create') { const key=rowKey(operation.database_id,operation.target_id); require(!rows.has(key), '새 항목이 중복되어 있습니다.'); rows.set(key,newId()); createRecords.set(canonical(['row',operation.database_id,operation.target_id]),record); }
        }
        const warnings = [...source.warnings], extraEdges = new Map();
        const edge = (record, dependency) => { if (!extraEdges.has(record.operation.id)) extraEdges.set(record.operation.id, []); if (dependency) extraEdges.get(record.operation.id).push(dependency.operation.id); };
        const requireRow = async (databaseId,id,record) => {
          identity(id); const creating=createRecords.get(canonical(['row',databaseId,id]));
          if (creating) { edge(record,creating); return rows.get(rowKey(databaseId,id)); }
          if (!databases.has(databaseId)) databases.set(databaseId,await read('database',databaseId));
          const snapshot=databases.get(databaseId); require(snapshot.rows.some(row=>row.id===id),'참조한 원래 항목이 파일이나 현재 서버에 없습니다.',404);
          specs.get('/databases/'+encodeURIComponent(databaseId)).rowIds.push(id); return id;
        };
        for (const record of source.records) {
          const operation=record.operation,body=operation.body;
          if (operation.kind==='page.create'&&body.parent_id) {
            const creating=createRecords.get(canonical(['page',body.parent_id]));
            if (creating) edge(record,creating); else { const parent=await read('page',body.parent_id); require(parent.access_level>=3&&!parent.page.locked&&!parent.page.archived,'상위 문서를 편집할 권한이 없습니다.',403); }
          } else if (operation.kind==='page.patch'&&!pages.has(operation.target_id)) { const page=await read('page',operation.target_id); require(page.access_level>=3&&!page.page.locked&&!page.page.archived,'문서를 편집할 권한이 없습니다.',403); }
          else if (operation.kind==='page.patch') edge(record,createRecords.get(canonical(['page',operation.target_id])));
          if (operation.database_id) {
            const db=databases.get(operation.database_id),spec=specs.get('/databases/'+encodeURIComponent(operation.database_id));
            if (operation.kind!=='row.create') await requireRow(operation.database_id,operation.target_id,record);
            if (body.parent_row_id) await requireRow(operation.database_id,body.parent_row_id,record);
            for (const id of body.depends_on||[]) await requireRow(operation.database_id,id,record);
            this.schema(db.database,body.properties||{});
            for (const [id,value] of Object.entries(body.properties||{})) {
              const property=db.database.properties.find(property=>property.id===id); require(property&&!['formula','rollup'].includes(property.type),'삭제되었거나 계산된 속성은 가져올 수 없습니다.');
              if (property.type==='relation'&&value!==null) for (const target of value) await requireRow(property.database_id||operation.database_id,target,record);
              if (property.type==='files'&&value!==null) for (const attachment of value) await read('metadata',identity(attachment));
            }
            if (operation.kind==='row.delete'&&!rows.has(rowKey(operation.database_id,operation.target_id))) spec.deleteIds.push(operation.target_id);
          }
        }
        const ordered=FountainRecovery.topological(source.records,extraEdges),virtual=[],mutations=[],localPages=[],drafts=[],items=[];
        const mappedBody = operation => {
          const body=copy(operation.body);
          if (operation.kind.startsWith('page.')) { if (body.parent_id) body.parent_id=pages.get(body.parent_id)||body.parent_id; return body; }
          if (body.parent_row_id) body.parent_row_id=rows.get(rowKey(operation.database_id,body.parent_row_id))||body.parent_row_id;
          if (body.depends_on) body.depends_on=body.depends_on.map(id=>rows.get(rowKey(operation.database_id,id))||id);
          for (const property of databases.get(operation.database_id).database.properties) if (property.type==='relation'&&Array.isArray(body.properties?.[property.id])) body.properties[property.id]=body.properties[property.id].map(id=>rows.get(rowKey(property.database_id||operation.database_id,id))||id);
          return body;
        };
        const pageValues=new Map();let bodyBudget=Math.max(0,FountainRecovery.MAX_RGA_POINTS-(source.summary.replayedCodePoints||0)),deferredBodies=0,deferredBlocks=0,deferredCodePoints=0;
        for (const record of ordered) {
          const original=record.operation,body=mappedBody(original),target=original.kind.startsWith('page.')?(pages.get(original.target_id)||original.target_id):(rows.get(rowKey(original.database_id,original.target_id))||original.target_id);
          let bodyDeferred=false,preservedBlocks=0,preservedCodePoints=0;
          let operation={id:opIds.get(original.id),kind:original.kind,target_id:target,body,depends_on:[...new Set([...(original.depends_on||[]),...(extraEdges.get(original.id)||[])].filter(id=>opIds.has(id)).map(id=>opIds.get(id)))]},before=null,after=null,deleteRows;
          if (original.kind==='page.create') {
            require(this.profile.session.member.role!=='guest','게스트는 새 문서를 만들 수 없습니다.',403);
            require(!workspace.pages.some(page=>page.id===target),'새 문서 식별자가 이미 사용 중입니다.',409);
            let parent=body.parent_id&&(pageValues.get(body.parent_id)||(await read('page',body.parent_id)).page);
            if(parent)body.teamspace_id=parent.teamspace_id??null;
            else if(own(original.body,'teamspace_id')){require(body.teamspace_id===null||workspace.teamspaces?.some(space=>space.id===body.teamspace_id),'원래 팀스페이스가 없거나 새 문서를 만들 권한이 없습니다.',403);}
            else body.teamspace_id=workspace.teamspaces?.find(space=>space.id==='general')?.id??workspace.teamspaces?.[0]?.id??null;
            operation.document_epoch=newId();body.id=target;body.permissions={default:'private',inherit:false,members:{},groups:{}};
            warnings.push('새 문서 사본은 과거 공유 설정을 가져오지 않고 비공개로 만듭니다.');
            const page={id:target,...copy(body),owner_id:this.profile.memberId,access_level:4,revision:0,locked:false,archived:false,favorite:false,blocks:[]};
            pageValues.set(target,page);after=copy(page);
            const snapshot={epoch:operation.document_epoch,seq:0,state:FountainCollaboration.seedState([]),blocks:[],page:copy(page),access_level:4,access_revision:workspace.access_revision||0,data_revision:0,workspace_id:this.profile.workspaceId,current_member_id:this.profile.memberId,session_binding:this.profile.cacheBinding};
            const oldBody=source.localPages.find(page=>page.page_id===original.target_id).blocks;
            for (const block of oldBody) if (block.attachment_id) await read('metadata',identity(block.attachment_id));
            preservedCodePoints=FountainRecovery.bodyCodePoints(oldBody);preservedBlocks=oldBody.length;bodyDeferred=preservedCodePoints>bodyBudget;
            const built=bodyDeferred?{blocks:FountainRecovery.remapBlocks(oldBody,{newId}),operations:[]}:FountainRecovery.buildBody(oldBody,{newId,clientId:'recovery_'+newId().replace(/-/g,''),epoch:operation.document_epoch}),resourceKey=this.offline.key(this.profile,target);
            if(bodyDeferred){deferredBodies++;deferredBlocks+=preservedBlocks;deferredCodePoints+=preservedCodePoints;warnings.push('새 문서 본문은 한 번에 자동 구성할 수 있는 문자·서식 작업 범위를 넘어 읽을 수 있는 복구 초안으로 모두 보관합니다. 비공개 문서를 생성한 뒤 별도 본문 복구가 필요하며 원문은 내보낼 수 있습니다.');}else bodyBudget-=preservedCodePoints;
            localPages.push({resourceKey,metadata:{page:copy(page),initial_epoch:operation.document_epoch,create_operation_id:operation.id,localOnly:true},snapshot,operations:built.operations,drafts:[{clientId:newId(),draft:bodyDeferred?{epoch:operation.document_epoch,blocks:built.blocks,reason:'imported_large_body',imported:true,source_digest:source.digest,createdAt:new Date().toISOString()}:{epoch:operation.document_epoch,ops:built.operations.map(({_epoch,...op})=>op),blocks:built.blocks,reason:'pending',createdAt:new Date().toISOString()}}]});
            after.blocks=copy(built.blocks);
          } else if (original.kind.startsWith('row.')) {
            operation.database_id=original.database_id;const snapshot=this.projectDatabase(databases.get(original.database_id),virtual);
            before=copy(snapshot.rows.find(row=>row.id===target)||null);
            operation=this.planRowOperation(operation,snapshot,virtual);
            if (operation.kind==='row.create') operation.body.id=target;
            if (operation.kind==='row.delete') { deleteRows=copy(subtree(snapshot.rows,target));warnings.push('항목 삭제는 미리보기에 표시된 현재 하위 항목 전체에 적용됩니다.'); }
            virtual.push({id:operation.id,operation,status:'pending',createdAt:Date.now()});after=copy(this.projectDatabase(databases.get(original.database_id),virtual).rows.find(row=>row.id===target)||null);
            specs.get('/databases/'+encodeURIComponent(original.database_id)).rowIds.push(target);
          } else {
            let page=pageValues.get(target);if(!page) page=copy((await read('page',target)).page);
            require(page.access_level>=3&&!page.locked&&!page.archived,'문서를 편집할 권한이 없습니다.',403);before=copy(page);
            operation.base={fields:Object.fromEntries(Object.keys(body).map(key=>[key,copy(page[key]??null)]))};Object.assign(page,copy(body));pageValues.set(target,page);after=copy(page);
          }
          require(operation.depends_on.length<=50,'한 변경에 연결된 복구 작업이 너무 많습니다.');
          if(!original.kind.startsWith('row.')) virtual.push({id:operation.id,operation,status:'pending',createdAt:Date.now()});
          const resourceKey=operation.database_id?this.offline.databaseKey(this.profile,operation.database_id):this.offline.key(this.profile,target);mutations.push({resourceKey,operation});
          const schema=operation.database_id?databases.get(operation.database_id).database.properties:null,titleProperty=schema?.find(property=>property.type==='title');
          const rowTitle=titleProperty&&(after?.properties?.[titleProperty.id]??before?.properties?.[titleProperty.id]);
          const title=schema?(typeof rowTitle==='string'&&rowTitle?rowTitle:operation.kind==='row.delete'?'항목 삭제':operation.kind==='row.create'?'새 항목':'항목 변경'):(body.title||after?.title||before?.title||target);
          items.push({kind:operation.kind,targetId:target,...(schema?{databaseId:operation.database_id,...(titleProperty?{titlePropertyId:titleProperty.id}:{}),propertyLabels:Object.fromEntries(schema.map(property=>[property.id,property.name||property.id]))}:{}),title,before,after,...(bodyDeferred?{bodyDeferred,preservedBlocks,preservedCodePoints}:{}),...(deleteRows?{deleteRows}:{})});
        }
        for (const entry of source.drafts) {
          const target=source.kind==='body'&&!archiveTargets?targetPageId:pages.get(entry.page_id)||entry.page_id;identity(target);
          let page=pageValues.get(target);if(!page) page=(await read('page',target)).page;
          require(page.access_level>=3&&!page.locked&&!page.archived,'본문을 복사할 문서를 편집할 권한이 없습니다.',403);
          for (const block of entry.draft.blocks) if (block.attachment_id) await read('metadata',identity(block.attachment_id));
          const built={blocks:FountainRecovery.remapBlocks(entry.draft.blocks,{newId})};
          const draft={blocks:built.blocks,reason:entry.draft.reason,imported:true,source_digest:source.digest,createdAt:new Date().toISOString()};
          drafts.push({resourceKey:this.offline.key(this.profile,target),clientId:newId(),draft});
          items.push({kind:'body',targetId:target,title:page.title||target,before:null,after:copy(built.blocks)});
        }
        const workspaceSpec=specs.get('/workspace');workspaceSpec.pageIds=[...new Set([...workspaceSpec.pageIds,...pages.values(),...source.records.filter(record=>record.operation.kind==='page.create').map(record=>record.operation.body.parent_id).filter(id=>id&&!pages.has(id))])];
        const proofs=[];for(const [path,promise] of reads){const value=await promise;this.importCurrent(isCurrent);const spec=specs.get(path);proofs.push({...spec,fingerprint:this.importFingerprint(value,spec)});}
        const summary={...source.summary,deferredBodies,deferredBlocks,deferredCodePoints,createdPages:mutations.filter(record=>record.operation.kind==='page.create').length,createdRows:mutations.filter(record=>record.operation.kind==='row.create').length,updatedPages:mutations.filter(record=>record.operation.kind==='page.patch').length,updatedRows:mutations.filter(record=>record.operation.kind==='row.patch').length,deletedRows:mutations.filter(record=>record.operation.kind==='row.delete').length};
        const token=newId(),publicValue={token,digest,kind:source.kind,summary,warnings:[...new Set(warnings)],items,source:source.source};
        this.importCurrent(isCurrent);await this.guard();this.importCurrent(isCurrent);
        preparedImports.get(this).clear();preparedImports.get(this).set(token,{digest,proofs,bundle:{digest,mutations,localPages,drafts},role:this.profile.session.member.role});
        return copy(publicValue);
      } finally { this.importBusy--; if(!this.importBusy&&this.importResume){this.importResume=false;const delay=Math.max(0,this.importResumeAt-Date.now());this.importResumeAt=Infinity;this.schedule(delay);} }
    }
    async importPrepared(prepared, { isCurrent } = {}) {
      this.importCurrent(isCurrent);if(this.scheduled){this.importResume=true;this.importResumeAt=Math.min(this.importResumeAt,this.scheduledAt);}clearTimeout(this.timer);this.scheduled=false;this.importBusy++;
      try {
        const saved=preparedImports.get(this).get(prepared?.token);require(saved&&saved.digest===prepared.digest,'가져오기 미리보기를 다시 열어 주세요.',409,'IMPORT_PREVIEW_STALE');
        await this.authenticate();this.importCurrent(isCurrent);require(this.profile.session.member.role===saved.role,'권한이 바뀌었습니다. 미리보기를 다시 확인해 주세요.',409,'IMPORT_PREVIEW_STALE');
        const verifiedEditablePageIds=[],draftTargets=new Set(saved.bundle.drafts.map(draft=>draft.resourceKey));
        for(const proof of saved.proofs){
          const value=await this.importRead(proof.path,proof.kind,proof.id,isCurrent);require(this.importFingerprint(value,proof)===proof.fingerprint,'복구 대상의 현재 내용이나 권한이 바뀌었습니다. 미리보기를 다시 확인해 주세요.',409,'IMPORT_PREVIEW_STALE');
          // A newly fetched workspace may know a target absent from the older cache.
          // Only this revalidated response supplies storage's separate target proof.
          if(proof.kind==='workspace')for(const page of value.pages||[])if(proof.pageIds.includes(page.id)&&page.access_level>=3&&!page.locked&&!page.archived&&draftTargets.has(this.offline.key(this.profile,page.id)))verifiedEditablePageIds.push(page.id);
        }
        this.importCurrent(isCurrent);
        const result=await this.write(()=>{this.importCurrent(isCurrent);return this.offline.stageRecoveryImport(this.profile,copy(saved.bundle),{verifiedEditablePageIds,isCurrent:()=>!this.closed&&(!isCurrent||isCurrent())});});
        this.importCurrent(isCurrent);preparedImports.get(this).delete(prepared.token);await this.changed({reason:'recovery-import'});return result;
      } finally { this.importBusy--; if(!this.importBusy&&this.importResume){this.importResume=false;const delay=Math.max(0,this.importResumeAt-Date.now());this.importResumeAt=Infinity;this.schedule(delay);} }
    }
    async drop(id) {
      require(!this.syncing, '동기화 중인 변경은 완료 뒤 정리해 주세요.', 409);
      const records = await this.records(), selected = this.closure(records, id);
      require(!selected.some(record => record.status === 'applied'), '서버에 반영된 변경은 최신 내용을 확인한 뒤 정리해 주세요.', 409);
      require(this.offline.discardMutations, '이 저장소는 원자적 변경 폐기를 지원하지 않습니다.', 409, 'UNSUPPORTED_RECOVERY');
      const result = await this.write(() => this.offline.discardMutations(this.profile, selected.map(record => record.id)));
      await this.changed({ reason: 'dropped' }); return result;
    }
    async reapply(id) {
      if (this.syncing) await this.syncing;
      await this.authenticate(); const all = await this.records(), selected = this.closure(all, id), oldIds = new Set(selected.map(record => record.id));
      require(PAUSED.has(selected.find(record => record.id === id).status), '처리 중인 변경은 동기화를 먼저 확인해 주세요.', 409);
      require(!selected.some(record => record.status === 'applied'), '이미 반영된 변경을 다시 실행하지 않습니다.', 409, 'UNSUPPORTED_RECOVERY');
      require(this.offline.replaceMutations, '이 저장소는 원자적 복구를 지원하지 않습니다.', 409, 'UNSUPPORTED_RECOVERY');
      const databases = new Map(), pageValues = new Map(); let freshWorkspace;
      if (selected.some(record => record.operation.kind === 'page.create')) {
        freshWorkspace = await this.request('/workspace');
        require(this.bound(freshWorkspace), '다른 로그인에서 도착한 문서 목록입니다.', 403, 'SESSION_CHANGED');
      }
      for (const record of selected) {
        const operation = record.operation;
        if (operation.database_id && !databases.has(operation.database_id)) databases.set(operation.database_id, await this.canonicalDatabase(operation.database_id));
        if (operation.kind === 'page.patch' && !pageValues.has(operation.target_id)) {
          const creating = selected.find(record => record.operation.kind === 'page.create' && record.operation.target_id === operation.target_id);
          pageValues.set(operation.target_id, creating ? { favorite: false, ...copy(creating.operation.body), id: operation.target_id } : (await this.canonicalPage(operation.target_id)).page);
        }
      }
      const mapping = new Map(selected.map(record => [record.id, uuid()])), fresh = [], virtual = all.filter(record => !oldIds.has(record.id));
      for (const record of selected) {
        const original = record.operation, operation = copy(original); operation.id = mapping.get(record.id); operation.depends_on = (original.depends_on || []).map(value => mapping.get(value) || value).filter(value => !oldIds.has(value));
        if (original.kind === 'page.create') {
          require(!(record.status === 'conflict' && record.result?.http_status === 409) && !freshWorkspace.pages.some(page => page.id === original.target_id),
            '같은 ID의 문서가 있어 자동으로 이동하지 않습니다. 본문을 내보내기로 보존해 주세요.', 409, 'UNSUPPORTED_RECOVERY');
          if (original.body.parent_id) {
            const parents = await this.workspace(freshWorkspace), parent = parents.pages.find(page => page.id === original.body.parent_id);
            require(parent && parent.access_level >= 3 && !parent.locked && !parent.archived, '상위 문서의 권한을 확인한 뒤 재적용해 주세요.', 403);
          }
        } else if (original.kind.startsWith('row.')) {
          const snapshot = this.projectDatabase(databases.get(original.database_id), virtual), row = snapshot.rows.find(value => value.id === original.target_id);
          Object.assign(operation,this.planRowOperation(operation,snapshot,virtual));
        } else {
          const page = copy(pageValues.get(original.target_id)); for (const previous of virtual) if (ACTIVE.has(previous.status) && previous.operation.kind === 'page.patch' && previous.operation.target_id === original.target_id) Object.assign(page, previous.operation.body);
          operation.base = { fields: Object.fromEntries(Object.keys(original.body).map(key => [key, copy(page[key] ?? null)])) };
        }
        fresh.push({ resourceKey: record.resourceKey, operation }); virtual.push({ ...record, id: operation.id, operation, status: 'pending', result: undefined });
      }
      await this.write(() => this.offline.replaceMutations(this.profile, fresh.map((record, index) => ({ previousId: selected[index].id, operation: record.operation }))));
      await this.changed({ reason: 'reapplied' }); this.schedule(); return { operations: fresh.map(record => record.operation) };
    }
    close() {
      if (this.closed) return; this.closed = true; preparedImports.get(this)?.clear(); clearTimeout(this.timer);
      for (const request of this.requests) request.abort(); this.requests.clear();
      removeEventListener('online', this.online); removeEventListener('fountain-offline-mutations-changed', this.queueChanged);
      removeEventListener('fountain-offline-profile-cleared', this.profileCleared); removeEventListener('fountain-offline-profile-changed', this.profileChanged);
    }
  }
  globalThis.FountainMutations = Object.freeze({ Controller });
})();
