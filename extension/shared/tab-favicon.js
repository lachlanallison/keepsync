// Resolve tab row favicons: prefer server/client URL, then host-based icon service.
(function (globalScope) {
  const PLACEHOLDER =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ccc"/></svg>'
    );

  function tabFaviconSrc(storedUrl, pageUrl) {
    const u = (storedUrl || '').trim();
    if (u) return u;
    if (!pageUrl) return PLACEHOLDER;
    try {
      const hostname = new URL(pageUrl).hostname;
      if (!hostname) return PLACEHOLDER;
      return 'https://icons.duckduckgo.com/ip3/' + hostname + '.ico';
    } catch {
      return PLACEHOLDER;
    }
  }

  /**
   * @param {HTMLImageElement} img
   * @param {string} [storedUrl]
   * @param {string} [pageUrl]
   */
  function bindTabFaviconImg(img, storedUrl, pageUrl) {
    const stored = (storedUrl || '').trim();
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.src = tabFaviconSrc(stored, pageUrl);
    img.onerror = () => {
      img.onerror = null;
      if (stored) {
        img.src = tabFaviconSrc('', pageUrl);
        return;
      }
      img.src = PLACEHOLDER;
    };
  }

  globalScope.tabFaviconSrc = tabFaviconSrc;
  globalScope.bindTabFaviconImg = bindTabFaviconImg;
})(typeof self !== 'undefined' ? self : window);
