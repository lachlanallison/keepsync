// KeepSync Logger — wraps console with redaction + debug toggle.
// Load this script FIRST in every context (background, popup, options, offscreen)
// so the global `logger` object is available to all downstream scripts.
(function (globalScope) {
  const DEBUG = false;

  function redact(arg) {
    if (typeof arg !== 'string') return arg;
    return arg
      .replace(/token=[^&\s]+/gi, 'token=<redacted>')
      .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
  }

  function sanitize(args) {
    return Array.from(args).map(redact);
  }

  const logger = {
    log: DEBUG ? function () { console.log.apply(console, sanitize(arguments)); } : function () {},
    info: DEBUG ? function () { console.info.apply(console, sanitize(arguments)); } : function () {},
    warn: function () { console.warn.apply(console, sanitize(arguments)); },
    error: function () { console.error.apply(console, sanitize(arguments)); }
  };

  globalScope.logger = logger;
})(typeof self !== 'undefined' ? self : window);
