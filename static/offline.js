/* Durable private drafts. Keys always include origin, workspace and signed-in actor. */
(() => {
  'use strict';
  const DATABASE = 'fountain-offline-v1';
  const STORES = ['profiles', 'meta', 'snapshots', 'operations', 'drafts'];
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
    return `${location.origin}|${identifier(profile.workspaceId, 'workspace')}|${identifier(profile.memberId, 'member')}|${identifier(binding, 'session binding')}`;
  }
  function key(profile, pageId) {
    return `${namespace(profile)}|${identifier(pageId, 'page')}`;
  }
  function open() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('Offline storage is unavailable'));
    if (!connection) connection = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DATABASE, 1);
      opening.onupgradeneeded = () => {
        const database = opening.result;
        database.createObjectStore('profiles', { keyPath: 'id' });
        database.createObjectStore('meta', { keyPath: 'id' });
        for (const [name, keyPath] of [['snapshots', 'key'], ['operations', ['key', 'id']], ['drafts', ['key', 'clientId']]]) {
          database.createObjectStore(name, { keyPath }).createIndex('profileId', 'profileId');
          if (name !== 'snapshots') opening.transaction.objectStore(name).createIndex('key', 'key');
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
    return profile && profile.origin === location.origin && Number.isFinite(profile.validUntil)
      && profile.validUntil > Date.now() ? profile : null;
  }
  function matches(profile, resourceKey) {
    if (!profile || typeof resourceKey !== 'string') return false;
    const parts = resourceKey.split('|');
    return parts.length === 5 && parts[4].length > 0 && parts.slice(0, 4).join('|') === profile.id;
  }
  async function scoped(resourceKey, storeName, mode, callback, fallback) {
    return transaction(['profiles', 'meta', storeName], mode, async tx => {
      const profile = await active(tx);
      if (!matches(profile, resourceKey)) {
        if (mode === 'readwrite') throw new DOMException('Offline profile is expired or does not match', 'SecurityError');
        return fallback;
      }
      if (await request(tx.objectStore('meta').get('revoked-resource:' + resourceKey))) {
        if (mode === 'readwrite') throw new DOMException('Offline page access was revoked for this login', 'SecurityError');
        return fallback;
      }
      return callback(tx.objectStore(storeName), profile);
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
    const profile = { id, origin: location.origin, workspaceId: input.workspaceId, memberId: input.memberId,
      cacheBinding: session.cache_binding,
      session: copy(safeSession), workspace: copy(input.workspace), validUntil, updatedAt: Date.now() };
    return transaction(['profiles', 'meta'], 'readwrite', async tx => {
      if (await request(tx.objectStore('meta').get('revoked:' + id))) {
        throw new DOMException('Offline session was logged out', 'SecurityError');
      }
      if (Array.isArray(profile.workspace?.pages)) {
        const pages = [];
        for (const page of profile.workspace.pages) {
          if (typeof page.id === 'string' && !await request(tx.objectStore('meta').get('revoked-resource:' + key(profile, page.id)))) pages.push(page);
        }
        profile.workspace.pages = pages;
      }
      tx.objectStore('profiles').put(profile);
      tx.objectStore('meta').put({ id: 'active', profileId: id });
      return copy(profile);
    });
  }
  function getProfile() {
    return transaction(['profiles', 'meta'], 'readonly', active);
  }
  function saveSnapshot(resourceKey, snapshot) {
    const value = copy(snapshot);
    return scoped(resourceKey, 'snapshots', 'readwrite', async (store, profile) => {
      const previous = (await request(store.get(resourceKey)))?.snapshot;
      if (previous && value) {
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
  function removeIndexed(store, profileId) {
    return new Promise((resolve, reject) => {
      const cursor = store.index('profileId').openCursor(IDBKeyRange.only(profileId));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) { resolve(); return; }
        cursor.result.delete();
        cursor.result.continue();
      };
    });
  }
  async function purge(tx, profileId) {
    for (const name of ['snapshots', 'operations', 'drafts']) await removeIndexed(tx.objectStore(name), profileId);
    tx.objectStore('profiles').delete(profileId);
    const pointer = await request(tx.objectStore('meta').get('active'));
    if (pointer?.profileId === profileId) tx.objectStore('meta').delete('active');
  }
  const logoutChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fountain-offline') : null;
  function announce(profileId, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-profile-cleared', { detail: { profileId } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'profile-cleared', profileId });
  }
  function resourcePurged(resourceKey, broadcast = true) {
    globalThis.dispatchEvent(new CustomEvent('fountain-offline-resource-purged', { detail: { key: resourceKey } }));
    if (broadcast) logoutChannel?.postMessage({ type: 'resource-purged', key: resourceKey });
  }
  if (logoutChannel) logoutChannel.onmessage = event => {
    if (event.data?.type === 'profile-cleared' && typeof event.data.profileId === 'string') announce(event.data.profileId, false);
    if (event.data?.type === 'resource-purged' && typeof event.data.key === 'string') resourcePurged(event.data.key, false);
  };
  async function purgeResource(resourceKey) {
    await transaction(STORES, 'readwrite', async tx => {
      const profile = await active(tx);
      if (!matches(profile, resourceKey)) throw new DOMException('Offline profile does not match', 'SecurityError');
      // Durable fence: another tab's late network response cannot recreate this page.
      tx.objectStore('meta').put({ id: 'revoked-resource:' + resourceKey, revokedAt: Date.now() });
      tx.objectStore('snapshots').delete(resourceKey);
      for (const name of ['operations', 'drafts']) {
        await new Promise((resolve, reject) => {
          const cursor = tx.objectStore(name).index('key').openCursor(IDBKeyRange.only(resourceKey));
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            if (!cursor.result) { resolve(); return; }
            cursor.result.delete();
            cursor.result.continue();
          };
        });
      }
      if (Array.isArray(profile.workspace?.pages)) {
        const pageId = decodeURIComponent(resourceKey.split('|')[4]);
        profile.workspace.pages = profile.workspace.pages.filter(page => page.id !== pageId);
        tx.objectStore('profiles').put(profile);
      }
    });
    resourcePurged(resourceKey);
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
    await transaction(STORES, 'readwrite', tx => purgeActor(tx, id));
    announce(id);
  }
  async function clearActiveProfile() {
    const id = await transaction(STORES, 'readwrite', async tx => {
      const pointer = await request(tx.objectStore('meta').get('active'));
      return pointer ? purgeActor(tx, pointer.profileId) : null;
    });
    if (id) announce(id);
  }
  const serviceWorkerReady = globalThis.isSecureContext && 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);
  globalThis.FountainOffline = Object.freeze({ available: !!globalThis.indexedDB,
    key, saveProfile, getProfile, saveSnapshot, getSnapshot, listSnapshots,
    putOperations, pendingOperations, acknowledge, saveDraft, getDrafts,
    clearProfile, clearActiveProfile, purgeResource, serviceWorkerReady });
})();
