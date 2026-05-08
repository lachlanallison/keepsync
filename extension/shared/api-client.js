// API Client - Shared between extension components and server communication
(function (globalScope) {
  class APIClient {
  constructor() {
    this.serverUrl = null;
    this.deviceToken = null;
    this.requestTimeout = 30000; // 30 seconds
  }

  setServerUrl(url) {
    // Ensure URL doesn't end with slash
    this.serverUrl = url.replace(/\/$/, '');
  }

  setDeviceToken(token) {
    this.deviceToken = token;
  }

  // Authentication endpoints
  async requestMagicLink(email, deviceName = '') {
    const response = await this.request('POST', '/auth/magic-link', {
      email,
      device_name: deviceName
    });
    return response;
  }

  async activateDevice(token, deviceName, browser) {
    const response = await this.request('POST', '/auth/activate', {
      token
    }, {
      'X-Device-Name': deviceName,
      'X-Browser': browser
    });
    return response;
  }

  async requestPairingCode(email) {
    const response = await this.request('POST', '/auth/pairing', {
      email
    });
    return response;
  }

  async registerDeviceWithPairing(pairingCode, deviceName, browser) {
    const response = await this.request('POST', '/devices/register', {
      pairing_code: pairingCode,
      device_name: deviceName
    }, {
      'X-Device-Name': deviceName,
      'X-Browser': browser
    });
    return response;
  }

  async activateInvite(token, deviceName, browser) {
    const response = await this.request('POST', '/auth/invite', {
      token,
      device_name: deviceName
    }, {
      'X-Device-Name': deviceName,
      'X-Browser': browser
    });
    return response;
  }

  // Device management
  async getDevices() {
    return await this.authenticatedRequest('GET', '/devices');
  }

  async updateDeviceName(deviceId, deviceName) {
    return await this.authenticatedRequest('PUT', `/devices/${deviceId}`, {
      device_name: deviceName
    });
  }

  async revokeDevice(deviceId) {
    return await this.authenticatedRequest('DELETE', `/devices/${deviceId}`);
  }

  // Tab sync endpoints
  async uploadSnapshot(snapshotData) {
    const payload = this.normalizeSnapshot(snapshotData);
    return await this.authenticatedRequest('POST', '/tabs/snapshot', payload);
  }

  async uploadEvents(eventsData) {
    const payload = this.normalizeEvents(eventsData);
    const raw = await this.authenticatedRequest('POST', '/tabs/events', payload);
    const out = this.normalizeEventsResponse(raw);
    if (typeof logger !== 'undefined' && logger.info) {
      logger.info('[KeepSync:history] POST /tabs/events', {
        sent: (payload && payload.events && payload.events.length) || 0,
        applied: out.appliedCount,
        conflicts: out.conflictsCreated,
        acknowledged: out.acknowledged,
        serverVersion: out.serverVersion
      });
    }
    return out;
  }

  async getCurrentTabs(sinceVersion = 0) {
    const params = sinceVersion > 0 ? `?since=${sinceVersion}` : '';
    return await this.authenticatedRequest('GET', `/tabs/current${params}`, null, {}, 15000);
  }

  // History
  async getHistory(options = {}) {
    const params = new URLSearchParams();
    if (options.deviceId) params.append('device_id', options.deviceId);
    if (options.from) params.append('from', options.from);
    if (options.to) params.append('to', options.to);
    if (options.limit) params.append('limit', options.limit);
    if (options.cursor) params.append('cursor', options.cursor);

    const query = params.toString();
    const url = `/history${query ? '?' + query : ''}`;

    const raw = await this.authenticatedRequest('GET', url, null, {}, 15000);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      logger.warn('[KeepSync:history] GET /history unexpected body', raw);
      return { items: [], nextCursor: null };
    }
    const items = Array.isArray(raw.items) ? raw.items : [];
    if (typeof logger !== 'undefined' && logger.info) {
      logger.info('[KeepSync:history] GET /history', {
        count: items.length,
        deviceId: options.deviceId || null,
        limit: options.limit
      });
    }
    return { ...raw, items };
  }

  async clearHistory() {
    return await this.authenticatedRequest('POST', '/history/clear');
  }

  /** Remove tab history, live tabs, and bookmarks from the server for this account (devices stay paired). */
  async purgeSyncedData() {
    return await this.authenticatedRequest('POST', '/account/purge-synced-data', {});
  }

  /**
   * Tab sessions across devices (opened, last active, close event, still open).
   * @param {object} [options]
   * @param {string} [options.deviceId]
   * @param {string} [options.status] all | open | closed
   * @param {string} [options.title] LIKE filter (server)
   * @param {string} [options.url] LIKE filter (server)
   * @param {string} [options.openedFrom] [options.openedTo] RFC3339
   * @param {string} [options.closedFrom] [options.closedTo]
   * @param {string} [options.sort] opened_desc | opened_asc | last_active_desc | last_active_asc | closed_desc | closed_asc
   */
  async getHistorySessions(options = {}) {
    const params = new URLSearchParams();
    if (options.deviceId) params.append('device_id', options.deviceId);
    if (options.status && options.status !== 'all') params.append('status', options.status);
    if (options.title) params.append('title', options.title);
    if (options.url) params.append('url', options.url);
    if (options.openedFrom) params.append('opened_from', options.openedFrom);
    if (options.openedTo) params.append('opened_to', options.openedTo);
    if (options.closedFrom) params.append('closed_from', options.closedFrom);
    if (options.closedTo) params.append('closed_to', options.closedTo);
    if (options.sort) params.append('sort', options.sort);
    if (options.limit != null) params.append('limit', String(options.limit));
    if (options.offset != null) params.append('offset', String(options.offset));
    const q = params.toString();
    return await this.authenticatedRequest(
      'GET',
      `/history/sessions${q ? '?' + q : ''}`,
      null,
      {},
      60000
    );
  }

  /**
   * Aggregated visit sessions from tab_history (URL + time merge).
   * @param {object} [options]
   * @param {string} [options.deviceId]
   * @param {string} [options.from] ISO or RFC3339
   * @param {string} [options.to]
   * @param {string} [options.search] substring for URL/title
   * @param {number} [options.limit] max 1000, default 200
   */
  async getHistoryVisits(options = {}) {
    const params = new URLSearchParams();
    if (options.deviceId) params.append('device_id', options.deviceId);
    if (options.from) params.append('from', options.from);
    if (options.to) params.append('to', options.to);
    if (options.search) params.append('search', options.search);
    if (options.limit) params.append('limit', String(options.limit));
    const q = params.toString();
    return await this.authenticatedRequest(
      'GET',
      `/history/visits${q ? '?' + q : ''}`,
      null,
      {},
      20000
    );
  }

  // Bookmarks (full tree; optimistic version on PUT)
  async getBookmarks() {
    return await this.authenticatedRequest('GET', '/bookmarks', null, {}, 20000);
  }

  /**
   * @param {object} body
   * @param {number} [body.baseVersion] if omitted, server may treat as 0
   * @param {Array<{id:string,title:string,position:number,url?:string,parentId?:string}>} body.nodes
   */
  async putBookmarks(body) {
    return await this.authenticatedRequest('PUT', '/bookmarks', body, {}, 60000);
  }

  // Quota
  async getQuota() {
    const quota = await this.authenticatedRequest('GET', '/quota');
    return this.normalizeQuota(quota);
  }

  // Real-time endpoints (for future use)
  getWebSocketUrl() {
    if (!this.serverUrl || !this.deviceToken) {
      throw new Error('Server URL and device token required');
    }
    
    const wsUrl = this.serverUrl.replace(/^https?:/, 'wss:').replace(/^http:/, 'ws:');
    return `${wsUrl}/realtime/ws?token=${encodeURIComponent(this.deviceToken)}`;
  }

  getSSEUrl() {
    if (!this.serverUrl || !this.deviceToken) {
      throw new Error('Server URL and device token required');
    }
    
    return `${this.serverUrl}/realtime/sse?token=${encodeURIComponent(this.deviceToken)}`;
  }

  // Health check — short timeout so UI does not sit on "checking" for 30s when the host is down
  async healthCheck() {
    return await this.request('GET', '/healthz', null, {}, 5000);
  }

  // Private methods
  async authenticatedRequest(
    method,
    path,
    body = null,
    additionalHeaders = {},
    timeoutMs = null
  ) {
    if (!this.deviceToken) {
      throw new Error('Device token required for authenticated requests');
    }

    const headers = {
      'Authorization': `Bearer ${this.deviceToken}`,
      ...additionalHeaders
    };

    return await this.request(method, path, body, headers, timeoutMs);
  }

  async request(method, path, body = null, additionalHeaders = {}, timeoutMs = null) {
    if (!this.serverUrl) {
      throw new Error('Server URL not configured');
    }

    const url = `${this.serverUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...additionalHeaders
    };

    const t =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : this.requestTimeout;

    const options = {
      method,
      headers,
      signal: AbortSignal.timeout(t)
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    logger.log(`API Request: ${method} ${url}`);

    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        let errorBody = null;
        try {
          const contentType = response.headers.get('content-type');
          const tryJson =
            (contentType && contentType.includes('application/json')) ||
            response.status === 401;
          if (tryJson) {
            errorBody = await response.json();
            if (errorBody && errorBody.error) {
              errorMessage = errorBody.error;
            }
          }
        } catch (e) {
          errorMessage = response.statusText || errorMessage;
        }
        const err = new APIError(errorMessage, response.status);
        if (errorBody) {
          err.body = errorBody;
          if (errorBody.code) {
            err.code = errorBody.code;
          }
        }
        if (
          response.status === 401 &&
          errorBody &&
          errorBody.code === 'device_revoked'
        ) {
          err.deviceRevoked = true;
          try {
            const g =
              typeof self !== 'undefined'
                ? self
                : typeof globalThis !== 'undefined'
                  ? globalThis
                  : null;
            if (g && typeof g.keepSyncNotifyDeviceRevoked === 'function') {
              void Promise.resolve(g.keepSyncNotifyDeviceRevoked()).catch(() => {});
            } else {
              const br =
                typeof browser !== 'undefined' && browser.runtime ? browser : null;
              const cr = typeof chrome !== 'undefined' && chrome.runtime ? chrome : null;
              const rt = br || cr;
              if (rt && rt.runtime && rt.runtime.sendMessage) {
                void rt.runtime.sendMessage({ type: 'LOCAL_DEVICE_REVOKED', reason: 'http_401' });
              }
            }
          } catch (_) {
            // not in extension context or messaging unavailable
          }
        }
        throw err;
      }

      // Handle empty responses
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      } else if (error instanceof APIError) {
        throw error;
      } else {
        throw new Error(`Network error: ${error.message}`);
      }
    }
  }

  // Utility methods
  isConfigured() {
    return !!(this.serverUrl && this.deviceToken);
  }

  getConfiguration() {
    return {
      serverUrl: this.serverUrl,
      hasToken: !!this.deviceToken
    };
  }

  normalizeSnapshot(snapshotData) {
    const tabs = (snapshotData?.tabs || []).map((tab) => ({
      tab_id: tab.tabId ?? tab.tab_id ?? 0,
      url: tab.url,
      title: tab.title || '',
      favicon_url: tab.faviconUrl || tab.favicon_url || '',
      window_id: tab.windowId ?? tab.window_id ?? 0,
      pinned: !!tab.pinned,
      discarded: !!tab.discarded,
      last_active_at: tab.lastActiveAt || tab.last_active_at || new Date().toISOString()
    }));

    const baseVersion = snapshotData?.baseVersion ?? snapshotData?.base_version;

    const payload = {
      version: snapshotData?.version || Date.now(),
      tabs
    };
    if (typeof baseVersion === 'number' && baseVersion > 0) {
      payload.base_version = baseVersion;
    }
    return payload;
  }

  normalizeEvents(eventsData) {
    const events = (eventsData?.events || []).map((event) => {
      const cid =
        event.clientTabId ?? event.client_tab_id ?? event.tabId ?? event.tab_id;
      const idNum = cid != null ? Number(cid) : 0;
      const base = {
        event_type: event.eventType || event.event_type,
        url: event.url,
        title: event.title || '',
        favicon_url: event.faviconUrl || event.favicon_url || '',
        window_id: event.windowId ?? event.window_id ?? 0,
        tab_correlation_id: event.tabCorrelationId || event.tab_correlation_id || '',
        occurred_at: event.occurredAt || event.occurred_at || new Date().toISOString(),
        update_triggers: event.updateTriggers || event.update_triggers || ''
      };
      if (idNum > 0) {
        base.client_tab_id = idNum;
      }
      return base;
    });

    return { events };
  }

  /**
   * Server JSON uses snake_case; keep camelCase for extension code and logging.
   */
  normalizeEventsResponse(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        acknowledged: false,
        appliedCount: 0,
        conflictsCreated: 0,
        serverVersion: 0
      };
    }
    return {
      acknowledged: raw.acknowledged !== false,
      appliedCount: raw.applied_count ?? raw.appliedCount ?? 0,
      conflictsCreated: raw.conflicts_created ?? raw.conflictsCreated ?? 0,
      serverVersion: raw.server_version ?? raw.serverVersion ?? 0
    };
  }

  normalizeQuota(quota) {
    if (!quota || typeof quota !== 'object') {
      return quota;
    }

    const usageBytes = quota.usageBytes ?? quota.usage_bytes ?? 0;
    const limitMB = quota.limitMB ?? quota.limit_mb ?? 0;
    const usageMB = quota.usageMB ?? quota.usage_mb ?? Math.floor(usageBytes / (1024 * 1024));

    return {
      status: quota.status,
      usageBytes,
      usageMB,
      limitMB,
      tabHistoryCount: quota.tabHistoryCount ?? quota.tab_history_count ?? 0,
      tabHistoryBytesSum: quota.tabHistoryBytesSum ?? quota.tab_history_bytes_sum ?? 0,
      avgEventBytes: quota.avgEventBytes ?? quota.avg_event_bytes ?? 0,
      recentEvents: quota.recentEvents ?? quota.recent_events ?? []
    };
  }
  }

// Custom error class for API errors
  class APIError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    /** @type {object|null} Parsed JSON body when the server returned one */
    this.body = null;
    /** @type {string|null} Server error code when present, e.g. device_revoked */
    this.code = null;
    this.deviceRevoked = false;
  }
  }

// Browser detection utility — in Firefox, `chrome` is also defined for
// WebExtension compatibility, so we must test `browser` first.
  function detectBrowser() {
  if (typeof browser !== 'undefined' && browser.runtime) {
    return 'firefox';
  }
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    return 'chrome';
  }
  return 'unknown';
  }

// URL validation utility
  function isValidServerUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (error) {
    return false;
  }
  }

  globalScope.APIClient = APIClient;
  globalScope.APIError = APIError;
  globalScope.detectBrowser = detectBrowser;
  globalScope.isValidServerUrl = isValidServerUrl;
})(typeof self !== 'undefined' ? self : window);
