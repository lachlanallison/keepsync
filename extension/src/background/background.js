// Cross-Browser Tab Sync - Background script
// Loaded after dependencies: Chrome via src/background/service-worker.js (importScripts);
// Firefox via manifest.firefox.json ordered background.scripts.
/* global APIClient, StorageManager, SyncManager, TabManager, BookmarkManager */

logger.log('Background service worker loading...');

class BackgroundService {
  constructor() {
    this.ext = typeof browser !== 'undefined' ? browser : chrome;
    this.isInitialized = false;
    this.serverUrl = 'http://localhost:8787';
    this.deviceToken = null;
    this.storage = new StorageManager();
    this.apiClient = new APIClient();
    this.tabManager = new TabManager(this);
    this.syncManager = new SyncManager(this);
    this.bookmarkManager = new BookmarkManager(this);
    this.fastSyncIntervalId = null;
    this._initInFlight = null;
    this.realtimeSource = null;
    this.realtimeRetryMs = 5000;
    this.realtimeMode = null;
    this.realtimeKey = null;
    this._sseCreatedAt = 0;
    this._pairingClearedForRevoke = false;
    /** Prevent duplicate tab/alarm/message listeners if initialize() retries after a partial failure. */
    this._eventListenersBound = false;
    /** Coalesce reconnect attempts when many tab updates fire at once (ms). */
    this._realtimeNudgeMinGapMs = 4000;
    this._lastRealtimeNudgeStartedAt = 0;
    const svc = this;
    if (typeof self !== 'undefined') {
      self.keepSyncNotifyDeviceRevoked = () => svc.clearPairingAfterServerRevoke('http_401');
    }
  }

  async initialize() {
    logger.log('Initializing background service...');

    try {
      // Register before any await: MV3 wake events (tabs.*) can fire while later awaits
      // (tabManager.initialize snapshots all windows) run; late registration drops them.
      this.setupEventListeners();

      await this.loadConfiguration();

      await this.tabManager.initialize();
      await this.syncManager.initialize();
      await this.bookmarkManager.initialize();

      await this.updateSyncSchedule();
      await this.updateHeartbeatSchedule();
      await this.startFastSyncLoop();
      this.startRealtimeListener();

      try {
        await this.syncManager.runHeartbeat();
      } catch (e) {
        logger.warn('Initial heartbeat failed:', e);
      }
      await this.updateIconBadge();

      this.isInitialized = true;
      logger.log('Background service initialized successfully');

      // Do not block init on first sync — failures here used to leave isInitialized false
      // and caused initialize() to re-run, stacking duplicate listeners.
      void (async () => {
        try {
          if (await this.syncManager.shouldResync()) {
            await this.syncManager.performSync({ full: true });
          }
        } catch (e) {
          logger.warn('Initial resync failed:', e);
        }
      })();
    } catch (error) {
      logger.error('Failed to initialize background service:', error);
    }
  }

  async loadConfiguration() {
    const config = await this.storage.getConfig();

    if (config.serverUrl) {
      this.serverUrl = config.serverUrl;
      this.apiClient.setServerUrl(config.serverUrl);
    }

    if (config.deviceToken) {
      this.deviceToken = config.deviceToken;
      this.apiClient.setDeviceToken(config.deviceToken);
    }

    await this.updateIconBadge();
  }

  async updateIconBadge() {
    try {
      const config = await this.storage.getConfig();
      const syncState = await this.storage.getSyncState();
      const configured = !!(config.serverUrl && config.deviceToken);
      const reachable = syncState && syncState.serverReachable;
      const connected = configured && reachable !== false;

      if (!this.ext.action || !this.ext.action.setBadgeText) {
        return;
      }

      if (!connected) {
        await this.ext.action.setBadgeText({ text: '!' });
        await this.ext.action.setBadgeBackgroundColor({ color: '#e74c3c' });
      } else {
        await this.ext.action.setBadgeText({ text: '' });
      }
    } catch (e) {
      logger.warn('Failed to update icon badge:', e);
    }
  }

  setupEventListeners() {
    if (this._eventListenersBound) {
      return;
    }
    this._eventListenersBound = true;
    this.ext.tabs.onCreated.addListener((tab) => this.handleTabEvent('created', tab));
    this.ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
        // Firefox often gives a partial `tab` (url/title) without `id`. `resolveTabForEvent`
        // would return early and we'd hash url+window for correlation — navigation then
        // looks like different "tabs" in history. The id from this callback is the source
        // of truth (same for the tab’s whole lifetime in this session).
        const merged = { ...(tab || {}), id: tabId };
        void this.handleTabEvent('updated', merged, changeInfo);
      }
    });
    this.ext.tabs.onRemoved.addListener((tabId, removeInfo) => 
      this.handleTabEvent('removed', { id: tabId, ...removeInfo }));
    this.ext.tabs.onActivated.addListener((activeInfo) => 
      this.handleTabActivated(activeInfo));

    // Window events
    this.ext.windows.onCreated.addListener(() => this.handleWindowEvent('created'));
    this.ext.windows.onRemoved.addListener(() => this.handleWindowEvent('removed'));

    // Extension lifecycle
    this.ext.runtime.onStartup.addListener(() => this.handleStartup());
    this.ext.runtime.onInstalled.addListener((details) => this.handleInstalled(details));

    // Alarm events (for periodic sync)
    this.ext.alarms.onAlarm.addListener((alarm) => this.handleAlarm(alarm));

    // Message handling (return true: async sendResponse)
    this.ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });
  }

  /**
   * Chrome/Firefox alarms are minute-based (min ~1 for repeating in practice).
   * This is a *backup* to wake a sleeping MV3 service worker. Sub-minute
   * "Background sync" intervals (e.g. 5s) are implemented via setInterval in
   * startFastSyncLoop, which only runs after initIfNeeded() and while the
   * worker is alive.
   */
  getPeriodicSyncAlarmMinutes(syncIntervalMs) {
    const ms = typeof syncIntervalMs === 'number' ? syncIntervalMs : 300000;
    const rounded = Math.round(ms / 60000);
    return Math.max(1, Math.min(24 * 60, rounded < 1 ? 1 : rounded));
  }

  async updateSyncSchedule() {
    const config = await this.storage.getConfig();
    await this.ext.alarms.clear('periodicSync');

    if (config.syncEnabled === false) {
      return;
    }

    const periodMinutes = this.getPeriodicSyncAlarmMinutes(config.syncInterval);
    this.ext.alarms.create('periodicSync', {
      delayInMinutes: periodMinutes,
      periodInMinutes: periodMinutes
    });
  }

  async updateHeartbeatSchedule() {
    await this.ext.alarms.clear('serverHeartbeat');
    const config = await this.storage.getConfig();
    if (!config.serverUrl) {
      return;
    }
    this.ext.alarms.create('serverHeartbeat', {
      delayInMinutes: 1,
      periodInMinutes: 1
    });
  }

  async startFastSyncLoop() {
    // Best-effort fast sync while service worker is alive.
    // Note: Firefox MV3 service workers may suspend, so this is not guaranteed.
    if (this.fastSyncIntervalId) {
      clearInterval(this.fastSyncIntervalId);
    }
    const intervalMs = await this.getFastSyncIntervalMs();
    this.fastSyncIntervalId = setInterval(() => {
      void (async () => {
        const config = await this.storage.getConfig();
        if (config.syncEnabled !== false && config.serverUrl && config.deviceToken) {
          await this.syncManager.performSync();
        }
      })().catch((e) => logger.error('fastSync loop:', e));
    }, intervalMs);
  }

  async getFastSyncIntervalMs() {
    const config = await this.storage.getConfig();
    const configured = typeof config.syncInterval === 'number' ? config.syncInterval : 5000;
    // Respect the chosen interval (1s – 1h). Previously capped at 5s, which
    // made “every 5s” the max and broke 1–30 minute choices.
    return Math.max(1000, Math.min(60 * 60 * 1000, configured));
  }

  /**
   * MV3 workers often restart without firing `activate` again. Without this,
   * listeners and setInterval for sync never reattach after sleep.
   */
  async initIfNeeded() {
    if (this.isInitialized) {
      return;
    }
    if (this._initInFlight) {
      await this._initInFlight;
      return;
    }
    this._initInFlight = (async () => {
      try {
        await this.initialize();
      } finally {
        this._initInFlight = null;
      }
    })();
    await this._initInFlight;
  }

  /**
   * tabs.onUpdated often passes a partial `tab` (Firefox/Chrome) without `url` and/or
   * without `id`. isRestrictedUrl('') is true, so we must resolve a full tab when url
   * is missing. The `onUpdated` listener should merge the first-argument `tabId` into
   * the tab so correlation ids stay stable.
   */
  async resolveTabForEvent(eventType, tab) {
    if (eventType === 'removed' || !tab || tab.id == null) {
      return tab;
    }
    const hasUrl = typeof tab.url === 'string' && tab.url.length > 0;
    if (hasUrl) {
      return tab;
    }
    try {
      return await this.ext.tabs.get(tab.id);
    } catch (e) {
      logger.warn('Could not read tab; URL may be unavailable yet:', tab.id, e);
      return tab;
    }
  }

  async handleTabEvent(eventType, tab, changeInfo) {
    await this.initIfNeeded();
    const t = await this.resolveTabForEvent(eventType, tab);
    if (eventType !== 'removed' && this.isRestrictedUrl(t && t.url)) {
      return;
    }

    logger.log('Tab event:', eventType, t && t.id, t && t.url);
    
    try {
      await this.tabManager.handleTabEvent(eventType, t, changeInfo);
      this.syncManager.queueSync();
      const nudgeOnUserNavigation =
        eventType === 'created' ||
        (eventType === 'updated' &&
          changeInfo &&
          (changeInfo.url != null || changeInfo.status === 'complete'));
      if (nudgeOnUserNavigation) {
        void this.nudgeRealtimeIfStale();
      }
    } catch (error) {
      logger.error('Error handling tab event:', error);
    }
  }

  async handleTabActivated(activeInfo) {
    await this.initIfNeeded();

    try {
      const tab = await this.ext.tabs.get(activeInfo.tabId);
      if (!this.isRestrictedUrl(tab.url)) {
        await this.tabManager.handleTabActivated(tab);
        this.syncManager.queueSync();
        void this.nudgeRealtimeIfStale();
      }
    } catch (error) {
      logger.error('Error handling tab activation:', error);
    }
  }

  async handleWindowEvent(eventType) {
    await this.initIfNeeded();
    logger.log('Window event:', eventType);
    this.syncManager.queueSync();
  }

  async handleStartup() {
    logger.log('Extension startup');
    await this.initIfNeeded();
  }

  async handleInstalled(details) {
    logger.log('Extension installed:', details.reason);
    
    if (details.reason === 'install') {
      // First installation - open options page
      await this.ext.runtime.openOptionsPage();
    } else if (details.reason === 'update') {
      await this.initIfNeeded();
    }
  }

  async handleAlarm(alarm) {
    await this.initIfNeeded();
    if (alarm.name === 'periodicSync') {
      logger.log('Periodic sync triggered (alarm backup)');
      const config = await this.storage.getConfig();
      if (config.syncEnabled === false) {
        return;
      }
      this.dropStaleEventSourceIfNeeded();
      await this.syncManager.performSync();
      await this.startFastSyncLoop();
      this.startRealtimeListener();
      return;
    }
    if (alarm.name === 'serverHeartbeat') {
      await this.syncManager.runHeartbeat();
      const sseWasOpen =
        this.realtimeMode === 'sse' &&
        this.realtimeSource &&
        this.realtimeSource.readyState === EventSource.OPEN;
      this.dropStaleEventSourceIfNeeded();
      this.startRealtimeListener();
      const cfg = await this.storage.getConfig();
      if (cfg.syncEnabled !== false && cfg.deviceToken) {
        await this.syncManager.performSync({ full: !sseWasOpen });
      }
      await this.updateIconBadge();
    }
  }

  async handleMessage(message, sender, sendResponse) {
    logger.log('Background message received:', message.type);
    try {
      await this.initIfNeeded();
    } catch (e) {
      logger.error('initIfNeeded in message failed:', e);
      sendResponse({ success: false, error: (e && e.message) || 'Init failed' });
      return;
    }
    try {
      switch (message.type) {
        case 'MANUAL_SYNC': {
          const result = await this.syncManager.performSync({ full: true });
          sendResponse({ success: true, result });
          break;
        }
          
        case 'GET_SYNC_STATUS': {
          const status = await this.syncManager.getSyncStatus();
          this.startRealtimeListener();
          sendResponse({ success: true, status });
          break;
        }

        case 'PING_HEARTBEAT': {
          await this.syncManager.runHeartbeat();
          const status = await this.syncManager.getSyncStatus();
          sendResponse({ success: true, status });
          break;
        }

        case 'REFRESH_FROM_SERVER': {
          const result = await this.syncManager.performSync({ full: true });
          sendResponse({ success: true, result });
          break;
        }

        case 'BOOKMARK_SYNC_NOW': {
          if (this.bookmarkManager) {
            await this.bookmarkManager.push();
            await this.bookmarkManager.runSync();
          }
          sendResponse({ success: true });
          break;
        }

        case 'BOOKMARK_RESOLVE_CONFLICT': {
          if (!this.bookmarkManager || !message.choice) {
            sendResponse({ success: false, error: 'not_available' });
            break;
          }
          const r = await this.bookmarkManager.resolveConflict(message.choice);
          sendResponse({ success: r.ok, ok: r.ok, error: r.error, version: r.version });
          break;
        }
          
        case 'UPDATE_CONFIG': {
          await this.updateConfiguration(message.config);
          sendResponse({ success: true });
          break;
        }

        case 'LOCAL_DEVICE_REVOKED': {
          await this.clearPairingAfterServerRevoke(message.reason || 'message');
          sendResponse({ success: true });
          break;
        }
          
        case 'GET_REMOTE_TABS': {
          const remoteTabs = await this.apiClient.getCurrentTabs();
          sendResponse({ success: true, data: remoteTabs });
          break;
        }

        case 'REALTIME_NOTIFY': {
          // Some realtime events (device_revoked targeted at us) demand a
          // hard teardown before any further sync work happens. Route the
          // payload through the dispatcher first, and only run a sync when
          // the message is a routine change notification.
          const handled = await this.handleRealtimePayload(message.payload);
          if (!handled) {
            await this.syncManager.performSync({ full: true });
          }
          sendResponse({ success: true });
          break;
        }

        case 'START_WEBSOCKET':
        case 'STOP_WEBSOCKET': {
          // Handled by offscreen document; ignore if received here.
          sendResponse({ success: true });
          break;
        }
          
        default:
          logger.warn('Unknown message type:', message.type);
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      logger.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
    
    // Return true to keep message port open for async response
    return true;
  }

  async updateConfiguration(config) {
    await this.storage.setConfig(config);
    
    if (config.serverUrl) {
      this.apiClient.setServerUrl(config.serverUrl);
    }
    
    if (config.deviceToken) {
      this._pairingClearedForRevoke = false;
      this.deviceToken = config.deviceToken;
      this.apiClient.setDeviceToken(config.deviceToken);
    }
    
    if (!this.isInitialized) {
      await this.initIfNeeded();
      return;
    }

    await this.updateSyncSchedule();
    await this.updateHeartbeatSchedule();
    await this.startFastSyncLoop();
    this.startRealtimeListener();
    if (this.bookmarkManager) {
      await this.bookmarkManager.setupAlarm();
    }

    if (config.serverUrl && config.deviceToken) {
      await this.syncManager.performSync({ full: true });
    } else if (config.serverUrl) {
      await this.syncManager.runHeartbeat();
    }

    await this.updateIconBadge();
  }

  // handleRealtimePayload parses a server push payload and handles
  // special event types (device_revoked) that shouldn't just trigger a
  // normal sync. Returns true when the message was fully handled so
  // callers know to skip their default "performSync on any message"
  // behaviour.
  async handleRealtimePayload(rawPayload) {
    if (!rawPayload) return false;
    let evt = null;
    try {
      evt = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    } catch (error) {
      return false;
    }
    if (!evt || typeof evt !== 'object' || !evt.type) {
      return false;
    }

    if (evt.type !== 'device_revoked') {
      return false;
    }

    // Only react if the revocation targets *this* device; other devices'
    // revocations are irrelevant to our local credentials but are fine to
    // surface in UI (the options page refreshes on its own).
    const deviceInfo = await this.storage.getDeviceInfo();
    const localId = deviceInfo?.id;
    if (!localId || evt.device_id !== localId) {
      return true;
    }

    await this.clearPairingAfterServerRevoke('sse_push');
    return true;
  }

  /**
   * EventSource can sit CLOSED or wedged in CONNECTING after timeouts/sleep
   * while we still hold a reference. Clear so startRealtimeListener can reopen.
   */
  dropStaleEventSourceIfNeeded() {
    if (!this.realtimeSource || this.realtimeMode === 'ws') {
      return;
    }
    const rs = this.realtimeSource.readyState;
    if (rs === EventSource.CLOSED) {
      logger.warn('SSE EventSource closed; clearing for reconnect');
      this.stopRealtimeListener();
      return;
    }
    if (rs === EventSource.CONNECTING) {
      const age = Date.now() - (this._sseCreatedAt || 0);
      if (age > 25000) {
        logger.warn('SSE stuck CONNECTING; clearing for reconnect');
        this.stopRealtimeListener();
      }
    }
  }

  /**
   * Server revoked this device (or its token). Idempotent so SSE + HTTP can race.
   */
  async clearPairingAfterServerRevoke(source) {
    if (this._pairingClearedForRevoke) {
      return;
    }
    this._pairingClearedForRevoke = true;
    logger.warn('Device access revoked on server; clearing local pairing', source || '');
    this.stopRealtimeListener();
    try {
      const cfg = await this.storage.getConfig();
      await this.storage.setConfig({ ...cfg, deviceToken: '' });
      await this.storage.setDeviceInfo({ id: null });
      this.apiClient.setDeviceToken(null);
      this.deviceToken = null;
      const prev = (await this.storage.getSyncState()) || {};
      await this.storage.setSyncState({
        ...prev,
        lastServerError: 'This device was unpaired on the server. Open Settings to pair again.'
      });
    } catch (error) {
      logger.warn('Failed to clear credentials after revocation:', error);
    }
    await this.updateIconBadge();
  }

  /**
   * Cheap wake when user opens a tab: if SSE isn't OPEN, reconnect. MV3 workers
   * often miss onerror timers; user activity makes catch-up feel instant.
   */
  async nudgeRealtimeIfStale() {
    try {
      const now = Date.now();
      const config = await this.storage.getConfig();
      if (config.enableRealtime === false || !config.serverUrl || !config.deviceToken) {
        return;
      }
      if (this.realtimeMode === 'ws' && this.ext.offscreen?.createDocument) {
        let wsOpen = false;
        try {
          const st = await this.ext.runtime.sendMessage({ type: 'WS_STATUS' });
          wsOpen = !!(st && st.open);
        } catch (e) {
          wsOpen = false;
        }
        if (wsOpen) {
          return;
        }
        logger.info('[KeepSync:realtime] nudge: WebSocket not open; forcing reconnect');
        this.startRealtimeListener({ force: true });
        return;
      }
      if (this.realtimeMode === 'ws') {
        this.startRealtimeListener({ force: true });
        return;
      }
      if (
        this.realtimeSource &&
        this.realtimeSource.readyState === EventSource.OPEN
      ) {
        return;
      }
      // CONNECTING with a fresh EventSource — don't spam startRealtimeListener.
      if (
        this.realtimeSource &&
        this.realtimeSource.readyState === EventSource.CONNECTING &&
        now - (this._sseCreatedAt || 0) < 20000
      ) {
        return;
      }
      // Bursty onUpdated('complete'|'url'): coalesce reconnect attempts.
      if (
        now - this._lastRealtimeNudgeStartedAt < this._realtimeNudgeMinGapMs &&
        this.realtimeSource &&
        this.realtimeSource.readyState === EventSource.CONNECTING
      ) {
        return;
      }
      this._lastRealtimeNudgeStartedAt = now;
      this.dropStaleEventSourceIfNeeded();
      logger.info('[KeepSync:realtime] nudge: reconnecting SSE', {
        hadSource: !!this.realtimeSource,
        readyState: this.realtimeSource && this.realtimeSource.readyState
      });
      this.startRealtimeListener({ force: true });
    } catch (e) {
      logger.warn('nudgeRealtimeIfStale:', e);
    }
  }

  startRealtimeListener(options) {
    const force = options && options.force === true;
    const useRealtime = async () => {
      const config = await this.storage.getConfig();
      if (config.enableRealtime === false) {
        this.stopRealtimeListener();
        return;
      }
      if (!config.serverUrl || !config.deviceToken) {
        return;
      }

      this.dropStaleEventSourceIfNeeded();

      const useWebSocket = !!this.ext.offscreen?.createDocument;
      const realtimeKey = `${config.serverUrl}|${config.deviceToken}|${useWebSocket ? 'ws' : 'sse'}`;
      // Same URL/token/mode but EventSource may be CLOSED (network blip, server
      // idle timeout, MV3 worker recycling) while we still hold realtimeKey —
      // reconnect instead of believing the channel is healthy.
      if (!force && this.realtimeKey === realtimeKey) {
        if (useWebSocket && this.realtimeMode === 'ws') {
          return;
        }
        if (!useWebSocket && this.realtimeSource) {
          const rs = this.realtimeSource.readyState;
          if (rs === EventSource.OPEN) {
            return;
          }
          if (rs === EventSource.CONNECTING) {
            const age = Date.now() - (this._sseCreatedAt || 0);
            if (age < 20000) {
              return;
            }
          }
        }
      }

      this.stopRealtimeListener();
      this.realtimeKey = realtimeKey;

      if (useWebSocket) {
        await this.createOffscreenDocument();
        try {
          await this.ext.runtime.sendMessage({
            type: 'START_WEBSOCKET',
            serverUrl: config.serverUrl,
            deviceToken: config.deviceToken
          });
          this.realtimeMode = 'ws';
          return;
        } catch (error) {
          logger.warn('Failed to start WebSocket listener, falling back to SSE:', error);
        }
      }

      const sseUrl = `${config.serverUrl.replace(/\/$/, '')}/realtime/sse?token=${encodeURIComponent(config.deviceToken)}`;
      try {
        const source = new EventSource(sseUrl);
        this._sseCreatedAt = Date.now();
        this.realtimeSource = source;
        this.realtimeRetryMs = 5000;
        this.realtimeMode = 'sse';

        source.onopen = () => {
          this.realtimeRetryMs = 5000;
          void this.syncManager.performSync().catch((e) => logger.warn('SSE open sync:', e));
        };

        source.onmessage = async (event) => {
          if (!event?.data) return;
          if (event.data.includes('"ping"')) return;
          const handled = await this.handleRealtimePayload(event.data);
          if (handled) return;
          try {
            await this.syncManager.performSync();
          } catch (error) {
            logger.warn('Realtime sync failed:', error);
          }
        };

        source.onerror = () => {
          this.stopRealtimeListener();
          setTimeout(() => this.startRealtimeListener({ force: true }), this.realtimeRetryMs);
          this.realtimeRetryMs = Math.min(this.realtimeRetryMs * 2, 60000);
        };
      } catch (error) {
        logger.warn('Failed to start realtime listener:', error);
      }
    };

    useRealtime();
  }

  stopRealtimeListener() {
    if (this.realtimeSource) {
      this.realtimeSource.close();
      this.realtimeSource = null;
    }
    if (this.realtimeMode === 'ws') {
      this.ext.runtime.sendMessage({ type: 'STOP_WEBSOCKET' }).catch(() => {});
    }
    this.realtimeMode = null;
    this.realtimeKey = null;
    this._sseCreatedAt = 0;
  }

  async createOffscreenDocument() {
    // Chrome-specific: Create offscreen document for WebSocket connections
    try {
      if (await this.hasOffscreenDocument()) {
        return;
      }
      
      await this.ext.offscreen.createDocument({
        url: this.ext.runtime.getURL('src/offscreen/offscreen.html'),
        reasons: ['DOM_SCRAPING'], // Required reason
        justification: 'Maintain WebSocket connection for real-time sync'
      });
      
      logger.log('Offscreen document created');
    } catch (error) {
      logger.error('Failed to create offscreen document:', error);
    }
  }

  async hasOffscreenDocument() {
    if (!this.ext.offscreen) {
      return false;
    }
    
    try {
      const documents = await this.ext.offscreen.hasDocument();
      return documents;
    } catch (error) {
      return false;
    }
  }

  isRestrictedUrl(url) {
    if (!url) return true;
    
    const restrictedSchemes = [
      'chrome://', 
      'chrome-extension://', 
      'moz-extension://', 
      'about:', 
      'file://',
      'edge://',
      'opera://'
    ];
    
    return restrictedSchemes.some(scheme => url.startsWith(scheme));
  }
}

// Initialize background service
const backgroundService = new BackgroundService();

// Service worker: activate and cold-start (MV3 may not re-fire activate after sleep)
self.addEventListener('activate', (event) => {
  logger.log('Service worker activated');
  event.waitUntil(backgroundService.initIfNeeded());
});
backgroundService.initIfNeeded().catch((e) => logger.error('Background init:', e));

// Handle service worker installation
self.addEventListener('install', () => {
  logger.log('Service worker installed');
  // Skip waiting to activate immediately
  self.skipWaiting();
});

// Export for testing
if (typeof module !== 'undefined') {
  module.exports = { BackgroundService };
}
