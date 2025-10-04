
console.log("[SW] loaded", new Date().toISOString());

// ======== CONFIG ========
const API_BASE = "http://bevo.ly:8002";
const CHECK_API = `${API_BASE}/cached-links`;
const SAVE_API  = `${API_BASE}/admin/cache`;
const TTL_MS = 60_000; // cache freshness for per-origin checks

// ======== UTIL ========
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content",
     "gclid","fbclid","ref","refsrc","spm","mkt_tok","cid","cmpid"]
      .forEach(p => url.searchParams.delete(p));
    url.hash = "";
    // remove trailing slash unless root
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return u;
  }
}

async function setBadge({ text = "", tooltip }) {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: "#2ecc71" });
  if (tooltip) await chrome.action.setTitle({ title: tooltip });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
}

// ======== SIMPLE IN-MEM CACHE ========
/**
 * mem structure:
 *   key: origin (https://news.example.com)
 *   val: { at: number, cachedSet: Set<string> }
 */
const mem = new Map();

function getOriginKey(pageUrl) {
  try { return new URL(pageUrl).origin; } catch { return "global"; }
}

// ======== BACKEND CALLS ========
async function checkCached(pageUrl, urls, { force = false } = {}) {
  const originKey = getOriginKey(pageUrl);
  const now = Date.now();
  const entry = mem.get(originKey);
  const payload = [...new Set(urls.map(normalizeUrl))];

  // use cache if fresh
  if (!force && entry && now - entry.at < TTL_MS) {
    const result = payload.filter(u => entry.cachedSet.has(u));
    return { ok: true, cached: result };
  }

  // fetch fresh
  const res = await fetch(CHECK_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: payload })
  });
  if (!res.ok) throw new Error(`CHECK failed: ${res.status}`);
  const data = await res.json();
  const set = new Set((data.cached || []).map(normalizeUrl));
  mem.set(originKey, { at: Date.now(), cachedSet: set });
  const result = payload.filter(u => set.has(u));
  return { ok: true, cached: result };
}

async function saveToBackend(url) {
  const body = JSON.stringify({ urls: [normalizeUrl(url)] });
  const res = await fetch(SAVE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`SAVE failed (${res.status}): ${msg || "Unknown error"}`);
  }
  return res.json();
}

// ======== MESSAGE HANDLERS ========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "CHECK_CACHED") {
    checkCached(msg.pageUrl, msg.urls, { force: Boolean(msg.force) })
      .then(resp => sendResponse(resp))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg?.type === "SAVE_URL") {
    (async () => {
      try {
        const url = msg.url || "";
        const tabId = msg.tabId;
        if (!/^https?:\/\//i.test(url)) {
          await setBadge({ text: "×", tooltip: "Unsupported URL" });
          if (tabId) {
            try {
              await chrome.tabs.sendMessage(tabId, { type: "TOAST", text: "Unsupported URL" });
            } catch (err) {
              console.warn("Failed to send toast to tab", err);
            }
          }
          sendResponse({ ok: false, error: "Unsupported URL" });
          return;
        }
        await saveToBackend(url);
        await setBadge({ text: "✓", tooltip: "Saved" });
        if (tabId) {
          try {
            await chrome.tabs.sendMessage(tabId, { type: "TOAST", text: "Saved to cache" });
          } catch (e) {
            console.warn("Failed to send toast to tab", e);
          }
        }
        const originKey = getOriginKey(url);
        const entry = mem.get(originKey) || { at: 0, cachedSet: new Set() };
        entry.cachedSet.add(normalizeUrl(url));
        entry.at = Date.now();
        mem.set(originKey, entry);
        sendResponse({ ok: true });
      } catch (e) {
        console.error(e);
        await setBadge({ text: "×", tooltip: "Save failed" });
        if (msg.tabId) {
          try {
            await chrome.tabs.sendMessage(msg.tabId, { type: "TOAST", text: "Save failed" });
          } catch (err) {
            console.warn("Failed to send toast to tab", err);
          }
        }
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

// ======== CONTEXT MENU: SAVE LINK ========
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-link-to-cache",
    title: "Save link to cache",
    contexts: ["link"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "save-link-to-cache" || !info.linkUrl) return;
  try {
    await saveToBackend(info.linkUrl);
    await setBadge({ text: "✓", tooltip: "Link saved" });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Link saved" });
  } catch (e) {
    console.error(e);
    await setBadge({ text: "×", tooltip: "Save failed" });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Save failed" });
  }
});

