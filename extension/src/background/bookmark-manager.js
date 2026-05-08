/* global APIClient, APIError, StorageManager */
// Bookmark full-tree sync (portable UUID ids in the API for Chrome ↔ Firefox).
/* eslint-disable no-undef */
(function (globalScope) {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  function newUUID() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === 'function') {
      return globalScope.crypto.randomUUID();
    }
    return `bs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class BookmarkManager {
    constructor(service) {
      this.service = service;
      this.api = service.apiClient;
      this.storage = service.storage;
      this.ext = service.ext;
      this._debounce = null;
      this._pushInFlight = null;
      this._listenersAttached = false;
    }

    hasBookmarksAPI() {
      return !!(this.ext && this.ext.bookmarks && typeof this.ext.bookmarks.getTree === 'function');
    }

    async initialize() {
      if (!this.hasBookmarksAPI()) {
        return;
      }
      await this.setupAlarm();
      this.attachListeners();
    }

    async setupAlarm() {
      try {
        await this.ext.alarms.clear('bookmarkSync');
        const c = await this.storage.getConfig();
        if (c.bookmarkSyncEnabled === false) {
          return;
        }
        this.ext.alarms.create('bookmarkSync', { delayInMinutes: 2, periodInMinutes: 15 });
      } catch (e) {
        logger.warn('BookmarkManager: could not set alarm', e);
      }
    }

    attachListeners() {
      if (!this.hasBookmarksAPI()) {
        return;
      }
      if (this._listenersAttached) {
        return;
      }
      this._listenersAttached = true;
      const b = this.ext.bookmarks;
      const onChange = () => this.scheduleDebounce();
      b.onCreated.addListener(onChange);
      b.onRemoved.addListener((id) => {
        void this.onNativeRemoved(id);
        onChange();
      });
      b.onChanged.addListener(onChange);
      b.onMoved.addListener(onChange);
    }

    async onNativeRemoved(nativeId) {
      const s = String(nativeId);
      const maps = await this.storage.getBookmarkIdMaps();
      const u = maps.nativeToUUID && maps.nativeToUUID[s];
      if (u) {
        delete maps.nativeToUUID[s];
        if (maps.uuidToNative) delete maps.uuidToNative[u];
        await this.storage.setBookmarkIdMaps(maps);
      }
    }

    scheduleDebounce() {
      if (this._debounce) {
        clearTimeout(this._debounce);
      }
      this._debounce = setTimeout(() => {
        this._debounce = null;
        void this.markDirtyAndSync();
      }, 4000);
    }

    async markDirtyAndSync() {
      await this.storage.setBookmarkSyncState({ localDirty: true });
      const c = await this.storage.getConfig();
      if (c.bookmarkSyncEnabled === false) {
        return;
      }
      if (c.bookmarkSyncDirection === 'upload_only' || c.bookmarkSyncDirection === 'bidirectional') {
        void this.push().catch((e) => logger.warn('Bookmark push', e));
      }
    }

    async runSync() {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
        return;
      }
      const c = await this.storage.getConfig();
      if (c.bookmarkSyncEnabled === false) {
        return;
      }
      if (c.bookmarkSyncDirection === 'upload_only' || c.bookmarkSyncDirection === 'bidirectional') {
        const st = await this.storage.getBookmarkSyncState();
        if (st.localDirty) {
          await this.push();
        }
      }
      if (c.bookmarkSyncDirection === 'download_only' || c.bookmarkSyncDirection === 'bidirectional') {
        if (c.bookmarkSyncDirection === 'download_only' || !(await this.storage.getBookmarkSyncState()).localDirty) {
          await this.pull();
        }
      }
    }

    /**
     * Export flat nodes with stable UUIDs for API and server.
     */
    async buildNodesForServer() {
      const maps = await this.storage.getBookmarkIdMaps();
      const tree = await this.ext.bookmarks.getTree();
      const out = [];
      const nativeToUUID = { ...(maps.nativeToUUID || {}) };
      const uuidToNative = { ...(maps.uuidToNative || {}) };

      const visit = (nodes, _depth) => {
        if (!nodes) return;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (!n) continue;
          if (n.id === '0' || n.parentId == null) {
            if (n.children) visit(n.children, _depth);
            continue;
          }
          const nid = String(n.id);
          let uuid = nativeToUUID[nid];
          if (!uuid) {
            uuid = newUUID();
            nativeToUUID[nid] = uuid;
            uuidToNative[uuid] = nid;
          }
          let parentUUID = null;
          if (n.parentId != null && n.parentId !== '') {
            const pid = String(n.parentId);
            if (pid === '0') {
              parentUUID = null;
            } else {
              parentUUID = nativeToUUID[pid];
              if (!parentUUID) {
                parentUUID = newUUID();
                nativeToUUID[pid] = parentUUID;
                uuidToNative[parentUUID] = pid;
              }
            }
          }
          out.push({
            id: uuid,
            parentId: parentUUID,
            title: n.title || '',
            url: n.url != null && n.url !== '' ? n.url : null,
            position: i
          });
          if (n.children && n.children.length) {
            visit(n.children, _depth + 1);
          }
        }
      };

      if (tree && tree[0] && tree[0].children) {
        visit(tree[0].children, 0);
      }

      await this.storage.setBookmarkIdMaps({ nativeToUUID, uuidToNative });
      return { nodes: out, maps: { nativeToUUID, uuidToNative } };
    }

    async push() {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
        return;
      }
      if (this._pushInFlight) {
        return this._pushInFlight;
      }
      this._pushInFlight = this._doPush();
      try {
        await this._pushInFlight;
      } finally {
        this._pushInFlight = null;
      }
    }

    async _doPush() {
      const { nodes } = await this.buildNodesForServer();
      const st = await this.storage.getBookmarkSyncState();
      const body = {
        base_version: st.lastServerVersion != null ? st.lastServerVersion : 0,
        nodes
      };
      let res;
      try {
        res = await this.api.putBookmarks(body);
      } catch (e) {
        if (e && e.name === 'APIError' && e.statusCode === 409 && e.body) {
          res = await this._handle409(e.body, body);
          if (res == null) {
            return;
          }
        } else {
          await this.storage.setBookmarkSyncState({ lastError: (e && e.message) || 'push_failed' });
          throw e;
        }
      }
      const v =
        res && typeof res === 'object' && res.version != null
          ? res.version
          : Number((res && res.version) != null ? res.version : res) || 0;
      await this.storage.setBookmarkSyncState({
        lastServerVersion: v,
        localDirty: false,
        lastSyncedAt: Date.now(),
        lastError: null,
        pendingConflict: null
      });
    }

    /**
     * @returns {Promise<object|null>} response body or null (handled or prompt)
     */
    async _handle409(conflict, body) {
      const cfg = await this.storage.getConfig();
      const act = cfg.bookmarkConflictAction || 'prompt';
      const del = (await this._deletePolicy()) === 'match_server';
      if (act === 'use_server' || (act === 'auto_prefer' && cfg.bookmarkAutoResolution === 'server_wins')) {
        await this.applyFromServer(
          conflict.server_version,
          conflict.nodes || [],
          { deleteOrphans: del }
        );
        await this.storage.setBookmarkSyncState({
          localDirty: false,
          lastError: null,
          pendingConflict: null,
          lastServerVersion: conflict.server_version
        });
        return null;
      }
      if (act === 'use_local' || (act === 'auto_prefer' && cfg.bookmarkAutoResolution === 'local_wins')) {
        const next = { ...body, base_version: conflict.server_version };
        return await this.api.putBookmarks(next);
      }
      await this.storage.setBookmarkSyncState({ pendingConflict: conflict, lastError: 'version_conflict' });
      return null;
    }

    /**
     * @param {string} [policy] match_server | keep_local
     */
    async _deletePolicy(policy) {
      const c = await this.storage.getConfig();
      return policy || c.bookmarkDeletePolicy || 'match_server';
    }

    async pull() {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
        return;
      }
      const raw = await this.api.getBookmarks();
      const version = raw.version != null ? raw.version : 0;
      const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
      const st = await this.storage.getBookmarkSyncState();
      if (version === st.lastServerVersion) {
        return;
      }
      if (st.localDirty) {
        return;
      }
      await this.applyFromServer(version, nodes, { deleteOrphans: (await this._deletePolicy()) === 'match_server' });
    }

    /**
     * Apply server list (UUID parent ids) to the local profile.
     */
    async applyFromServer(version, nodes, opts) {
      const deleteOrphans = opts && opts.deleteOrphans;
      const byId = new Map();
      for (const n of nodes) {
        if (n && n.id) {
          byId.set(n.id, n);
        }
      }
      if (nodes.length === 0) {
        await this.storage.setBookmarkSyncState({ lastServerVersion: version, lastSyncedAt: Date.now() });
        return;
      }

      const maps = await this.storage.getBookmarkIdMaps();
      const uuidToNative = { ...(maps.uuidToNative || {}) };
      const nativeToUUID = { ...(maps.nativeToUUID || {}) };

      const topParentId = await this.getDefaultParentId();
      const depthMemo = new Map();
      const depth = (id) => {
        if (depthMemo.has(id)) {
          return depthMemo.get(id);
        }
        const n = byId.get(id);
        if (!n) {
          depthMemo.set(id, 999);
          return 999;
        }
        const p = n.parentId;
        if (p == null || p === '') {
          depthMemo.set(id, 0);
          return 0;
        }
        const d = 1 + depth(p);
        depthMemo.set(id, d);
        return d;
      };

      const ordered = [...nodes].sort((a, b) => {
        const da = depth(a.id);
        const db = depth(b.id);
        if (da !== db) {
          return da - db;
        }
        return (a.position || 0) - (b.position || 0);
      });

      for (const n of ordered) {
        if (!n || !n.id) {
          continue;
        }
        const local = uuidToNative[n.id] ? String(uuidToNative[n.id]) : null;
        const parentIdForCreate = n.parentId && uuidToNative[n.parentId] ? String(uuidToNative[n.parentId]) : topParentId;

        if (local) {
          try {
            const cur = (await this.ext.bookmarks.get(local))[0];
            if (cur) {
              const isFolder = !n.url || n.url === '';
              const updates = { title: n.title || '' };
              if (!isFolder) {
                updates.url = n.url;
              }
              if (String(cur.parentId) !== String(parentIdForCreate)) {
                try {
                  await this.ext.bookmarks.move(local, { parentId: parentIdForCreate, index: n.position || 0 });
                } catch (e) {
                  logger.warn('Bookmark move', e);
                }
              }
              try {
                await this.ext.bookmarks.update(local, updates);
              } catch (e) {
                logger.warn('Bookmark update', e);
              }
            } else {
              await this._create(n, parentIdForCreate, n.position || 0, uuidToNative, nativeToUUID);
            }
          } catch {
            await this._create(n, parentIdForCreate, n.position || 0, uuidToNative, nativeToUUID);
          }
        } else {
          await this._create(n, parentIdForCreate, n.position || 0, uuidToNative, nativeToUUID);
        }
      }

      if (deleteOrphans) {
        const serverSet = new Set(nodes.map((x) => x && x.id).filter(Boolean));
        for (const u of Object.keys(uuidToNative)) {
          if (!serverSet.has(u)) {
            const nid = uuidToNative[u];
            if (nid) {
              try {
                await this.ext.bookmarks.remove(nid);
              } catch (e) {
                logger.warn('Bookmark orphan remove', e);
              }
            }
            delete uuidToNative[u];
            if (nativeToUUID[nid]) {
              delete nativeToUUID[nid];
            }
          }
        }
      }

      for (const u of Object.keys(uuidToNative)) {
        const nid = uuidToNative[u];
        if (nid) {
          nativeToUUID[nid] = u;
        }
      }

      await this.storage.setBookmarkIdMaps({ nativeToUUID, uuidToNative });
      await this.storage.setBookmarkSyncState({ lastServerVersion: version, lastSyncedAt: Date.now(), lastError: null, localDirty: false });
    }

    async _create(n, parentId, index, uuidToNative, nativeToUUID) {
      const isFolder = !n.url || n.url === '';
      const created = await this.ext.bookmarks.create({
        parentId,
        index,
        title: n.title || '',
        url: isFolder ? undefined : n.url
      });
      const newId = String(created.id);
      uuidToNative[n.id] = newId;
      nativeToUUID[newId] = n.id;
    }

    async getDefaultParentId() {
      const t = await this.ext.bookmarks.getTree();
      const root = t && t[0];
      const ch = (root && root.children) || [];
      if (ch[0]) {
        return String(ch[0].id);
      }
      return '1';
    }

    async resolveConflict(choice) {
      const st = await this.storage.getBookmarkSyncState();
      const p = st.pendingConflict;
      if (!p) {
        return { ok: false, error: 'no_conflict' };
      }
      if (choice === 'use_server' || choice === 'server') {
        const nodes = p.nodes || [];
        const sv = p.serverVersion != null ? p.serverVersion : p.server_version;
        await this.applyFromServer(sv, nodes, { deleteOrphans: (await this._deletePolicy()) === 'match_server' });
        await this.storage.setBookmarkSyncState({ pendingConflict: null, lastError: null });
        return { ok: true };
      }
      if (choice === 'use_local' || choice === 'local') {
        const { nodes } = await this.buildNodesForServer();
        const sv = p.serverVersion != null ? p.serverVersion : p.server_version;
        const body = { base_version: sv, nodes };
        const res = await this.api.putBookmarks(body);
        const ver = res && (res.version != null ? res.version : res);
        const v = typeof ver === 'object' && ver && ver.version != null ? ver.version : Number(ver) || 0;
        await this.storage.setBookmarkSyncState({
          lastServerVersion: v,
          localDirty: false,
          pendingConflict: null,
          lastError: null
        });
        return { ok: true, version: v };
      }
      return { ok: false, error: 'unknown_choice' };
    }
  }

  globalScope.BookmarkManager = BookmarkManager;
})(typeof self !== 'undefined' ? self : window);
