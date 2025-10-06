
console.log("[SW] loaded", new Date().toISOString());

// ======== CONFIG ========
const API_BASE = "http://bevo.ly:8002";
const CHECK_API = `${API_BASE}/cached-links`;
const SAVE_API = `${API_BASE}/admin/cache`;
const TTL_MS = 60_000; // cache freshness for per-origin checks

// ======== UTIL ========
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    const hostname = (url.hostname || "").toLowerCase();
    let port = url.port;
    if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) {
      port = "";
    }

    let path = url.pathname || "/";
    try {
      path = decodeURIComponent(path || "/");
    } catch (err) {
      console.warn("[SW] failed to decode pathname", path, err);
    }
    path = path || "/";
    path = path.replace(/\/{2,}/g, "/");
    if (path !== "/" && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    if (!path.startsWith("/")) {
      path = `/${path}`;
    }

    const authority = port ? `${hostname}:${port}` : hostname;
    return `${scheme}://${authority}${path}`;
  } catch {
    return u;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function sanitizeFilenamePart(part) {
  return part
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function buildFilename(url, ext = "mhtml") {
  try {
    const parsed = new URL(url);
    const host = sanitizeFilenamePart(parsed.hostname);
    let path = sanitizeFilenamePart(parsed.pathname.replace(/\/+$/g, "").replace(/^\//, "").replace(/\//g, "-"));
    if (!path) path = "index";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return [host, path, timestamp].filter(Boolean).join("_") + `.${ext}`;
  } catch {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `page_${timestamp}.${ext}`;
  }
}

async function captureMhtml(tabId, url) {
  if (!tabId) {
    throw new Error("Missing tab id for MHTML capture");
  }
  if (!chrome.pageCapture?.saveAsMHTML) {
    throw new Error("MHTML capture is not supported in this browser");
  }

  try {
    const blob = await new Promise((resolve, reject) => {
      chrome.pageCapture.saveAsMHTML({ tabId }, (result) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message || "Failed to capture MHTML"));
          return;
        }
        if (!result) {
          reject(new Error("Failed to capture MHTML"));
          return;
        }
        resolve(result);
      });
    });
    const buffer = await blob.arrayBuffer();
    return {
      content: {
        type: "multipart/related",
        encoding: "base64",
        data: arrayBufferToBase64(buffer),
        filename: buildFilename(url, "mhtml"),
      },
      blob,
    };
  } catch (err) {
    throw new Error(`Failed to capture MHTML: ${err?.message || err}`);
  }
}

async function saveMhtmlLocally({ blob, content }) {
  if (!blob || !content?.filename) {
    throw new Error("Missing MHTML data for local save");
  }

  if (!chrome.downloads?.download) {
    throw new Error("Downloads API is not available");
  }

  const mimeType = blob.type || content?.type || "application/octet-stream";
  // URL.createObjectURL is unavailable in extension service workers, so build a data URL.
  const blobUrl = `data:${mimeType};base64,${content.data}`;

  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename: content.filename,
          saveAs: false,
        },
        (downloadId) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            reject(new Error(err.message || "Failed to start download"));
            return;
          }
          if (!downloadId) {
            reject(new Error("Failed to start download"));
            return;
          }
          resolve(downloadId);
        }
      );
    });
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

async function saveMhtmlToBackend(url, content) {
  const body = JSON.stringify({
    items: [
      {
        url: normalizeUrl(url),
        contents: [content],
      },
    ],
  });
  const res = await fetch(SAVE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`SAVE failed (${res.status}): ${msg || "Unknown error"}`);
  }
  return res.json();
}

async function showErrorDialog(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ERROR_DIALOG", text: message });
  } catch (err) {
    console.warn("Failed to send error dialog to tab", err);
  }
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
        const mhtml = await captureMhtml(tabId, url);
        await saveMhtmlToBackend(url, mhtml.content);
        await saveMhtmlLocally(mhtml);
        await setBadge({ text: "✓", tooltip: "MHTML saved" });
        if (tabId) {
          try {
            await chrome.tabs.sendMessage(tabId, { type: "TOAST", text: "Saved page to cache & downloads" });
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
          await showErrorDialog(msg.tabId, e?.message || "Failed to save page as MHTML");
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
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Save failed" });
      } catch (err) {
        console.warn("Failed to send toast to tab", err);
      }
      await showErrorDialog(tab.id, e?.message || "Failed to save page");
    }
  }
});

