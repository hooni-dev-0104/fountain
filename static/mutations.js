/* Durable resource mutations. Canonical data and optimistic changes stay separate. */
(() => {
  'use strict';
  const ACTIVE = new Set(['pending', 'deferred', 'applied']);
  const PAUSED = new Set(['conflict', 'denied', 'invalid', 'paused']);
  const PAGE_FIELDS = ['title', 'icon', 'cover', 'favorite'];
  const ROW_FIELDS = ['parent_row_id', 'depends_on'];
  const copy = value => structuredClone(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
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
      this.closed = false; this.writing = 0; this.requests = new Set(); this.workspaceSource = copy(profile.workspace || {}); this.pages = new Map(); this.delay = 1000;
      this.online = () => this.sync().catch(error => this.report(error));
      this.queueChanged = event => { if (!this.closed && event.detail?.profileId === this.profile.id && !this.writing) { this.changed({ reason: 'queue' }).catch(error => this.report(error)); this.schedule(); } };
      this.profileCleared = event => { if (!this.closed && event.detail?.profileId === this.profile.id) { this.close(); this.denied({ status: 401, kind: 'session', message: '로그인이 종료되었습니다.' }); } };
      this.profileChanged = async () => { const current = await this.offline.getProfile().catch(() => null); if (!this.closed && current?.id !== this.profile.id) { this.close(); this.denied({ status: 401, kind: 'session', switched: true, message: '다른 로그인으로 전환되었습니다.' }); } };
      addEventListener('online', this.online); addEventListener('fountain-offline-mutations-changed', this.queueChanged);
      addEventListener('fountain-offline-profile-cleared', this.profileCleared); addEventListener('fountain-offline-profile-changed', this.profileChanged);
      this.schedule();
    }
    report(error) { if (this.closed || error?.name === 'AbortError' || error?.code === 'STALE_CONTROLLER') return; try { this.onError(error); } catch { /* UI errors cannot undo an already durable change. */ } }
    denied(detail) { try { this.onDenied(detail); } catch { /* Keep authorization decisions independent of rendering. */ } }
    async guard() {
      require(!this.closed, '이 연결은 종료되었습니다.', 401, 'STALE_CONTROLLER');
      const current = await this.offline.getProfile();
      if (!current || current.id !== this.profile.id) { this.close(); this.denied({ status: 401, kind: 'session', switched: true, message: '기존 로그인에 저장한 변경입니다.' }); throw failure('로그인이 변경되었습니다.', 401, 'STALE_CONTROLLER'); }
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
      this.close(); await this.offline.clearProfile(this.profile).catch(() => {});
      this.denied({ status: error.status || 401, kind: 'session', switched, message: error.message });
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
      clearTimeout(this.timer); if (this.closed || !navigator.onLine) return;
      this.timer = setTimeout(async () => { try { if ((await this.records()).some(record => ACTIVE.has(record.status))) await this.sync(); } catch (error) { this.report(error); } }, delay);
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
    async export(id) {
      const records = await this.records(), selected = id ? this.closure(records, id) : records, pages = [];
      for (const record of selected) if (record.operation.kind === 'page.create') { const local = await this.localPage(record.operation.target_id); if (local) pages.push({ ...local, operations: await this.offline.pendingOperations(record.resourceKey), drafts: await this.offline.getDrafts(record.resourceKey) }); }
      return { format: 'fountain-mutation-recovery-v1', workspace_id: this.profile.workspaceId, member_id: this.profile.memberId, exported_at: new Date().toISOString(), records: copy(selected), localPages: pages };
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
          if (original.kind === 'row.create') { require(!row, '같은 ID의 항목이 이미 있습니다. 자동으로 ID를 바꾸지 않습니다.', 409, 'UNSUPPORTED_RECOVERY'); operation.base = { schema: this.schema(snapshot.database, original.body.properties || {}) }; }
          else if (original.kind === 'row.patch') {
            require(row, '항목이 없어 재적용할 수 없습니다.', 404, 'UNSUPPORTED_RECOVERY');
            operation.base = { schema: this.schema(snapshot.database, original.body.properties || {}), properties: Object.fromEntries(Object.keys(original.body.properties || {}).map(key => [key, copy(row.properties[key] ?? null)])), fields: Object.fromEntries(ROW_FIELDS.filter(key => own(original.body, key)).map(key => [key, copy(row[key] ?? (key === 'depends_on' ? [] : null))])) };
          } else {
            const replacement = this.deleteOperation(original.database_id, original.target_id, snapshot, virtual); operation.base_rows = replacement.base_rows; operation.depends_on = [...new Set([...operation.depends_on, ...replacement.depends_on])].slice(-50);
          }
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
      if (this.closed) return; this.closed = true; clearTimeout(this.timer);
      for (const request of this.requests) request.abort(); this.requests.clear();
      removeEventListener('online', this.online); removeEventListener('fountain-offline-mutations-changed', this.queueChanged);
      removeEventListener('fountain-offline-profile-cleared', this.profileCleared); removeEventListener('fountain-offline-profile-changed', this.profileChanged);
    }
  }
  globalThis.FountainMutations = Object.freeze({ Controller });
})();
