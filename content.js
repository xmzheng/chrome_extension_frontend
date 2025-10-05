(() => {
  const STATE_KEY = "__cachedArticleHighlighterState";
  const LOG_PREFIX = "[Cached Article Highlighter]";

  const existingState = window[STATE_KEY];
  if (existingState && existingState.href === location.href) {
    console.debug(`${LOG_PREFIX} already initialized for`, location.href);
    return;
  }

  if (existingState?.teardown) {
    try {
      existingState.teardown();
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to teardown previous instance`, err);
    }
  }

  const state = { href: location.href };
  window[STATE_KEY] = state;

  // ======== URL NORMALIZATION (match backend logic) ========
  function normalizeUrl(u) {
    try {
      const abs = new URL(u, location.href);
      [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "gclid",
        "fbclid",
        "ref",
        "refsrc",
        "spm",
        "mkt_tok",
        "cid",
        "cmpid",
      ].forEach((p) => abs.searchParams.delete(p));
      abs.hash = "";
      if (abs.pathname.length > 1 && abs.pathname.endsWith("/")) {
        abs.pathname = abs.pathname.slice(0, -1);
      }
      return abs.toString();
    } catch (error) {
      console.warn(`${LOG_PREFIX} failed to normalize url`, u, error);
      return u;
    }
  }

  // ======== FIND ARTICLE ANCHORS ========
  function getArticleAnchors() {
    return [...document.querySelectorAll("a[href]")].filter((anchor) => {
      const text = anchor.textContent?.trim().toLowerCase() || "";
      if (!text) return false;

      const role = anchor.getAttribute("role");
      if (role && role.toLowerCase() === "button") return false;

      const parent = anchor.closest("article, header, main, section, h1, h2, h3, h4, h5, h6");
      if (parent) return true;

      const className = anchor.className || "";
      return /article|headline|story|card|entry/i.test(className);
    });
  }

  // ======== HIGHLIGHT & BADGE ========
  function highlight(anchor) {
    if (anchor.dataset.cachedHighlight === "1") return;
    anchor.dataset.cachedHighlight = "1";

    anchor.style.outline = "2px solid rgb(0, 200, 120)";
    anchor.style.background = "rgba(0, 200, 120, 0.18)";

    const badgeHost = anchor.closest("h1,h2,h3,h4,h5,h6") || anchor;
    const existingBadge = badgeHost.querySelector(':scope > span[data-cached-badge="1"]');
    if (existingBadge) return;

    const badge = document.createElement("span");
    badge.dataset.cachedBadge = "1";
    badge.textContent = "cached";
    badge.style.cssText = `
      margin-left: 6px;
      padding: 0 6px;
      font-size: 10px;
      line-height: 16px;
      border-radius: 8px;
      border: 1px solid rgb(0,200,120);
      background: rgba(0,200,120,0.12);
      color: rgb(0,120,80);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    `;
    badgeHost.appendChild(badge);
  }

  // ======== SCAN & QUERY BACKGROUND ========
  function scanAndMark({ force = false } = {}) {
    const anchors = getArticleAnchors();
    if (!anchors.length) return;

    const map = new Map(); // url -> [elements]
    for (const anchor of anchors) {
      const normalized = normalizeUrl(anchor.href);
      if (!normalized) continue;
      if (!map.has(normalized)) map.set(normalized, []);
      map.get(normalized).push(anchor);
    }

    if (!map.size) return;

    chrome.runtime.sendMessage(
      {
        type: "CHECK_CACHED",
        pageUrl: location.href,
        urls: [...map.keys()],
        force,
      },
      (resp) => {
        if (!resp || !resp.ok) return;
        const cachedSet = new Set(resp.cached || []);
        for (const [url, anchorsForUrl] of map.entries()) {
          if (cachedSet.has(url)) {
            anchorsForUrl.forEach(highlight);
          }
        }
      }
    );
  }

  // ======== DEBOUNCED OBSERVER FOR SPA/INFINITE SCROLL ========
  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndMark();
    }, 250);
  };

  let mutationObserver = null;
  function startObservers() {
    scanAndMark();
    mutationObserver = new MutationObserver(scheduleScan);
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObservers() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function handlePageShow(event) {
    if (event.persisted) {
      scanAndMark();
    }
  }

  // ======== OPTIONAL: TOAST FROM BACKGROUND (save success/fail) ========
  let toastTimer = null;
  function showToast(text) {
    let el = document.getElementById("__cached_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cached_toast";
      el.style.cssText = `
        position: fixed; z-index: 2147483647; left: 50%; transform: translateX(-50%);
        bottom: 20px; background: rgba(0,0,0,0.85); color: #fff; padding: 10px 14px;
        border-radius: 10px; font-size: 12px; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        box-shadow: 0 6px 20px rgba(0,0,0,0.25);
        transition: opacity 160ms ease;
      `;
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
    }, 1600);
  }

  const messageListener = (msg) => {
    if (msg?.type === "TOAST" && msg.text) {
      showToast(msg.text);
    } else if (msg?.type === "ERROR_DIALOG" && msg.text) {
      window.alert(msg.text);
    } else if (msg?.type === "FORCE_RESCAN") {
      scanAndMark({ force: true });
    }
  };
  chrome.runtime.onMessage.addListener(messageListener);

  function teardown() {
    stopObservers();
    window.removeEventListener("pageshow", handlePageShow, true);
    chrome.runtime.onMessage.removeListener(messageListener);
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    const toastEl = document.getElementById("__cached_toast");
    if (toastEl) {
      toastEl.remove();
    }
    delete window[STATE_KEY];
  }

  state.teardown = teardown;
  state.scanAndMark = scanAndMark;

  startObservers();
  window.addEventListener("pageshow", handlePageShow, true);
  console.debug(`${LOG_PREFIX} initialized on`, location.href);
})();
