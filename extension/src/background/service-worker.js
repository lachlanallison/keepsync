// Chrome MV3 entry: single service_worker that loads the same script bundle
// order as manifest.firefox.json (global IIFE scripts, no imports).
importScripts(
  '../../shared/logger.js',
  '../../shared/api-client.js',
  '../../shared/storage.js',
  './sync-manager.js',
  './tab-manager.js',
  './bookmark-manager.js',
  './background.js'
);
