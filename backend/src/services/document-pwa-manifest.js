'use strict';

/**
 * document-pwa-manifest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Web App Manifest (PWA manifest.json) field references:
 *
 *   - name / short_name / description
 *   - display: standalone / fullscreen / minimal-ui / browser
 *   - start_url / scope / id
 *   - theme_color / background_color
 *   - icons array with src/sizes/type/purpose
 *   - shortcuts / share_target
 *   - service worker references (sw.js, navigator.serviceWorker)
 *
 * Public API:
 *   extractPwaManifest(text)             → { entries, totals, total }
 *   buildPwaManifestForFiles(files)      → { perFile, aggregate, totals }
 *   renderPwaManifestBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const NAME_RE = /"(name|short_name|description)"\s*:\s*"([^"\n]{1,150})"/g;
const DISPLAY_RE = /"display"\s*:\s*"(standalone|fullscreen|minimal-ui|browser|window-controls-overlay)"/g;
const URL_FIELD_RE = /"(start_url|scope|id)"\s*:\s*"([^"\n]{1,200})"/g;
const COLOR_RE = /"(theme_color|background_color)"\s*:\s*"(#[A-Fa-f0-9]{3,8}|rgba?\([^)]+\)|hsl\([^)]+\))"/g;
const ORIENTATION_RE = /"orientation"\s*:\s*"(any|natural|landscape|portrait|portrait-primary|landscape-primary)"/g;
const ICONS_RE = /"icons"\s*:\s*\[/g;
const SHORTCUTS_RE = /"shortcuts"\s*:\s*\[/g;
const SHARE_TARGET_RE = /"share_target"\s*:\s*\{/g;
const SW_RE = /(?:\bnavigator\.serviceWorker\.register|\bregister(?:Service)?Worker|\/sw\.js|\/service-worker\.js)/g;

function extractPwaManifest(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { meta: 0, display: 0, url: 0, color: 0, orientation: 0, icons: 0, shortcuts: 0, shareTarget: 0, serviceWorker: 0 };

  function push(kind, key, value) {
    const sig = `${kind}:${key}:${value || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, key, value });
    if (totals[kind] != null) totals[kind] += 1;
  }

  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('meta', m[1], m[2].slice(0, 80));
  }
  if (entries.length < MAX_PER_FILE) {
    DISPLAY_RE.lastIndex = 0;
    while ((m = DISPLAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('display', 'display', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    URL_FIELD_RE.lastIndex = 0;
    while ((m = URL_FIELD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('url', m[1], m[2].slice(0, 80));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    COLOR_RE.lastIndex = 0;
    while ((m = COLOR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('color', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ORIENTATION_RE.lastIndex = 0;
    while ((m = ORIENTATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('orientation', 'orientation', m[1]);
    }
  }

  let iconsCount = 0;
  ICONS_RE.lastIndex = 0;
  while (ICONS_RE.exec(body) && iconsCount < 20) iconsCount += 1;
  totals.icons = iconsCount;
  if (iconsCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'icons', key: 'icons', value: `${iconsCount} array(s)` });
  }

  let shortcutsCount = 0;
  SHORTCUTS_RE.lastIndex = 0;
  while (SHORTCUTS_RE.exec(body) && shortcutsCount < 20) shortcutsCount += 1;
  totals.shortcuts = shortcutsCount;

  let shareCount = 0;
  SHARE_TARGET_RE.lastIndex = 0;
  while (SHARE_TARGET_RE.exec(body) && shareCount < 20) shareCount += 1;
  totals.shareTarget = shareCount;

  let swCount = 0;
  SW_RE.lastIndex = 0;
  while (SW_RE.exec(body) && swCount < 20) swCount += 1;
  totals.serviceWorker = swCount;
  if (swCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'serviceWorker', key: 'sw', value: `${swCount} reference(s)` });
  }

  return { entries, totals, total: entries.length };
}

function buildPwaManifestForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { meta: 0, display: 0, url: 0, color: 0, orientation: 0, icons: 0, shortcuts: 0, shareTarget: 0, serviceWorker: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPwaManifest(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.key}:${e.value || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPwaManifestBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PWA WEB APP MANIFEST'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.key}: \`${e.value || ''}\` (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPwaManifest,
  buildPwaManifestForFiles,
  renderPwaManifestBlock,
};
