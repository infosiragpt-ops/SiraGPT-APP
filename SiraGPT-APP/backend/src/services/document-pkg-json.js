'use strict';

/**
 * document-pkg-json.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects package.json structure: scripts, dependency sections, package meta,
 * engines, workspaces. Only the *names* and counts are emitted — full version
 * specifiers are truncated; script bodies are masked to their command head.
 *
 *   - Meta:           name / version / description / license / type
 *   - Scripts:        scripts.X (mask body to first command word)
 *   - Dependencies:   dependencies / devDependencies / peerDependencies / optionalDependencies (counts + sample names)
 *   - Engines:        engines.node / engines.npm / engines.pnpm
 *   - Workspaces:     workspaces: ["packages/*"]
 *   - Module fields:  main / module / types / exports / browser / unpkg
 *   - Manager fields: packageManager / private / repository / bin
 *
 * Public API:
 *   extractPkgJson(text)             → { entries, totals, total }
 *   buildPkgJsonForFiles(files)      → { perFile, aggregate, totals }
 *   renderPkgJsonBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const META_RE = /"(name|version|description|license|type|private|packageManager|main|module|types|browser|unpkg|module|sideEffects|bin)"\s*:\s*("[^"\n]{1,200}"|true|false|null|\{[^}]{0,300}\})/g;
const SCRIPTS_SECTION_RE = /"scripts"\s*:\s*\{([^}]{1,5000})\}/g;
const SCRIPT_ENTRY_RE = /"([a-zA-Z][a-zA-Z0-9:_-]{0,60})"\s*:\s*"([^"\n]{1,400})"/g;
const DEPS_SECTION_RE = /"(dependencies|devDependencies|peerDependencies|optionalDependencies|bundledDependencies)"\s*:\s*\{([^}]{1,8000})\}/g;
const DEP_ENTRY_RE = /"(@?[a-zA-Z0-9._/-]{1,100})"\s*:\s*"([^"\n]{1,80})"/g;
const ENGINES_RE = /"engines"\s*:\s*\{([^}]{1,300})\}/g;
const ENGINE_ENTRY_RE = /"(node|npm|pnpm|yarn|bun|deno|vscode)"\s*:\s*"([^"\n]{1,40})"/g;
const WORKSPACES_RE = /"workspaces"\s*:\s*(\[[^\]]{0,400}\]|\{[^}]{0,500}\})/g;

function commandHead(scriptBody) {
  // Mask: take first word of the script command
  const trimmed = scriptBody.trim();
  if (!trimmed) return '';
  const firstWord = trimmed.split(/\s/)[0];
  return firstWord.slice(0, 30);
}

function isPkgJsonLike(body) {
  return /"name"\s*:\s*"|"version"\s*:\s*"|"scripts"\s*:\s*\{|"dependencies"\s*:\s*\{/.test(body);
}

function extractPkgJson(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isPkgJsonLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    meta: 0, script: 0, dependencies: 0, devDependencies: 0,
    peerDependencies: 0, optionalDependencies: 0, engine: 0, workspace: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  META_RE.lastIndex = 0;
  let m;
  while ((m = META_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const val = m[2].replace(/^"|"$/g, '').slice(0, 40);
    push('meta', m[1], val);
  }

  ENGINES_RE.lastIndex = 0;
  while ((m = ENGINES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const block = m[1];
    ENGINE_ENTRY_RE.lastIndex = 0;
    let em;
    while ((em = ENGINE_ENTRY_RE.exec(block)) && entries.length < MAX_PER_FILE) {
      push('engine', em[1], em[2]);
    }
  }

  WORKSPACES_RE.lastIndex = 0;
  while ((m = WORKSPACES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const paths = m[1].match(/"([^"\n]{1,80})"/g) || [];
    for (const p of paths.slice(0, 8)) {
      if (entries.length >= MAX_PER_FILE) break;
      push('workspace', p.replace(/"/g, ''), null);
    }
  }

  SCRIPTS_SECTION_RE.lastIndex = 0;
  while ((m = SCRIPTS_SECTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const block = m[1];
    SCRIPT_ENTRY_RE.lastIndex = 0;
    let sm;
    let scriptCount = 0;
    while ((sm = SCRIPT_ENTRY_RE.exec(block)) && entries.length < MAX_PER_FILE && scriptCount < 6) {
      push('script', sm[1], commandHead(sm[2]));
      scriptCount += 1;
    }
  }

  DEPS_SECTION_RE.lastIndex = 0;
  while ((m = DEPS_SECTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const section = m[1];
    const block = m[2];
    DEP_ENTRY_RE.lastIndex = 0;
    let dm;
    let sectionCount = 0;
    while ((dm = DEP_ENTRY_RE.exec(block)) && sectionCount < 80) {
      sectionCount += 1;
      if (totals[section] != null) totals[section] += 1;
      if (entries.length < MAX_PER_FILE && sectionCount <= 4) {
        push(section, dm[1].slice(0, 50), dm[2].slice(0, 20));
      }
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPkgJsonForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    meta: 0, script: 0, dependencies: 0, devDependencies: 0,
    peerDependencies: 0, optionalDependencies: 0, engine: 0, workspace: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPkgJson(txt);
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

function renderPkgJsonBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PACKAGE.JSON SCRIPTS & DEPS'];
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
  extractPkgJson,
  buildPkgJsonForFiles,
  renderPkgJsonBlock,
  _internal: { isPkgJsonLike, commandHead },
};
