// Offscreen document script (Chrome) - manages WebSocket connections
/* global chrome */
logger.log('Offscreen document loaded');

const ext = typeof browser !== 'undefined' ? browser : chrome;
let socket = null;
let config = null;
let reconnectTimer = null;
let backoffMs = 5000;

function buildWebSocketUrl(serverUrl, deviceToken) {
  const wsBase = serverUrl.replace(/^https?:/, (match) => (match === 'https:' ? 'wss:' : 'ws:'));
  return `${wsBase.replace(/\/$/, '')}/realtime/ws?token=${encodeURIComponent(deviceToken)}`;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(backoffMs * 2, 60000);
    connect();
  }, backoffMs);
}

function connect() {
  if (!config?.serverUrl || !config?.deviceToken) {
    return;
  }

  const wsUrl = buildWebSocketUrl(config.serverUrl, config.deviceToken);
  try {
    socket = new WebSocket(wsUrl);
  } catch (error) {
    logger.warn('Failed to create WebSocket:', error);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    backoffMs = 5000;
    logger.log('WebSocket connected');
  };

  socket.onmessage = (event) => {
    if (!event?.data) return;
    if (String(event.data).includes('"ping"') || String(event.data).includes('"connected"')) return;
    ext.runtime.sendMessage({ type: 'REALTIME_NOTIFY', payload: event.data }).catch(() => {});
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch (error) {
      // ignore
    }
  };

  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };
}

function stop() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'START_WEBSOCKET') {
    config = {
      serverUrl: message.serverUrl,
      deviceToken: message.deviceToken
    };
    stop();
    connect();
    sendResponse({ success: true });
    return true;
  }

  if (message?.type === 'STOP_WEBSOCKET') {
    config = null;
    stop();
    sendResponse({ success: true });
    return true;
  }

  if (message?.type === 'OFFSCREEN_PING') {
    sendResponse({ success: true, message: 'pong' });
    return true;
  }

  if (message?.type === 'WS_STATUS') {
    const open = !!(socket && socket.readyState === WebSocket.OPEN);
    sendResponse({ success: true, open });
    return true;
  }
});
