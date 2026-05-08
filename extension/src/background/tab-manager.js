// Tab Manager - Handles tab events and state management
(function (globalScope) {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  class TabManager {
  constructor(backgroundService) {
    this.backgroundService = backgroundService;
    this.storage = backgroundService.storage;
    this.apiClient = backgroundService.apiClient;
    this.eventQueue = [];
    this.isProcessing = false;
    this.tabCache = new Map();
    this.tabCacheSaveTimeout = null;
  }

  async initialize() {
    logger.log('Initializing tab manager...');
    
    // Load existing tab state from storage
    await this.loadTabState();
    await this.loadTabCache();
    
    // Perform initial snapshot of current tabs
    await this.captureCurrentSnapshot();
  }

  buildUpdateTriggers(changeInfo) {
    if (!changeInfo || typeof changeInfo !== 'object') {
      return '';
    }
    return Object.keys(changeInfo)
      .filter((k) => changeInfo[k] != null && changeInfo[k] !== undefined)
      .map((k) => {
        if (k === 'status' && typeof changeInfo[k] === 'string') {
          return `status:${changeInfo[k]}`;
        }
        return k;
      })
      .join(',');
  }

  async handleTabEvent(eventType, tab, changeInfo) {
    if (eventType === 'removed') {
      await this.handleTabRemoved(tab);
      return;
    }

    this.updateTabCache(tab);
    const correlationId = await this.generateCorrelationId(tab);
    const updateTriggers =
      eventType === 'updated' ? this.buildUpdateTriggers(changeInfo) : '';
    const tabIdNum = tab && tab.id != null && Number(tab.id) > 0 ? Number(tab.id) : 0;
    const tabEvent = {
      eventType: this.mapEventType(eventType),
      url: tab.url,
      title: tab.title || '',
      faviconUrl: tab.favIconUrl || '',
      windowId: tab.windowId,
      tabCorrelationId: correlationId,
      clientTabId: tabIdNum,
      updateTriggers,
      occurredAt: new Date().toISOString()
    };

    // Store locally for offline support
    await this.storeTabEvent(tabEvent);
    
    logger.log('Tab event queued:', tabEvent);
  }

  async handleTabActivated(tab) {
    this.updateTabCache(tab);
    const correlationId = await this.generateCorrelationId(tab);
    // Focus-only: updates tabs_current / last_active_at on the server without a tab_history row.
    const tabIdNum = tab && tab.id != null && Number(tab.id) > 0 ? Number(tab.id) : 0;
    const tabEvent = {
      eventType: 'focus',
      url: tab.url,
      title: tab.title || '',
      faviconUrl: tab.favIconUrl || '',
      windowId: tab.windowId,
      tabCorrelationId: correlationId,
      clientTabId: tabIdNum,
      occurredAt: new Date().toISOString()
    };

    await this.storeTabEvent(tabEvent);
  }

  async handleTabRemoved(tabInfo) {
    const tabId = tabInfo?.id;
    const cached = tabId ? this.tabCache.get(tabId) : null;
    if (!cached || !cached.url) {
      return;
    }

    const correlationId = await this.generateCorrelationId({ id: tabId, ...cached });
    const tabIdNum = tabId != null && Number(tabId) > 0 ? Number(tabId) : 0;
    const tabEvent = {
      eventType: 'close',
      url: cached.url,
      title: cached.title || '',
      faviconUrl: cached.faviconUrl || '',
      windowId: cached.windowId,
      tabCorrelationId: correlationId,
      clientTabId: tabIdNum,
      occurredAt: new Date().toISOString()
    };

    await this.storeTabEvent(tabEvent);
    this.tabCache.delete(tabId);
    this.queueTabCacheSave();
  }

  async captureCurrentSnapshot() {
    try {
      const windows = await ext.windows.getAll({ populate: true });
      const tabs = [];

      for (const window of windows) {
        for (const tab of window.tabs) {
          if (!this.backgroundService.isRestrictedUrl(tab.url)) {
            this.updateTabCache(tab);
            tabs.push({
              tabId: tab.id,
              url: tab.url,
              title: tab.title || '',
              faviconUrl: tab.favIconUrl || '',
              windowId: tab.windowId,
              pinned: tab.pinned,
              discarded: tab.discarded,
              lastActiveAt: new Date().toISOString()
            });
          }
        }
      }

      // Store snapshot locally
      await this.storage.setTabSnapshot(tabs);
      
      logger.log(`Captured snapshot of ${tabs.length} tabs`);
      return tabs;
    } catch (error) {
      logger.error('Failed to capture tab snapshot:', error);
      return [];
    }
  }

  async getQueuedEvents() {
    const storedEvents = await this.storage.getQueuedEvents() || [];
    return storedEvents;
  }

  async clearEventQueue() {
    this.eventQueue = [];
    await this.storage.clearQueuedEvents();
  }

  async storeTabEvent(event) {
    try {
      const storedEvents = await this.storage.getQueuedEvents() || [];
      const cid = event.tabCorrelationId || '';
      const url = event.url || '';
      const title = event.title || '';
      const et = event.eventType || '';

      // Coalesce same-tab, same-URL updates into one (latest title, occurredAt):
      // navigation changes URL; title-only follow-ups from onUpdated should not
      // multiply rows or create stale/conflict pairs with the server.
      const urlTrim = (s) => (typeof s === 'string' ? s.trim() : '');
      const nUrl = urlTrim(url);
      let lastForTab = -1;
      for (let i = storedEvents.length - 1; i >= 0; i--) {
        if ((storedEvents[i].tabCorrelationId || '') === cid) {
          lastForTab = i;
          break;
        }
      }
      if (lastForTab >= 0) {
        const p = storedEvents[lastForTab];
        if ((p.eventType || '') === et && nUrl !== '' && urlTrim(p.url) === nUrl) {
          storedEvents[lastForTab] = { ...event, occurredAt: event.occurredAt };
          await this.storage.setQueuedEvents(storedEvents);
          if (typeof logger !== 'undefined' && logger.info) {
            logger.info(
              '[KeepSync:history] coalesced same-URL update (latest title); queue size',
              storedEvents.length
            );
          }
          await this.storage.set('lastExtensionActivityAt', Date.now());
          return;
        }
      }

      storedEvents.push(event);
      if (typeof logger !== 'undefined' && logger.info) {
        logger.info('[KeepSync:history] queued tab event; queue size', storedEvents.length, {
          type: et,
          url: (url || '').slice(0, 80)
        });
      }

      // Limit queue size to prevent unbounded growth
      if (storedEvents.length > 1000) {
        storedEvents.splice(0, storedEvents.length - 1000);
      }

      await this.storage.setQueuedEvents(storedEvents);
      await this.storage.set('lastExtensionActivityAt', Date.now());
    } catch (error) {
      logger.error('Failed to store tab event:', error);
    }
  }

  async loadTabState() {
    try {
      const snapshot = await this.storage.getTabSnapshot();
      if (snapshot) {
        logger.log(`Loaded tab state: ${snapshot.length} tabs`);
      }
    } catch (error) {
      logger.error('Failed to load tab state:', error);
    }
  }

  updateTabCache(tab) {
    if (!tab || tab.id == null || !tab.url) {
      return;
    }
    this.tabCache.set(tab.id, {
      url: tab.url,
      title: tab.title || '',
      faviconUrl: tab.favIconUrl || '',
      windowId: tab.windowId
    });
    this.queueTabCacheSave();
  }

  async loadTabCache() {
    try {
      const cached = await this.storage.getTabCache();
      if (cached && typeof cached === 'object') {
        Object.entries(cached).forEach(([id, value]) => {
          if (value && value.url) {
            this.tabCache.set(Number(id), value);
          }
        });
      }
    } catch (error) {
      logger.warn('Failed to load tab cache:', error);
    }
  }

  queueTabCacheSave() {
    if (this.tabCacheSaveTimeout) {
      clearTimeout(this.tabCacheSaveTimeout);
    }
    this.tabCacheSaveTimeout = setTimeout(() => {
      this.persistTabCache().catch((error) => {
        logger.warn('Failed to persist tab cache:', error);
      });
    }, 500);
  }

  async persistTabCache() {
    const cacheObj = {};
    let count = 0;
    for (const [id, value] of this.tabCache.entries()) {
      if (count >= 3000) break;
      cacheObj[id] = value;
      count++;
    }
    await this.storage.setTabCache(cacheObj);
  }

  async generateCorrelationId(tab) {
    // Match server tabIDHashForSnapshot: stable for the life of a browser tab (navigations
    // keep the same id). URL is *not* part of the id — that way history can group
    // Google → Speedtest in the same "tab" and the current-tabs row updates in place.
    const data =
      tab && tab.id != null && Number(tab.id) !== 0
        ? `id:${Number(tab.id)}`
        : `${tab?.url || ''}:${tab?.windowId ?? 0}`;
    if (crypto?.subtle && typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(data);
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      const hashBytes = Array.from(new Uint8Array(hashBuffer)).slice(0, 8);
      return hashBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    // Fallback to simple hash if SubtleCrypto is unavailable
    return this.simpleHash(data);
  }

  simpleHash(str) {
    let hash = 0;
    if (str.length === 0) return hash.toString();
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return Math.abs(hash).toString(16);
  }

  mapEventType(eventType) {
    switch (eventType) {
      case 'created':
        return 'create';
      case 'updated':
        return 'update';
      case 'removed':
        return 'close';
      default:
        return eventType;
    }
  }

  // Get current tab statistics
  async getTabStats() {
    try {
      const windows = await ext.windows.getAll({ populate: true });
      let totalTabs = 0;
      let restrictedTabs = 0;

      for (const window of windows) {
        totalTabs += window.tabs.length;
        restrictedTabs += window.tabs.filter(tab => 
          this.backgroundService.isRestrictedUrl(tab.url)
        ).length;
      }

      const queuedEvents = await this.getQueuedEvents();

      return {
        totalTabs,
        syncableTabs: totalTabs - restrictedTabs,
        restrictedTabs,
        queuedEvents: queuedEvents.length,
        windows: windows.length
      };
    } catch (error) {
      logger.error('Failed to get tab stats:', error);
      return {
        totalTabs: 0,
        syncableTabs: 0,
        restrictedTabs: 0,
        queuedEvents: 0,
        windows: 0
      };
    }
  }
  }

  globalScope.TabManager = TabManager;
})(typeof self !== 'undefined' ? self : window);
