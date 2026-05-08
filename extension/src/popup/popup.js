// Popup JavaScript - Main UI controller
/* global APIClient, StorageManager, formatQuotaSizeLabel, quotaBarPercent, bindTabFaviconImg */

const ext = typeof browser !== 'undefined' ? browser : chrome;

function isBackgroundUnavailableError(err) {
  const m = (err && err.message) || String(err);
  return /Receiving end does not exist|Could not establish connection|the message port closed before a response|no tab with id|Extension context invalidated/i.test(
    m
  );
}

const OPTIONS_TAB_KEY = 'optionsOpenTab';

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

class PopupController {
  constructor() {
    this.apiClient = new APIClient();
    this._quotaInFlight = null;
    this._lastQuotaData = null;
    this._lastQuotaFetchedAt = 0;
    this._heartbeatProbePromise = null;
    this.storage = new StorageManager();
    this.refreshInterval = null;
    this.messageTimeout = null;
    this.toastTimeout = null;
    this.shouldPingHeartbeat = true;
    
    this.elements = {
      statusIndicator: document.getElementById('statusIndicator'),
      statusText: document.getElementById('statusText'),
      setupSection: document.getElementById('setupSection'),
      actionsSection: document.getElementById('actionsSection'),
      devicesSection: document.getElementById('devicesSection'),
      quotaSection: document.getElementById('quotaSection'),
      errorSection: document.getElementById('errorSection'),
      loadingOverlay: document.getElementById('loadingOverlay'),
      openOptionsBtn: document.getElementById('openOptionsBtn'),
      manualSyncBtn: document.getElementById('manualSyncBtn'),
      settingsBtn: document.getElementById('settingsBtn'),
      refreshBtn: document.getElementById('refreshBtn'),
      lastSyncTime: document.getElementById('lastSyncTime'),
      localTabCount: document.getElementById('localTabCount'),
      queuedEvents: document.getElementById('queuedEvents'),
      devicesList: document.getElementById('devicesList'),
      devicesLoading: document.getElementById('devicesLoading'),
      devicesEmpty: document.getElementById('devicesEmpty'),
      deviceSearch: document.getElementById('deviceSearch'),
      quotaFill: document.getElementById('quotaFill'),
      quotaUsage: document.getElementById('quotaUsage'),
      quotaLimit: document.getElementById('quotaLimit'),
      quotaStatus: document.getElementById('quotaStatus'),
      errorMessage: document.getElementById('errorMessage'),
      loadingText: document.getElementById('loadingText'),
      historyLink: document.getElementById('historyLink'),
      testServerLink: document.getElementById('testServerLink'),
      helpLink: document.getElementById('helpLink'),
      toastSuccess: document.getElementById('toastSuccess'),
      toastSuccessText: document.getElementById('toastSuccessText'),
      devicesCacheNotice: document.getElementById('devicesCacheNotice')
    };
  }

  async initialize() {
    logger.log('Initializing popup...');

    try {
      await this.applyStoredTheme();
      this.setupEventListeners();
      await this.loadConfiguration();
      this.shouldPingHeartbeat = true;
      await this.updateUI();
      this.startPeriodicRefresh();
    } catch (error) {
      logger.error('Failed to initialize popup:', error);
      this.showError('Failed to initialize: ' + error.message);
    }
  }

  async applyStoredTheme() {
    try {
      const config = await this.storage.getConfig();
      const mode = config.theme || 'auto';
      if (mode === 'light' || mode === 'dark') {
        document.documentElement.setAttribute('data-theme', mode);
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      const prefs = await this.storage.getPreferences();
      document.body.classList.toggle('compact', !!prefs.compactView);
    } catch (_) {
      // non-fatal
    }
  }

  setupEventListeners() {
    this.elements.openOptionsBtn.addEventListener('click', () => this.openOptions());
    this.elements.settingsBtn.addEventListener('click', () => this.openOptions());
    this.elements.manualSyncBtn.addEventListener('click', () => this.performManualSync());
    this.elements.refreshBtn.addEventListener('click', () => this.refreshRemoteTabs());
    this.elements.deviceSearch?.addEventListener('input', () => this.updateRemoteDevices());
    
    this.elements.historyLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.openHistory();
    });
    this.elements.testServerLink?.addEventListener('click', (e) => {
      e.preventDefault();
      this.testServerHealth();
    });
    this.elements.helpLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.openHelp();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.shouldPingHeartbeat = true;
        this.updateUI();
      }
    });

    if (ext.storage && ext.storage.onChanged) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.syncState) {
          return;
        }
        if (isOnlyHeartbeatSyncStateChange(changes.syncState)) {
          return;
        }
        this.updateUI().catch((e) => logger.warn('Popup updateUI (storage):', e));
      });
    }
  }

  async loadConfiguration() {
    const config = await this.storage.getConfig();
    if (config.serverUrl) {
      this.apiClient.setServerUrl(config.serverUrl);
    }
    if (config.deviceToken) {
      this.apiClient.setDeviceToken(config.deviceToken);
    }
  }

  /**
   * When the service worker is asleep or the message port fails, background
   * heartbeat never runs — probe /healthz from the popup and persist result.
   */
  async runLocalServerProbe() {
    const config = await this.storage.getConfig();
    if (!config?.serverUrl) {
      return;
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
    } catch (e) {
      const message = (e && e.message) || 'Server unreachable';
      await this.storage.setSyncState({
        serverReachable: false,
        lastHeartbeatAt: now,
        lastServerError: message
      });
    }
  }

  async fetchSyncStatus() {
    const config = await this.storage.getConfig();
    const configured = !!(config.serverUrl && config.deviceToken);
    // Fresh health check on popup show / visibility — direct /healthz from the
    // popup updates syncState; relying only on the background message could leave
    // a stale "unreachable" until the next sync.
    if (configured && this.shouldPingHeartbeat) {
      this.shouldPingHeartbeat = false;
      if (!this._heartbeatProbePromise) {
        this._heartbeatProbePromise = this.runLocalServerProbe().finally(() => {
          this._heartbeatProbePromise = null;
        });
      }
    }
    if (this._heartbeatProbePromise) {
      await this._heartbeatProbePromise;
    }
    let status = await this.getSyncStatus();
    if (configured && status.serverReachable == null) {
      if (!this._heartbeatProbePromise) {
        this._heartbeatProbePromise = this.runLocalServerProbe().finally(() => {
          this._heartbeatProbePromise = null;
        });
      }
      await this._heartbeatProbePromise;
      status = await this.getSyncStatus();
    }
    return status;
  }

  async updateUI() {
    try {
      const status = await this.fetchSyncStatus();
      this.updateStatusIndicator(status);
      if (!status.configured) {
        this.showSetupSection();
      } else {
        this.hideSetupSection();
        await this.updateSyncInfo(status);
        await this.updateRemoteDevices(status);
        await this.updateQuotaInfo();
      }
    } catch (error) {
      logger.error('Failed to update UI:', error);
      this.showError('Failed to load data: ' + error.message);
    }
  }

  updateStatusIndicator(status) {
    const { statusIndicator, statusText } = this.elements;
    statusIndicator.className = 'status-indicator';
    statusText.textContent = '';
    statusText.removeAttribute('title');

    if (!status.configured) {
      statusIndicator.classList.add('error');
      statusText.textContent = 'Not configured';
      return;
    }
    if (status.isSyncing) {
      statusIndicator.classList.add('syncing');
      statusText.textContent = 'Syncing...';
      return;
    }
    if (status.online === false) {
      statusIndicator.classList.add('offline');
      statusText.textContent = 'Browser offline';
      return;
    }
    if (status.serverReachable === false) {
      statusIndicator.classList.add('server-down');
      statusText.textContent = 'Server unreachable';
      if (status.lastServerError) {
        statusText.setAttribute('title', status.lastServerError);
      }
      return;
    }
    if (status.serverReachable == null) {
      statusIndicator.classList.add('pending');
      statusText.textContent = 'Server status unknown';
      return;
    }
    if (status.lastSyncTime) {
      statusIndicator.classList.add('connected');
      statusText.textContent = 'Connected';
    } else {
      statusIndicator.classList.add('connected');
      statusText.textContent = 'Connected (not synced yet)';
    }
  }

  showSetupSection() {
    this.elements.setupSection.style.display = 'block';
    this.elements.actionsSection.style.display = 'none';
    this.elements.devicesSection.style.display = 'none';
  }

  hideSetupSection() {
    this.elements.setupSection.style.display = 'none';
    this.elements.actionsSection.style.display = 'block';
    this.elements.devicesSection.style.display = 'block';
  }

  async updateSyncInfo(status) {
    const lastSync = status.lastSyncTime ? new Date(status.lastSyncTime) : null;
    this.elements.lastSyncTime.textContent = lastSync ? this.formatRelativeTime(lastSync) : 'Never';
    this.elements.localTabCount.textContent = status.tabStats?.syncableTabs || 0;
    this.elements.queuedEvents.textContent = status.queuedEvents || 0;
    if (status.online === false && status.queuedEvents > 0) {
      this.showSuccessToast(`Offline: ${status.queuedEvents} changes queued`, 5000);
    }
    const syncBtn = this.elements.manualSyncBtn;
    if (status.isSyncing) {
      syncBtn.classList.add('syncing');
      syncBtn.disabled = true;
    } else {
      syncBtn.classList.remove('syncing');
      syncBtn.disabled = false;
    }
  }

  planDeviceTabLayout(tabs, maxPerDevice, searchTerm) {
    let tabsFiltered = tabs || [];
    const totalCount = (tabs || []).length;
    if (searchTerm) {
      tabsFiltered = tabsFiltered.filter((tab) => {
        const n = this.normalizeTab(tab);
        return `${n.title} ${n.url}`.toLowerCase().includes(searchTerm);
      });
    }
    const grouped = this.groupTabsByWindow(tabsFiltered);
    const windowKeys = Object.keys(grouped).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    const ordinalMap = new Map();
    windowKeys.forEach((k, i) => ordinalMap.set(k, i + 1));

    const allInWindows = {};
    for (const wk of windowKeys) {
      allInWindows[wk] = (grouped[wk] || []).map((t) => this.normalizeTab(t));
    }

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
    return {
      visibleGrouped,
      ordinalMap,
      allInWindows,
      totalHidden,
      searchTerm,
      matchedCount: tabsFiltered.length,
      totalCount,
      windowKeys
    };
  }

  async updateRemoteDevices(syncStatus) {
    const devicesList = this.elements.devicesList;
    const devicesLoading = this.elements.devicesLoading;
    const devicesEmpty = this.elements.devicesEmpty;
    const notice = this.elements.devicesCacheNotice;

    if (!syncStatus || Object.keys(syncStatus).length === 0) {
      try {
        syncStatus = await this.getSyncStatus();
      } catch (_) {
        syncStatus = {};
      }
    }

    const hideCacheNotice = () => {
      if (notice) {
        notice.style.display = 'none';
        notice.textContent = '';
      }
    };

    try {
      devicesLoading.style.display = 'block';
      devicesEmpty.style.display = 'none';
      hideCacheNotice();
      devicesList.querySelectorAll('.device-item').forEach((item) => item.remove());

      const remoteTabs = await this.storage.getRemoteTabs();
      const prefs = await this.storage.getPreferences();
      const maxTabs = Math.max(10, Math.min(100, prefs.maxTabsPerDevice || 50));
      const showFavicons = prefs.showFavicons !== false;

      devicesLoading.style.display = 'none';

      if (!remoteTabs || remoteTabs.length === 0) {
        devicesEmpty.style.display = 'block';
        return;
      }

      const deviceInfo = await this.storage.getDeviceInfo();
      const otherDevices = remoteTabs.filter((device) => device.device_id !== deviceInfo.id);
      if (otherDevices.length === 0) {
        devicesEmpty.style.display = 'block';
        return;
      }

      const searchTerm = this.elements.deviceSearch?.value.trim().toLowerCase() || '';
      let renderedDevices = 0;
      for (const device of otherDevices) {
        const el = this.createDeviceElement(device, { searchTerm, maxTabs, showFavicons });
        if (el) {
          devicesList.appendChild(el);
          renderedDevices++;
        }
      }

      if (renderedDevices === 0) {
        devicesEmpty.style.display = 'block';
        devicesEmpty.textContent = searchTerm ? 'No tabs match your search.' : 'No other devices found.';
        return;
      }

      const useCacheUi =
        renderedDevices > 0 &&
        (syncStatus.serverReachable === false ||
          (typeof navigator !== 'undefined' && navigator.onLine === false));
      if (notice && useCacheUi) {
        const ts = await this.storage.getRemoteTabsUpdatedAt();
        const t =
          ts > 0
            ? new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
            : 'an earlier time';
        notice.textContent = `Showing saved data from this device (server unreachable). Last tab snapshot: ${t}.`;
        notice.style.display = 'block';
      } else {
        hideCacheNotice();
      }
    } catch (error) {
      logger.error('Failed to update remote devices:', error);
      devicesLoading.style.display = 'none';
      devicesEmpty.style.display = 'block';
      devicesEmpty.textContent = 'Failed to load devices';
      hideCacheNotice();
    }
  }

  createDeviceElement(device, { searchTerm, maxTabs, showFavicons }) {
    const plan = this.planDeviceTabLayout(device.tabs || [], maxTabs, searchTerm);
    if (plan.matchedCount === 0) {
      return null;
    }

    const deviceDiv = document.createElement('div');
    deviceDiv.className = 'device-item';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'device-header';
    headerDiv.setAttribute('role', 'button');
    headerDiv.setAttribute('tabindex', '0');
    headerDiv.setAttribute('aria-expanded', 'false');

    const nameDiv = document.createElement('div');
    nameDiv.className = 'device-name';

    const browserIcon = document.createElement('div');
    browserIcon.className = 'browser-icon';
    browserIcon.style.background = this.getBrowserColor(device.browser);
    browserIcon.textContent = (device.browser || '?').charAt(0).toUpperCase();
    nameDiv.appendChild(browserIcon);

    const deviceLabel = device.device_name || (device.device_id ? device.device_id.slice(-8) : 'Unknown Device');
    nameDiv.appendChild(document.createTextNode(deviceLabel));

    const chevron = document.createElement('span');
    chevron.className = 'device-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▸';
    nameDiv.appendChild(chevron);

    const tabCount = document.createElement('span');
    tabCount.className = 'tab-count';
    if (searchTerm) {
      tabCount.textContent = `${plan.matchedCount} / ${plan.totalCount}`;
      tabCount.title = 'Matching / total tabs on device';
    } else {
      tabCount.textContent = String(plan.matchedCount);
    }

    headerDiv.appendChild(nameDiv);
    headerDiv.appendChild(tabCount);

    const tabsList = document.createElement('div');
    tabsList.className = 'tabs-list';
    tabsList.setAttribute('hidden', '');

    const keysWithVisible = plan.windowKeys.filter((wk) => (plan.visibleGrouped[wk] || []).length > 0);
    for (const windowId of keysWithVisible) {
      const ord = plan.ordinalMap.get(windowId) || 0;
      const visibleTabs = plan.visibleGrouped[windowId] || [];
      const allInWin = plan.allInWindows[windowId] || [];
      const nAll = allInWin.length;
      if (visibleTabs.length === 0) continue;

      const winBar = document.createElement('div');
      winBar.className = 'window-toolbar';

      const winTitle = document.createElement('div');
      winTitle.className = 'window-title';
      winTitle.textContent = `Window ${ord} · ${nAll} tab${nAll === 1 ? '' : 's'}`;

      const openAllBtn = document.createElement('button');
      openAllBtn.type = 'button';
      openAllBtn.className = 'open-window-btn';
      openAllBtn.textContent = nAll > 1 ? 'Open all' : 'Open';
      openAllBtn.title = 'Open these URLs in a new window';
      openAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const urls = allInWin.map((t) => t.url).filter(Boolean);
        this.openWindowTabs(urls);
      });

      winBar.appendChild(winTitle);
      winBar.appendChild(openAllBtn);
      tabsList.appendChild(winBar);

      for (const tab of visibleTabs) {
        tabsList.appendChild(this.createTabElement(tab, { showWindowPill: false, showFavicon: showFavicons }));
      }
    }

    if (plan.totalHidden > 0) {
      const hint = document.createElement('div');
      hint.className = 'tab-overflow-hint';
      hint.textContent = `${plan.totalHidden} more tab${plan.totalHidden === 1 ? '' : 's'} not shown. Raise “Max tabs per device” in Settings → Advanced.`;
      tabsList.appendChild(hint);
    }

    const toggle = () => {
      const isOpen = !tabsList.hasAttribute('hidden');
      if (isOpen) {
        tabsList.setAttribute('hidden', '');
        headerDiv.setAttribute('aria-expanded', 'false');
        deviceDiv.classList.remove('expanded');
      } else {
        tabsList.removeAttribute('hidden');
        headerDiv.setAttribute('aria-expanded', 'true');
        deviceDiv.classList.add('expanded');
      }
    };
    headerDiv.addEventListener('click', toggle);
    headerDiv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    deviceDiv.appendChild(headerDiv);
    deviceDiv.appendChild(tabsList);
    return deviceDiv;
  }

  createTabElement(tab, { showWindowPill, showFavicon } = {}) {
    const normalized = this.normalizeTab(tab);
    const tabDiv = document.createElement('div');
    tabDiv.className = 'tab-item';

    if (showFavicon !== false) {
      const favicon = document.createElement('img');
      favicon.className = 'tab-favicon';
      favicon.alt = '';
      if (typeof bindTabFaviconImg === 'function') {
        bindTabFaviconImg(favicon, normalized.faviconUrl, normalized.url);
      } else {
        favicon.src = normalized.faviconUrl || '';
      }
      tabDiv.appendChild(favicon);
    } else {
      const ph = document.createElement('div');
      ph.className = 'tab-favicon tab-favicon-placeholder';
      ph.setAttribute('aria-hidden', 'true');
      tabDiv.appendChild(ph);
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'tab-info';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = normalized.title || 'Untitled';
    title.title = normalized.title;
    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = this.formatURL(normalized.url);
    url.title = normalized.url;
    infoDiv.appendChild(title);
    infoDiv.appendChild(url);
    tabDiv.appendChild(infoDiv);

    if (showWindowPill) {
      const windowDiv = document.createElement('div');
      windowDiv.className = 'tab-window';
      windowDiv.textContent = `W${normalized.windowId}`;
      tabDiv.appendChild(windowDiv);
    }

    tabDiv.addEventListener('click', () => this.openTab(normalized.url));
    return tabDiv;
  }

  normalizeTab(tab) {
    return {
      url: tab.url,
      title: tab.title,
      faviconUrl: tab.faviconUrl || tab.favicon_url,
      windowId: tab.windowId || tab.window_id || 0
    };
  }

  groupTabsByWindow(tabs) {
    return (tabs || []).reduce((acc, tab) => {
      const normalized = this.normalizeTab(tab);
      const key = String(normalized.windowId || 0);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(tab);
      return acc;
    }, {});
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
        window.close();
        return;
      }
    } catch (error) {
      logger.warn('windows.create failed, falling back to tabs:', error);
    }
    try {
      for (let i = 0; i < clean.length; i++) {
        await ext.tabs.create({ url: clean[i], active: i === 0 });
      }
      window.close();
    } catch (error) {
      logger.error('Failed to open tabs:', error);
      this.showError('Failed to open tabs: ' + error.message);
    }
  }

  _applyPopupQuota(quota) {
    if (!quota) return;
    this.elements.quotaSection.style.display = 'block';
    const usageBytes = quota.usageBytes ?? quota.usage_bytes ?? 0;
    const limitMB = quota.limitMB ?? quota.limit_mb ?? 0;
    const limitBytes = limitMB * 1024 * 1024;
    const percentage = quotaBarPercent(usageBytes, limitBytes);
    this.elements.quotaFill.style.width = `${Math.min(percentage, 100)}%`;
    this.elements.quotaUsage.textContent = formatQuotaSizeLabel(usageBytes);
    this.elements.quotaLimit.textContent = formatQuotaSizeLabel(limitBytes);
    const statusEl = this.elements.quotaStatus;
    if (statusEl) {
      statusEl.className = 'quota-status';
      if (quota.status === 'warn') {
        statusEl.classList.add('warn');
        statusEl.textContent = 'Near quota limit';
      } else if (quota.status === 'prune') {
        statusEl.classList.add('prune');
        statusEl.textContent = 'Over limit (pruning)';
      } else {
        statusEl.textContent = '';
      }
    }
  }

  async updateQuotaInfo({ force = false } = {}) {
    const ttlMs = 2000;
    try {
      if (!this.apiClient.isConfigured()) {
        this.elements.quotaSection.style.display = 'none';
        return;
      }
      if (!force && this._lastQuotaData && Date.now() - this._lastQuotaFetchedAt < ttlMs) {
        this._applyPopupQuota(this._lastQuotaData);
        return;
      }
      if (!this._quotaInFlight) {
        this._quotaInFlight = (async () => {
          const q = await this.apiClient.getQuota();
          const nq = this.apiClient.normalizeQuota(q);
          this._lastQuotaData = nq;
          this._lastQuotaFetchedAt = Date.now();
          await this.storage.setCachedQuota(nq);
          return nq;
        })().finally(() => {
          this._quotaInFlight = null;
        });
      }
      const quota = await this._quotaInFlight;
      if (quota) {
        this._applyPopupQuota(quota);
      } else {
        this.elements.quotaSection.style.display = 'none';
      }
    } catch (error) {
      this._quotaInFlight = null;
      logger.warn('Failed to update quota info:', error);
      const cached = await this.storage.getCachedQuota();
      if (cached && cached.quota) {
        this._applyPopupQuota(cached.quota);
      } else {
        this.elements.quotaSection.style.display = 'none';
      }
    }
  }

  async getSyncStatus() {
    try {
      const response = await ext.runtime.sendMessage({ type: 'GET_SYNC_STATUS' });
      return response.success ? response.status : {};
    } catch (error) {
      if (!isBackgroundUnavailableError(error)) {
        logger.warn('Failed to get sync status from background, falling back to local storage:', error);
      }
      const config = await this.storage.getConfig();
      const syncState = await this.storage.getSyncState();
      const queuedEvents = await this.storage.getQueuedEvents();
      const snapshot = await this.storage.getTabSnapshot();
      return {
        configured: !!(config.serverUrl && config.deviceToken),
        lastSyncTime: syncState?.lastSyncTime || null,
        isSyncing: false,
        queuedEvents: queuedEvents?.length || 0,
        backoffMs: null,
        tabStats: { syncableTabs: snapshot?.length || 0 },
        lastSyncResult: syncState?.lastSyncResult || null,
        serverUrl: config.serverUrl || null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : true,
        serverReachable: syncState?.serverReachable,
        lastHeartbeatAt: syncState?.lastHeartbeatAt || null,
        lastServerError: syncState?.lastServerError || null
      };
    }
  }

  async performManualSync() {
    this.showLoading('Syncing tabs...');
    try {
      const response = await ext.runtime.sendMessage({ type: 'MANUAL_SYNC' });
      if (response.success) {
        await this.updateUI();
        this.hideLoading();
        this.showSuccessToast('Sync complete');
        return;
      }
      this.hideLoading();
      this.showError('Sync failed: ' + (response.error || 'Unknown error'));
    } catch (error) {
      if (!isBackgroundUnavailableError(error)) {
        logger.warn('Background sync failed, attempting direct sync:', error);
      }
      try {
        const result = await this.performDirectSync();
        this.shouldPingHeartbeat = true;
        await this.updateUI();
        this.hideLoading();
        this.showSuccessToast(`Sync complete: ${result.snapshotCount} tabs`);
      } catch (directError) {
        this.hideLoading();
        this.showError('Sync failed: ' + directError.message);
      }
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
      snapshotResponse = await this.apiClient.uploadSnapshot({ version: Date.now(), tabs });
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
      lastServerVersion,
      serverReachable: true,
      lastHeartbeatAt: new Date().toISOString(),
      lastServerError: null
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
      'chrome://', 'chrome-extension://', 'moz-extension://', 'about:', 'file://', 'edge://', 'opera://'
    ];
    return restrictedSchemes.some((scheme) => url.startsWith(scheme));
  }

  async testServerHealth() {
    const config = await this.storage.getConfig();
    if (!config.serverUrl) {
      this.showError('Server URL not configured');
      return;
    }
    this.showLoading('Testing server...');
    try {
      this.shouldPingHeartbeat = true;
      const r = await ext.runtime.sendMessage({ type: 'PING_HEARTBEAT' });
      this.hideLoading();
      if (r?.success && r.status) {
        this.updateStatusIndicator(r.status);
        if (r.status.serverReachable === false) {
          this.showError(r.status.lastServerError || 'Server unreachable');
        } else {
          this.showSuccessToast('Server is reachable');
        }
      } else {
        this.showError('Health check did not return status');
      }
    } catch (error) {
      this.hideLoading();
      this.showError('Health check failed: ' + error.message);
    }
  }

  async refreshRemoteTabs() {
    this.elements.refreshBtn.style.animation = 'spin 1s linear infinite';
    this.showLoading('Pulling latest…');
    try {
      const response = await ext.runtime.sendMessage({ type: 'REFRESH_FROM_SERVER' });
      this.shouldPingHeartbeat = true;
      if (response?.success) {
        await this.updateRemoteDevices();
        this.showSuccessToast('List updated from server');
      } else {
        this.showError(response?.error || 'Refresh failed');
      }
    } catch (e) {
      this.showError('Refresh failed: ' + (e?.message || String(e)));
    } finally {
      this.hideLoading();
      this.elements.refreshBtn.style.animation = '';
    }
  }

  async openTab(url) {
    try {
      await ext.tabs.create({ url, active: true });
      window.close();
    } catch (error) {
      logger.error('Failed to open tab:', error);
      this.showError('Failed to open tab: ' + error.message);
    }
  }

  openOptions() {
    ext.runtime.openOptionsPage();
    window.close();
  }

  async openHistory() {
    try {
      await ext.storage.local.set({ [OPTIONS_TAB_KEY]: 'history' });
    } catch (e) {
      logger.warn('Could not set options tab', e);
    }
    ext.runtime.openOptionsPage();
    window.close();
  }

  openHelp() {
    ext.tabs.create({ url: 'https://github.com/keepsync/extension/wiki', active: true });
    window.close();
  }

  showLoading(text = 'Loading...') {
    this.elements.loadingText.textContent = text;
    this.elements.loadingOverlay.style.display = 'flex';
  }

  hideLoading() {
    this.elements.loadingOverlay.style.display = 'none';
  }

  showError(message) {
    this.elements.errorMessage.textContent = message;
    this.elements.errorSection.style.display = 'block';
    this.elements.errorMessage.className = 'error-message';
    this.elements.toastSuccess.style.display = 'none';
    if (this.messageTimeout) {
      clearTimeout(this.messageTimeout);
    }
    this.messageTimeout = setTimeout(() => {
      this.elements.errorSection.style.display = 'none';
    }, 5000);
  }

  showSuccessToast(message, ms = 4000) {
    if (!this.elements.toastSuccess || !this.elements.toastSuccessText) {
      return;
    }
    this.elements.toastSuccessText.textContent = message;
    this.elements.toastSuccess.style.display = 'block';
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = setTimeout(() => {
      this.elements.toastSuccess.style.display = 'none';
    }, ms);
  }

  showNotification(message) {
    this.showSuccessToast(message, 4000);
  }

  startPeriodicRefresh() {
    this.refreshInterval = setInterval(() => {
      if (!document.hidden) {
        this.updateUI();
      }
    }, 30000);
  }

  stopPeriodicRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  formatRelativeTime(date) {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }

  formatURL(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname + parsed.pathname;
    } catch (error) {
      return url;
    }
  }

  getBrowserColor(browser) {
    const colors = { chrome: '#4285f4', firefox: '#ff7139', edge: '#0078d4', safari: '#006cff' };
    return colors[browser] || '#666666';
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
    const byId = new Map((existing || []).map((d) => [d.device_id, d]));
    (incomingDevices || []).forEach((device) => {
      byId.set(device.device_id, device);
    });
    await this.storage.setRemoteTabs(Array.from(byId.values()));
  }

  cleanup() {
    this.stopPeriodicRefresh();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const popup = new PopupController();
  await popup.initialize();
  window.addEventListener('beforeunload', () => {
    popup.cleanup();
  });
});

window.addEventListener('unload', () => {
  logger.log('Popup closed');
});
