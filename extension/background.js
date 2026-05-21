/**
 * Sira Appshots — service-worker entry point.
 *
 * Flow (MV3-compliant):
 *   1. User triggers `capture-window` command (or popup "Capturar" button)
 *      → entrypoint `runCapture()`.
 *   2. `chrome.desktopCapture.chooseDesktopMedia(...)` returns a streamId
 *      after the user picks a window/tab/screen in the native picker.
 *   3. We can't call `getUserMedia` from a service worker, so we spin up an
 *      offscreen document (`offscreen.html`) and message it the streamId.
 *   4. Offscreen grabs ONE video frame, paints it to a canvas, replies with
 *      a PNG blob URL.
 *   5. SW fetches that blob URL, uploads it to /api/appshots/capture with
 *      the paired bearer token, and opens the returned `redirectUrl` in a
 *      new tab.
 *
 * Any failure surfaces as a chrome notification so the user doesn't sit
 * staring at a silent picker.
 */

const STORAGE_KEYS = {
  token: 'siraAppshotsToken',
  apiBase: 'siraAppshotsApiBase',
};

const DEFAULT_API_BASE = 'https://siragpt.com';
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

// ── command + popup-trigger entrypoint ───────────────────────
chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'capture-window') {
    runCapture().catch((err) => notifyError(err));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'appshots:capture-now') {
    runCapture()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep channel open for async response
  }
  return false;
});

// ── core flow ────────────────────────────────────────────────
async function runCapture() {
  const { token, apiBase } = await loadConfig();
  if (!token) {
    await openOptionsTab();
    throw new Error('Falta vincular la extensi\u00f3n con Sira. Abre las opciones y pega el c\u00f3digo de Sira.');
  }

  const streamId = await chooseDesktopStream();
  if (!streamId) throw new Error('Captura cancelada.');

  await ensureOffscreen();
  const blob = await grabFrameViaOffscreen(streamId);

  const baseUrl = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const form = new FormData();
  form.append('image', blob, 'appshot.png');
  form.append('source', 'Captura de ventana');
  form.append('ocr', '1');

  const resp = await fetch(`${baseUrl}/api/appshots/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Sira rechaz\u00f3 la captura (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data?.redirectUrl) await chrome.tabs.create({ url: data.redirectUrl });
  return data;
}

function chooseDesktopStream() {
  return new Promise((resolve, reject) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(
        ['window', 'screen', 'tab'],
        (streamId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(streamId || null);
        },
      );
    } catch (err) {
      reject(err);
    }
  });
}

// ── offscreen document plumbing ──────────────────────────────
async function ensureOffscreen() {
  const has = await (chrome.offscreen?.hasDocument?.() ?? Promise.resolve(false));
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Captura un frame de la ventana elegida por el usuario.',
  });
}

function grabFrameViaOffscreen(streamId) {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    let timeoutHandle = null;
    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(listener);
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    };
    const listener = (msg) => {
      if (msg?.type !== 'appshots:frame-result' || msg.requestId !== requestId) return;
      cleanup();
      if (msg.error) { reject(new Error(msg.error)); return; }
      // Re-fetch the blob URL the offscreen page handed us, then revoke it so
      // we don't leak the underlying ArrayBuffer across repeated captures.
      // Blob URLs created in the offscreen document remain readable from the
      // SW within the same extension origin.
      fetch(msg.blobUrl)
        .then((r) => r.blob())
        .then((blob) => {
          try { URL.revokeObjectURL(msg.blobUrl); } catch (_) { /* best-effort */ }
          // Best-effort: also tell the offscreen page to revoke its own
          // reference so the page's GC roots release the buffer immediately.
          chrome.runtime.sendMessage({
            type: 'appshots:revoke-blob',
            target: 'offscreen',
            blobUrl: msg.blobUrl,
          }).catch(() => { /* offscreen may have torn down */ });
          resolve(blob);
        })
        .catch(reject);
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({
      type: 'appshots:grab-frame',
      target: 'offscreen',
      requestId,
      streamId,
    });
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error('Tiempo agotado capturando el frame.'));
    }, 15000);
  });
}

// ── storage + UX ─────────────────────────────────────────────
async function loadConfig() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.apiBase]);
  return {
    token: data[STORAGE_KEYS.token] || null,
    apiBase: data[STORAGE_KEYS.apiBase] || DEFAULT_API_BASE,
  };
}

async function openOptionsTab() {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
  } else {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
}

function notifyError(err) {
  const message = String(err?.message || err);
  // Surface short errors as a popup-side message; full error always logged.
  console.warn('[appshots] capture failed:', message);
  chrome.notifications?.create?.({
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: 'Sira Appshots',
    message,
  });
}
