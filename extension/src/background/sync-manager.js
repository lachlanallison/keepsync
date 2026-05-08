// Sync Manager - Handles synchronization with the server
(function (globalScope) {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  class SyncManager {
  constructor(backgroundService) {
    this.backgroundService = backgroundService;
    this.storage = backgroundService.storage;
    this.apiClient = backgroundService.apiClient;
    this.tabManager = backgroundService.tabManager;
    
    this.syncTimeout = null;
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.lastServerVersion = 0;
    this.syncBackoffMs = 1000; // Start with 1 second
    this.maxBackoffMs = 300000; // Max 5 minutes
    // Tab events (onUpdated) can fire many times per second; 300ms caused a full
    // doSync (events+snapshot+remote+history) for each burst. Coalesce to ~1s.
    this.debounceMs = 1000;
    this._lastSnapshotSignature = null;
    this._lastHistoryCacheAt = 0;
    this._lastRemoteTabsAt = 0;
    /** When true, doSync must not skip snapshot/history/remote throttles. */
    this._forceFullSync = false;
  }

  async initialize() {
    logger.log('Initializing sync manager...');
    
    // Load last sync time
    const syncState = await this.storage.getSyncState();
    if (syncState) {
      this.lastSyncTime = new Date(syncState.lastSyncTime);
      this.lastServerVersion = syncState.lastServerVersion || 0;
      logger.log('Last sync time:', this.lastSyncTime);
    }

    const act = await this.storage.get('lastExtensionActivityAt', 0);
    if (!act) {
      await this.storage.set('lastExtensionActivityAt', Date.now());
    }
  }

  async queueSync() {
    // Debounce sync requests to avoid excessive API calls
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(() => {
      void this.performSync().catch((e) => logger.error('queueSync:', e));
    }, this.debounceMs);
  }

  async performSync(options = {}) {
    if (this.isSyncing) {
      logger.log('Sync already in progress, skipping');
      return { skipped: true };
    }

    const config = await this.storage.getConfig();
    if (!config.serverUrl || !config.deviceToken) {
      logger.log('Server not configured, skipping sync');
      return { error: 'Not configured' };
    }

    this._forceFullSync = options.full === true;

    logger.log('Starting sync...');
    this.isSyncing = true;

    try {
      const result = await this.doSync();
      
      // Reset backoff on successful sync
      this.syncBackoffMs = 1000;
      
      // Update last sync time; successful sync implies server is reachable
      this.lastSyncTime = new Date();
      await this.storage.setSyncState({
        lastSyncTime: this.lastSyncTime.toISOString(),
        lastSyncResult: result,
        lastServerVersion: this.lastServerVersion || 0,
        serverReachable: true,
        lastHeartbeatAt: this.lastSyncTime.toISOString(),
        lastServerError: null
      });

      logger.log('Sync completed successfully:', result);
      return result;

    } catch (error) {
      logger.error('Sync failed:', error);

      // Implement exponential backoff for failed syncs
      this.syncBackoffMs = Math.min(this.syncBackoffMs * 2, this.maxBackoffMs);
      
      // Schedule retry
      setTimeout(() => {
        void this.performSync().catch((e) => logger.error('sync retry:', e));
      }, this.syncBackoffMs);

      return { error: error.message };
    } finally {
      this._forceFullSync = false;
      this.isSyncing = false;
    }
  }

  async doSync() {
    const result = {
      snapshotSynced: false,
      eventsSynced: 0,
      remoteTabs: 0,
      quotaStatus: null
    };

    const previousServerVersion = this.lastServerVersion || 0;

    // Step 1: Queued tab events *before* snapshot. If the snapshot runs first,
    // tabs_current gets a fresh server UpdatedAt; each queued create/update
    // has a client occurred_at from slightly earlier, so the server would
    // treat every event as strictly older than the row we just wrote — endless
    // "conflict" history and lost navigation (e.g. Google before Kmart).
    const queuedEvents = await this.tabManager.getQueuedEvents();
    const nQueued = queuedEvents.length;
    /** When true, tab events were POSTed and ack'd this pass — skip chrome.history backfill to avoid duplicate rows. */
    let skipHistoryBackfillThisSync = false;
    if (nQueued > 0) {
      const eventsResponse = await this.apiClient.uploadEvents({
        events: queuedEvents
      });

      const applied = eventsResponse.appliedCount;
      const conflicts = eventsResponse.conflictsCreated;
      result.eventsSynced = applied;
      this.updateServerVersion(eventsResponse.serverVersion);

      if (eventsResponse.acknowledged) {
        await this.tabManager.clearEventQueue();
        skipHistoryBackfillThisSync = true;
      }

      if (applied === 0 && nQueued > 0 && eventsResponse.acknowledged) {
        logger.info(
          '[KeepSync:history] doSync: event upload acknowledged; no new history row (server dedup / no-op)',
          { queued: nQueued, conflicts }
        );
      } else if (applied > 0) {
        logger.info('[KeepSync:history] doSync:queue cleared after upload', {
          queued: nQueued,
          applied,
          conflicts
        });
      } else {
        logger.warn(
          '[KeepSync:history] 0 events applied, queue not cleared — check service worker + server',
          { queued: nQueued, acknowledged: eventsResponse.acknowledged }
        );
      }
    }

    const eventsApplied = result.eventsSynced;

    // Step 2: Full tab snapshot. Uses base_version so another device's newer
    // state can reject; on 409 we pull and retry. Must run *after* events so
    // event apply order matches client navigation order.
    const snapshot = await this.tabManager.captureCurrentSnapshot();
    let snapshotDidUpload = false;
    if (snapshot.length > 0) {
      const sig = this.computeSnapshotSignature(snapshot);
      const skipSnapshot =
        !this._forceFullSync &&
        nQueued === 0 &&
        this._lastSnapshotSignature != null &&
        sig === this._lastSnapshotSignature;
      if (skipSnapshot) {
        if (typeof logger !== 'undefined' && logger.info) {
          logger.info('[KeepSync:sync] doSync: skip POST /tabs/snapshot (tab state unchanged since last upload)');
        }
      } else {
        const snapshotResponse = await this.uploadSnapshotWithConflictRetry(
          snapshot,
          this.lastServerVersion || 0
        );
        if (snapshotResponse) {
          snapshotDidUpload = true;
          result.snapshotSynced = true;
          result.quotaStatus = snapshotResponse.quotaStatus || snapshotResponse.quota_status || null;
          this.updateServerVersion(snapshotResponse?.server_version || snapshotResponse?.serverVersion);
          if (typeof logger !== 'undefined' && logger.log) {
            logger.log('Snapshot uploaded:', snapshotResponse);
          }
        }
        this._lastSnapshotSignature = sig;
      }
    }

    // Step 3: Download remote tabs (incremental when we already have a cache).
    // Throttle idle syncs: other devices rarely need sub‑30s refresh.
    const needRemote =
      this._forceFullSync ||
      nQueued > 0 ||
      eventsApplied > 0 ||
      snapshotDidUpload ||
      !this._lastRemoteTabsAt ||
      Date.now() - this._lastRemoteTabsAt > 30000;
    if (needRemote) {
      try {
        const sincePull = await this.getSinceVersionForRemoteTabPull(
          this.lastServerVersion || previousServerVersion
        );
        const remoteTabsResponse = await this.apiClient.getCurrentTabs(sincePull);
        this._lastRemoteTabsAt = Date.now();
        if (remoteTabsResponse && remoteTabsResponse.devices) {
          const mergedDevices = await this.mergeRemoteTabs(remoteTabsResponse.devices, sincePull);
          result.remoteTabs = mergedDevices.reduce(
            (total, device) => total + device.tabs.length,
            0
          );

          this.updateServerVersion(
            this.getMaxVersion(remoteTabsResponse.devices, previousServerVersion)
          );

          if (typeof logger !== 'undefined' && logger.log) {
            logger.log('Remote tabs downloaded:', result.remoteTabs);
          }
        }
      } catch (error) {
        // Don't fail entire sync if remote tabs fetch fails
        logger.warn('Failed to fetch remote tabs:', error);
      }
    } else if (typeof logger !== 'undefined' && logger.info) {
      logger.info('[KeepSync:sync] doSync: skip GET /tabs/current (throttled, nothing new to pull)');
    }

    // Step 4: Cache recent /history for the options page. Throttle: opening one
    // page should not N× GET /history; refresh when events land or every 2 min.
    const needHistory =
      this._forceFullSync ||
      eventsApplied > 0 ||
      !this._lastHistoryCacheAt ||
      Date.now() - this._lastHistoryCacheAt > 120000;
    if (needHistory) {
      try {
        const hist = await this.apiClient.getHistory({ limit: 200 });
        const n = Array.isArray(hist?.items) ? hist.items.length : 0;
        this._lastHistoryCacheAt = Date.now();
        if (n > 0) {
          await this.storage.setHistoryEventsCache(hist.items);
          logger.info('[KeepSync:history] doSync:cache updated', n, 'row(s) from GET /history');
        } else {
          logger.warn(
            '[KeepSync:history] doSync:GET /history returned 0 items — if History is empty, visit a few http(s) pages and check POST /tabs/events (applied) in service worker'
          );
        }
      } catch (e) {
        logger.warn('[KeepSync:history] doSync: cache refresh failed', e);
      }
    } else if (typeof logger !== 'undefined' && logger.info) {
      logger.info('[KeepSync:sync] doSync: skip GET /history (throttled, no new events this sync)');
    }

    await this.maybeBackfillBrowserHistory({
      skipBecauseTabQueueFlushed: skipHistoryBackfillThisSync
    });

    return result;
  }

  async getSyncStatus() {
    const config = await this.storage.getConfig();
    const syncState = await this.storage.getSyncState();
    const queuedEvents = await this.tabManager.getQueuedEvents();
    const tabStats = await this.tabManager.getTabStats();

    return {
      configured: !!(config.serverUrl && config.deviceToken),
      lastSyncTime: this.lastSyncTime?.toISOString() || syncState?.lastSyncTime || null,
      isSyncing: this.isSyncing,
      queuedEvents: queuedEvents.length,
      backoffMs: this.syncBackoffMs,
      tabStats,
      lastSyncResult: syncState?.lastSyncResult || null,
      lastServerVersion: this.lastServerVersion || 0,
      serverUrl: config.serverUrl || null,
      online: typeof navigator !== 'undefined' ? navigator.onLine : true,
      serverReachable: syncState?.serverReachable,
      lastHeartbeatAt: syncState?.lastHeartbeatAt || null,
      lastServerError: syncState?.lastServerError || null
    };
  }

  /**
   * Lightweight unauthenticated /healthz check. Updates syncState so UI can
   * show "server unreachable" even when the browser is online.
   */
  async runHeartbeat() {
    const config = await this.storage.getConfig();
    if (!config.serverUrl) {
      return { ok: false, skipped: true };
    }

    this.apiClient.setServerUrl(config.serverUrl);
    const now = new Date().toISOString();
    try {
      await this.apiClient.healthCheck();
      await this.storage.setSyncState({
        serverReachable: true,
        lastHeartbeatAt: now,
        lastServerError: null
      });
      return { ok: true };
    } catch (error) {
      const message = (error && error.message) || 'Server unreachable';
      await this.storage.setSyncState({
        serverReachable: false,
        lastHeartbeatAt: now,
        lastServerError: message
      });
      return { ok: false, error: message };
    }
  }

  // Manual sync triggered by user
  async forcSync() {
    logger.log('Manual sync requested');
    
    // Clear any pending debounced sync
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }

    // Reset backoff for manual sync
    const originalBackoff = this.syncBackoffMs;
    this.syncBackoffMs = 1000;

    try {
      return await this.performSync({ full: true });
    } finally {
      // Restore backoff if sync failed
      if (this.syncBackoffMs > 1000) {
        this.syncBackoffMs = originalBackoff;
      }
    }
  }

  // Check if we should perform a full resync
  async shouldResync() {
    const config = await this.storage.getConfig();
    if (!config.serverUrl || !config.deviceToken) {
      return false;
    }

    // Resync if we haven't synced in over an hour
    if (!this.lastSyncTime) {
      return true;
    }

    const hoursSinceSync = (Date.now() - this.lastSyncTime.getTime()) / (1000 * 60 * 60);
    return hoursSinceSync > 1;
  }

  // Get network status info
  getNetworkInfo() {
    return {
      online: navigator.onLine,
      connection: navigator.connection ? {
        effectiveType: navigator.connection.effectiveType,
        rtt: navigator.connection.rtt,
        downlink: navigator.connection.downlink
      } : null
    };
  }

  updateServerVersion(version) {
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      return;
    }
    if (version > this.lastServerVersion) {
      this.lastServerVersion = version;
    }
  }

  /**
   * Cheap fingerprint of open tabs to skip redundant snapshot uploads when
   * the fast sync loop runs while the user is idle.
   */
  computeSnapshotSignature(tabs) {
    if (!tabs || !tabs.length) {
      return '';
    }
    const parts = tabs
      .map((t) => {
        const id = t.tabId != null ? t.tabId : t.tab_id;
        return `${id != null ? id : 0}\t${String(t.url || '').trim()}\t${String(t.title || '').trim()}`;
      })
      .sort();
    return parts.join('\n');
  }

  // uploadSnapshotWithConflictRetry tries a snapshot upload with the
  // supplied base_version; on 409 it refreshes from /tabs/current and
  // retries once with the latest server version. We cap at a single retry
  // to avoid pathological loops when the server is moving faster than we
  // can upload.
  async uploadSnapshotWithConflictRetry(tabs, previousServerVersion) {
    const tryUpload = async (baseVersion) => {
      const payload = {
        version: Date.now(),
        tabs
      };
      if (baseVersion > 0) {
        payload.baseVersion = baseVersion;
      }
      return await this.apiClient.uploadSnapshot(payload);
    };

    try {
      return await tryUpload(previousServerVersion);
    } catch (error) {
      const is409 = error && (error.statusCode === 409 || error.status === 409);
      if (!is409) {
        throw error;
      }

      logger.warn('Snapshot rejected (version conflict); pulling latest and retrying');
      try {
        const sincePull = await this.getSinceVersionForRemoteTabPull(previousServerVersion);
        const remote = await this.apiClient.getCurrentTabs(sincePull);
        if (remote?.devices) {
          await this.mergeRemoteTabs(remote.devices, sincePull);
          this.updateServerVersion(this.getMaxVersion(remote.devices, previousServerVersion));
        }
      } catch (pullError) {
        logger.warn('Failed to pull latest after 409:', pullError);
      }

      return await tryUpload(this.lastServerVersion || 0);
    }
  }

  getMaxVersion(devices, fallback) {
    const max = (devices || []).reduce((current, device) => {
      const deviceVersion = typeof device.version === 'number' ? device.version : 0;
      return Math.max(current, deviceVersion);
    }, fallback || 0);
    return max;
  }

  /**
   * Use `since=0` (full) when we have no remote tab snapshot in storage. The
   * server only returns devices with device version **greater** than `since`, so
   * `since=lastVersion` while caught up returns **no devices** — which is
   * correct for incremental updates but wrong for an empty local cache.
   */
  async getSinceVersionForRemoteTabPull(lastVersion) {
    const existing = (await this.storage.getRemoteTabs()) || [];
    const hasCached =
      existing.length > 0 &&
      existing.some((d) => Array.isArray(d.tabs) && d.tabs.length > 0);
    if (!hasCached) {
      return 0;
    }
    return typeof lastVersion === 'number' && lastVersion > 0 ? lastVersion : 0;
  }

  async mergeRemoteTabs(incomingDevices, sinceVersion) {
    if (!sinceVersion || sinceVersion <= 0) {
      await this.storage.setRemoteTabs(incomingDevices);
      return incomingDevices;
    }

    const existing = await this.storage.getRemoteTabs();
    const byId = new Map((existing || []).map((device) => [device.device_id, device]));
    (incomingDevices || []).forEach((device) => {
      byId.set(device.device_id, device);
    });
    const merged = Array.from(byId.values());
    await this.storage.setRemoteTabs(merged);
    return merged;
  }

  isRestrictedHistoryUrl(url) {
    if (!url || typeof url !== 'string') return true;
    const restricted = [
      'chrome://',
      'chrome-extension://',
      'moz-extension://',
      'about:',
      'file://',
      'edge://',
      'opera://',
      'brave://'
    ];
    return restricted.some((p) => url.startsWith(p));
  }

  async historySearchRange(startMs, endMs) {
    const api = ext.history;
    if (!api || typeof api.search !== 'function') {
      return [];
    }
    const query = { text: '', startTime: startMs, endTime: endMs, maxResults: 400 };
    try {
      const maybe = api.search(query);
      if (maybe && typeof maybe.then === 'function') {
        return (await maybe) || [];
      }
    } catch (e) {
      logger.warn('[KeepSync:history] history.search (promise) failed:', e);
    }
    return await new Promise((resolve) => {
      try {
        api.search(query, (items) => resolve(items || []));
      } catch (e2) {
        resolve([]);
      }
    });
  }

  /**
   * After an offline/crash gap, upload deduped rows from the browser history API
   * (event_type history on the server). Skips when extension stayed alive recently.
   * @param {object} [opts]
   * @param {boolean} [opts.skipBecauseTabQueueFlushed] When true, tab events were
   * just uploaded in this doSync — avoid mixing chrome.history rows in the same pass
   * (they read as "history" in the UI instead of create/update/focus pipeline).
   */
  async maybeBackfillBrowserHistory(opts = {}) {
    if (opts.skipBecauseTabQueueFlushed === true) {
      if (typeof logger !== 'undefined' && logger.info) {
        logger.info(
          '[KeepSync:history] skip browser backfill (tab event queue was flushed this sync)'
        );
      }
      return;
    }
    const config = await this.storage.getConfig();
    if (!config.serverUrl || !config.deviceToken || config.historyBackfillEnabled === false) {
      return;
    }
    const dev = await this.storage.getDeviceInfo();
    if (!dev || !dev.id) {
      return;
    }

    const now = Date.now();
    let lastAct = await this.storage.get('lastExtensionActivityAt', 0);
    if (!lastAct) {
      await this.storage.set('lastExtensionActivityAt', now);
      return;
    }
    if (now - lastAct < 90000) {
      return;
    }

    const overlap = 120000;
    const startMs = Math.max(0, lastAct - overlap);
    const rawItems = await this.historySearchRange(startMs, now);
    const items = (rawItems || []).filter(
      (h) => h && h.url && !this.isRestrictedHistoryUrl(String(h.url))
    );
    if (!items.length) {
      await this.storage.set('lastExtensionActivityAt', now);
      return;
    }

    const events = [];
    for (const h of items) {
      const t = h.lastVisitTime;
      const ts = typeof t === 'number' ? t : now;
      const occurred = new Date(ts);
      const visitKey =
        h.id != null && String(h.id) !== ''
          ? String(h.id)
          : `u:${String(h.url).slice(0, 200)}\t${ts}`;
      events.push({
        eventType: 'history',
        url: h.url,
        title: h.title || '',
        windowId: 0,
        tabCorrelationId: `hist:${visitKey}`.slice(0, 200),
        occurredAt: occurred.toISOString(),
        updateTriggers: 'source:browser_history'
      });
    }

    const chunkSize = 80;
    try {
      for (let i = 0; i < events.length; i += chunkSize) {
        const chunk = events.slice(i, i + chunkSize);
        const resp = await this.apiClient.uploadEvents({ events: chunk });
        if (typeof logger !== 'undefined' && logger.info) {
          logger.info('[KeepSync:history] backfill chunk', {
            gapMs: now - lastAct,
            sent: chunk.length,
            applied: resp && resp.appliedCount
          });
        }
      }
      await this.storage.set('lastExtensionActivityAt', now);
    } catch (e) {
      logger.warn('[KeepSync:history] backfill upload failed:', e);
    }
  }
  }

  globalScope.SyncManager = SyncManager;
})(typeof self !== 'undefined' ? self : window);
