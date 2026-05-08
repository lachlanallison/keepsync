// Jest setup for KeepSync extension tests
// Provides a minimal WebExtension API mock.

global.browser = {
  storage: {
    local: {
      get: jest.fn(() => Promise.resolve({})),
      set: jest.fn(() => Promise.resolve()),
      remove: jest.fn(() => Promise.resolve()),
      clear: jest.fn(() => Promise.resolve()),
      getBytesInUse: jest.fn(() => Promise.resolve(0))
    }
  },
  runtime: {
    getManifest: jest.fn(() => ({ version: '1.0.0' })),
    getURL: jest.fn((path) => `chrome-extension://test-id/${path}`),
    sendMessage: jest.fn(() => Promise.resolve()),
    onMessage: { addListener: jest.fn() },
    onStartup: { addListener: jest.fn() },
    onInstalled: { addListener: jest.fn() }
  },
  tabs: {
    query: jest.fn(() => Promise.resolve([])),
    get: jest.fn(() => Promise.resolve({})),
    onCreated: { addListener: jest.fn() },
    onUpdated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() },
    onActivated: { addListener: jest.fn() }
  },
  windows: {
    onCreated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() }
  },
  alarms: {
    create: jest.fn(),
    clear: jest.fn(() => Promise.resolve()),
    onAlarm: { addListener: jest.fn() }
  },
  permissions: {
    request: jest.fn(() => Promise.resolve(true)),
    contains: jest.fn(() => Promise.resolve(false))
  }
};

global.chrome = global.browser;

// Load shared logger first so downstream scripts have logger.log etc.
require('../shared/logger.js');
