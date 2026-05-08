// Storage Manager - Handles extension data persistence
(function (globalScope) {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  class StorageManager {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 60000; // 1 minute cache
  }

  // Configuration management
  async getConfig() {
    return await this.get('config', {
      serverUrl: '',
      deviceToken: '',
      deviceName: '',
      email: '',
      syncEnabled: true,
      syncInterval: 300000, // 5 minutes
      enableNotifications: true,
      enableRealtime: true,
      bookmarkSyncEnabled: true,
      /** bidirectional | upload_only | download_only */
      bookmarkSyncDirection: 'bidirectional',
      /** use_server | use_local | prompt | auto_prefer */
      bookmarkConflictAction: 'prompt',
      /** server_wins | local_wins — used when bookmarkConflictAction is auto_prefer */
      bookmarkAutoResolution: 'server_wins',
      /** match_server (remove locals missing from server) | keep_local */
      bookmarkDeletePolicy: 'match_server',
      /** When true (default), after sync recover gaps using browser history API. */
      historyBackfillEnabled: true
    });
  }

  async setConfig(config) {
    await this.set('config', config);
  }

  // Tab data management
  async getTabSnapshot() {
    return await this.get('tabSnapshot', []);
  }

  async setTabSnapshot(tabs) {
    await this.set('tabSnapshot', tabs);
  }

  // Per-tab id → { url, title, faviconUrl, windowId } for close correlation (survives restarts)
  async getTabCache() {
    return await this.get('tabCache', {});
  }

  async setTabCache(cache) {
    await this.set('tabCache', cache);
  }

  async getQueuedEvents() {
    return await this.get('queuedEvents', []);
  }

  async setQueuedEvents(events) {
    await this.set('queuedEvents', events);
  }

  async clearQueuedEvents() {
    await this.remove('queuedEvents');
  }

  // Remote tabs from other devices
  async getRemoteTabs() {
    return await this.get('remoteTabs', []);
  }

  async setRemoteTabs(devices) {
    await this.set('remoteTabs', devices);
    await this.set('remoteTabsUpdated', Date.now());
  }

  async getRemoteTabsAge() {
    const updated = await this.get('remoteTabsUpdated', 0);
    return Date.now() - updated;
  }

  /** Timestamp (ms) when remote tab snapshot was last written */
  async getRemoteTabsUpdatedAt() {
    return await this.get('remoteTabsUpdated', 0);
  }

  // Last good history list from API — used when offline
  async getBookmarkIdMaps() {
    return await this.get('bookmarkIdMaps', { nativeToUUID: {}, uuidToNative: {} });
  }

  /** @param {{ nativeToUUID?: object, uuidToNative?: object }} p */
  async setBookmarkIdMaps(p) {
    const cur = await this.getBookmarkIdMaps();
    await this.set('bookmarkIdMaps', {
      nativeToUUID: p.nativeToUUID != null ? p.nativeToUUID : cur.nativeToUUID,
      uuidToNative: p.uuidToNative != null ? p.uuidToNative : cur.uuidToNative
    });
  }

  async getBookmarkSyncState() {
    return await this.get('bookmarkSyncState', {
      lastServerVersion: 0,
      localDirty: false,
      lastSyncedAt: null,
      lastError: null,
      /** Raw 409 body when action is prompt */
      pendingConflict: null
    });
  }

  async setBookmarkSyncState(updates) {
    const s = await this.getBookmarkSyncState();
    await this.set('bookmarkSyncState', { ...s, ...updates });
  }

  async getHistoryEventsCache() {
    return await this.get('historyEventsCache', null);
  }

  async setHistoryEventsCache(items) {
    await this.set('historyEventsCache', {
      items: items || [],
      updatedAt: Date.now()
    });
  }

  // Sync state management
  async getSyncState() {
    return await this.get('syncState', {
      lastSyncTime: null,
      lastSyncResult: null,
      syncEnabled: true,
      lastServerVersion: 0,
      serverReachable: null,
      lastHeartbeatAt: null,
      lastServerError: null
    });
  }

  async setSyncState(state) {
    const currentState = await this.getSyncState();
    await this.set('syncState', { ...currentState, ...state });
  }

  // Device information
  async getDeviceInfo() {
    return await this.get('deviceInfo', {
      id: null,
      name: '',
      browser: this.detectBrowser(),
      version: ext.runtime.getManifest().version,
      registeredAt: null
    });
  }

  async setDeviceInfo(info) {
    const currentInfo = await this.getDeviceInfo();
    await this.set('deviceInfo', { ...currentInfo, ...info });
  }

  // User preferences
  async getPreferences() {
    return await this.get('preferences', {
      theme: 'auto', // auto, light, dark
      showFavicons: true,
      groupByWindow: true,
      compactView: false,
      maxTabsPerDevice: 50,
      historyViewMode: 'timeline', // timeline | byTab | tree
      historyDedupeDisplay: true
    });
  }

  async setPreferences(prefs) {
    const currentPrefs = await this.getPreferences();
    await this.set('preferences', { ...currentPrefs, ...prefs });
  }

  // Statistics and analytics
  async getStats() {
    return await this.get('stats', {
      totalSyncs: 0,
      totalTabEvents: 0,
      lastActiveDate: null,
      installDate: Date.now()
    });
  }

  async updateStats(updates) {
    const currentStats = await this.getStats();
    await this.set('stats', { ...currentStats, ...updates });
  }

  async incrementSyncCount() {
    const stats = await this.getStats();
    await this.updateStats({
      totalSyncs: stats.totalSyncs + 1,
      lastActiveDate: Date.now()
    });
  }

  async incrementTabEventCount() {
    const stats = await this.getStats();
    await this.updateStats({
      totalTabEvents: stats.totalTabEvents + 1,
      lastActiveDate: Date.now()
    });
  }

  // Error logging
  async getErrorLog() {
    return await this.get('errorLog', []);
  }

  async addError(error) {
    const errorLog = await this.getErrorLog();
    const errorEntry = {
      timestamp: Date.now(),
      message: error.message,
      stack: error.stack,
      type: error.name || 'Error'
    };

    errorLog.push(errorEntry);
    
    // Keep only last 100 errors
    if (errorLog.length > 100) {
      errorLog.splice(0, errorLog.length - 100);
    }

    await this.set('errorLog', errorLog);
  }

  async clearErrorLog() {
    await this.remove('errorLog');
  }

  /** Last successful GET /quota (for offline UI). */
  async getCachedQuota() {
    return await this.get('cachedQuotaResponse', null);
  }

  async setCachedQuota(quota) {
    await this.set('cachedQuotaResponse', {
      quota,
      updatedAt: Date.now()
    });
  }

  /** Last successful GET /devices list. */
  async getCachedDevicesList() {
    return await this.get('cachedDevicesList', null);
  }

  async setCachedDevicesList(devices) {
    await this.set('cachedDevicesList', {
      devices: devices || [],
      updatedAt: Date.now()
    });
  }

  // Cache management
  getCached(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.value;
    }
    return null;
  }

  setCached(key, value) {
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  // Low-level storage operations
  async get(key, defaultValue = null) {
    // syncState is written from the popup (health probe) and read in the service
    // worker (GET_SYNC_STATUS). Per-context in-memory cache would stay stale for
    // up to cacheExpiry; never cache this key.
    const noCache = key === 'syncState';
    if (!noCache) {
      const cached = this.getCached(key);
      if (cached !== null) {
        return cached;
      }
    }

    try {
      const result = await ext.storage.local.get(key);
      const value = result[key] !== undefined ? result[key] : defaultValue;

      if (!noCache) {
        this.setCached(key, value);
      }

      return value;
    } catch (error) {
      logger.error(`Failed to get storage key ${key}:`, error);
      return defaultValue;
    }
  }

  async set(key, value) {
    try {
      await ext.storage.local.set({ [key]: value });

      if (key === 'syncState') {
        this.cache.delete(key);
      } else {
        this.setCached(key, value);
      }

    } catch (error) {
      logger.error(`Failed to set storage key ${key}:`, error);
      throw error;
    }
  }

  async remove(key) {
    try {
      await ext.storage.local.remove(key);
      
      // Remove from cache
      this.cache.delete(key);
      
    } catch (error) {
      logger.error(`Failed to remove storage key ${key}:`, error);
      throw error;
    }
  }

  async clear() {
    try {
      await ext.storage.local.clear();
      this.cache.clear();
    } catch (error) {
      logger.error('Failed to clear storage:', error);
      throw error;
    }
  }

  // Utility methods
  async getStorageUsage() {
    if (ext.storage.local.getBytesInUse) {
      try {
        return await ext.storage.local.getBytesInUse();
      } catch (error) {
        logger.warn('Failed to get storage usage:', error);
      }
    }
    return null;
  }

  async exportData() {
    try {
      const allData = await ext.storage.local.get();
      return {
        version: '1.0',
        timestamp: Date.now(),
        data: allData
      };
    } catch (error) {
      logger.error('Failed to export data:', error);
      throw error;
    }
  }

  async importData(exportData) {
    try {
      if (!exportData.data || !exportData.version) {
        throw new Error('Invalid export data format');
      }

      // Clear existing data
      await this.clear();
      
      // Import new data
      await ext.storage.local.set(exportData.data);
      
      logger.log('Data imported successfully');
    } catch (error) {
      logger.error('Failed to import data:', error);
      throw error;
    }
  }

  detectBrowser() {
    if (typeof browser !== 'undefined' && browser.runtime) {
      return 'firefox';
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      return 'chrome';
    }
    return 'unknown';
  }

  // Migration utilities (for future use)
  async migrate() {
    const currentVersion = ext.runtime.getManifest().version;
    const storedVersion = await this.get('dataVersion', '1.0.0');

    if (currentVersion !== storedVersion) {
      logger.log(`Migrating data from ${storedVersion} to ${currentVersion}`);
      
      // Future migration logic would go here
      
      await this.set('dataVersion', currentVersion);
    }
  }
  }

  globalScope.StorageManager = StorageManager;
})(typeof self !== 'undefined' ? self : window);
