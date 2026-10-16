/* Durable private drafts. Keys always include origin, workspace and signed-in actor. */
(() => {
  'use strict';
  const SERVER_ORIGIN=globalThis.FountainTransport?.origin||location.origin;
  const DATABASE = 'fountain-offline-v1';
  const STORES = ['profiles', 'meta', 'snapshots', 'operations', 'drafts', 'databaseSnapshots', 'mutations', 'localPages'];
  const LOCAL_TTL = 24 * 60 * 60 * 1000;
  let connection;
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
      const opening = indexedDB.open(DATABASE, 2);
      opening.onupgradeneeded = () => {
        const database = opening.result;
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
    const pointer = await request(tx.objectStore('meta').get('active'));
    if (!pointer) return null;
    const profile = await request(tx.objectStore('profiles').get(pointer.profileId));
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
    const safeSession = Object.fromEntries(['enabled', 'required', 'authenticated', 'mode', 'identity', 'expires_at', 'workspace_id', 'cache_binding']
      .filter(field => Object.hasOwn(session, field)).map(field => [field, session[field]]));
    safeSession.member = safeMember;
    const profile = { id, origin: SERVER_ORIGIN, workspaceId: input.workspaceId, memberId: input.memberId,
      cacheBinding: session.cache_binding,
      session: copy(safeSession), workspace: copy(input.workspace), validUntil, updatedAt: Date.now() };
    let changed = false;
    const saved = await transaction(STORES, 'readwrite', async tx => {
      if (await request(tx.objectStore('meta').get('revoked:' + id))) {
        throw new DOMException('Offline session was logged out', 'SecurityError');
      }
      const previous = await request(tx.objectStore('meta').get('active'));
      changed = previous?.profileId !== id;
      if (previous && previous.profileId !== id) {
        tx.objectStore('meta').put({ id: 'revoked:' + previous.profileId, revokedAt: Date.now() });
        await purge(tx, previous.profileId);
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
      tx.objectStore('meta').put({ id: 'active', profileId: id });
      return copy(profile);
    });
    if (changed) profileChanged(id);
    return saved;
  }
  function getProfile() {
    return transaction(['profiles', 'meta'], 'readonly', active);
  }
  function saveSnapshot(resourceKey, snapshot) {
    const value = copy(snapshot);
    return scoped(resourceKey, 'snapshots', 'readwrite', async (store, profile) => {
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
        if (nextAccess < previousAccess) return;
        if (previous.epoch === value.epoch && Number.isSafeInteger(previous.seq)
            && Number.isSafeInteger(value.seq) && value.seq < previous.seq) return;
        if (Number.isSafeInteger(previous.page?.revision) && Number.isSafeInteger(value.page?.revision)
            && value.page.revision < previous.page.revision) return;
      }
      store.put({ key: resourceKey, profileId: profile.id, snapshot: value, updatedAt: Date.now() });
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
        store.delete([current.id, id]);
      }
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
  function removeIndexed(store, value, index = 'profileId') {
    return new Promise((resolve, reject) => {
      const cursor = store.index(index).openCursor(IDBKeyRange.only(value));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) { resolve(); return; }
        cursor.result.delete();
        cursor.result.continue();
      };
    });
  }
  async function purge(tx, profileId) {
    for (const name of STORES.filter(name => !['profiles', 'meta'].includes(name))) await removeIndexed(tx.objectStore(name), profileId);
    tx.objectStore('profiles').delete(profileId);
    const pointer = await request(tx.objectStore('meta').get('active'));
    if (pointer?.profileId === profileId) tx.objectStore('meta').delete('active');
  }
  const logoutChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fountain-offline') : null;
  function announce(profileId, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-profile-cleared', { detail: { profileId } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'profile-cleared', profileId });
  }
  function profileChanged(profileId, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-profile-changed', { detail: { profileId } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'profile-changed', profileId });
  }
  function resourcePurged(resourceKey, broadcast = true) {
    const parts = resourceKey.split('|'), kind = parts.length === 6 && parts[4] === 'database' ? 'database' : 'page';
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-resource-purged', { detail: { key: resourceKey, kind } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'resource-purged', key: resourceKey });
  }
  function mutationsChanged(profileId, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-mutations-changed', { detail: { profileId } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'mutations-changed', profileId });
  }
  function localPagesChanged(resourceKey, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-local-pages-changed', { detail: { key: resourceKey } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'local-pages-changed', key: resourceKey });
  }
  if (logoutChannel) logoutChannel.onmessage = event => {
    if (event.data?.type === 'profile-cleared' && typeof event.data.profileId === 'string') announce(event.data.profileId, false);
    if (event.data?.type === 'resource-purged' && typeof event.data.key === 'string') resourcePurged(event.data.key, false);
    if (event.data?.type === 'profile-changed' && typeof event.data.profileId === 'string') profileChanged(event.data.profileId, false);
    if (event.data?.type === 'mutations-changed' && typeof event.data.profileId === 'string') mutationsChanged(event.data.profileId, false);
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
            cursor.result.delete();
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
          cursor.result.update({ ...record, status: 'denied', recovery: { reason: 'resource_revoked', at: Date.now() }, updatedAt: Date.now() });
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
    const profiles = await request(tx.objectStore('profiles').getAll());
    const ids = new Set([profileId, ...profiles.filter(profile => profile.id.startsWith(prefix)).map(profile => profile.id)]);
    for (const id of ids) {
      tx.objectStore('meta').put({ id: 'revoked:' + id, revokedAt: Date.now() });
      await purge(tx, id);
    }
    return profileId;
  }
  async function clearProfile(profile) {
    const id = namespace(profile);
    await transaction(STORES, 'readwrite', async tx => {
      tx.objectStore('meta').put({ id: 'revoked:' + id, revokedAt: Date.now() });
      await purge(tx, id);
    });
    announce(id);
  }
  async function clearActiveProfile() {
    const id = await transaction(STORES, 'readwrite', async tx => {
      const pointer = await request(tx.objectStore('meta').get('active'));
      return pointer ? purgeActor(tx, pointer.profileId) : null;
    });
    if (id) announce(id);
  }
  const serviceWorkerReady = !globalThis.FountainTransport?.native && globalThis.isSecureContext && 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);
  globalThis.FountainOffline = Object.freeze({ available: !!globalThis.indexedDB,
    key, databaseKey, saveProfile, getProfile, saveSnapshot, getSnapshot, listSnapshots,
    saveDatabase, getDatabase, listDatabases, putMutation, putMutations, listMutations, pendingMutations,
    updateMutation, acknowledgeMutations, removeMutation, replaceMutations, discardMutations, stageLocalPage,
    saveLocalPage, getLocalPage, listLocalPages, deleteLocalPage,
    putOperations, pendingOperations, acknowledge, saveDraft, getDrafts,
    clearProfile, clearActiveProfile, purgeResource, serviceWorkerReady });
})();
