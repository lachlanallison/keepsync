// Shared: storage quota labels + bar % (extension popup + options)
(function (global) {
  'use strict';
  const MIB = 1024 * 1024;
  const KIB = 1024;

  function formatQuotaSizeLabel(byteCount) {
    const b = Math.max(0, Math.floor(Number(byteCount) || 0));
    if (b < MIB) {
      return Math.max(0, Math.round(b / KIB)) + ' KB';
    }
    const mb = b / MIB;
    if (mb >= 10) {
      return Math.round(mb) + ' MB';
    }
    const t = Math.round(mb * 10) / 10;
    return (Number.isInteger(t) ? String(t) : t.toFixed(1)) + ' MB';
  }

  function quotaBarPercent(usageBytes, limitBytes) {
    const u = Math.max(0, Number(usageBytes) || 0);
    const l = Math.max(0, Number(limitBytes) || 0);
    if (l <= 0) return 0;
    return Math.min(100, (u / l) * 100);
  }

  global.formatQuotaSizeLabel = formatQuotaSizeLabel;
  global.quotaBarPercent = quotaBarPercent;
}(typeof globalThis !== 'undefined' ? globalThis : this));
