'use strict';

/**
 * document-permissions-api.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects browser Permissions / capability API usage:
 *
 *   - navigator.permissions.query({name: 'geolocation'})
 *   - navigator.mediaDevices.getUserMedia({video, audio})
 *   - navigator.geolocation.getCurrentPosition / watchPosition
 *   - Notification.requestPermission
 *   - navigator.clipboard.readText / writeText
 *   - navigator.serviceWorker (already partial in pwa-manifest)
 *   - Bluetooth / USB / Serial / NFC web APIs
 *
 * Public API:
 *   extractPermissionsApi(text)             → { entries, totals, total }
 *   buildPermissionsApiForFiles(files)      → { perFile, aggregate, totals }
 *   renderPermissionsApiBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  { re: /\bnavigator\.permissions\.query\s*\(\s*\{\s*name\s*:\s*['"]([a-z-]{3,40})['"]/g, name: 'permissions-query', category: 'permission-query' },
  { re: /\bnavigator\.mediaDevices\.getUserMedia/g, name: 'getUserMedia', category: 'media' },
  { re: /\bnavigator\.mediaDevices\.enumerateDevices/g, name: 'enumerateDevices', category: 'media' },
  { re: /\bnavigator\.geolocation\.(getCurrentPosition|watchPosition)/g, name: 'geolocation', category: 'location' },
  { re: /\bNotification\.requestPermission/g, name: 'requestPermission', category: 'notification' },
  { re: /\bnew\s+Notification\s*\(/g, name: 'new Notification', category: 'notification' },
  { re: /\bnavigator\.clipboard\.(readText|writeText|read|write)/g, name: 'clipboard', category: 'clipboard' },
  { re: /\bnavigator\.bluetooth\.requestDevice/g, name: 'bluetooth', category: 'device' },
  { re: /\bnavigator\.usb\.requestDevice/g, name: 'usb', category: 'device' },
  { re: /\bnavigator\.serial\.requestPort/g, name: 'serial', category: 'device' },
  { re: /\bnavigator\.hid\.requestDevice/g, name: 'hid', category: 'device' },
  { re: /\bnavigator\.wakeLock\.request/g, name: 'wakeLock', category: 'power' },
  { re: /\bnavigator\.share\b/g, name: 'web-share', category: 'sharing' },
  { re: /\bdocument\.requestFullscreen|\.exitFullscreen/g, name: 'fullscreen', category: 'display' },
  { re: /\bnavigator\.requestMIDIAccess/g, name: 'midi', category: 'device' },
  { re: /\bcaches\.(open|match|delete)/g, name: 'cache-api', category: 'storage' },
  { re: /\bindexedDB\.open/g, name: 'indexedDB', category: 'storage' },
];

function extractPermissionsApi(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  for (const { re, name, category } of PATTERNS) {
    if (entries.length >= MAX_PER_FILE) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const detail = m[1] || null;
      const key = `${name}:${detail || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, category, detail });
      totals[category] = (totals[category] || 0) + 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPermissionsApiForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPermissionsApi(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.name}:${e.detail || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.category] = (totals[e.category] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPermissionsApiBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BROWSER PERMISSIONS / CAPABILITY APIs'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const det = e.detail ? `:${e.detail}` : '';
      lines.push(`- [${e.category}] ${e.name}${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPermissionsApi,
  buildPermissionsApiForFiles,
  renderPermissionsApiBlock,
};
