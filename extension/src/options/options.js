/* global APIClient, detectBrowser, isValidServerUrl, StorageManager, formatQuotaSizeLabel, quotaBarPercent, bindTabFaviconImg */

const ext = typeof browser !== 'undefined' ? browser : chrome;

function isBackgroundUnavailableError(err) {
  const m = (err && err.message) || String(err);
  return /Receiving end does not exist|Could not establish connection|the message port closed before a response|no tab with id|Extension context invalidated/i.test(
    m
  );
}

const OPTIONS_OPEN_TAB_KEY = 'optionsOpenTab';

/** sessionStorage JSON: { [deviceId]: true } when that device's tab list is minimised */
const TABS_DEVICE_COLLAPSED_KEY = 'keepsyncTabsDeviceCollapsed';

/** Same logic as the popup: heartbeat-only updates should not re-fetch the whole page. */
function isOnlyHeartbeatSyncStateChange(storageChange) {
  const c = storageChange;
  if (!c || c.newValue == null || typeof c.newValue !== 'object') {
    return false;
  }
  if (c.oldValue == null || typeof c.oldValue !== 'object') {
    return false;
  }
  const probe = new Set(['serverReachable', 'lastHeartbeatAt', 'lastServerError']);
  const keys = new Set([...Object.keys(c.oldValue), ...Object.keys(c.newValue)]);
  for (const k of keys) {
    if (c.oldValue[k] === c.newValue[k]) {
      continue;
    }
    if (!probe.has(k)) {
      return false;
    }
  }
  return true;
}

/** Tabs tab poll interval (synced open tabs). */
const HISTORY_BG_POLL_MS = 60000;
/** Debounce when history cache updates from the service worker (avoids hammering /history). */
const HISTORY_BG_MIN_INTERVAL_MS = 55000;
const HISTORY_CACHE_DEBOUNCE_MS = 4000;

class OptionsController {
  constructor() {
    this.apiClient = new APIClient();
    this.storage = new StorageManager();
    this.activeTab = 'setup';

    this.elements = {
      tabButtons: document.querySelectorAll('.tab-button'),
      tabContents: document.querySelectorAll('.tab-content'),

      serverUrl: document.getElementById('serverUrl'),
      email: document.getElementById('email'),
      deviceName: document.getElementById('deviceName'),

      testConnectionBtn: document.getElementById('testConnectionBtn'),
      requestMagicLinkBtn: document.getElementById('requestMagicLinkBtn'),
      activateDeviceBtn: document.getElementById('activateDeviceBtn'),
      resendMagicLinkBtn: document.getElementById('resendMagicLinkBtn'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      createPairingCodeBtn: document.getElementById('createPairingCodeBtn'),
      registerPairingBtn: document.getElementById('registerPairingBtn'),

      connectionStatus: document.getElementById('connectionStatus'),
      statusIndicator: document.getElementById('statusIndicator'),
      statusText: document.getElementById('statusText'),

      activationSection: document.getElementById('activationSection'),
      connectedSection: document.getElementById('connectedSection'),
      activationToken: document.getElementById('activationToken'),
      pairingCode: document.getElementById('pairingCode'),
      inviteToken: document.getElementById('inviteToken'),
      activateInviteBtn: document.getElementById('activateInviteBtn'),
      renameDeviceName: document.getElementById('renameDeviceName'),
      renameDeviceBtn: document.getElementById('renameDeviceBtn'),

      deviceId: document.getElementById('deviceId'),
      connectedServer: document.getElementById('connectedServer'),
      lastSync: document.getElementById('lastSync'),

      notification: document.getElementById('notification'),
      notificationMessage: document.getElementById('notificationMessage'),
      notificationClose: document.getElementById('notificationClose'),

      loadingOverlay: document.getElementById('loadingOverlay'),
      loadingText: document.getElementById('loadingText'),

      // Raw tab events (Advanced tab)
      historyList: document.getElementById('historyList'),
      historyLoading: document.getElementById('historyLoading'),
      historyEmpty: document.getElementById('historyEmpty'),
      refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
      exportHistoryBtn: document.getElementById('exportHistoryBtn'),
      rawDeviceFilter: document.getElementById('rawDeviceFilter'),
      eventTypeFilter: document.getElementById('eventTypeFilter'),
      currentTabsSearch: document.getElementById('currentTabsSearch'),
      historySearch: document.getElementById('historySearch'),
      historySeeMore: document.getElementById('historySeeMore'),

      tabsDeviceFilter: document.getElementById('tabsDeviceFilter'),
      refreshTabsBtn: document.getElementById('refreshTabsBtn'),

      currentTabsList: document.getElementById('currentTabsList'),
      currentTabsLoading: document.getElementById('currentTabsLoading'),
      currentTabsEmpty: document.getElementById('currentTabsEmpty'),

      // Sync settings
      enableSync: document.getElementById('enableSync'),
      syncInterval: document.getElementById('syncInterval'),
      enableRealtime: document.getElementById('enableRealtime'),
      enableNotifications: document.getElementById('enableNotifications'),
      manualSyncBtn: document.getElementById('manualSyncBtn'),
      syncStatusText: document.getElementById('syncStatusText'),
      syncQueuedEvents: document.getElementById('syncQueuedEvents'),
      syncLastTime: document.getElementById('syncLastTime'),
      quotaUsed: document.getElementById('quotaUsed'),
      quotaTotal: document.getElementById('quotaTotal'),
      quotaFill: document.getElementById('quotaFill'),
      quotaBreakdownDetails: document.getElementById('quotaBreakdownDetails'),
      quotaHistorySummary: document.getElementById('quotaHistorySummary'),
      quotaDriftNote: document.getElementById('quotaDriftNote'),
      quotaRecentEventsBody: document.getElementById('quotaRecentEventsBody'),
      refreshQuotaBtn: document.getElementById('refreshQuotaBtn'),
      clearHistoryBtn: document.getElementById('clearHistoryBtn'),

      // Devices
      refreshDevicesBtn: document.getElementById('refreshDevicesBtn'),
      deviceList: document.getElementById('deviceList'),
      devicesLoading: document.getElementById('devicesLoading'),
      devicesEmpty: document.getElementById('devicesEmpty'),

      // Appearance
      themeSelect: document.getElementById('theme'),
      themeToggle: document.getElementById('themeToggle'),
      showFavicons: document.getElementById('showFavicons'),
      compactView: document.getElementById('compactView'),
      maxTabsPerDevice: document.getElementById('maxTabsPerDevice'),
      historyViewMode: document.getElementById('historyViewMode'),
      historyDedupeDisplay: document.getElementById('historyDedupeDisplay'),
      syncServerStatus: document.getElementById('syncServerStatus'),
      currentTabsCacheNotice: document.getElementById('currentTabsCacheNotice'),
      historyCacheNotice: document.getElementById('historyCacheNotice'),
      historyTabFocusBar: document.getElementById('historyTabFocusBar'),
      historyTabFocusText: document.getElementById('historyTabFocusText'),
      historyTabFocusClear: document.getElementById('historyTabFocusClear'),

      bookmarkSyncEnabled: document.getElementById('bookmarkSyncEnabled'),
      bookmarkSyncDirection: document.getElementById('bookmarkSyncDirection'),
      bookmarkConflictAction: document.getElementById('bookmarkConflictAction'),
      bookmarkAutoResolution: document.getElementById('bookmarkAutoResolution'),
      bookmarkDeletePolicy: document.getElementById('bookmarkDeletePolicy'),
      bookmarkSyncNowBtn: document.getElementById('bookmarkSyncNowBtn'),
      bookmarkSyncStatus: document.getElementById('bookmarkSyncStatus'),
      bookmarkConflictBox: document.getElementById('bookmarkConflictBox'),
      bookmarkConflictText: document.getElementById('bookmarkConflictText'),
      bookmarkUseServerBtn: document.getElementById('bookmarkUseServerBtn'),
      bookmarkUseLocalBtn: document.getElementById('bookmarkUseLocalBtn'),

      histSessionsDeviceFilter: document.getElementById('histSessionsDeviceFilter'),
      histSessionsStatus: document.getElementById('histSessionsStatus'),
      histSessionsTitle: document.getElementById('histSessionsTitle'),
      histSessionsUrl: document.getElementById('histSessionsUrl'),
      histSessionsOpenedFrom: document.getElementById('histSessionsOpenedFrom'),
      histSessionsOpenedTo: document.getElementById('histSessionsOpenedTo'),
      histSessionsClosedFrom: document.getElementById('histSessionsClosedFrom'),
      histSessionsClosedTo: document.getElementById('histSessionsClosedTo'),
      histSessionsSort: document.getElementById('histSessionsSort'),
      loadHistSessionsBtn: document.getElementById('loadHistSessionsBtn'),
      exportHistSessionsBtn: document.getElementById('exportHistSessionsBtn'),
      histTableTitle: document.getElementById('histTableTitle'),
      histTableUrl: document.getElementById('histTableUrl'),
      histTableDevice: document.getElementById('histTableDevice'),
      histTableStatus: document.getElementById('histTableStatus'),
      histSessionsMeta: document.getElementById('histSessionsMeta'),
      histSessionsTbody: document.getElementById('histSessionsTbody'),
      histSessionsPrev: document.getElementById('histSessionsPrev'),
      histSessionsNext: document.getElementById('histSessionsNext'),

      devicesCacheNotice: document.getElementById('devicesCacheNotice'),
      extensionVersion: document.getElementById('extensionVersion'),
      browserInfo: document.getElementById('browserInfo'),
      storageUsed: document.getElementById('storageUsed'),
      viewErrorLogBtn: document.getElementById('viewErrorLogBtn'),
      clearErrorLogBtn: document.getElementById('clearErrorLogBtn'),
      exportDataBtn: document.getElementById('exportDataBtn'),
      importDataBtn: document.getElementById('importDataBtn'),
      importFileInput: document.getElementById('importFileInput'),
      clearAllDataBtn: document.getElementById('clearAllDataBtn'),
      purgeServerDataBtn: document.getElementById('purgeServerDataBtn'),
      dangerConfirmModal: document.getElementById('dangerConfirmModal'),
      dangerConfirmTitle: document.getElementById('dangerConfirmTitle'),
      dangerConfirmBody: document.getElementById('dangerConfirmBody'),
      dangerConfirmCancelBtn: document.getElementById('dangerConfirmCancelBtn'),
      dangerConfirmConfirmBtn: document.getElementById('dangerConfirmConfirmBtn')
    };

    this.lastHistoryItems = [];
    this._historyTabFocus = null;
    this._lastHistoryRenderMeta = null;
    this._optQuotaInFlight = null;
    this._optLastQuotaData = null;
    this._optQuotaFetchedAt = 0;
    this.historyDisplayLimit = 25;
    this._deviceFilterLabels = new Map();
    this.currentDeviceId = null;
    this.notificationTimeout = null;
    this._lastHistoryRenderFingerprint = null;
    this._tabsPollTimer = null;
    this._lastBackgroundHistoryFetchAt = 0;
    this._historyFromCacheDebounceTimer = null;
    this._histSessionsOffset = 0;
    this._histSessionsTotal = 0;
    this._histSessionsPageSize = 100;
    this._histSessionsData = [];
    this._histTableDebounce = null;
    this._lastTabsViewRenderFingerprint = null;
    this._dangerConfirmAction = null;
  }

  async initialize() {
    // Load storage-driven state before tab clicks are wired: `setupTabs` runs after
    // `consumeInitialOptionsTab`, otherwise a fast click (e.g. Tabs) during the
    // awaits below could be overwritten when we later apply `optionsOpenTab`
    // from the popup (“Open history”) hint.
    await this.loadConfiguration();
    await this.loadPreferences();
    await this.consumeInitialOptionsTab();
    this.setupTabs();
    this.setupEventListeners();
    this.setupSidebar();
    await this.applyStoredTheme();
    await this.updateConnectionState();
    await this.updateSyncStatusPanel();
    await this.updateDeviceList();
    await this.refreshBookmarkStatusLine();
    await this.refreshDiagnostics();
  }

  /**
   * Updates syncState (serverReachable) before painting paired UI. Uses the
   * background heartbeat when available, then falls back to a direct /healthz
   * from this page (same as the popup) when the service worker is unavailable.
   */
  /** Sets `data-server-reachable` on <html> so the header status dot matches reachability. */
  applyOptionsHeaderServerIndicator(syncState) {
    const root = document.documentElement;
    if (!root) return;
    if (!syncState) {
      root.removeAttribute('data-server-reachable');
      return;
    }
    const v = syncState.serverReachable;
    if (v === true) {
      root.setAttribute('data-server-reachable', 'true');
    } else if (v === false) {
      root.setAttribute('data-server-reachable', 'false');
    } else {
      root.setAttribute('data-server-reachable', 'unknown');
    }
  }

  /**
   * Probes the server (same as popup) so the options page is not stuck on a
   * stale "unreachable" for 15s. Only skips a new probe if we *recently*
   * checked successful reachability, unless `force` is set (e.g. after sync).
   */
  async syncServerHealthForOptions(opts = {}) {
    const force = opts.force === true;
    const config = await this.storage.getConfig();
    if (!config?.serverUrl || !config?.deviceToken) {
      return;
    }

    const previous = await this.storage.getSyncState();
    const ageMs = previous?.lastHeartbeatAt
      ? Date.now() - new Date(previous.lastHeartbeatAt).getTime()
      : Infinity;
    if (!force && previous?.serverReachable === true && ageMs < 15_000) {
      return;
    }

    this.apiClient.setServerUrl(config.serverUrl);
    this.apiClient.setDeviceToken(config.deviceToken);
    const now = new Date().toISOString();
    try {
      await this.apiClient.healthCheck();
      await this.storage.setSyncState({
        serverReachable: true,
        lastHeartbeatAt: now,
        lastServerError: null
      });
    } catch (e) {
      await this.storage.setSyncState({
        serverReachable: false,
        lastHeartbeatAt: now,
        lastServerError: (e && e.message) || 'Server unreachable'
      });
    }
  }

  async consumeInitialOptionsTab() {
    try {
      const r = await ext.storage.local.get(OPTIONS_OPEN_TAB_KEY);
      const tabId = r[OPTIONS_OPEN_TAB_KEY];
      if (tabId && ['setup', 'sync', 'bookmarks', 'tabs', 'history', 'advanced'].includes(tabId)) {
        await ext.storage.local.remove(OPTIONS_OPEN_TAB_KEY);
        this.switchTab(tabId);
      }
    } catch (e) {
      logger.warn('options tab hint:', e);
    }
  }

  async loadPreferences() {
    const p = await this.storage.getPreferences();
    if (this.elements.showFavicons) {
      this.elements.showFavicons.checked = p.showFavicons !== false;
    }
    if (this.elements.compactView) {
      this.elements.compactView.checked = !!p.compactView;
    }
    if (this.elements.maxTabsPerDevice) {
      const m = Math.max(10, Math.min(100, p.maxTabsPerDevice || 50));
      this.elements.maxTabsPerDevice.value = String(m);
    }
    if (this.elements.historyViewMode) {
      const m = p.historyViewMode;
      this.elements.historyViewMode.value = m === 'byTab' || m === 'tree' ? m : 'timeline';
    }
    if (this.elements.historyDedupeDisplay) {
      this.elements.historyDedupeDisplay.checked = p.historyDedupeDisplay !== false;
    }
  }

  async savePreferences() {
    const mode = this.elements.historyViewMode?.value;
    const historyViewMode = mode === 'byTab' || mode === 'tree' ? mode : 'timeline';
    await this.storage.setPreferences({
      showFavicons: this.elements.showFavicons?.checked ?? true,
      compactView: this.elements.compactView?.checked ?? false,
      maxTabsPerDevice: Math.max(
        10,
        Math.min(100, parseInt(this.elements.maxTabsPerDevice?.value || '50', 10) || 50)
      ),
      historyViewMode,
      historyDedupeDisplay: this.elements.historyDedupeDisplay?.checked !== false
    });
    this.showNotification('Preferences saved');
  }

  // ---------------------------------------------------------------------
  // Theme handling — three states stored under storage key "theme":
  //   "auto" (follow OS) | "light" | "dark"
  //
  // The CSS handles "auto" by default (prefers-color-scheme media query),
  // and explicit light/dark override via :root[data-theme=...] attribute.
  // ---------------------------------------------------------------------
  async applyStoredTheme() {
    const config = await this.storage.getConfig();
    const mode = config.theme || 'auto';
    this.setThemeMode(mode, { persist: false });
  }

  setThemeMode(mode, { persist = true } = {}) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
    } else {
      root.removeAttribute('data-theme');
    }
    if (this.elements.themeSelect) {
      this.elements.themeSelect.value = mode;
    }
    if (this.elements.themeToggle) {
      const resolved = this.resolveThemeLabel(mode);
      this.elements.themeToggle.textContent = resolved;
    }
    if (persist) {
      this.storage.updateConfig({ theme: mode });
    }
  }

  resolveThemeLabel(mode) {
    if (mode === 'light') return 'Light';
    if (mode === 'dark') return 'Dark';
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'Auto · dark' : 'Auto · light';
  }

  cycleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') || 'auto';
    const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
    this.setThemeMode(next, { persist: true });
  }

  setupTabs() {
    this.elements.tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        this.switchTab(target);
      });
    });
  }

  switchTab(tabId) {
    this.activeTab = tabId;
    this.elements.tabButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    this.elements.tabContents.forEach((content) => {
      content.classList.toggle('active', content.id === tabId);
    });

    if (tabId === 'tabs') {
      this._startTabsTabPolling();
      this.updateCurrentTabsView();
    } else {
      this._stopTabsTabPolling();
    }

    if (tabId === 'advanced') {
      void this.updateHistoryEvents();
      void this.refreshDiagnostics();
    } else {
      this._stopHistoryTabDebouncedRefresh();
    }

    if (tabId === 'sync') {
      this.updateSyncStatusPanel();
    }
    if (tabId === 'bookmarks') {
      void this.refreshBookmarkConflictUI();
      void this.refreshBookmarkStatusLine();
      void this.refreshLocalBookmarkTree();
    }
    if (tabId === 'history') {
      void this.loadHistorySessionsFromServer(false);
    }
  }

  setupEventListeners() {
    this.elements.testConnectionBtn?.addEventListener('click', () => this.testConnection());
    this.elements.requestMagicLinkBtn?.addEventListener('click', () => this.requestMagicLink());
    this.elements.activateDeviceBtn?.addEventListener('click', () => this.activateDevice());
    this.elements.resendMagicLinkBtn?.addEventListener('click', () => this.requestMagicLink());
    this.elements.disconnectBtn?.addEventListener('click', () => this.disconnectDevice());
    this.elements.createPairingCodeBtn?.addEventListener('click', () => this.createPairingCode());
    this.elements.registerPairingBtn?.addEventListener('click', () => this.registerWithPairing());
    this.elements.activateInviteBtn?.addEventListener('click', () => this.activateWithInvite());
    this.elements.renameDeviceBtn?.addEventListener('click', () => this.renameDevice());
    this.elements.refreshHistoryBtn?.addEventListener('click', () => this.updateHistoryEvents());
    this.elements.rawDeviceFilter?.addEventListener('change', () => {
      this.historyDisplayLimit = 25;
      this._historyTabFocus = null;
      this.updateHistoryTabFocusBar();
      this.updateHistoryEvents();
    });
    this.elements.tabsDeviceFilter?.addEventListener('change', () => {
      this.updateCurrentTabsView();
    });
    this.elements.refreshTabsBtn?.addEventListener('click', () =>
      this.updateCurrentTabsView({ force: true })
    );
    this.elements.eventTypeFilter?.addEventListener('change', () => {
      this.historyDisplayLimit = 25;
      this.updateHistoryEvents();
    });
    this.elements.currentTabsSearch?.addEventListener('input', () => this.updateCurrentTabsView());
    this.elements.historySearch?.addEventListener('input', () => {
      this.historyDisplayLimit = 25;
      this.updateHistoryEvents();
    });
    this.elements.historySeeMore?.addEventListener('click', () => {
      this.historyDisplayLimit += 25;
      this.renderHistoryEvents();
    });
    this.elements.exportHistoryBtn?.addEventListener('click', () => this.exportHistory());
    this.elements.historyTabFocusClear?.addEventListener('click', () => {
      this.clearHistoryTabFocus();
    });
    this.elements.manualSyncBtn?.addEventListener('click', () => this.performManualSync());
    this.elements.refreshDevicesBtn?.addEventListener('click', () => this.updateDeviceList());
    this.elements.refreshQuotaBtn?.addEventListener('click', () => this.updateQuotaPanel({ force: true }));
    this.elements.clearHistoryBtn?.addEventListener('click', () => this.clearHistory());

    this.elements.exportDataBtn?.addEventListener('click', () => this.exportAllExtensionData());
    this.elements.importDataBtn?.addEventListener('click', () => this.elements.importFileInput?.click());
    this.elements.importFileInput?.addEventListener('change', (e) => this.importExtensionDataFromFile(e));
    this.elements.clearAllDataBtn?.addEventListener('click', () => this.clearAllLocalExtensionData());
    this.elements.purgeServerDataBtn?.addEventListener('click', () => this.openPurgeServerModal());
    this.elements.dangerConfirmCancelBtn?.addEventListener('click', () => this.closeDangerConfirmModal());
    this.elements.dangerConfirmConfirmBtn?.addEventListener('click', () => this.onDangerConfirmCommit());
    this.elements.dangerConfirmModal?.addEventListener('close', () => {
      this._dangerConfirmAction = null;
    });
    this.elements.viewErrorLogBtn?.addEventListener('click', () => this.viewErrorLog());
    this.elements.clearErrorLogBtn?.addEventListener('click', () => this.clearErrorLogFromUI());

    this.elements.bookmarkSyncEnabled?.addEventListener('change', () => this.saveBookmarkSettings());
    this.elements.bookmarkSyncDirection?.addEventListener('change', () => this.saveBookmarkSettings());
    this.elements.bookmarkConflictAction?.addEventListener('change', () => this.saveBookmarkSettings());
    this.elements.bookmarkAutoResolution?.addEventListener('change', () => this.saveBookmarkSettings());
    this.elements.bookmarkDeletePolicy?.addEventListener('change', () => this.saveBookmarkSettings());
    this.elements.bookmarkSyncNowBtn?.addEventListener('click', () => this.performBookmarkSyncNow());
    this.elements.bookmarkUseServerBtn?.addEventListener('click', () => this.resolveBookmarkFromUI('use_server'));
    this.elements.bookmarkUseLocalBtn?.addEventListener('click', () => this.resolveBookmarkFromUI('use_local'));
    document.getElementById('bookmarkTreeRefresh')?.addEventListener('click', () => this.refreshLocalBookmarkTree());

    const bmDetails = document.getElementById('bookmarkSyncSettingsDetails');
    const bmHint = bmDetails?.querySelector('.bookmark-sync-settings-hint');
    bmDetails?.addEventListener('toggle', () => {
      if (bmHint) {
        bmHint.textContent = bmDetails.open ? 'hide' : 'show';
      }
    });
    this.elements.loadHistSessionsBtn?.addEventListener('click', () => this.loadHistorySessionsFromServer(false));
    this.elements.exportHistSessionsBtn?.addEventListener('click', () => this.exportHistorySessions());
    this.elements.histSessionsPrev?.addEventListener('click', () => this.loadHistorySessionsFromServer(true, -1));
    this.elements.histSessionsNext?.addEventListener('click', () => this.loadHistorySessionsFromServer(true, 1));
    const onHistTableFilter = () => {
      if (this._histTableDebounce) {
        clearTimeout(this._histTableDebounce);
      }
      this._histTableDebounce = setTimeout(() => {
        this._histTableDebounce = null;
        this.renderHistorySessionsTable();
      }, 200);
    };
    this.elements.histTableTitle?.addEventListener('input', onHistTableFilter);
    this.elements.histTableUrl?.addEventListener('input', onHistTableFilter);
    this.elements.histTableDevice?.addEventListener('input', onHistTableFilter);
    this.elements.histTableStatus?.addEventListener('change', onHistTableFilter);

    this.elements.enableSync?.addEventListener('change', () => this.saveSyncSettings());
    this.elements.syncInterval?.addEventListener('change', () => this.saveSyncSettings());
    this.elements.enableRealtime?.addEventListener('change', () => this.saveSyncSettings());
    this.elements.enableNotifications?.addEventListener('change', () => this.saveSyncSettings());

    this.elements.notificationClose?.addEventListener('click', () => {
      if (this.notificationTimeout) {
        clearTimeout(this.notificationTimeout);
        this.notificationTimeout = null;
      }
      this.elements.notification.style.display = 'none';
    });

    this.elements.themeSelect?.addEventListener('change', (e) => {
      this.setThemeMode(e.target.value, { persist: true });
    });
    this.elements.themeToggle?.addEventListener('click', () => this.cycleTheme());

    this.elements.showFavicons?.addEventListener('change', () => this.savePreferences());
    this.elements.compactView?.addEventListener('change', () => this.savePreferences());
    this.elements.maxTabsPerDevice?.addEventListener('change', () => {
      this.savePreferences();
      if (this.activeTab === 'tabs') {
        this.updateCurrentTabsView();
      }
    });
    this.elements.historyViewMode?.addEventListener('change', () => {
      this.savePreferences();
      this.historyDisplayLimit = 25;
      this.renderHistoryEvents(this._lastHistoryRenderMeta);
    });
    this.elements.historyDedupeDisplay?.addEventListener('change', () => {
      this.savePreferences();
      this.historyDisplayLimit = 25;
      this.renderHistoryEvents(this._lastHistoryRenderMeta);
    });

    // Keep the toggle label in sync with the OS when in auto mode.
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (!document.documentElement.hasAttribute('data-theme') && this.elements.themeToggle) {
        this.elements.themeToggle.textContent = this.resolveThemeLabel('auto');
      }
    });

    if (ext.storage && ext.storage.onChanged) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') {
          return;
        }
        if (changes.syncState) {
          this.updateSyncStatusPanel().catch((e) => logger.warn('options syncState listener:', e));
          if (this.activeTab === 'tabs' && !isOnlyHeartbeatSyncStateChange(changes.syncState)) {
            this.updateCurrentTabsView({ background: true }).catch((e) =>
              logger.warn('options tabs refresh:', e)
            );
          }
        }
        if (this.activeTab === 'advanced' && changes.historyEventsCache) {
          this._scheduleDebouncedHistoryCacheRefresh();
        }
        if (changes.bookmarkSyncState && this.activeTab === 'bookmarks') {
          void this.refreshBookmarkConflictUI();
          void this.refreshBookmarkStatusLine();
          void this.refreshLocalBookmarkTree();
        }
      });
    }
  }

  async loadConfiguration() {
    const config = await this.storage.getConfig();

    if (config.serverUrl) {
      this.elements.serverUrl.value = config.serverUrl;
      this.apiClient.setServerUrl(config.serverUrl);
    }
    if (config.email) {
      this.elements.email.value = config.email;
    }
    if (config.deviceName) {
      this.elements.deviceName.value = config.deviceName;
    }
    if (config.deviceToken) {
      this.apiClient.setDeviceToken(config.deviceToken);
    }

    if (this.elements.enableSync) {
      this.elements.enableSync.checked = config.syncEnabled !== false;
    }
    if (this.elements.syncInterval) {
      this.elements.syncInterval.value = String(config.syncInterval || 5000);
    }
    if (this.elements.enableRealtime) {
      this.elements.enableRealtime.checked = config.enableRealtime !== false;
    }
    if (this.elements.enableNotifications) {
      this.elements.enableNotifications.checked = config.enableNotifications !== false;
    }
    if (this.elements.bookmarkSyncEnabled) {
      this.elements.bookmarkSyncEnabled.checked = config.bookmarkSyncEnabled !== false;
    }
    if (this.elements.bookmarkSyncDirection) {
      this.elements.bookmarkSyncDirection.value = config.bookmarkSyncDirection || 'bidirectional';
    }
    if (this.elements.bookmarkConflictAction) {
      this.elements.bookmarkConflictAction.value = config.bookmarkConflictAction || 'prompt';
    }
    if (this.elements.bookmarkAutoResolution) {
      this.elements.bookmarkAutoResolution.value = config.bookmarkAutoResolution || 'server_wins';
    }
    if (this.elements.bookmarkDeletePolicy) {
      this.elements.bookmarkDeletePolicy.value = config.bookmarkDeletePolicy || 'match_server';
    }
    await this.refreshBookmarkConflictUI();
    await this.updateBookmarkBrowserSection();
  }

  async saveConfiguration(updates) {
    const current = await this.storage.getConfig();
    const next = { ...current, ...updates };
    await this.storage.setConfig(next);
    await this.notifyBackground(next);
    return next;
  }

  async notifyBackground(config) {
    try {
      await ext.runtime.sendMessage({ type: 'UPDATE_CONFIG', config });
    } catch (error) {
      if (!isBackgroundUnavailableError(error)) {
        logger.warn('Failed to notify background:', error);
      }
    }
  }

  async testConnection() {
    const serverUrl = this.elements.serverUrl.value.trim();
    if (!this.validateServerUrl(serverUrl)) {
      return;
    }

    this.showLoading('Testing connection...');
    this.apiClient.setServerUrl(serverUrl);

    try {
      const response = await this.apiClient.healthCheck();
      this.hideLoading();
      this.showStatus('connected', response?.status ? `Server: ${response.status}` : 'Server reachable');
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Connection failed: ${error.message}`);
    }
  }

  async requestMagicLink() {
    const serverUrl = this.elements.serverUrl.value.trim();
    const email = this.elements.email.value.trim();
    const deviceName = this.elements.deviceName.value.trim() || 'My Browser';

    if (!this.validateServerUrl(serverUrl)) {
      return;
    }
    let finalEmail = email;
    if (!finalEmail) {
      // Dev convenience: use a placeholder email
      finalEmail = 'dev@local';
      this.elements.email.value = finalEmail;
      this.showNotification('Using dev@local for testing');
    }

    this.showLoading('Requesting magic link...');
    this.apiClient.setServerUrl(serverUrl);

    try {
      await this.saveConfiguration({ serverUrl, email: finalEmail, deviceName });
      const response = await this.apiClient.requestMagicLink(finalEmail, deviceName);
      this.hideLoading();
      const deviceToken = response?.device_token || response?.deviceToken;
      const deviceId = response?.device_id || response?.deviceId;
      if (deviceToken) {
        this.apiClient.setDeviceToken(deviceToken);
        await this.saveConfiguration({ deviceToken });
        await this.storage.setDeviceInfo({
          id: deviceId || null,
          name: deviceName,
          browser: detectBrowser(),
          registeredAt: Date.now()
        });
        await this.showConnectedSection(deviceId || '-', serverUrl);
        this.showNotification('Device activated (dev mode)');
        return;
      }

      this.showStatus('connected', response?.message || 'Magic link sent');
      this.showActivationSection(response?.token || '');
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Magic link failed: ${error.message}`);
    }
  }

  async activateDevice() {
    const serverUrl = this.elements.serverUrl.value.trim();
    const deviceName = this.elements.deviceName.value.trim() || 'My Browser';
    const token = this.elements.activationToken.value.trim();

    if (!this.validateServerUrl(serverUrl)) {
      return;
    }
    if (!token) {
      this.showStatus('error', 'Activation token is required');
      return;
    }

    this.showLoading('Activating device...');
    this.apiClient.setServerUrl(serverUrl);

    try {
      const browserName = detectBrowser();
      const response = await this.apiClient.activateDevice(token, deviceName, browserName);
      this.apiClient.setDeviceToken(response.device_token || response.deviceToken);

      const deviceToken = response.device_token || response.deviceToken;
      const deviceId = response.device_id || response.deviceId;

      await this.saveConfiguration({ serverUrl, deviceName, deviceToken });
      await this.storage.setDeviceInfo({
        id: deviceId,
        name: deviceName,
        browser: browserName,
        registeredAt: Date.now()
      });

      this.hideLoading();
      await this.showConnectedSection(deviceId, serverUrl);
      this.showNotification('Device activated successfully');
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Activation failed: ${error.message}`);
    }
  }

  async createPairingCode() {
    const serverUrl = this.elements.serverUrl.value.trim();
    const email = this.elements.email.value.trim() || 'dev@local';

    if (!this.validateServerUrl(serverUrl)) {
      return;
    }

    this.showLoading('Generating pairing code...');
    this.apiClient.setServerUrl(serverUrl);

    try {
      await this.saveConfiguration({ serverUrl, email });
      const response = await this.apiClient.requestPairingCode(email);
      this.hideLoading();
      this.elements.pairingCode.value = response?.pairing_code || '';
      this.showNotification('Pairing code generated');
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Pairing code failed: ${error.message}`);
    }
  }

  async registerWithPairing() {
    const serverUrl = this.elements.serverUrl.value.trim();
    const deviceName = this.elements.deviceName.value.trim() || 'My Browser';
    const code = this.elements.pairingCode.value.trim();

    if (!this.validateServerUrl(serverUrl)) {
      return;
    }
    if (!code) {
      this.showStatus('error', 'Pairing code is required');
      return;
    }

    this.showLoading('Registering device...');
    this.apiClient.setServerUrl(serverUrl);

    try {
      const browserName = detectBrowser();
      const response = await this.apiClient.registerDeviceWithPairing(code, deviceName, browserName);
      const deviceToken = response.device_token || response.deviceToken;
      const deviceId = response.device_id || response.deviceId;

      this.apiClient.setDeviceToken(deviceToken);
      await this.saveConfiguration({ serverUrl, deviceName, deviceToken });
      await this.storage.setDeviceInfo({
        id: deviceId,
        name: deviceName,
        browser: browserName,
        registeredAt: Date.now()
      });

      this.hideLoading();
      await this.showConnectedSection(deviceId, serverUrl);
      this.showNotification('Device registered');
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Pairing failed: ${error.message}`);
    }
  }

  async activateWithInvite() {
    const serverUrl = this.elements.serverUrl.value.trim();
    const deviceName = this.elements.deviceName.value.trim() || 'My Browser';
    const token = this.elements.inviteToken?.value.trim() || '';

    if (!this.validateServerUrl(serverUrl)) {
      return;
    }
    if (!token) {
      this.showStatus('error', 'Invite token is required');
      return;
    }

    this.showLoading('Activating device...');
    this.apiClient.setServerUrl(serverUrl);

    try {
      const browserName = detectBrowser();
      const response = await this.apiClient.activateInvite(token, deviceName, browserName);
      const deviceToken = response.device_token || response.deviceToken;
      const deviceId = response.device_id || response.deviceId;

      this.apiClient.setDeviceToken(deviceToken);
      await this.saveConfiguration({ serverUrl, deviceName, deviceToken });
      await this.storage.setDeviceInfo({
        id: deviceId,
        name: deviceName,
        browser: browserName,
        registeredAt: Date.now()
      });

      this.hideLoading();
      await this.showConnectedSection(deviceId, serverUrl);
      this.showNotification('Device activated via invite');
      if (this.elements.inviteToken) {
        this.elements.inviteToken.value = '';
      }
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Invite activation failed: ${error.message}`);
    }
  }

  async disconnectDevice() {
    this.showLoading('Disconnecting...');
    try {
      await this.saveConfiguration({ deviceToken: '' });
      await this.storage.setDeviceInfo({ id: null });
      this.apiClient.setDeviceToken(null);
      this.hideLoading();
      this.showSetupSection();
      this.showNotification('Device disconnected');
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Failed to disconnect: ${error.message}`);
    }
  }

  async renameDevice() {
    const newName = this.elements.renameDeviceName.value.trim();
    if (!newName) {
      this.showNotification('Enter a device name');
      return;
    }

    const config = await this.storage.getConfig();
    const deviceInfo = await this.storage.getDeviceInfo();
    if (!config.serverUrl || !config.deviceToken || !deviceInfo?.id) {
      this.showStatus('error', 'Not connected');
      return;
    }

    this.apiClient.setServerUrl(config.serverUrl);
    this.apiClient.setDeviceToken(config.deviceToken);

    try {
      await this.apiClient.updateDeviceName(deviceInfo.id, newName);
      await this.storage.setDeviceInfo({ name: newName });
      await this.saveConfiguration({ deviceName: newName });
      this.showNotification('Device name updated');
    } catch (error) {
      this.showStatus('error', `Rename failed: ${error.message}`);
    }
  }

  async updateConnectionState() {
    const config = await this.storage.getConfig();
    const deviceInfo = await this.storage.getDeviceInfo();
    const syncState = await this.storage.getSyncState();

    if (config.deviceToken && deviceInfo?.id) {
      await this.showConnectedSection(deviceInfo.id, config.serverUrl);
      const t = syncState.lastSyncTime
        ? new Date(syncState.lastSyncTime).toLocaleString()
        : 'Never';
      this.elements.lastSync.textContent = t;
      if (this.elements.syncLastTime) {
        this.elements.syncLastTime.textContent = t;
      }
    } else {
      this.showSetupSection();
    }
  }

  async updateSyncStatusPanel({ forceServerHealth = false } = {}) {
    if (!this.elements.syncStatusText) return;
    const config = await this.storage.getConfig();
    if (config.serverUrl && config.deviceToken) {
      await this.syncServerHealthForOptions({ force: forceServerHealth });
    }
    const syncState = await this.storage.getSyncState();
    this.applyOptionsHeaderServerIndicator(
      !config.serverUrl || !config.deviceToken ? null : syncState
    );
    const queuedEvents = await this.storage.getQueuedEvents();

    if (!config.serverUrl || !config.deviceToken) {
      this.elements.syncStatusText.textContent = 'Not configured';
    } else if (!navigator.onLine) {
      this.elements.syncStatusText.textContent = 'Browser offline';
    } else {
      this.elements.syncStatusText.textContent = 'Browser online';
    }

    this.elements.syncQueuedEvents.textContent = String(queuedEvents?.length || 0);
    const lastSyncText = syncState?.lastSyncTime
      ? new Date(syncState.lastSyncTime).toLocaleString()
      : 'Never';
    this.elements.syncLastTime.textContent = lastSyncText;
    if (this.elements.lastSync) {
      this.elements.lastSync.textContent = lastSyncText;
    }

    if (this.elements.syncServerStatus) {
      if (syncState?.serverReachable === false) {
        this.elements.syncServerStatus.textContent = 'Unreachable';
        this.elements.syncServerStatus.classList.add('value-bad');
      } else if (syncState?.serverReachable === true) {
        this.elements.syncServerStatus.textContent = 'Reachable';
        this.elements.syncServerStatus.classList.remove('value-bad');
      } else {
        this.elements.syncServerStatus.textContent = 'Unknown';
        this.elements.syncServerStatus.classList.remove('value-bad');
      }
    }

    await this.updateQuotaPanel();
  }

  _applyOptionsQuota(quota) {
    if (!quota || !this.elements.quotaUsed || !this.elements.quotaTotal) return;
    const usageBytes = quota.usageBytes ?? quota.usage_bytes ?? 0;
    const limitMB = quota.limitMB ?? quota.limit_mb ?? 0;
    const limitBytes = limitMB * 1024 * 1024;
    const percentage = quotaBarPercent(usageBytes, limitBytes);
    if (this.elements.quotaFill) {
      this.elements.quotaFill.style.width = `${Math.min(percentage, 100)}%`;
    }
    this.elements.quotaUsed.textContent = formatQuotaSizeLabel(usageBytes);
    this.elements.quotaTotal.textContent = formatQuotaSizeLabel(limitBytes);

    const n = quota.tabHistoryCount ?? 0;
    const sum = quota.tabHistoryBytesSum ?? 0;
    const avg = quota.avgEventBytes ?? 0;
    const elSum = this.elements.quotaHistorySummary;
    const elDrift = this.elements.quotaDriftNote;
    const elTbody = this.elements.quotaRecentEventsBody;
    const details = this.elements.quotaBreakdownDetails;
    if (elSum && details) {
      if (n > 0) {
        elSum.textContent = `${n.toLocaleString()} tab history rows stored; sum of per-row estimates ${formatQuotaSizeLabel(
          sum
        )}; average ${(avg / 1024).toFixed(2)} KB per row. (Server quota counter may differ slightly from this sum if older builds miscounted.)`;
      } else {
        elSum.textContent = 'No tab history rows on the server for this account yet.';
      }
    }
    if (elDrift) {
      const drift = Math.abs(usageBytes - sum);
      if (n > 0 && drift > 64 * 1024) {
        elDrift.style.display = 'block';
        elDrift.textContent = `Quota counter (${formatQuotaSizeLabel(
          usageBytes
        )}) differs from sum of row estimates (${formatQuotaSizeLabel(sum)}) by ${formatQuotaSizeLabel(
          drift
        )}. A future server build can reconcile these; data above shows the real row count and sizes.`;
      } else {
        elDrift.style.display = 'none';
        elDrift.textContent = '';
      }
    }
    if (elTbody) {
      elTbody.textContent = '';
      const rows = quota.recentEvents || [];
      if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = '—';
        tr.appendChild(td);
        elTbody.appendChild(tr);
      } else {
        const fmtKb = (b) => `${(Number(b) / 1024).toFixed(2)} KB`;
        for (const ev of rows) {
          const tr = document.createElement('tr');
          const when = ev.occurredAt || ev.occurred_at || '';
          const type = ev.eventType || ev.event_type || '';
          const sz = ev.sizeBytes ?? ev.size_bytes ?? 0;
          const url = ev.url || '';
          const shortUrl = url.length > 72 ? `${url.slice(0, 70)}…` : url;
          const addCell = (tag, cls, txt) => { const c = document.createElement(tag); if (cls) c.className = cls; c.textContent = txt; return c; };
          tr.appendChild(addCell('td', 'mono', when));
          tr.appendChild(addCell('td', '', String(type)));
          tr.appendChild(addCell('td', 'mono', fmtKb(sz)));
          const urlCell = addCell('td', '', shortUrl);
          urlCell.title = url;
          tr.appendChild(urlCell);
          elTbody.appendChild(tr);
        }
      }
    }
  }

  async updateQuotaPanel({ force = false } = {}) {
    if (!this.elements.quotaUsed || !this.elements.quotaTotal) return;
    const ttlMs = 2000;
    try {
      const config = await this.storage.getConfig();
      if (!config.serverUrl || !config.deviceToken) {
        this.elements.quotaUsed.textContent = '-';
        this.elements.quotaTotal.textContent = '-';
        if (this.elements.quotaFill) {
          this.elements.quotaFill.style.width = '0%';
        }
        if (this.elements.quotaHistorySummary) {
          this.elements.quotaHistorySummary.textContent = '';
        }
        if (this.elements.quotaDriftNote) {
          this.elements.quotaDriftNote.style.display = 'none';
          this.elements.quotaDriftNote.textContent = '';
        }
        if (this.elements.quotaRecentEventsBody) {
          this.elements.quotaRecentEventsBody.textContent = '';
        }
        return;
      }

      if (!force && this._optLastQuotaData && Date.now() - this._optQuotaFetchedAt < ttlMs) {
        this._applyOptionsQuota(this._optLastQuotaData);
        return;
      }
      if (!this._optQuotaInFlight) {
        this._optQuotaInFlight = (async () => {
          this.apiClient.setServerUrl(config.serverUrl);
          this.apiClient.setDeviceToken(config.deviceToken);
          const q = await this.apiClient.getQuota();
          this._optLastQuotaData = q;
          this._optQuotaFetchedAt = Date.now();
          return q;
        })().finally(() => {
          this._optQuotaInFlight = null;
        });
      }
      const quota = await this._optQuotaInFlight;
      if (quota) {
        const nq = this.apiClient.normalizeQuota(quota);
        this._applyOptionsQuota(nq);
        await this.storage.setCachedQuota(nq);
      } else {
        this.elements.quotaUsed.textContent = '0 KB';
        this.elements.quotaTotal.textContent = '0 KB';
        if (this.elements.quotaFill) {
          this.elements.quotaFill.style.width = '0%';
        }
      }
    } catch (error) {
      this._optQuotaInFlight = null;
      logger.warn('Failed to fetch quota:', error);
      const cached = await this.storage.getCachedQuota();
      if (cached && cached.quota) {
        this._applyOptionsQuota(cached.quota);
      } else {
        this.elements.quotaUsed.textContent = '0 KB';
        this.elements.quotaTotal.textContent = '0 KB';
        if (this.elements.quotaFill) {
          this.elements.quotaFill.style.width = '0%';
        }
      }
    }
  }

  async clearHistory() {
    try {
      const config = await this.storage.getConfig();
      if (!config.serverUrl || !config.deviceToken) {
        this.showStatus('error', 'Not connected');
        return;
      }

      this.apiClient.setServerUrl(config.serverUrl);
      this.apiClient.setDeviceToken(config.deviceToken);

      await this.apiClient.clearHistory();
      try {
        await this.storage.remove('historyEventsCache');
      } catch (e) {
        /* optional */
      }
      this.showNotification('History cleared');
      await this.updateHistoryView();
      await this.updateQuotaPanel({ force: true });
    } catch (error) {
      this.showStatus('error', `Failed to clear history: ${error.message}`);
    }
  }

  async updateDeviceList() {
    if (!this.elements.deviceList) return;

    const hideCacheNotice = () => {
      if (this.elements.devicesCacheNotice) {
        this.elements.devicesCacheNotice.style.display = 'none';
        this.elements.devicesCacheNotice.textContent = '';
      }
    };

    this.elements.devicesLoading.style.display = 'block';
    this.elements.devicesEmpty.style.display = 'none';
    hideCacheNotice();
    this.elements.deviceList.querySelectorAll('.device-row').forEach((node) => node.remove());

    try {
      const config = await this.storage.getConfig();
      if (!config.serverUrl || !config.deviceToken) {
        this.elements.devicesLoading.style.display = 'none';
        this.elements.devicesEmpty.style.display = 'block';
        this.elements.devicesEmpty.textContent = 'Connect a device to manage devices.';
        return;
      }

      this.apiClient.setServerUrl(config.serverUrl);
      this.apiClient.setDeviceToken(config.deviceToken);

      const deviceInfo = await this.storage.getDeviceInfo();
      this.currentDeviceId = deviceInfo?.id || null;

      const syncState = await this.storage.getSyncState();
      const lastSyncStr = syncState?.lastSyncTime
        ? new Date(syncState.lastSyncTime).toLocaleString()
        : null;

      let devices = [];
      let fromCache = false;
      try {
        const response = await this.apiClient.getDevices();
        devices = response?.devices || [];
        await this.storage.setCachedDevicesList(devices);
      } catch (error) {
        logger.warn('Failed to load devices from server; using cache if available', error);
        const cached = await this.storage.getCachedDevicesList();
        devices = cached?.devices || [];
        fromCache = true;
        if (this.elements.devicesCacheNotice) {
          const t =
            cached?.updatedAt > 0
              ? new Date(cached.updatedAt).toLocaleString(undefined, {
                  dateStyle: 'short',
                  timeStyle: 'short'
                })
              : 'earlier';
          this.elements.devicesCacheNotice.textContent = `Could not reach the server. Showing devices list saved in this extension (${t}). Last sync: ${lastSyncStr || 'never'}.`;
          this.elements.devicesCacheNotice.style.display = 'block';
        }
      }

      if (!devices.length) {
        this.elements.devicesLoading.style.display = 'none';
        this.elements.devicesEmpty.style.display = 'block';
        if (fromCache) {
          this.elements.devicesEmpty.textContent = `No cached devices. Server unreachable. Last sync: ${lastSyncStr || 'never'}. Connect once while the server is up to cache this list.`;
        } else {
          this.elements.devicesEmpty.textContent = 'No devices found.';
        }
        return;
      }

      devices.forEach((device) => {
        const row = this.createDeviceRow(device);
        this.elements.deviceList.appendChild(row);
      });

      this.populateRegistryDeviceFilters(devices);

      this.elements.devicesLoading.style.display = 'none';
      if (fromCache && this.elements.devicesCacheNotice && devices.length === 1 && this.currentDeviceId) {
        const only = devices[0];
        if (only && only.id === this.currentDeviceId) {
          this.elements.devicesCacheNotice.textContent = `Server unreachable. Only this device is in the saved list. Last sync: ${lastSyncStr || 'never'}.`;
          this.elements.devicesCacheNotice.style.display = 'block';
        }
      }
    } catch (error) {
      logger.error('Failed to load devices:', error);
      this.elements.devicesLoading.style.display = 'none';
      this.elements.devicesEmpty.style.display = 'block';
      this.elements.devicesEmpty.textContent = 'Failed to load devices.';
    }
  }

  createDeviceRow(device) {
    const row = document.createElement('div');
    row.className = 'device-row';

    const info = document.createElement('div');
    info.className = 'device-info-block';
    const title = document.createElement('div');
    title.className = 'device-title';
    const isCurrentDevice = this.currentDeviceId && device.id === this.currentDeviceId;
    const suffix = isCurrentDevice ? ' — this device' : '';
    title.textContent = `${device.device_name || 'Unnamed'} (${device.browser || 'unknown'})${suffix}`;
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'Unknown';
    meta.textContent = `Last seen: ${lastSeen}`;
    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'device-actions';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Rename device';
    input.value = device.device_name || '';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'secondary-btn';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const newName = input.value.trim();
      if (!newName) {
        this.showNotification('Enter a device name');
        return;
      }
      try {
        await this.apiClient.updateDeviceName(device.id, newName);
        this.showNotification('Device renamed');
        await this.updateDeviceList();
      } catch (error) {
        this.showStatus('error', `Rename failed: ${error.message}`);
      }
    });

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'danger-btn';
    revokeBtn.textContent = isCurrentDevice ? 'Sign out' : 'Revoke';
    revokeBtn.title = isCurrentDevice
      ? 'Revoking this device will sign it out and clear local credentials.'
      : 'Revoking disables tab sync on that device and invalidates its token.';
    revokeBtn.addEventListener('click', () => {
      const label = device.device_name || device.browser || 'this device';
      const esc = this._escapeHtml(label);
      const title = isCurrentDevice ? 'Sign out?' : 'Revoke device?';
      const bodyHtml = isCurrentDevice
        ? `<p>Sign out <strong>${esc}</strong> (this browser)? You will need to re-pair to sync again.</p>`
        : `<p>Revoke <strong>${esc}</strong>? Its token will stop working immediately.</p>`;
      this.openDangerConfirm({
        title,
        bodyHtml,
        confirmLabel: isCurrentDevice ? 'Sign out' : 'Revoke',
        onConfirm: async () => {
          try {
            await this.apiClient.revokeDevice(device.id);
            this.showNotification(isCurrentDevice ? 'This device signed out' : 'Device revoked');
            if (isCurrentDevice) {
              await this.clearLocalCredentials();
              return;
            }
            await this.updateDeviceList();
          } catch (error) {
            this.showStatus('error', `Revoke failed: ${error.message}`);
          }
        }
      });
    });

    actions.appendChild(input);
    actions.appendChild(renameBtn);
    actions.appendChild(revokeBtn);

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  // clearLocalCredentials wipes this browser's device token + identity so
  // the UI returns to the unconnected state. Used after self-revocation or
  // when the server pushes a device_revoked event for our own device_id.
  async clearLocalCredentials() {
    await this.saveConfiguration({ deviceToken: '' });
    await this.storage.setDeviceInfo({ id: null });
    this.apiClient.setDeviceToken(null);
    this.currentDeviceId = null;
    this.showSetupSection();
    await this.updateDeviceList();
  }

  async saveSyncSettings() {
    const updates = {
      syncEnabled: this.elements.enableSync?.checked ?? true,
      syncInterval: parseInt(this.elements.syncInterval?.value || '5000', 10),
      enableRealtime: this.elements.enableRealtime?.checked ?? true,
      enableNotifications: this.elements.enableNotifications?.checked ?? true
    };

    await this.saveConfiguration(updates);
    this.ensureAlarmSchedule(updates);
    this.showNotification('Sync settings saved');
  }

  ensureAlarmSchedule(config) {
    if (config.syncEnabled === false) {
      ext.alarms.clear('periodicSync');
      return;
    }
    // Must match `getPeriodicSyncAlarmMinutes` in background.js: alarms are
    // minute-based fallbacks; sub-minute options use setInterval in the worker.
    const ms = config.syncInterval || 300000;
    const rounded = Math.round(ms / 60000);
    const periodMinutes = Math.max(1, Math.min(24 * 60, rounded < 1 ? 1 : rounded));
    ext.alarms.create('periodicSync', {
      delayInMinutes: periodMinutes,
      periodInMinutes: periodMinutes
    });
  }

  async updateHistoryView() {
    await this.updateCurrentTabsView();
    await this.updateHistoryEvents();
  }

  _stopHistoryTabDebouncedRefresh() {
    if (this._historyFromCacheDebounceTimer) {
      clearTimeout(this._historyFromCacheDebounceTimer);
      this._historyFromCacheDebounceTimer = null;
    }
  }

  _startTabsTabPolling() {
    this._stopTabsTabPolling();
    this._tabsPollTimer = setInterval(() => {
      if (this.activeTab !== 'tabs') return;
      this.updateCurrentTabsView({ background: true, fromPoll: true }).catch((e) =>
        logger.warn('tabs poll:', e)
      );
    }, HISTORY_BG_POLL_MS);
  }

  _stopTabsTabPolling() {
    if (this._tabsPollTimer) {
      clearInterval(this._tabsPollTimer);
      this._tabsPollTimer = null;
    }
  }

  _scheduleDebouncedHistoryCacheRefresh() {
    if (this._historyFromCacheDebounceTimer) {
      clearTimeout(this._historyFromCacheDebounceTimer);
    }
    this._historyFromCacheDebounceTimer = setTimeout(() => {
      this._historyFromCacheDebounceTimer = null;
      this.updateHistoryEvents({ background: true }).catch((e) =>
        logger.warn('options history cache refresh:', e)
      );
    }, HISTORY_CACHE_DEBOUNCE_MS);
  }

  /** Stable string for “would the history list look the same?” — avoids DOM churn while the tab is open. */
  computeHistoryRenderFingerprint() {
    const mode = this.elements.historyViewMode?.value || 'timeline';
    const dedupe = this.elements.historyDedupeDisplay?.checked !== false ? '1' : '0';
    const focus = this._historyTabFocus
      ? `${this._historyTabFocus.deviceId}|${this._historyTabFocus.tabIdHash || ''}|${(this._historyTabFocus.url || '').slice(0, 120)}|${this._historyTabFocus.windowId ?? ''}`
      : '';
    const forRender = this.getHistoryItemsForRender();
    const ids = forRender.map((e) => e.id).join(',');
    return `${mode}|${dedupe}|${this.historyDisplayLimit}|${focus}|${ids}`;
  }

  captureHistoryScrollSnapshot() {
    const hEl = this.elements.historyList;
    const tEl = this.elements.currentTabsList;
    const hMax = hEl ? Math.max(0, hEl.scrollHeight - hEl.clientHeight) : 0;
    const tMax = tEl ? Math.max(0, tEl.scrollHeight - tEl.clientHeight) : 0;
    return {
      history: hEl?.scrollTop ?? 0,
      hRatio: hMax > 0 ? hEl.scrollTop / hMax : 0,
      tabs: tEl?.scrollTop ?? 0,
      tRatio: tMax > 0 ? tEl.scrollTop / tMax : 0
    };
  }

  /**
   * After async fetch + DOM replace, raw scrollTop can clamp wrong before layout
   * finishes. Restoring a ratio of (scrollTop / maxScroll) keeps the user’s
   * position in the list; a second pass catches late font/image layout.
   */
  restoreHistoryScrollSnapshot(snap) {
    if (!snap) return;
    const apply = () => {
      const hEl = this.elements.historyList;
      if (hEl) {
        const hMax = Math.max(0, hEl.scrollHeight - hEl.clientHeight);
        if (typeof snap.hRatio === 'number' && hMax > 0) {
          hEl.scrollTop = Math.min(hMax, Math.round(snap.hRatio * hMax));
        } else {
          hEl.scrollTop = Math.min(hMax, snap.history);
        }
      }
      const tEl = this.elements.currentTabsList;
      if (tEl) {
        const tMax = Math.max(0, tEl.scrollHeight - tEl.clientHeight);
        if (typeof snap.tRatio === 'number' && tMax > 0) {
          tEl.scrollTop = Math.min(tMax, Math.round(snap.tRatio * tMax));
        } else {
          tEl.scrollTop = Math.min(tMax, snap.tabs);
        }
      }
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
        setTimeout(apply, 32);
      });
    });
  }

  async updateCurrentTabsView(options = {}) {
    if (!this.elements.currentTabsList) return;
    const background = options.background === true;
    const force = options.force === true;
    const fromPoll = options.fromPoll === true;

    const hideTabsCacheNotice = () => {
      if (this.elements.currentTabsCacheNotice) {
        this.elements.currentTabsCacheNotice.style.display = 'none';
        this.elements.currentTabsCacheNotice.textContent = '';
      }
    };

    try {
      const config = await this.storage.getConfig();
      if (!config.serverUrl || !config.deviceToken) {
        this.elements.currentTabsLoading.style.display = 'none';
        this.elements.currentTabsEmpty.style.display = 'block';
        this.elements.currentTabsEmpty.textContent = 'Connect a device to view synced tabs.';
        this._lastTabsViewRenderFingerprint = null;
        return;
      }

      this.apiClient.setServerUrl(config.serverUrl);
      this.apiClient.setDeviceToken(config.deviceToken);

      const syncState = await this.storage.getSyncState();
      const serverUnreachable = syncState?.serverReachable === false;

      /**
       * Background: after each sync the service worker updates `remoteTabs` in storage,
       * then updates `syncState`. Re-read storage — do not call GET /tabs/current again
       * (avoids rate limits + DOM churn). Poll / explicit refresh use network.
       */
      const storageOnlyRefresh =
        background && !force && !fromPoll && !serverUnreachable;

      let devices = [];
      let fromCache = false;
      /** 'error' = fetch failed; 'stale' = API returned [] but we kept last good snapshot. */
      let tabsCacheReason = null;

      if (background && serverUnreachable) {
        devices = (await this.storage.getRemoteTabs()) || [];
        fromCache = devices.length > 0;
        tabsCacheReason = 'error';
      } else if (storageOnlyRefresh) {
        devices = (await this.storage.getRemoteTabs()) || [];
      } else {
        try {
          const response = await this.apiClient.getCurrentTabs();
          devices = response?.devices || [];
          if (devices.length > 0) {
            await this.storage.setRemoteTabs(devices);
          } else {
            const cached = (await this.storage.getRemoteTabs()) || [];
            if (cached.length > 0) {
              devices = cached;
              fromCache = true;
              tabsCacheReason = 'stale';
            }
          }
        } catch (err) {
          logger.warn('getCurrentTabs failed; showing saved copy from extension storage', err);
          devices = (await this.storage.getRemoteTabs()) || [];
          fromCache = true;
          tabsCacheReason = 'error';
        }
      }

      devices = this._dedupeTabsDevicesById(devices);

      let selectedDevice = this.elements.tabsDeviceFilter?.value || '';
      this.populateTabsDeviceFilter(devices);
      selectedDevice = this.elements.tabsDeviceFilter?.value || '';

      const afterDevice = devices.filter(
        (device) => !selectedDevice || device.device_id === selectedDevice
      );
      const tabCountAfterDevice = afterDevice.reduce(
        (n, d) => n + (d.tabs || []).length,
        0
      );

      const searchTerm = this.elements.currentTabsSearch?.value.trim().toLowerCase() || '';
      const filteredDevices = afterDevice
        .map((device) => {
          if (!searchTerm) return device;
          const tabs = (device.tabs || []).filter((tab) => {
            const title = tab.title || '';
            const url = tab.url || '';
            return `${title} ${url}`.toLowerCase().includes(searchTerm);
          });
          return { ...device, tabs };
        })
        .filter((device) => (device.tabs || []).length > 0);

      const prefs = await this.storage.getPreferences();
      const maxTabs = Math.max(10, Math.min(100, prefs.maxTabsPerDevice || 50));
      const showFavicons = prefs.showFavicons !== false;

      const renderFp = this._computeTabsRenderFingerprint(
        filteredDevices,
        selectedDevice,
        searchTerm,
        maxTabs,
        showFavicons,
        fromCache,
        tabsCacheReason,
        tabCountAfterDevice
      );

      if (background && !force && renderFp === this._lastTabsViewRenderFingerprint) {
        return;
      }
      this._lastTabsViewRenderFingerprint = renderFp;

      if (!background) {
        this.elements.currentTabsLoading.style.display = 'block';
        this.elements.currentTabsEmpty.style.display = 'none';
      }
      hideTabsCacheNotice();
      this.elements.currentTabsList.querySelectorAll('.history-device').forEach((node) => node.remove());

      if (!filteredDevices.length) {
        this.elements.currentTabsLoading.style.display = 'none';
        this.elements.currentTabsEmpty.style.display = 'block';
        if (searchTerm && tabCountAfterDevice > 0) {
          this.elements.currentTabsEmpty.textContent = 'No tabs match your search.';
        } else if (fromCache) {
          this.elements.currentTabsEmpty.textContent =
            'The server is unreachable and this extension has no tab snapshot in storage. Remote tabs are saved to chrome.storage.local only after a successful online load. Reconnect, open this page, and the list should refresh. If you never saw other devices’ tabs while online, nothing was stored yet.';
        } else {
          this.elements.currentTabsEmpty.textContent = 'No synced tabs to display.';
        }
        return;
      }

      if (fromCache && this.elements.currentTabsCacheNotice) {
        const ts = await this.storage.getRemoteTabsUpdatedAt();
        const t =
          ts > 0
            ? new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
            : 'earlier';
        this.elements.currentTabsCacheNotice.textContent =
          tabsCacheReason === 'stale'
            ? `The server returned an empty tab snapshot. Showing the last one saved in this extension (${t}).`
            : `Could not reach the server. Showing data saved in this extension (last snapshot: ${t}).`;
        this.elements.currentTabsCacheNotice.style.display = 'block';
      } else {
        hideTabsCacheNotice();
      }

      filteredDevices.forEach((device) => {
        const deviceSection = this.createHistoryDeviceSection(device, {
          groupByWindow: true,
          maxTabs,
          showFavicons
        });
        this.elements.currentTabsList.appendChild(deviceSection);
      });
      this.highlightFocusedSyncedTab();

      this.elements.currentTabsLoading.style.display = 'none';
    } catch (error) {
      logger.error('Failed to load synced tabs:', error);
      this.elements.currentTabsLoading.style.display = 'none';
      this.elements.currentTabsEmpty.style.display = 'block';
      this.elements.currentTabsEmpty.textContent = 'Failed to load synced tabs.';
      hideTabsCacheNotice();
    }
  }

  async updateHistoryEvents(options = {}) {
    if (!this.elements.historyList) return;
    const background = options.background === true;
    if (background) {
      const now = Date.now();
      if (
        this._lastBackgroundHistoryFetchAt &&
        now - this._lastBackgroundHistoryFetchAt < HISTORY_BG_MIN_INTERVAL_MS
      ) {
        if (typeof logger !== 'undefined' && logger.info) {
          logger.info(
            '[KeepSync:history:options] skipped (background min-interval; open DevTools and Refresh for full load)'
          );
        }
        return;
      }
    }

    const hideHistoryCacheNotice = () => {
      if (this.elements.historyCacheNotice) {
        this.elements.historyCacheNotice.style.display = 'none';
        this.elements.historyCacheNotice.textContent = '';
      }
    };

    if (!background) {
      this.elements.historyLoading.style.display = 'block';
      this.elements.historyEmpty.style.display = 'none';
      hideHistoryCacheNotice();
      this.elements.historyList
        .querySelectorAll('.history-event, .history-tab-group, .history-tree-root')
        .forEach((node) => node.remove());
    }

    try {
      const config = await this.storage.getConfig();
      if (!config.serverUrl || !config.deviceToken) {
        if (background) {
          return;
        }
        this.elements.historyLoading.style.display = 'none';
        this.elements.historyEmpty.style.display = 'block';
        this.elements.historyEmpty.textContent = 'Connect a device to view history.';
        this.lastHistoryItems = [];
        if (this.elements.historySeeMore) {
          this.elements.historySeeMore.style.display = 'none';
        }
        return;
      }

      this.apiClient.setServerUrl(config.serverUrl);
      this.apiClient.setDeviceToken(config.deviceToken);

      const selectedDevice = this.elements.rawDeviceFilter?.value || '';
      const selectedType = this.elements.eventTypeFilter?.value || '';

      let items = [];
      let fromCache = false;

      try {
        if (background) {
          this._lastBackgroundHistoryFetchAt = Date.now();
        }
        const response = await this.apiClient.getHistory({
          deviceId: selectedDevice || undefined,
          limit: 200
        });
        items = response?.items || [];
        if (items.length > 0) {
          // Only cache an unfiltered list; caching one device was overwriting
          // the "all devices" list and made History look empty after changing filters.
          if (!selectedDevice) {
            await this.storage.setHistoryEventsCache(items);
          }
        } else {
          const c = await this.storage.getHistoryEventsCache();
          let ci = c?.items || [];
          if (selectedDevice) {
            ci = ci.filter((it) => (it.device_id || it.deviceId) === selectedDevice);
          }
          if (ci.length > 0) {
            items = ci;
            fromCache = true;
            if (this.elements.historyCacheNotice) {
              const t =
                c.updatedAt > 0
                  ? new Date(c.updatedAt).toLocaleString(undefined, {
                      dateStyle: 'short',
                      timeStyle: 'short'
                    })
                  : 'earlier';
              this.elements.historyCacheNotice.textContent = `The server returned no events. Showing last events saved in this extension (${t}).`;
              this.elements.historyCacheNotice.style.display = 'block';
            }
          }
        }
      } catch (err) {
        logger.warn('getHistory failed; using last saved list from extension storage', err);
        const c = await this.storage.getHistoryEventsCache();
        items = c?.items || [];
        if (selectedDevice) {
          items = items.filter((it) => (it.device_id || it.deviceId) === selectedDevice);
        }
        fromCache = true;
        if (this.elements.historyCacheNotice && items.length) {
          const t =
            c && c.updatedAt > 0
              ? new Date(c.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
              : 'earlier';
          this.elements.historyCacheNotice.textContent = `Server unreachable. Showing last loaded events (saved in this extension, ${t}).`;
          this.elements.historyCacheNotice.style.display = 'block';
        }
      }

      const beforeFilter = items;

      if (selectedType) {
        items = items.filter((item) => (item.event_type || item.eventType) === selectedType);
      }

      const searchTerm = this.elements.historySearch?.value.trim().toLowerCase() || '';
      if (searchTerm) {
        items = items.filter((item) => {
          const title = item.title || '';
          const url = item.url || '';
          return `${title} ${url}`.toLowerCase().includes(searchTerm);
        });
      }

      if (!fromCache) {
        hideHistoryCacheNotice();
      }

      this.lastHistoryItems = items;

      if (typeof logger !== 'undefined' && logger.info) {
        logger.info('[KeepSync:history:options] updateHistoryEvents', {
          background,
          fromCache,
          fromServer: !fromCache,
          beforeFilter: beforeFilter.length,
          afterSearchAndType: items.length,
          device: selectedDevice || '(all)',
          eventType: selectedType || '(all)',
          search: (this.elements.historySearch?.value || '').trim() || '(none)'
        });
      }

      // Unreachable server + no rows at all (not "filters removed everything")
      if (fromCache && !beforeFilter.length) {
        this._lastHistoryRenderMeta = {
          beforeFilterCount: 0,
          fromCache: true,
          noEventsForDevice: false,
          serverEmpty: false
        };
        if (background) {
          const fp = this.computeHistoryRenderFingerprint();
          if (fp === this._lastHistoryRenderFingerprint) {
            if (typeof logger !== 'undefined' && logger.info) {
              logger.info(
                '[KeepSync:history:options] no-op UI (fingerprint match); press Refresh if you expect new events'
              );
            }
            return;
          }
        }
        this.elements.historyLoading.style.display = 'none';
        this.elements.historyList
          .querySelectorAll('.history-event, .history-tab-group, .history-tree-root')
          .forEach((node) => node.remove());
        this.elements.historyEmpty.style.display = 'block';
        this.elements.historyEmpty.textContent =
          "The server is unreachable and there is no events list in this extension's history cache. Events are written to chrome.storage.local only after a successful online load of Recent events (or a background sync that fetched /history). Reconnect and tap Refresh, or the server may have had no event rows. Clear history in Advanced only removes the local copy.";
        if (this.elements.historySeeMore) {
          this.elements.historySeeMore.style.display = 'none';
        }
        this._lastHistoryRenderFingerprint = this.computeHistoryRenderFingerprint();
        return;
      }

      this._lastHistoryRenderMeta = {
        beforeFilterCount: beforeFilter.length,
        fromCache,
        noEventsForDevice:
          !fromCache && beforeFilter.length === 0 && !selectedType && !searchTerm && !!selectedDevice,
        serverEmpty:
          !fromCache && beforeFilter.length === 0 && !selectedType && !searchTerm && !selectedDevice
      };
      if (background) {
        const fp = this.computeHistoryRenderFingerprint();
        if (fp === this._lastHistoryRenderFingerprint) {
          if (typeof logger !== 'undefined' && logger.info) {
            logger.info(
              '[KeepSync:history:options] no-op UI (fingerprint match); press Refresh if you expect new events'
            );
          }
          return;
        }
      }
      const scrollSnapshot = background ? this.captureHistoryScrollSnapshot() : null;
      this.renderHistoryEvents(this._lastHistoryRenderMeta);
      if (background) {
        this.restoreHistoryScrollSnapshot(scrollSnapshot);
      }
    } catch (error) {
      logger.error('Failed to load history events:', error);
      if (background) {
        return;
      }
      this.elements.historyLoading.style.display = 'none';
      this.elements.historyEmpty.style.display = 'block';
      this.elements.historyEmpty.textContent = 'Failed to load history.';
      hideHistoryCacheNotice();
    }
  }

  /**
   * Server stores a browser tag at device registration. Firefox was mis-tagged
   * as "chrome" until detectBrowser() checked `browser` before `chrome`. For
   * this device we show the running browser; for others, the server value.
   */
  formatBrowserDisplayName(stored) {
    if (!stored) {
      return 'Browser';
    }
    const s = String(stored).toLowerCase();
    const map = { chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge', unknown: 'Browser' };
    if (map[s]) {
      return map[s];
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  deviceLabelBrowser(device) {
    if (!device) {
      return 'Browser';
    }
    if (this.currentDeviceId && device.device_id === this.currentDeviceId) {
      return this.formatBrowserDisplayName(detectBrowser());
    }
    return this.formatBrowserDisplayName(device.browser);
  }

  populateTabsDeviceFilter(devices) {
    const sel = this.elements.tabsDeviceFilter;
    if (!sel) {
      return;
    }
    (devices || []).forEach((device) => {
      const id = device.device_id || device.id;
      if (!id) {
        return;
      }
      const shortName =
        device.device_name || device.DeviceName || (id ? id.slice(-6) : 'unknown');
      const browser = this.deviceLabelBrowser(device);
      const line = `${browser} — ${shortName}`;
      this._deviceFilterLabels.set(id, line);
    });
    const prev = sel.value || '';
    sel.textContent = '';
    sel.add(new Option('All devices', ''));
    (devices || []).forEach((device) => {
      const id = device.device_id || device.id;
      if (!id) {
        return;
      }
      const option = document.createElement('option');
      option.value = id;
      option.textContent = this._deviceFilterLabels.get(id) || id;
      sel.appendChild(option);
    });
    if (prev) {
      sel.value = prev;
    }
  }

  /** Paired devices from GET /devices — fills History + Raw event filters. */
  populateRegistryDeviceFilters(devices) {
    const normalized = (devices || []).map((d) => ({
      device_id: d.id,
      device_name: d.device_name,
      browser: d.browser
    }));
    normalized.forEach((device) => {
      const shortName =
        device.device_name || (device.device_id ? device.device_id.slice(-6) : 'unknown');
      const browser = this.deviceLabelBrowser(device);
      this._deviceFilterLabels.set(device.device_id, `${browser} — ${shortName}`);
    });
    const fill = (selectEl) => {
      if (!selectEl) {
        return;
      }
      const prev = selectEl.value || '';
      selectEl.textContent = '';
      selectEl.add(new Option('All devices', ''));
      normalized.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.device_id;
        option.textContent =
          this._deviceFilterLabels.get(device.device_id) || device.device_id;
        selectEl.appendChild(option);
      });
      if (prev) {
        selectEl.value = prev;
      }
    };
    fill(this.elements.histSessionsDeviceFilter);
    fill(this.elements.rawDeviceFilter);
  }

  deviceLabelForHistory(deviceId) {
    if (!deviceId) {
      return 'Unknown device';
    }
    return this._deviceFilterLabels.get(deviceId) || `Device ${String(deviceId).slice(0, 8)}…`;
  }

  planDeviceTabsForList(tabs, maxPerDevice) {
    const raw = tabs || [];
    const grouped = this.groupTabsByWindow(raw);
    const windowKeys = Object.keys(grouped).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    const ordinalMap = new Map();
    windowKeys.forEach((k, i) => ordinalMap.set(k, i + 1));
    const allInWindows = {};
    windowKeys.forEach((wk) => {
      allInWindows[wk] = (grouped[wk] || []).map((t) => this.normalizeTab(t));
    });
    let budget = maxPerDevice;
    const visibleGrouped = {};
    let totalHidden = 0;
    for (const wk of windowKeys) {
      const list = grouped[wk] || [];
      if (budget <= 0) {
        totalHidden += list.length;
        continue;
      }
      const take = list.slice(0, budget);
      visibleGrouped[wk] = take.map((t) => this.normalizeTab(t));
      const left = list.length - take.length;
      totalHidden += left;
      budget -= take.length;
    }
    return { visibleGrouped, ordinalMap, allInWindows, totalHidden, windowKeys };
  }

  _isTabsDeviceSectionCollapsed(deviceId) {
    if (!deviceId) {
      return false;
    }
    try {
      const raw = sessionStorage.getItem(TABS_DEVICE_COLLAPSED_KEY);
      const o = raw ? JSON.parse(raw) : {};
      return o[deviceId] === true;
    } catch {
      return false;
    }
  }

  _setTabsDeviceSectionCollapsed(deviceId, collapsed) {
    if (!deviceId) {
      return;
    }
    try {
      const raw = sessionStorage.getItem(TABS_DEVICE_COLLAPSED_KEY);
      const o = raw ? JSON.parse(raw) : {};
      if (collapsed) {
        o[deviceId] = true;
      } else {
        delete o[deviceId];
      }
      sessionStorage.setItem(TABS_DEVICE_COLLAPSED_KEY, JSON.stringify(o));
    } catch {
      /* ignore */
    }
  }

  /**
   * If the API or cache ever returns the same device_id twice, keep one snapshot
   * (prefer more tabs, then higher version).
   */
  _dedupeTabsDevicesById(devices) {
    const map = new Map();
    for (const d of devices || []) {
      const id = d.device_id || d.id;
      if (!id) {
        continue;
      }
      const cur = map.get(id);
      if (!cur) {
        map.set(id, d);
        continue;
      }
      const na = (cur.tabs || []).length;
      const nb = (d.tabs || []).length;
      const va = cur.version != null ? Number(cur.version) : 0;
      const vb = d.version != null ? Number(d.version) : 0;
      if (nb > na || (nb === na && vb >= va)) {
        map.set(id, d);
      }
    }
    return [...map.values()];
  }

  createHistoryDeviceSection(device, options = {}) {
    const groupByWindow = options.groupByWindow === true;
    const maxTabs = options.maxTabs || 50;
    const showFavicons = options.showFavicons !== false;

    const deviceId = device.device_id || device.id || '';
    const collapsible = options.collapsibleDevice !== false && !!deviceId;

    const outer = document.createElement('details');
    outer.className = 'history-device history-device-block';
    if (collapsible) {
      outer.open = !this._isTabsDeviceSectionCollapsed(deviceId);
      outer.addEventListener('toggle', () => {
        this._setTabsDeviceSectionCollapsed(deviceId, !outer.open);
      });
    } else {
      outer.open = true;
    }

    const header = document.createElement('summary');
    header.className = 'device-header';
    const label = device.device_name || (device.device_id ? device.device_id.slice(-6) : 'unknown');
    const browserLabel = this.deviceLabelBrowser(device);
    const deviceName = `${browserLabel} — ${label}`;
    const count = (device.tabs || []).length;
    const nameSpan = document.createElement('span'); nameSpan.textContent = deviceName;
    const countSpan = document.createElement('span'); countSpan.className = 'device-count'; countSpan.textContent = count;
    header.appendChild(nameSpan); header.appendChild(countSpan);
    outer.appendChild(header);

    const list = document.createElement('div');
    list.className = 'history-items';

    const tabs = device.tabs || [];
    if (groupByWindow) {
      const plan = this.planDeviceTabsForList(tabs, maxTabs);
      const keysWithVisible = plan.windowKeys.filter((wk) => (plan.visibleGrouped[wk] || []).length > 0);
      for (const windowId of keysWithVisible) {
        const ord = plan.ordinalMap.get(windowId) || 0;
        const visibleTabs = plan.visibleGrouped[windowId] || [];
        const allInWin = plan.allInWindows[windowId] || [];
        const nAll = allInWin.length;
        if (visibleTabs.length === 0) continue;

        const det = document.createElement('details');
        det.className = 'history-window-block';
        det.open = true;

        const summary = document.createElement('summary');
        summary.className = 'history-window-summary';

        const tool = document.createElement('div');
        tool.className = 'history-window-toolbar';
        const tlabel = document.createElement('div');
        tlabel.className = 'history-window-title';
        tlabel.textContent = `Window ${ord} · ${nAll} tab${nAll === 1 ? '' : 's'}`;
        const openAll = document.createElement('button');
        openAll.type = 'button';
        openAll.className = 'open-window-link';
        openAll.textContent = nAll > 1 ? 'Open all' : 'Open';
        openAll.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openWindowTabs(allInWin.map((t) => t.url).filter(Boolean));
        });
        tool.appendChild(tlabel);
        tool.appendChild(openAll);
        summary.appendChild(tool);

        const itemsWrap = document.createElement('div');
        itemsWrap.className = 'history-window-items';
        for (const tab of visibleTabs) {
          itemsWrap.appendChild(
            this.createHistoryTabItem(tab, { showFavicons, deviceId: device.device_id })
          );
        }

        det.appendChild(summary);
        det.appendChild(itemsWrap);
        list.appendChild(det);
      }
      if (plan.totalHidden > 0) {
        const hint = document.createElement('div');
        hint.className = 'tab-overflow-hint';
        hint.textContent = `${plan.totalHidden} more tab(s) not shown. Raise the limit in Advanced.`;
        list.appendChild(hint);
      }
    } else {
      tabs.forEach((tab) => {
        list.appendChild(
          this.createHistoryTabItem(tab, { showFavicons, deviceId: device.device_id })
        );
      });
    }

    outer.appendChild(list);
    return outer;
  }

  /**
   * Display-only filters for the raw tab_history list: drop browser backfill
   * rows that overlap live tab sync telemetry, and collapse rapid duplicate
   * updates (mirrors server window loosely). Export JSON still uses full rows.
   */
  _dedupeRawHistoryItemsForDisplay(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    if (list.length < 2) {
      return list;
    }
    const HIST_OVERLAP_MS = 90_000;
    const UPDATE_BURST_MS = 6_000;
    const tMs = (it) => {
      const s = it.occurred_at || it.occurredAt;
      const n = s ? new Date(s).getTime() : 0;
      return Number.isFinite(n) ? n : 0;
    };
    const dev = (it) => it.device_id || it.deviceId || '';
    const url = (it) => String(it.url || '').trim();
    const cid = (it) => String(it.tab_correlation_id || it.tabCorrelationId || '').trim();
    const typ = (it) => String(it.event_type || it.eventType || '').toLowerCase();
    const tabEventTypes = new Set(['create', 'update', 'close']);

    const hideIdx = new Set();
    for (let i = 0; i < list.length; i++) {
      if (typ(list[i]) !== 'history') {
        continue;
      }
      const hi = list[i];
      const hiT = tMs(hi);
      const hiD = dev(hi);
      const hiU = url(hi);
      const hiC = cid(hi);
      if (!hiU) {
        continue;
      }
      for (let j = 0; j < list.length; j++) {
        if (i === j) {
          continue;
        }
        const o = list[j];
        if (!tabEventTypes.has(typ(o))) {
          continue;
        }
        if (dev(o) !== hiD || url(o) !== hiU) {
          continue;
        }
        if (Math.abs(tMs(o) - hiT) > HIST_OVERLAP_MS) {
          continue;
        }
        const oc = cid(o);
        if (hiC && oc && hiC !== oc) {
          continue;
        }
        hideIdx.add(i);
        break;
      }
    }

    const filtered = list.filter((_, i) => !hideIdx.has(i));
    const out = [];
    const lastKeptUpdateMs = new Map();
    for (const it of filtered) {
      if (typ(it) === 'update') {
        const k = `${dev(it)}|${cid(it) || '__noid__'}|${url(it)}|update`;
        const tm = tMs(it);
        const newer = lastKeptUpdateMs.get(k);
        if (newer != null && newer - tm < UPDATE_BURST_MS && newer >= tm) {
          continue;
        }
        lastKeptUpdateMs.set(k, tm);
      }
      out.push(it);
    }
    return out;
  }

  getHistoryItemsForRender() {
    let items = this.lastHistoryItems || [];
    const f = this._historyTabFocus;
    if (f && f.deviceId) {
      items = items.filter((it) => {
        const did = it.device_id || it.deviceId;
        if (did !== f.deviceId) {
          return false;
        }
        const c = it.tab_correlation_id || it.tabCorrelationId;
        if (f.tabIdHash) {
          return c === f.tabIdHash;
        }
        return (
          (it.url || '') === (f.url || '') &&
          (it.window_id ?? it.windowId ?? 0) === (f.windowId ?? 0)
        );
      });
    }
    if (this.elements.historyDedupeDisplay?.checked !== false) {
      items = this._dedupeRawHistoryItemsForDisplay(items);
    }
    return items;
  }

  updateHistoryTabFocusBar() {
    const bar = this.elements.historyTabFocusBar;
    const text = this.elements.historyTabFocusText;
    if (!bar) {
      return;
    }
    if (!this._historyTabFocus) {
      bar.style.display = 'none';
      if (text) {
        text.textContent = '';
      }
      return;
    }
    const t = this._historyTabFocus.title || this._historyTabFocus.url || 'this tab';
    if (text) {
      text.textContent = `Filtered to this tab: ${t}. The device filter is set to this tab’s device and the list is reloaded. Shows this tab’s navigation chain (same tab id). Use “Show all events” to clear the filter.`;
    }
    bar.style.display = 'flex';
  }

  async focusHistoryOnSyncedTab(focus) {
    this._historyTabFocus = { ...focus };
    if (this.elements.rawDeviceFilter && focus.deviceId) {
      this.elements.rawDeviceFilter.value = focus.deviceId;
    }
    if (this.elements.historySearch) {
      this.elements.historySearch.value = '';
    }
    this.updateHistoryTabFocusBar();
    this.historyDisplayLimit = 25;
    try {
      await this.updateHistoryEvents({ fromTabFocus: true });
    } catch (e) {
      logger.warn('focusHistoryOnSyncedTab: updateHistoryEvents failed', e);
    }
    if (this.activeTab === 'history') {
      this.elements.historyTabFocusBar?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    this.highlightFocusedSyncedTab();
  }

  clearHistoryTabFocus() {
    this._historyTabFocus = null;
    this.updateHistoryTabFocusBar();
    this.renderHistoryEvents(this._lastHistoryRenderMeta);
    this.highlightFocusedSyncedTab();
  }

  highlightFocusedSyncedTab() {
    const f = this._historyTabFocus;
    this.elements.currentTabsList?.querySelectorAll('.history-item').forEach((el) => {
      const did = el.dataset.deviceId || '';
      const hash = el.dataset.tabHash || '';
      const w = Number(el.dataset.windowId || 0);
      const u = el.dataset.url || '';
      const match = f &&
        did === f.deviceId &&
        (f.tabIdHash
          ? hash === f.tabIdHash
          : u === (f.url || '') && w === (f.windowId ?? 0));
      el.classList.toggle('is-focus-target', !!match);
    });
  }

  async openTab(url) {
    if (!url) return;
    try {
      await ext.tabs.create({ url, active: true });
    } catch (error) {
      logger.warn('Failed to open tab:', error);
      this.showNotification('Failed to open tab');
    }
  }

  async openWindowTabs(urls) {
    const clean = (urls || []).filter(Boolean);
    if (clean.length === 0) return;
    if (clean.length === 1) {
      await this.openTab(clean[0]);
      return;
    }
    try {
      if (ext.windows && ext.windows.create) {
        await ext.windows.create({ url: clean, focused: true });
        return;
      }
    } catch (error) {
      logger.warn('windows.create failed:', error);
    }
    for (let i = 0; i < clean.length; i++) {
      await ext.tabs.create({ url: clean[i], active: i === 0 });
    }
  }

  createHistoryTabItem(tab, opts = {}) {
    const showFavicons = opts.showFavicons !== false;
    const deviceId = opts.deviceId || '';
    const normalized = this.normalizeTab(tab);
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.deviceId = deviceId;
    item.dataset.tabHash = normalized.tabIdHash || '';
    item.dataset.windowId = String(normalized.windowId ?? 0);
    if (normalized.url) {
      item.dataset.url = normalized.url;
    }

    const main = document.createElement('div');
    main.className = 'history-item-main';
    main.title = 'Show this tab’s history below';
    if (showFavicons) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.alt = '';
      if (typeof bindTabFaviconImg === 'function') {
        bindTabFaviconImg(img, normalized.faviconUrl, normalized.url);
      } else {
        img.src = normalized.faviconUrl || '';
      }
      main.appendChild(img);
    }
    const textWrap = document.createElement('div');
    textWrap.className = 'history-item-text';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = normalized.title || 'Untitled';
    const url = document.createElement('div');
    url.className = 'history-url';
    url.textContent = normalized.url || '';
    textWrap.appendChild(title);
    textWrap.appendChild(url);
    main.appendChild(textWrap);
    main.addEventListener('click', () => {
      void this.focusHistoryOnSyncedTab({
        deviceId,
        tabIdHash: normalized.tabIdHash,
        url: normalized.url,
        windowId: normalized.windowId,
        title: normalized.title
      });
    });

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'history-tab-open-btn';
    openBtn.textContent = 'Open';
    openBtn.title = 'Open in a new tab';
    openBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openTab(normalized.url);
    });

    item.appendChild(main);
    item.appendChild(openBtn);
    return item;
  }

  normalizeTab(tab) {
    return {
      url: tab.url,
      title: tab.title,
      windowId: tab.windowId || tab.window_id || 0,
      tabIdHash: tab.tabIdHash || tab.tab_id_hash || '',
      faviconUrl: tab.faviconUrl || tab.favicon_url
    };
  }

  groupTabsByWindow(tabs) {
    return (tabs || []).reduce((acc, tab) => {
      const normalized = this.normalizeTab(tab);
      const key = String(normalized.windowId || 0);
      if (!acc[key]) acc[key] = [];
      acc[key].push(normalized);
      return acc;
    }, {});
  }

  getMaxVersion(devices, fallback) {
    return (devices || []).reduce((current, device) => {
      const version = typeof device.version === 'number' ? device.version : 0;
      return Math.max(current, version);
    }, fallback || 0);
  }

  async mergeRemoteTabs(incomingDevices, sinceVersion) {
    if (!sinceVersion || sinceVersion <= 0) {
      await this.storage.setRemoteTabs(incomingDevices);
      return;
    }

    const existing = await this.storage.getRemoteTabs();
    const byId = new Map((existing || []).map((device) => [device.device_id, device]));
    (incomingDevices || []).forEach((device) => {
      byId.set(device.device_id, device);
    });
    await this.storage.setRemoteTabs(Array.from(byId.values()));
  }

  createHistoryEventRow(item) {
    const row = document.createElement('div');
    const et = item.event_type || item.eventType || '';
    row.className = `history-event ${et}`;

    const header = document.createElement('div');
    header.className = 'history-event-header';
    const type = document.createElement('span');
    type.className = 'history-event-type';
    if (et) {
      type.classList.add(et);
    }
    if (et === 'history') {
      type.textContent = 'HISTORY (BROWSER)';
    } else {
      type.textContent = (et || 'event').toUpperCase();
    }
    const time = document.createElement('span');
    time.className = 'history-event-time';
    time.textContent = item.occurred_at ? new Date(item.occurred_at).toLocaleString() : '';
    header.appendChild(type);
    header.appendChild(time);

    const body = document.createElement('div');
    body.className = 'history-event-body';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = item.title || 'Untitled';
    const url = document.createElement('div');
    url.className = 'history-url';
    url.textContent = item.url || '';
    body.appendChild(title);
    body.appendChild(url);
    const trig = item.update_triggers || item.updateTriggers;
    if (trig) {
      const why = document.createElement('div');
      why.className = 'history-event-triggers';
      if (String(trig).includes('browser_history') || et === 'history') {
        why.textContent = `Source: browser history backfill (${trig})`;
      } else {
        why.textContent = `from onUpdated: ${trig}`;
      }
      body.appendChild(why);
    }

    row.appendChild(header);
    row.appendChild(body);
    row.addEventListener('click', () => this.openTab(item.url));
    return row;
  }

  renderHistoryEvents(partialMeta = {}) {
    if (!this.elements.historyList) return;

    const meta = { ...(this._lastHistoryRenderMeta || {}), ...partialMeta };

    try {
      this.elements.historyList
        .querySelectorAll('.history-event, .history-tab-group, .history-tree-root')
        .forEach((node) => node.remove());
      const rawItems = this.lastHistoryItems || [];
      const beforeFilter = meta.beforeFilterCount;
      const serverEmpty = meta.serverEmpty;
      const noEventsForDevice = meta.noEventsForDevice;

      if (!rawItems.length) {
        this.elements.historyLoading.style.display = 'none';
        this.elements.historyEmpty.style.display = 'block';
        if (typeof beforeFilter === 'number' && beforeFilter > 0) {
          this.elements.historyEmpty.textContent = 'No events match the current filters.';
        } else if (noEventsForDevice) {
          this.elements.historyEmpty.textContent =
            'No events for this device on the server. Try "All devices", or open and switch tabs to generate events, then sync.';
        } else if (serverEmpty) {
          this.elements.historyEmpty.textContent =
            'No tab events on the server yet. History is created from individual tab open, close, and update events, not from full snapshots. Use the browser as usual, let sync run, then Refresh. The extension only keeps a local copy in browser extension storage after a successful load; use Clear history to remove it.';
        } else {
          this.elements.historyEmpty.textContent = 'No history events to display.';
        }
        if (this.elements.historySeeMore) {
          this.elements.historySeeMore.style.display = 'none';
        }
        this.updateHistoryTabFocusBar();
        return;
      }

      const items = this.getHistoryItemsForRender();
      if (!items.length) {
        this.elements.historyLoading.style.display = 'none';
        this.elements.historyEmpty.style.display = 'block';
        this.elements.historyEmpty.textContent = this._historyTabFocus
          ? 'No events in the current list for this tab. Clear the filter, pick a different device, or Refresh after more sync activity.'
          : 'No history events to display.';
        if (this.elements.historySeeMore) {
          this.elements.historySeeMore.style.display = 'none';
        }
        this.updateHistoryTabFocusBar();
        return;
      }

      if (this.elements.historyViewMode && this.elements.historyViewMode.value === 'tree') {
        this.renderHistoryAsTree();
        return;
      }
      if (this.elements.historyViewMode && this.elements.historyViewMode.value === 'byTab') {
        this.renderHistoryByTab();
        return;
      }

      const visibleItems = items.slice(0, this.historyDisplayLimit);
      visibleItems.forEach((item) => {
        const eventRow = this.createHistoryEventRow(item);
        this.elements.historyList.appendChild(eventRow);
      });

      this.elements.historyLoading.style.display = 'none';
      this.elements.historyEmpty.style.display = 'none';

      if (this.elements.historySeeMore) {
        this.elements.historySeeMore.style.display = items.length > this.historyDisplayLimit ? 'inline-flex' : 'none';
      }
      this.updateHistoryTabFocusBar();
    } finally {
      this._lastHistoryRenderFingerprint = this.computeHistoryRenderFingerprint();
    }
  }

  renderHistoryByTab() {
    const items = this.getHistoryItemsForRender();
    if (!items.length) {
      this.elements.historyLoading.style.display = 'none';
      this.elements.historyEmpty.style.display = 'block';
      this.elements.historyEmpty.textContent = this._historyTabFocus
        ? 'No events in the current list for this tab. Clear the filter or Refresh.'
        : 'No history events to display.';
      if (this.elements.historySeeMore) {
        this.elements.historySeeMore.style.display = 'none';
      }
      this.updateHistoryTabFocusBar();
      return;
    }

    const groups = new Map();
    items.forEach((item, idx) => {
      const cid = item.tab_correlation_id || item.tabCorrelationId;
      const k = cid || `__noid__${item.id || idx}`;
      if (!groups.has(k)) {
        groups.set(k, []);
      }
      groups.get(k).push(item);
    });
    for (const evs of groups.values()) {
      evs.sort((a, b) => new Date(a.occurred_at || a.occurredAt) - new Date(b.occurred_at || b.occurredAt));
    }
    const ordered = Array.from(groups.entries()).sort((a, b) => {
      const maxA = Math.max(
        ...a[1].map((x) => new Date(x.occurred_at || x.occurredAt || 0).getTime())
      );
      const maxB = Math.max(
        ...b[1].map((x) => new Date(x.occurred_at || x.occurredAt || 0).getTime())
      );
      return maxB - maxA;
    });
    const limited = ordered.slice(0, this.historyDisplayLimit);
    limited.forEach(([key, evs]) => {
      this.elements.historyList.appendChild(this.createHistoryTabGroup(key, evs));
    });
    this.elements.historyLoading.style.display = 'none';
    this.elements.historyEmpty.style.display = 'none';
    if (this.elements.historySeeMore) {
      this.elements.historySeeMore.style.display =
        ordered.length > this.historyDisplayLimit ? 'inline-flex' : 'none';
    }
    this.updateHistoryTabFocusBar();
  }

  /**
   * Shared ordered list: one row per event (oldest → newest) with Open-on-click
   * for the row (URL).
   */
  buildHistoryTimelineOl(events) {
    const list = document.createElement('ol');
    list.className = 'history-timeline-tree';
    events.forEach((ev, i) => {
      const li = document.createElement('li');
      li.className = 'history-timeline-step';
      const idx = document.createElement('span');
      idx.className = 'history-timeline-idx';
      idx.setAttribute('aria-hidden', 'true');
      idx.textContent = String(i + 1);
      const main = document.createElement('div');
      main.className = 'history-timeline-step-main';
      const t = document.createElement('span');
      t.className = 'history-timeline-time';
      t.textContent = ev.occurred_at ? new Date(ev.occurred_at).toLocaleString() : '';
      const headRow = document.createElement('div');
      headRow.className = 'history-timeline-step-head';
      const meta = document.createElement('span');
      meta.className = 'history-timeline-meta';
      const ty = (ev.event_type || ev.eventType || 'event').toUpperCase();
      meta.textContent = ty;
      headRow.appendChild(t);
      headRow.appendChild(meta);
      const ptitle = document.createElement('div');
      ptitle.className = 'history-timeline-title';
      ptitle.textContent = ev.title || 'Untitled';
      const u = document.createElement('div');
      u.className = 'history-url';
      u.textContent = ev.url || '';
      const tr = ev.update_triggers || ev.updateTriggers;
      let w = null;
      if (tr) {
        w = document.createElement('div');
        w.className = 'history-event-triggers';
        w.textContent = `from onUpdated: ${tr}`;
      }
      main.appendChild(headRow);
      main.appendChild(ptitle);
      main.appendChild(u);
      if (w) {
        main.appendChild(w);
      }
      li.appendChild(idx);
      li.appendChild(main);
      li.addEventListener('click', (e) => {
        e.preventDefault();
        this.openTab(ev.url);
      });
      list.appendChild(li);
    });
    return list;
  }

  buildHistoryTimelineList(events) {
    const frag = document.createDocumentFragment();
    const pathLabel = document.createElement('p');
    pathLabel.className = 'history-path-label';
    pathLabel.textContent = 'Navigation path (oldest at top, newest at bottom)';
    frag.appendChild(pathLabel);
    frag.appendChild(this.buildHistoryTimelineOl(events));
    return frag;
  }

  createHistoryTabGroup(key, events) {
    const wrap = document.createElement('details');
    wrap.className = 'history-tab-group';
    wrap.open = true;

    const summary = document.createElement('summary');
    summary.className = 'history-tab-group-summary';
    const last = events[events.length - 1];
    const idLabel = String(key).startsWith('__noid__')
      ? 'No tab id in events'
      : `id ${String(key).slice(0, 18)}${String(key).length > 18 ? '…' : ''}`;
    const title = document.createElement('div');
    title.className = 'history-tab-group-title';
    title.textContent = last ? last.title || 'Untitled' : 'Tab';
    const sub = document.createElement('div');
    sub.className = 'history-tab-group-meta';
    sub.textContent = `${events.length} step(s) · ${idLabel} · last row is current page · summary toggles path`;

    summary.appendChild(title);
    summary.appendChild(sub);

    const body = document.createElement('div');
    body.className = 'history-tab-group-body';
    body.appendChild(this.buildHistoryTimelineList(events));

    wrap.appendChild(summary);
    wrap.appendChild(body);
    return wrap;
  }

  renderHistoryAsTree() {
    const items = this.getHistoryItemsForRender();
    if (!items.length) {
      this.elements.historyLoading.style.display = 'none';
      this.elements.historyEmpty.style.display = 'block';
      this.elements.historyEmpty.textContent = this._historyTabFocus
        ? 'No events in the current list for this tab. Clear the filter or Refresh.'
        : 'No history events to display.';
      if (this.elements.historySeeMore) {
        this.elements.historySeeMore.style.display = 'none';
      }
      this.updateHistoryTabFocusBar();
      return;
    }

    const byDevice = new Map();
    items.forEach((it, idx) => {
      const d = it.device_id || it.deviceId || 'unknown';
      if (!byDevice.has(d)) {
        byDevice.set(d, new Map());
      }
      const idMap = byDevice.get(d);
      const cid = it.tab_correlation_id || it.tabCorrelationId;
      const k = cid || `__noid__${it.id || idx}`;
      if (!idMap.has(k)) {
        idMap.set(k, []);
      }
      idMap.get(k).push(it);
    });

    for (const idMap of byDevice.values()) {
      for (const evs of idMap.values()) {
        evs.sort(
          (a, b) =>
            new Date(a.occurred_at || a.occurredAt) - new Date(b.occurred_at || b.occurredAt)
        );
      }
    }

    const flat = [];
    for (const [devId, idMap] of byDevice) {
      for (const [key, evs] of idMap) {
        const maxT = Math.max(
          ...evs.map((x) => new Date(x.occurred_at || x.occurredAt || 0).getTime())
        );
        flat.push({ devId, key, evs, maxT });
      }
    }
    flat.sort((a, b) => b.maxT - a.maxT);
    const totalGroups = flat.length;
    const limited = flat.slice(0, this.historyDisplayLimit);

    const byDevOut = new Map();
    for (const row of limited) {
      if (!byDevOut.has(row.devId)) {
        byDevOut.set(row.devId, []);
      }
      byDevOut.get(row.devId).push([row.key, row.evs]);
    }

    const root = document.createElement('div');
    root.className = 'history-tree-root';

    for (const devId of Array.from(byDevOut.keys()).sort()) {
      const tabPairs = byDevOut.get(devId);
      const devDet = document.createElement('details');
      devDet.className = 'history-tree-nest history-tree-device';
      devDet.open = true;
      const dSum = document.createElement('summary');
      dSum.className = 'history-tree-nest-summary';
      dSum.textContent = this.deviceLabelForHistory(devId);
      const dBody = document.createElement('div');
      dBody.className = 'history-tree-nest-body';
      for (const [, evs] of tabPairs) {
        const last = evs[evs.length - 1];
        const tabDet = document.createElement('details');
        tabDet.className = 'history-tree-nest history-tree-tab';
        tabDet.open = true;
        const tSum = document.createElement('summary');
        tSum.className = 'history-tree-nest-summary';
        tSum.textContent = `${last ? last.title || 'Untitled' : 'Tab'} · ${evs.length} step(s)`;
        const tBody = document.createElement('div');
        tBody.className = 'history-tree-nest-body';
        tBody.appendChild(this.buildHistoryTimelineList(evs));
        tabDet.appendChild(tSum);
        tabDet.appendChild(tBody);
        dBody.appendChild(tabDet);
      }
      devDet.appendChild(dSum);
      devDet.appendChild(dBody);
      root.appendChild(devDet);
    }

    this.elements.historyList.appendChild(root);
    this.elements.historyLoading.style.display = 'none';
    this.elements.historyEmpty.style.display = 'none';
    if (this.elements.historySeeMore) {
      this.elements.historySeeMore.style.display =
        totalGroups > this.historyDisplayLimit ? 'inline-flex' : 'none';
    }
    this.updateHistoryTabFocusBar();
  }

  async exportHistory() {
    if (!this.lastHistoryItems.length) {
      this.showNotification('No history to export');
      return;
    }
    const blob = new Blob([JSON.stringify(this.lastHistoryItems, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    await ext.downloads.download({
      url,
      filename: 'keepsync-history.json',
      saveAs: true
    });
    URL.revokeObjectURL(url);
  }

  async performManualSync() {
    this.showLoading('Syncing tabs...');

    try {
      const response = await ext.runtime.sendMessage({ type: 'MANUAL_SYNC' });
      if (response.success) {
        this.hideLoading();
        this.showNotification('Sync complete');
        await this.updateHistoryView();
        await this.updateSyncStatusPanel({ forceServerHealth: true });
        return;
      }
    } catch (error) {
      if (!isBackgroundUnavailableError(error)) {
        logger.warn('Background sync failed, falling back to direct sync:', error);
      }
    }

    try {
      const result = await this.performDirectSync();
      this.hideLoading();
      this.showNotification(`Sync complete: ${result.snapshotCount} tabs`);
      await this.updateHistoryView();
      await this.updateSyncStatusPanel({ forceServerHealth: true });
    } catch (error) {
      this.hideLoading();
      this.showStatus('error', `Sync failed: ${error.message}`);
    }
  }

  async performDirectSync() {
    const config = await this.storage.getConfig();
    if (!config.serverUrl || !config.deviceToken) {
      throw new Error('Not configured');
    }

    this.apiClient.setServerUrl(config.serverUrl);
    this.apiClient.setDeviceToken(config.deviceToken);

    const syncState = await this.storage.getSyncState();
    let lastServerVersion = syncState?.lastServerVersion || 0;

    const tabs = await this.captureLocalSnapshot();
    await this.storage.setTabSnapshot(tabs);

    let snapshotResponse = null;
    if (tabs.length > 0) {
      snapshotResponse = await this.apiClient.uploadSnapshot({
        version: Date.now(),
        tabs
      });
      const snapshotVersion = snapshotResponse?.server_version || snapshotResponse?.serverVersion;
      if (typeof snapshotVersion === 'number' && snapshotVersion > lastServerVersion) {
        lastServerVersion = snapshotVersion;
      }
    }

    const existingRemote = (await this.storage.getRemoteTabs()) || [];
    const hasRemoteCache =
      existingRemote.length > 0 &&
      existingRemote.some((d) => Array.isArray(d.tabs) && d.tabs.length > 0);
    const sincePull = hasRemoteCache && lastServerVersion > 0 ? lastServerVersion : 0;
    const remoteTabsResponse = await this.apiClient.getCurrentTabs(sincePull);
    if (remoteTabsResponse?.devices) {
      await this.mergeRemoteTabs(remoteTabsResponse.devices, sincePull);
      const maxVersion = this.getMaxVersion(remoteTabsResponse.devices, lastServerVersion);
      if (maxVersion > lastServerVersion) {
        lastServerVersion = maxVersion;
      }
    }

    await this.storage.setSyncState({
      lastSyncTime: new Date().toISOString(),
      lastSyncResult: {
        snapshotSynced: true,
        snapshotCount: tabs.length,
        quotaStatus: snapshotResponse?.quotaStatus || null
      },
      lastServerVersion
    });

    return { snapshotCount: tabs.length };
  }

  async captureLocalSnapshot() {
    const windows = await ext.windows.getAll({ populate: true });
    const tabs = [];
    for (const window of windows) {
      for (const tab of window.tabs) {
        if (!this.isRestrictedUrl(tab.url)) {
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
    return tabs;
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

  showActivationSection(token = '') {
    this.elements.activationSection.style.display = 'block';
    this.elements.connectedSection.style.display = 'none';
    this.elements.activationToken.value = token;
  }

  async showConnectedSection(deviceId, serverUrl) {
    this.elements.activationSection.style.display = 'none';
    this.elements.connectedSection.style.display = 'block';
    this.elements.deviceId.textContent = deviceId || '-';
    this.elements.connectedServer.textContent = serverUrl || '-';
    await this.syncServerHealthForOptions();
    await this.refreshPairedStatusFromStorage();
  }

  async refreshPairedStatusFromStorage() {
    const st = await this.storage.getSyncState();
    if (st?.serverReachable === false) {
      this.showStatus(
        'warning',
        'Paired — server not reachable. Start the server or check the URL; sync and remote tabs stay offline until it responds.'
      );
    } else if (st?.serverReachable === true) {
      this.showStatus('ok', 'Device connected · server reachable');
    } else {
      this.showStatus('pending', 'Device connected · server status not checked yet');
    }
  }

  showSetupSection() {
    this.elements.activationSection.style.display = 'none';
    this.elements.connectedSection.style.display = 'none';
    this.showStatus('error', 'Not connected');
  }

  showStatus(state, message) {
    const parent = this.elements.connectionStatus;
    if (!parent || !this.elements.statusText) {
      return;
    }
    parent.style.display = 'flex';
    parent.classList.remove('ok', 'err', 'pending', 'warn');
    this.elements.statusIndicator.className = 'status-indicator';
    if (state === 'ok' || state === 'connected') {
      parent.classList.add('ok');
    } else if (state === 'error') {
      parent.classList.add('err');
    } else if (state === 'warning') {
      parent.classList.add('warn');
    } else if (state === 'pending') {
      parent.classList.add('pending');
    } else {
      parent.classList.add('err');
    }
    this.elements.statusText.textContent = message;
  }

  showNotification(message, durationMs = 4500) {
    if (!this.elements.notification) return;
    this.elements.notificationMessage.textContent = message;
    this.elements.notification.style.display = 'block';
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    this.notificationTimeout = setTimeout(() => {
      this.notificationTimeout = null;
      if (this.elements.notification) {
        this.elements.notification.style.display = 'none';
      }
    }, durationMs);
  }

  showLoading(text = 'Loading...') {
    if (this.elements.loadingText) {
      this.elements.loadingText.textContent = text;
    }
    if (this.elements.loadingOverlay) {
      this.elements.loadingOverlay.style.display = 'flex';
    }
  }

  hideLoading() {
    if (this.elements.loadingOverlay) {
      this.elements.loadingOverlay.style.display = 'none';
    }
  }

  validateServerUrl(url) {
    if (!url) {
      this.showStatus('error', 'Server URL is required');
      return false;
    }
    if (!isValidServerUrl(url)) {
      this.showStatus('error', 'Invalid server URL');
      return false;
    }
    return true;
  }

  async saveBookmarkSettings() {
    const current = await this.storage.getConfig();
    const next = {
      ...current,
      bookmarkSyncEnabled: this.elements.bookmarkSyncEnabled?.checked !== false,
      bookmarkSyncDirection: this.elements.bookmarkSyncDirection?.value || 'bidirectional',
      bookmarkConflictAction: this.elements.bookmarkConflictAction?.value || 'prompt',
      bookmarkAutoResolution: this.elements.bookmarkAutoResolution?.value || 'server_wins',
      bookmarkDeletePolicy: this.elements.bookmarkDeletePolicy?.value || 'match_server'
    };
    await this.saveConfiguration(next);
    await this.updateBookmarkBrowserSection();
  }

  setupSidebar() {
    const main = document.getElementById('optionsMain');
    const btn = document.getElementById('sidebarCollapse');
    if (!main || !btn) {
      return;
    }
    const key = 'keepsyncOptionsSidebarCollapsed';
    const apply = (collapsed) => {
      main.classList.toggle('sidebar-collapsed', collapsed);
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.title = collapsed ? 'Expand sidebar' : 'Minimise sidebar';
      btn.textContent = collapsed ? '⟩' : '⟨';
      try {
        localStorage.setItem(key, collapsed ? '1' : '0');
      } catch (e) {
        /* ignore */
      }
    };
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(key) === '1';
    } catch (e) {
      /* ignore */
    }
    apply(collapsed);
    btn.addEventListener('click', () => apply(!main.classList.contains('sidebar-collapsed')));
    const mq = window.matchMedia('(max-width: 780px)');
    const syncMq = () => {
      if (mq.matches) {
        main.classList.remove('sidebar-collapsed');
        btn.style.display = 'none';
      } else {
        btn.style.display = '';
      }
    };
    mq.addEventListener?.('change', syncMq);
    syncMq();
  }

  hasBookmarksApi() {
    return !!(ext.bookmarks && typeof ext.bookmarks.getTree === 'function');
  }

  async updateBookmarkBrowserSection() {
    const sec = document.getElementById('bookmarkBrowserSection');
    const unavail = document.getElementById('bookmarkBrowserUnavailable');
    if (!sec) {
      return;
    }
    const syncOn = this.elements.bookmarkSyncEnabled?.checked !== false;
    if (!this.hasBookmarksApi()) {
      sec.style.display = syncOn ? 'block' : 'none';
      if (unavail) {
        unavail.style.display = syncOn ? 'block' : 'none';
        unavail.textContent =
          'Bookmarks are not available in this browser build (bookmark permission or API missing).';
      }
      const root = document.getElementById('bookmarkTreeRoot');
      if (root) {
        root.textContent = '';
      }
      return;
    }
    if (unavail) {
      unavail.style.display = 'none';
    }
    if (!syncOn) {
      sec.style.display = 'none';
      return;
    }
    sec.style.display = 'block';
    if (this.activeTab === 'bookmarks') {
      await this.refreshLocalBookmarkTree();
    }
  }

  async refreshLocalBookmarkTree() {
    const root = document.getElementById('bookmarkTreeRoot');
    if (!root || !this.hasBookmarksApi()) {
      return;
    }
    if (this.elements.bookmarkSyncEnabled?.checked === false) {
      root.textContent = '';
      return;
    }
    root.textContent = '';
    const loadingEl = document.createElement('div'); loadingEl.className = 'bookmark-tree-loading';
    const spinnerSpan = document.createElement('span'); spinnerSpan.className = 'spinner';
    const loadingText = document.createElement('span'); loadingText.className = 'loading-text'; loadingText.textContent = 'Loading bookmarks…';
    loadingEl.appendChild(spinnerSpan); loadingEl.appendChild(loadingText);
    root.appendChild(loadingEl);
    try {
      const tree = await ext.bookmarks.getTree();
      root.textContent = '';
      const mount = document.createElement('div');
      mount.className = 'bookmark-tree__mount';
      const kids = tree && tree[0] && tree[0].children ? tree[0].children : [];
      const ul = this._buildBookmarkTreeUl(kids, 0);
      if (ul) {
        mount.appendChild(ul);
      } else {
        const emptyP = document.createElement('p'); emptyP.className = 'bookmark-tree-empty'; emptyP.textContent = 'No bookmarks yet. Use the toolbar to add folders and pages.'; mount.appendChild(emptyP);
      }
      root.appendChild(mount);
    } catch (e) {
      const errP = document.createElement('p'); errP.className = 'help-text'; errP.setAttribute('role', 'alert');
      errP.textContent = `Could not read bookmarks: ${(e && e.message) || String(e)}`;
      root.appendChild(errP);
    }
  }

  _buildBookmarkTreeUl(nodes, depth) {
    if (!nodes || !nodes.length) {
      return null;
    }
    const ul = document.createElement('ul');
    ul.className = 'bookmark-tree__list';
    for (const n of nodes) {
      const li = document.createElement('li');
      li.className = 'bookmark-tree__item';
      if (n.children != null) {
        li.appendChild(this._buildBookmarkFolderNode(n, depth));
      } else {
        li.appendChild(this._buildBookmarkLeafNode(n));
      }
      ul.appendChild(li);
    }
    return ul;
  }

  _buildBookmarkFolderNode(n, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'bookmark-tree__folder-wrap';
    wrap.setAttribute('data-bm-id', n.id);
    const details = document.createElement('details');
    details.className = 'bookmark-tree__details';
    if (depth < 2) {
      details.open = true;
    }
    const summary = document.createElement('summary');
    summary.className = 'bookmark-tree__summary';
    const title = document.createElement('span');
    title.className = 'bookmark-tree__title';
    title.textContent = n.title || '(folder)';
    summary.appendChild(title);
    const actions = document.createElement('span');
    actions.className = 'bookmark-tree__actions';
    actions.appendChild(
      this._bookmarkActionBtn('Add bookmark', () =>
        this._bookmarkCreateIn(n.id, { url: 'https://' })
      )
    );
    actions.appendChild(
      this._bookmarkActionBtn('Add folder', () => this._bookmarkCreateIn(n.id, { folder: true }))
    );
    actions.appendChild(
      this._bookmarkActionBtn('Rename', () =>
        this._bookmarkStartEdit(n.id, { folder: true, title: n.title })
      )
    );
    if (!this._isProtectedBookmarkId(n.id)) {
      actions.appendChild(
        this._bookmarkActionBtn('Delete', () => this._bookmarkDelete(n.id, true))
      );
    }
    summary.appendChild(actions);
    details.appendChild(summary);
    if (n.children && n.children.length) {
      const inner = this._buildBookmarkTreeUl(n.children, depth + 1);
      if (inner) {
        details.appendChild(inner);
      }
    }
    wrap.appendChild(details);
    return wrap;
  }

  _isProtectedBookmarkId(id) {
    const s = String(id);
    return s === '0' || s === '1' || s === '2' || s === '3';
  }

  _buildBookmarkLeafNode(n) {
    const row = document.createElement('div');
    row.className = 'bookmark-tree__row';
    row.setAttribute('data-bm-id', n.id);
    const isSep = n.url == null || n.url === '';
    const titleEl = document.createElement('span');
    titleEl.className = 'bookmark-tree__title';
    titleEl.textContent = isSep ? '— separator —' : n.title || '(no title)';
    row.appendChild(titleEl);
    if (!isSep && n.url) {
      const urlEl = document.createElement('a');
      urlEl.className = 'bookmark-tree__url';
      urlEl.href = n.url;
      urlEl.target = '_blank';
      urlEl.rel = 'noopener noreferrer';
      urlEl.textContent = n.url;
      row.appendChild(urlEl);
    }
    if (!isSep) {
      const actions = document.createElement('span');
      actions.className = 'bookmark-tree__actions';
      actions.appendChild(
        this._bookmarkActionBtn('Edit', () =>
          this._bookmarkStartEdit(n.id, { folder: false, title: n.title, url: n.url || '' })
        )
      );
      actions.appendChild(this._bookmarkActionBtn('Delete', () => this._bookmarkDelete(n.id, false)));
      row.appendChild(actions);
    }
    return row;
  }

  _bookmarkActionBtn(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bookmark-tree__btn';
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  async _bookmarkCreateIn(parentId, opts) {
    try {
      if (opts.folder) {
        await ext.bookmarks.create({ parentId: String(parentId), title: 'New folder' });
      } else {
        await ext.bookmarks.create({
          parentId: String(parentId),
          title: 'New bookmark',
          url: opts.url || 'https://'
        });
      }
      await this.refreshLocalBookmarkTree();
    } catch (e) {
      this.showNotification((e && e.message) || String(e));
    }
  }

  async _bookmarkDelete(id, isTree) {
    const ok = confirm(
      isTree ? 'Delete this folder and everything inside?' : 'Delete this bookmark?'
    );
    if (!ok) {
      return;
    }
    try {
      if (isTree) {
        await ext.bookmarks.removeTree(String(id));
      } else {
        await ext.bookmarks.remove(String(id));
      }
      await this.refreshLocalBookmarkTree();
    } catch (e) {
      this.showNotification((e && e.message) || String(e));
    }
  }

  _bookmarkStartEdit(id, data) {
    const root = document.getElementById('bookmarkTreeRoot');
    if (!root) {
      return;
    }
    const prev = root.querySelector('.bookmark-tree__editor');
    if (prev) {
      prev.remove();
    }
    const sid = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const tid = `bm-title-${sid}`;
    const uid = `bm-url-${sid}`;
    const editor = document.createElement('div');
    editor.className = 'bookmark-tree__editor';
    const titleRow = document.createElement('div');
    titleRow.className = 'form-group';
    const titleLabel = document.createElement('label'); titleLabel.setAttribute('for', tid); titleLabel.textContent = 'Title';
    titleRow.appendChild(titleLabel);
    const titleIn = document.createElement('input');
    titleIn.type = 'text';
    titleIn.id = tid;
    titleIn.className = 'bookmark-tree__input';
    titleIn.value = data.title || '';
    titleRow.appendChild(titleIn);
    editor.appendChild(titleRow);
    let urlIn = null;
    if (!data.folder) {
      const urlRow = document.createElement('div');
      urlRow.className = 'form-group';
      const urlLabel = document.createElement('label'); urlLabel.setAttribute('for', uid); urlLabel.textContent = 'URL';
      urlRow.appendChild(urlLabel);
      urlIn = document.createElement('input');
      urlIn.type = 'url';
      urlIn.id = uid;
      urlIn.className = 'bookmark-tree__input';
      urlIn.value = data.url || '';
      urlRow.appendChild(urlIn);
      editor.appendChild(urlRow);
    }
    const actions = document.createElement('p');
    actions.className = 'form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'primary-btn';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary-btn';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    editor.appendChild(actions);
    saveBtn.addEventListener('click', async () => {
      try {
        const payload = { title: titleIn.value };
        if (!data.folder && urlIn) {
          payload.url = urlIn.value;
        }
        await ext.bookmarks.update(String(id), payload);
        editor.remove();
        await this.refreshLocalBookmarkTree();
      } catch (e) {
        this.showNotification((e && e.message) || String(e));
      }
    });
    cancelBtn.addEventListener('click', () => editor.remove());

    const targetRow = root.querySelector(`[data-bm-id="${this._escapeHtml(String(id))}"]`);
    if (targetRow) {
      targetRow.insertAdjacentElement('afterend', editor);
      editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      root.appendChild(editor);
    }
  }

  async refreshBookmarkConflictUI() {
    const st = await this.storage.getBookmarkSyncState();
    const box = this.elements.bookmarkConflictBox;
    if (!box) {
      return;
    }
    if (st.pendingConflict) {
      box.style.display = 'block';
      const det = document.getElementById('bookmarkSyncSettingsDetails');
      if (det) {
        det.open = true;
      }
      const sv = st.pendingConflict.server_version;
      if (this.elements.bookmarkConflictText) {
        this.elements.bookmarkConflictText.textContent = `Server is at version ${sv}. Choose which copy to keep.`;
      }
    } else {
      box.style.display = 'none';
    }
  }

  async refreshBookmarkStatusLine() {
    const el = this.elements.bookmarkSyncStatus;
    if (!el) {
      return;
    }
    const st = await this.storage.getBookmarkSyncState();
    const parts = [];
    parts.push(`Server v${st.lastServerVersion != null ? st.lastServerVersion : 0}`);
    if (st.localDirty) {
      parts.push('local changes pending');
    }
    if (st.lastError) {
      parts.push(`last: ${st.lastError}`);
    }
    el.textContent = parts.join(' · ') || '—';
  }

  async performBookmarkSyncNow() {
    try {
      await ext.runtime.sendMessage({ type: 'BOOKMARK_SYNC_NOW' });
      this.showNotification('Bookmark sync requested');
      await this.refreshBookmarkStatusLine();
      await this.refreshBookmarkConflictUI();
      await this.refreshLocalBookmarkTree();
    } catch (e) {
      this.showNotification(`Bookmark sync failed: ${(e && e.message) || e}`);
    }
  }

  async resolveBookmarkFromUI(choice) {
    try {
      const r = await ext.runtime.sendMessage({ type: 'BOOKMARK_RESOLVE_CONFLICT', choice });
      if (r && r.success) {
        this.showNotification('Conflict resolved');
      } else {
        this.showNotification((r && r.error) || 'Could not resolve');
      }
      await this.refreshBookmarkConflictUI();
      await this.refreshBookmarkStatusLine();
      await this.refreshLocalBookmarkTree();
    } catch (e) {
      this.showNotification((e && e.message) || String(e));
    }
  }

  _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _escapeHtmlAttr(s) {
    return this._escapeHtml(s).replace(/"/g, '&quot;');
  }

  /** Visible text for session table link; href remains full URL. */
  _truncateHistorySessionUrlForDisplay(url, maxLen = 150) {
    const u = String(url || '');
    if (u.length <= maxLen) {
      return u;
    }
    return `${u.slice(0, maxLen)}…`;
  }

  _fmtHistTs(t) {
    if (!t) return '—';
    try {
      return new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
    } catch {
      return String(t);
    }
  }

  /** Shorter timestamps for dense session table cells */
  _fmtHistSessionCellTs(t) {
    if (!t) return '—';
    try {
      return new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return String(t);
    }
  }

  _sessionStatusLabel(row) {
    const closedAt = row.closed_at || row.closedAt;
    const isOpen = row.is_open === true || row.isOpen === true;
    if (closedAt) return 'Closed (event)';
    if (isOpen) return 'Open';
    return 'Not open';
  }

  async loadHistorySessionsFromServer(pageOnly, dir) {
    if (!this.apiClient.isConfigured()) {
      this.showNotification('Connect a device first');
      return;
    }
    if (!pageOnly) {
      this._histSessionsOffset = 0;
    } else if (dir === -1) {
      this._histSessionsOffset = Math.max(0, this._histSessionsOffset - this._histSessionsPageSize);
    } else if (dir === 1) {
      const maxOff = Math.max(0, this._histSessionsTotal - this._histSessionsPageSize);
      this._histSessionsOffset = Math.min(maxOff, this._histSessionsOffset + this._histSessionsPageSize);
    }

    const meta = this.elements.histSessionsMeta;
    if (meta) {
      meta.textContent = 'Loading…';
    }

    const cfg = await this.storage.getConfig();
    this.apiClient.setServerUrl(cfg.serverUrl);
    this.apiClient.setDeviceToken(cfg.deviceToken);

    const statusVal = this.elements.histSessionsStatus?.value || 'all';
    const opt = {
      deviceId: this.elements.histSessionsDeviceFilter?.value || undefined,
      status: statusVal === 'all' ? undefined : statusVal,
      title: this.elements.histSessionsTitle?.value?.trim() || undefined,
      url: this.elements.histSessionsUrl?.value?.trim() || undefined,
      openedFrom: this.elements.histSessionsOpenedFrom?.value?.trim() || undefined,
      openedTo: this.elements.histSessionsOpenedTo?.value?.trim() || undefined,
      closedFrom: this.elements.histSessionsClosedFrom?.value?.trim() || undefined,
      closedTo: this.elements.histSessionsClosedTo?.value?.trim() || undefined,
      sort: this.elements.histSessionsSort?.value || 'opened_desc',
      limit: this._histSessionsPageSize,
      offset: this._histSessionsOffset
    };

    try {
      const raw = await this.apiClient.getHistorySessions(opt);
      const pageSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
      const deduped = this._dedupeHistorySessionsPreferRealTab(pageSessions);
      this._histSessionsData = deduped;
      this._histSessionsTotal = typeof raw.total === 'number' ? raw.total : pageSessions.length;
      if (meta) {
        const hid = pageSessions.length - deduped.length;
        const hideNote =
          hid > 0
            ? ` ${hid} history-only row(s) hidden on this page (same URL/device/time as a tab session).`
            : '';
        meta.textContent = `Showing ${deduped.length} of ${this._histSessionsTotal} rows (offset ${this._histSessionsOffset}). Table filters narrow this page only.${hideNote}`;
      }
      this.renderHistorySessionsTable();
    } catch (e) {
      this._histSessionsData = [];
      if (meta) {
        meta.textContent = `Error: ${(e && e.message) || e}`;
      }
      this.renderHistorySessionsTable();
    }
  }

  _dedupeHistorySessionsPreferRealTab(sessions) {
    const list = Array.isArray(sessions) ? sessions.slice() : [];
    if (list.length < 2) {
      return list;
    }
    const OPEN_WINDOW_MS = 120_000;
    const isHistCorr = (row) =>
      String(row.tab_correlation_id || row.tabCorrelationID || '').startsWith('hist:');
    const openedMs = (row) => {
      const o = row.opened_at || row.openedAt;
      if (!o) {
        return NaN;
      }
      const t = new Date(o).getTime();
      return Number.isFinite(t) ? t : NaN;
    };
    const dev = (row) => String(row.device_id || row.deviceId || '');
    const urlKey = (row) => String(row.url || '').trim();

    const hide = new Set();
    for (let i = 0; i < list.length; i++) {
      if (!isHistCorr(list[i])) {
        continue;
      }
      const ri = list[i];
      const di = dev(ri);
      const ui = urlKey(ri);
      const ti = openedMs(ri);
      if (!ui || !Number.isFinite(ti)) {
        continue;
      }
      for (let j = 0; j < list.length; j++) {
        if (i === j) {
          continue;
        }
        const rj = list[j];
        if (isHistCorr(rj)) {
          continue;
        }
        if (dev(rj) !== di) {
          continue;
        }
        if (urlKey(rj) !== ui) {
          continue;
        }
        const tj = openedMs(rj);
        if (!Number.isFinite(tj)) {
          continue;
        }
        if (Math.abs(tj - ti) <= OPEN_WINDOW_MS) {
          hide.add(i);
          break;
        }
      }
    }
    return list.filter((_, i) => !hide.has(i));
  }

  _filterSessionsForTable(rows) {
    const t = (this.elements.histTableTitle?.value || '').trim().toLowerCase();
    const u = (this.elements.histTableUrl?.value || '').trim().toLowerCase();
    const d = (this.elements.histTableDevice?.value || '').trim().toLowerCase();
    const st = this.elements.histTableStatus?.value || '';
    return rows.filter((row) => {
      const title = (row.title || '').toLowerCase();
      const url = (row.url || '').toLowerCase();
      const dev = (row.device_id || row.deviceId || '').toLowerCase();
      if (t && !title.includes(t)) {
        return false;
      }
      if (u && !url.includes(u)) {
        return false;
      }
      if (d && !dev.includes(d)) {
        return false;
      }
      const closedAt = row.closed_at || row.closedAt;
      const isOpen = row.is_open === true || row.isOpen === true;
      if (st === 'open' && !isOpen) {
        return false;
      }
      if (st === 'had_close' && !closedAt) {
        return false;
      }
      if (st === 'no_close_not_open' && (closedAt || isOpen)) {
        return false;
      }
      return true;
    });
  }

  renderHistorySessionsTable() {
    const tb = this.elements.histSessionsTbody;
    if (!tb) {
      return;
    }
    const rows = this._filterSessionsForTable(this._histSessionsData);
    if (!rows.length) {
      const emptyTr = document.createElement('tr');
      const emptyTd = document.createElement('td'); emptyTd.colSpan = 9; emptyTd.className = 'empty-message';
      emptyTd.textContent = 'No rows (try Load from server or relax filters).';
      emptyTr.appendChild(emptyTd);
      tb.appendChild(emptyTr);
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const addCell = (tag, cls, txt, ttl) => {
        const c = document.createElement(tag); if (cls) c.className = cls; c.textContent = txt; if (ttl) c.title = ttl; tr.appendChild(c);
      };
      const did = row.device_id || row.deviceId || '';
      const devLabel = this.deviceLabelForHistory(did);
      const opened = row.opened_at || row.openedAt;
      const lastA = row.last_active_at || row.lastActiveAt;
      const closedAt = row.closed_at || row.closedAt;
      const isOpen = row.is_open === true || row.isOpen === true;
      const corr = row.tab_correlation_id || row.tabCorrelationID || '';
      const closedCell = closedAt ? this._fmtHistSessionCellTs(closedAt) : '—';
      const status = this._sessionStatusLabel(row);
      const ec = row.event_count != null ? row.event_count : row.eventCount;
      const closedDisplay = !closedAt && isOpen ? '—' : closedCell;
      const shortCorr = corr.length > 14 ? `${corr.slice(0, 14)}…` : corr;
      const rawUrl = row.url || '';
      const href = rawUrl ? rawUrl : '#';
      const urlDisplay = this._truncateHistorySessionUrlForDisplay(rawUrl);
      addCell('td', 'hist-session-title', row.title || '');
      const urlTd = document.createElement('td'); urlTd.className = 'hist-url';
      const urlA = document.createElement('a'); urlA.href = href; urlA.target = '_blank'; urlA.rel = 'noopener'; urlA.textContent = urlDisplay;
      if (rawUrl) urlA.title = rawUrl;
      urlTd.appendChild(urlA); tr.appendChild(urlTd);
      addCell('td', '', devLabel, did);
      addCell('td', 'mono hist-session-ts', this._fmtHistSessionCellTs(opened));
      addCell('td', 'mono hist-session-ts', this._fmtHistSessionCellTs(lastA));
      addCell('td', 'mono hist-session-ts', closedDisplay);
      addCell('td', '', status);
      addCell('td', '', ec != null ? ec : '—');
      addCell('td', 'mono', shortCorr, corr);
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
  }

  exportHistorySessions() {
    if (!this._histSessionsData.length) {
      this.showNotification('Load sessions first');
      return;
    }
    const blob = new Blob([JSON.stringify(this._histSessionsData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    void ext.downloads.download({ url, filename: 'keepsync-tab-sessions.json', saveAs: true });
    URL.revokeObjectURL(url);
  }

  _computeTabsRenderFingerprint(
    filteredDevices,
    selectedDevice,
    searchTerm,
    maxTabs,
    showFavicons,
    fromCache,
    tabsCacheReason,
    tabCountAfterDevice
  ) {
    const devSig = (filteredDevices || [])
      .map((d) => {
        const id = d.device_id || '';
        const tabs = (d.tabs || [])
          .map((t) => {
            const h = String(t.tab_id_hash || t.tabIdHash || '');
            const u = String(t.url || '');
            const title = String(t.title || '');
            return `${h}\t${u}\t${title}`;
          })
          .join('\n');
        return `${id}\n${tabs}`;
      })
      .join('\n---\n');
    return [
      devSig,
      selectedDevice || '',
      searchTerm || '',
      String(maxTabs),
      showFavicons ? '1' : '0',
      fromCache ? '1' : '0',
      tabsCacheReason || '',
      String(tabCountAfterDevice)
    ].join('\f');
  }

  async refreshDiagnostics() {
    const elV = this.elements.extensionVersion;
    const elB = this.elements.browserInfo;
    const elS = this.elements.storageUsed;
    if (!elV && !elB && !elS) {
      return;
    }
    try {
      const manifest = ext.runtime.getManifest();
      const version = manifest.version || '—';
      if (elV) {
        elV.textContent = version;
      }
      const b = typeof detectBrowser === 'function' ? detectBrowser() : this.storage.detectBrowser();
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const browserLine = `${b}${ua ? ` · ${ua.slice(0, 120)}` : ''}`;
      if (elB) {
        elB.textContent = browserLine;
      }
      let bytes = await this.storage.getStorageUsage();
      if (bytes == null) {
        const all = await ext.storage.local.get(null);
        bytes = new Blob([JSON.stringify(all)]).size;
      }
      if (elS) {
        elS.textContent = formatQuotaSizeLabel(bytes);
      }
      await this.storage.set('diagnosticsSnapshot', {
        version,
        browserLine,
        storageBytes: bytes,
        updatedAt: Date.now()
      });
    } catch (e) {
      logger.warn('refreshDiagnostics:', e);
      const snap = await this.storage.get('diagnosticsSnapshot', null);
      if (snap && elV) {
        elV.textContent = snap.version || '—';
      }
      if (snap && elB) {
        elB.textContent = snap.browserLine || '—';
      }
      if (snap && elS && snap.storageBytes != null) {
        elS.textContent = formatQuotaSizeLabel(snap.storageBytes);
      }
    }
  }

  openDangerConfirm({ title, bodyHtml, confirmLabel, onConfirm }) {
    if (!this.elements.dangerConfirmModal) {
      return;
    }
    this.elements.dangerConfirmTitle.textContent = title;
    this.elements.dangerConfirmBody.textContent = '';
    const parsed = new DOMParser().parseFromString(bodyHtml, 'text/html');
    while (parsed.body.firstChild) this.elements.dangerConfirmBody.appendChild(parsed.body.firstChild);
    this.elements.dangerConfirmConfirmBtn.textContent = confirmLabel;
    this._dangerConfirmAction = onConfirm;
    this.elements.dangerConfirmModal.showModal();
  }

  closeDangerConfirmModal() {
    this.elements.dangerConfirmModal?.close?.();
  }

  async onDangerConfirmCommit() {
    const fn = this._dangerConfirmAction;
    this._dangerConfirmAction = null;
    if (!fn) {
      this.closeDangerConfirmModal();
      return;
    }
    try {
      await fn();
    } finally {
      this.closeDangerConfirmModal();
    }
  }

  openPurgeServerModal() {
    this.openDangerConfirm({
      title: 'Delete synced data on server?',
      bodyHtml:
        '<p>This removes <strong>all</strong> tab history, live tab snapshots, and the bookmark tree stored on the server for your account. Your devices stay paired. You cannot undo this.</p>',
      confirmLabel: 'Delete server data',
      onConfirm: () => this.executePurgeServerData()
    });
  }

  async executePurgeServerData() {
    const config = await this.storage.getConfig();
    if (!config.serverUrl || !config.deviceToken) {
      this.showNotification('Not connected');
      return;
    }
    this.apiClient.setServerUrl(config.serverUrl);
    this.apiClient.setDeviceToken(config.deviceToken);
    try {
      await this.apiClient.purgeSyncedData();
      await this.storage.remove('cachedQuotaResponse');
      await this.storage.remove('historyEventsCache');
      await this.storage.setRemoteTabs([]);
      this.showNotification('Server data deleted');
    } catch (e) {
      this.showNotification(`Delete failed: ${(e && e.message) || e}`);
    }
  }

  async exportAllExtensionData() {
    try {
      const data = await this.storage.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      void ext.downloads.download({ url, filename: 'keepsync-extension-backup.json', saveAs: true });
      URL.revokeObjectURL(url);
      this.showNotification('Export started');
    } catch (e) {
      this.showNotification(`Export failed: ${(e && e.message) || e}`);
    }
  }

  async importExtensionDataFromFile(ev) {
    const input = ev.target;
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await this.storage.importData(parsed);
      this.showNotification('Data imported — reload this page');
    } catch (e) {
      this.showNotification(`Import failed: ${(e && e.message) || e}`);
    } finally {
      input.value = '';
    }
  }

  clearAllLocalExtensionData() {
    this.openDangerConfirm({
      title: 'Clear all local data?',
      bodyHtml:
        '<p>Everything stored by the extension in this browser will be removed (settings, caches, credentials).</p>' +
        '<p>If you are connected, this device is <strong>revoked on the server</strong> first when possible. You will need to pair again unless you import a backup.</p>',
      confirmLabel: 'Clear local data',
      onConfirm: async () => {
        const config = await this.storage.getConfig();
        const deviceInfo = await this.storage.getDeviceInfo();
        const deviceId = deviceInfo && deviceInfo.id;
        if (config.serverUrl && config.deviceToken && deviceId) {
          this.apiClient.setServerUrl(config.serverUrl);
          this.apiClient.setDeviceToken(config.deviceToken);
          try {
            await this.apiClient.revokeDevice(deviceId);
          } catch (e) {
            logger.warn('Revoke before local clear failed (continuing with local wipe):', e);
          }
        }
        try {
          await this.storage.clear();
          this.showNotification('Local data cleared');
          window.location.reload();
        } catch (e) {
          this.showNotification(`Clear failed: ${(e && e.message) || e}`);
        }
      }
    });
  }

  async viewErrorLog() {
    const log = await this.storage.getErrorLog();
    const w = window.open('', '_blank');
    if (!w) {
      this.showNotification('Popup blocked');
      return;
    }
    w.document.open();
    const pre = w.document.createElement('pre'); pre.textContent = JSON.stringify(log, null, 2);
    w.document.body.appendChild(pre);
    w.document.close();
  }

  async clearErrorLogFromUI() {
    await this.storage.clearErrorLog();
    this.showNotification('Error log cleared');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const controller = new OptionsController();
  await controller.initialize();
});
