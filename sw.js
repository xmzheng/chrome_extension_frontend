
console.log("[SW] loaded", new Date().toISOString());

// ======== CONFIG ========
const API_BASE = "http://bevo.ly:8002";
const CHECK_API = `${API_BASE}/cached-links`;
const SAVE_API  = `${API_BASE}/admin/cache`;
const TTL_MS = 60_000; // cache freshness for per-origin checks

// ======== UTIL ========
function normalizeUrl(raw) {
  try {
    const abs = new URL(raw);
    const scheme = abs.protocol.replace(/:$/, "").toLowerCase();
    const hostname = (abs.hostname || "").toLowerCase();
    const port = abs.port;
    const isDefaultPort = !port || (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
    const netloc = isDefaultPort ? hostname : `${hostname}:${port}`;

    let path = abs.pathname || "/";
    try {
      path = decodeURIComponent(path);
    } catch {
      // ignore decode errors and keep the original path
    }
    path = path.replace(/\/{2,}/g, "/");
    if (path !== "/" && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    if (netloc && !path.startsWith("/")) {
      path = `/${path}`;
    }

    return netloc ? `${scheme}://${netloc}${path}` : `${scheme}:${path}`;
  } catch {
    return raw;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

function buildFilename(url, ext) {
  try {
    const { hostname, pathname } = new URL(url);
    const raw = `${hostname}${pathname}`.replace(/\?.*$/, "");
    const parts = raw.split(/[\/\s]+/).filter(Boolean).slice(-3);
    const slug = parts.join("-") || hostname || "page";
    const safeSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `${safeSlug || "page"}.${ext}`;
  } catch {
    return `page.${ext}`;
  }
}

async function capturePdf(tabId, url) {
  if (!tabId) {
    throw new Error("Missing tab id for PDF capture");
  }
  if (!chrome.tabs?.saveAsPDF) {
    throw new Error("PDF capture is not supported in this browser");
  }

  try {
    const pdfBuffer = await chrome.tabs.saveAsPDF({ tabId });
    return {
      content: {
        type: "application/pdf",
        encoding: "base64",
        data: arrayBufferToBase64(pdfBuffer),
        filename: buildFilename(url, "pdf"),
      },
      buffer: pdfBuffer,
    };
  } catch (err) {
    throw new Error(`Failed to capture PDF: ${err?.message || err}`);
  }
}

async function downloadPdf(content, buffer) {
  if (!chrome.downloads?.download || !content) return;

  try {
    const filename = content.filename || "page.pdf";
    const blob = buffer ? new Blob([buffer], { type: content.type || "application/pdf" })
                        : new Blob([Uint8Array.from(atob(content.data || ""), c => c.charCodeAt(0))], { type: content.type || "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  } catch (err) {
    console.warn("[SW] Failed to download PDF", err);
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
async function checkCached(pageUrl, urls) {
  const originKey = getOriginKey(pageUrl);
  const now = Date.now();
  const entry = mem.get(originKey);
  const payload = [...new Set(urls.map(normalizeUrl))];

  // use cache if fresh
  if (entry && now - entry.at < TTL_MS) {
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

async function saveToBackend(url, content) {
  const payload = { urls: [normalizeUrl(url)] };
  if (content) {
    payload.content = content;
  }
  const body = JSON.stringify(payload);
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
    checkCached(msg.pageUrl, msg.urls)
      .then(resp => sendResponse(resp))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
});

// ======== ACTION BUTTON: SAVE CURRENT TAB ========
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const url = tab?.url || "";
    if (!/^https?:\/\//i.test(url)) {
      await setBadge({ text: "×", tooltip: "Unsupported URL" });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Unsupported URL" });
      return;
    }
    const { content, buffer } = await capturePdf(tab.id, url);
    await saveToBackend(url, content);
    await downloadPdf(content, buffer);
    await setBadge({ text: "✓", tooltip: "Saved" });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Saved to cache" });
    // warm the cache for this origin
    const originKey = getOriginKey(url);
    const entry = mem.get(originKey) || { at: 0, cachedSet: new Set() };
    entry.cachedSet.add(normalizeUrl(url));
    entry.at = Date.now();
    mem.set(originKey, entry);
  } catch (e) {
    console.error(e);
    await setBadge({ text: "×", tooltip: "Save failed" });
    if (tab?.id) {
      const message = e?.message || "Failed to save page as PDF.";
      chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Save failed" });
      chrome.tabs.sendMessage(tab.id, {
        type: "ERROR_DIALOG",
        title: "Save failed",
        text: message,
      });
    }
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

