console.log("[CS] loaded on", location.href);


// ======== URL NORMALIZATION (match backend logic) ========
function normalizeUrl(u) {
  try {
    const abs = new URL(u, location.href);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content",
     "gclid","fbclid","ref","refsrc","spm","mkt_tok","cid","cmpid"]
      .forEach(p => abs.searchParams.delete(p));
    abs.hash = "";
    if (abs.pathname.length > 1 && abs.pathname.endsWith("/")) {
      abs.pathname = abs.pathname.slice(0, -1);
    }
    return abs.toString();
  } catch { return u; }
}

// ======== FIND ARTICLE ANCHORS ========
function getArticleAnchors() {
  const anchors = [...document.querySelectorAll("a[href]")];
  // Heuristics: links inside <article>, cards, headlines, or with typical classes
  console.log(anchors);
  return anchors;
}

// ======== HIGHLIGHT & BADGE ========
function highlight(el) {
  if (el.dataset.cachedHighlight === "1") return;
  el.dataset.cachedHighlight = "1";
  el.style.outline = "2px solid rgb(0, 200, 120)";
  el.style.background = "rgba(0, 200, 120, 0.18)";

  // small corner badge (non-destructive)
  const badge = document.createElement("span");
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
  // try to append near the link text
  (el.closest("h1,h2,h3,h4,h5,h6") || el).appendChild(badge);
}

// ======== SCAN & QUERY BACKGROUND ========
function scanAndMark() {
  const anchors = getArticleAnchors();
  console.log("the scan and mark: ");
  console.log(anchors);

  if (!anchors.length) return;

  const map = new Map(); // url -> [elements]
  for (const a of anchors) {
    const u = normalizeUrl(a.href);
    if (!map.has(u)) map.set(u, []);
    map.get(u).push(a);
  }

  chrome.runtime.sendMessage({
    type: "CHECK_CACHED",
    pageUrl: location.href,
    urls: [...map.keys()]
  }, (resp) => {
    if (!resp || !resp.ok) return;
    const cachedSet = new Set(resp.cached || []);
    for (const [url, els] of map.entries()) {
      if (cachedSet.has(url)) {
        els.forEach(highlight);
      }
    }
  });
}

// ======== DEBOUNCED OBSERVER FOR SPA/INFINITE SCROLL ========
let timer = null;
const debounced = (fn, ms) => {
  clearTimeout(timer);
  timer = setTimeout(fn, ms);
};

// initial run
scanAndMark();

// watch for DOM changes
const mo = new MutationObserver(() => debounced(scanAndMark, 250));
mo.observe(document.documentElement, { childList: true, subtree: true });

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
    `;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 1600);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TOAST" && msg.text) showToast(msg.text);
});

