'use strict';

/**
 * document-file-paths.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects file system paths in docs/runbooks/READMEs:
 *
 *   - POSIX absolute paths with depth (/etc/nginx/conf.d, /var/log/app.log)
 *   - Home-relative paths (~/.config/foo, ~/Desktop/file.txt)
 *   - Relative project paths (src/foo/bar.js, tests/fixtures/data.json,
 *     backend/src/services/x.ts)
 *   - Windows paths (C:\Users\foo\Documents)
 *
 * Different from document-api-endpoints (HTTP paths) by requiring
 * an extension OR a depth ≥ 2 AND specific directory hints. Different
 * from document-urls (web links) by excluding scheme://. Routes
 * "what files does this reference?" to a citeable inventory.
 *
 * Public API:
 *   extractFilePaths(text)         → PathReport
 *   buildFilePathsForFiles(files)  → { perFile, aggregate, totals }
 *   renderFilePathsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 40;
const MAX_BLOCK_CHARS = 5500;
const MAX_PATH_LEN = 200;

// File extensions used to validate path-like tokens
const VALID_EXTENSIONS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'cpp', 'c', 'h', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'md', 'rst', 'txt', 'pdf', 'doc', 'docx',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'sql', 'graphql', 'gql', 'proto',
  'xml', 'csv', 'tsv',
  'log',
  'dockerfile', 'gemfile',
  'lock',
]);

// POSIX absolute path with at least one segment beyond root
const POSIX_ABS_RE = /(?:^|[\s`'"<>(,;:])(\/(?:[a-zA-Z0-9_.\-]+\/)+[a-zA-Z0-9_.\-]+)(?=[\s`'"<>):,;.!?]|$)/g;
// Home-relative path
const HOME_REL_RE = /(?:^|[\s`'"<>(,;:])(~\/(?:[a-zA-Z0-9_.\-]+\/?)+)(?=[\s`'"<>):,;.!?]|$)/g;
// Relative project path: dir/subdir/file.ext OR dir/file.ext
const PROJECT_REL_RE = /(?:^|[\s`'"<>(,;:])((?:[a-zA-Z0-9_\-]+\/)+[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+)(?=[\s`'"<>):,;.!?]|$)/g;
// Windows absolute
const WINDOWS_ABS_RE = /(?:^|[\s`'"<>(,;:])([A-Z]:\\(?:[a-zA-Z0-9_.\- ]+\\)*[a-zA-Z0-9_.\- ]+)(?=[\s`'"<>):,;.!?]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipPath(p) {
  const s = String(p || '');
  if (s.length <= MAX_PATH_LEN) return s;
  return `${s.slice(0, MAX_PATH_LEN - 1)}…`;
}

function getExtension(path) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : null;
}

function isLikelyFilePath(path, kind) {
  if (!path || path.length < 3) return false;
  const ext = getExtension(path);
  if (kind === 'posix-abs') {
    // Need depth ≥ 2 (e.g. /etc/nginx/foo.conf or /var/log/app.log)
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    return true;
  }
  if (kind === 'home') {
    return /^~\//.test(path);
  }
  if (kind === 'project-rel') {
    // Require known extension to reduce false positives
    if (!ext || !VALID_EXTENSIONS.has(ext)) return false;
    // Reject URL-like or domain-like
    if (path.startsWith('http')) return false;
    return true;
  }
  if (kind === 'windows-abs') {
    return /^[A-Z]:\\/.test(path);
  }
  return false;
}

function extractFilePaths(input) {
  const text = safeText(input);
  if (!text) return { paths: [], total: 0, totals: { 'posix-abs': 0, 'home': 0, 'project-rel': 0, 'windows-abs': 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const paths = [];
  const seen = new Set();
  const totals = { 'posix-abs': 0, 'home': 0, 'project-rel': 0, 'windows-abs': 0 };

  function add(kind, path) {
    if (paths.length >= MAX_PER_FILE) return;
    if (!isLikelyFilePath(path, kind)) return;
    const cleanPath = clipPath(path.replace(/[.,;)\]]+$/, ''));
    const key = `${kind}|${cleanPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    paths.push({ kind, path: cleanPath });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(POSIX_ABS_RE)) add('posix-abs', m[1]);
  for (const m of head.matchAll(HOME_REL_RE)) add('home', m[1]);
  for (const m of head.matchAll(PROJECT_REL_RE)) add('project-rel', m[1]);
  for (const m of head.matchAll(WINDOWS_ABS_RE)) add('windows-abs', m[1]);

  return { paths, total: paths.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildFilePathsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = { 'posix-abs': 0, 'home': 0, 'project-rel': 0, 'windows-abs': 0 };
  for (const f of list) {
    const r = extractFilePaths(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, paths: r.paths, totals: r.totals });
    aggregate = aggregate.concat(r.paths.map((p) => ({ ...p, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderPath(p, opts = {}) {
  const file = opts.includeFile && p.file ? ` _(${p.file})_` : '';
  return `- [${p.kind}] \`${p.path}\`${file}`;
}

function renderFilePathsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || { 'posix-abs': 0, 'home': 0, 'project-rel': 0, 'windows-abs': 0 };
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## FILE PATHS
Filesystem paths detected in the document(s) — POSIX absolute (/etc/nginx/foo.conf, /var/log/app.log), home-relative (~/.config/foo, ~/Desktop/file.txt), project-relative (src/foo/bar.js, tests/data.json) with known file extensions, and Windows absolute (C:\\Users\\foo\\Documents). Different from document-api-endpoints (HTTP paths) and document-urls (web links). Routes "what files does this reference?" to a citeable inventory.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const p of only.paths) sections.push(renderPath(p));
  } else {
    sections.push('### Aggregate paths across all files');
    for (const p of report.aggregate) sections.push(renderPath(p, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const pp of p.paths) sections.push(renderPath(pp));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...file paths block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFilePaths,
  buildFilePathsForFiles,
  renderFilePathsBlock,
  _internal: {
    POSIX_ABS_RE,
    HOME_REL_RE,
    PROJECT_REL_RE,
    WINDOWS_ABS_RE,
    VALID_EXTENSIONS,
    isLikelyFilePath,
    getExtension,
  },
};
