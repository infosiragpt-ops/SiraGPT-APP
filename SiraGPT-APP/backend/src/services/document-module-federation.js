'use strict';

/**
 * document-module-federation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Webpack / Vite / Rspack Module Federation constructs:
 *
 *   - new ModuleFederationPlugin({...}) / federation({...})
 *   - name:        host/remote app identifier
 *   - filename:    "remoteEntry.js" / output filename
 *   - remotes:     { app1: "app1@http://...", app2: "..." }
 *   - exposes:     { "./Component": "./src/Component" }
 *   - shared:      { react: { singleton: true }, "react-dom": "^18" }
 *   - shareScope:  default / custom
 *   - dynamic remotes: __webpack_init_sharing__ / __webpack_share_scopes__
 *
 * Public API:
 *   extractModuleFederation(text)             → { entries, totals, total }
 *   buildModuleFederationForFiles(files)      → { perFile, aggregate, totals }
 *   renderModuleFederationBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const PLUGIN_RE = /\bnew\s+(ModuleFederationPlugin|VueLoaderPlugin)\s*\(/g;
const FEDERATION_FACTORY_RE = /\b(federation|moduleFederation|mfManifest)\s*\(\s*\{/g;
const NAME_RE = /\bname\s*:\s*["']([a-zA-Z][a-zA-Z0-9_-]{0,60})["']/g;
const FILENAME_RE = /\bfilename\s*:\s*["']([a-zA-Z][a-zA-Z0-9._/-]{0,80}\.js)["']/g;
const REMOTES_RE = /\bremotes\s*:\s*\{([^}]{1,800})\}/g;
const REMOTE_ENTRY_RE = /["']([a-zA-Z][a-zA-Z0-9_-]{0,40})["']\s*:\s*["']([a-zA-Z][a-zA-Z0-9_-]{0,40})@([^"'\n]{1,200})["']/g;
const EXPOSES_RE = /\bexposes\s*:\s*\{([^}]{1,800})\}/g;
const EXPOSE_ENTRY_RE = /["']\.\/([a-zA-Z][a-zA-Z0-9._/-]{0,60})["']\s*:\s*["'](\.\/[^"'\n]{1,80})["']/g;
const SHARED_RE = /\bshared\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;
const SHARED_ENTRY_RE = /(?:["']([@a-zA-Z][a-zA-Z0-9._/-]{0,60})["']|([a-zA-Z_][a-zA-Z0-9_-]{0,40}))\s*:\s*(?:\{([^}]{1,200})\}|["']([^"']{1,40})["'])/g;
const DYNAMIC_RE = /\b__webpack_init_sharing__|\b__webpack_share_scopes__|window\.[a-zA-Z_][a-zA-Z0-9_]*\.\w+\s*\?\s*await/g;
const SHARE_SCOPE_RE = /\bshareScope\s*:\s*["']([a-zA-Z_][a-zA-Z0-9_]{0,40})["']/g;

function isFederationLike(body) {
  return /\bModuleFederationPlugin\b|\bfederation\s*\(\s*\{|remotes\s*:\s*\{|exposes\s*:\s*\{|__webpack_init_sharing__/.test(body);
}

function extractModuleFederation(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isFederationLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    plugin: 0, factory: 0, name: 0, filename: 0,
    remote: 0, expose: 0, shared: 0, shareScope: 0, dynamic: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  PLUGIN_RE.lastIndex = 0;
  let m;
  while ((m = PLUGIN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('plugin', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    FEDERATION_FACTORY_RE.lastIndex = 0;
    while ((m = FEDERATION_FACTORY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('factory', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('name', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FILENAME_RE.lastIndex = 0;
    while ((m = FILENAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('filename', m[1].slice(0, 60), null);
    }
  }

  REMOTES_RE.lastIndex = 0;
  while ((m = REMOTES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const block = m[1];
    REMOTE_ENTRY_RE.lastIndex = 0;
    let rm;
    while ((rm = REMOTE_ENTRY_RE.exec(block)) && entries.length < MAX_PER_FILE) {
      push('remote', rm[1], `${rm[2]}@${rm[3].slice(0, 50)}`);
    }
  }

  EXPOSES_RE.lastIndex = 0;
  while ((m = EXPOSES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const block = m[1];
    EXPOSE_ENTRY_RE.lastIndex = 0;
    let em;
    while ((em = EXPOSE_ENTRY_RE.exec(block)) && entries.length < MAX_PER_FILE) {
      push('expose', `./${em[1]}`, em[2].slice(0, 60));
    }
  }

  SHARED_RE.lastIndex = 0;
  while ((m = SHARED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const block = m[1];
    SHARED_ENTRY_RE.lastIndex = 0;
    let sm;
    while ((sm = SHARED_ENTRY_RE.exec(block)) && entries.length < MAX_PER_FILE) {
      const name = sm[1] || sm[2];
      const detail = sm[3] ? 'options' : (sm[4] || '');
      push('shared', name.slice(0, 60), detail.slice(0, 40));
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SHARE_SCOPE_RE.lastIndex = 0;
    while ((m = SHARE_SCOPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('shareScope', m[1], null);
    }
  }

  let dynamicCount = 0;
  DYNAMIC_RE.lastIndex = 0;
  while (DYNAMIC_RE.exec(body) && dynamicCount < 10) dynamicCount += 1;
  totals.dynamic = dynamicCount;
  if (dynamicCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'dynamic', name: '__webpack_init_sharing__', detail: `${dynamicCount} ref(s)` });
  }

  return { entries, totals, total: entries.length };
}

function buildModuleFederationForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    plugin: 0, factory: 0, name: 0, filename: 0,
    remote: 0, expose: 0, shared: 0, shareScope: 0, dynamic: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractModuleFederation(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderModuleFederationBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MODULE FEDERATION'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` = \`${e.detail}\`` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractModuleFederation,
  buildModuleFederationForFiles,
  renderModuleFederationBlock,
  _internal: { isFederationLike },
};
