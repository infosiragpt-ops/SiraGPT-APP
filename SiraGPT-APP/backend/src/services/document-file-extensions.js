'use strict';

/**
 * document-file-extensions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregates the distribution of file extensions referenced in the
 * document(s). Surfaces top-N most common extensions and groups by
 * category (code, doc, data, image, archive, media, config).
 *
 * Different from document-file-paths (full paths with kind classification)
 * and document-media (audio/video specifically). Routes "what file types?"
 * to a citeable summary.
 *
 * Public API:
 *   extractFileExtensions(text)         → ExtReport
 *   buildFileExtensionsForFiles(files)  → { perFile, aggregate, byCategory }
 *   renderFileExtensionsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 4500;

const CATEGORIES = {
  code: ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'cpp', 'c', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'r', 'jl', 'lua', 'pl', 'asm'],
  doc: ['md', 'rst', 'txt', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'tex', 'epub', 'pages'],
  data: ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'csv', 'tsv', 'parquet', 'avro'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'heic'],
  archive: ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz', 'iso'],
  media: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv'],
  web: ['html', 'htm', 'css', 'scss', 'sass', 'less'],
  config: ['dockerfile', 'gemfile', 'lock', 'editorconfig', 'gitignore', 'gitattributes'],
};

// Build a map from extension → category
const EXT_TO_CATEGORY = {};
for (const [cat, exts] of Object.entries(CATEGORIES)) {
  for (const e of exts) EXT_TO_CATEGORY[e] = cat;
}

const EXT_RE = /(?:^|[\s`'"<>(\[/,;:])[a-zA-Z0-9_\-]{1,40}\.([a-zA-Z][a-zA-Z0-9]{1,8})(?=[\s`'"<>):,;.!?\]]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function categoryFor(ext) {
  return EXT_TO_CATEGORY[ext.toLowerCase()] || 'other';
}

function extractFileExtensions(input) {
  const text = safeText(input);
  if (!text) return { extensions: [], total: 0, byCategory: {}, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const counts = new Map();

  for (const m of head.matchAll(EXT_RE)) {
    const ext = m[1].toLowerCase();
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }

  // Sort by count desc
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PER_FILE)
    .map(([ext, count]) => ({ ext, count, category: categoryFor(ext) }));

  // Aggregate byCategory
  const byCategory = {};
  for (const e of sorted) {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.count;
  }

  return {
    extensions: sorted,
    total: sorted.length,
    byCategory,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildFileExtensionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byCategory = {};
  for (const f of list) {
    const r = extractFileExtensions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, extensions: r.extensions, byCategory: r.byCategory });
    aggregate = aggregate.concat(r.extensions.map((e) => ({ ...e, file: name })));
    for (const c of Object.keys(r.byCategory)) byCategory[c] = (byCategory[c] || 0) + r.byCategory[c];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byCategory };
}

function renderExtension(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.category}] **.${e.ext}** × ${e.count}${file}`;
}

function renderFileExtensionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byCategory = report.byCategory || {};
  const breakdown = Object.keys(byCategory)
    .filter((k) => byCategory[k] > 0)
    .map((k) => `${k}=${byCategory[k]}`)
    .join('  ');
  const heading = `## FILE EXTENSIONS / TYPES
Distribution of file extensions referenced in the document(s), aggregated and classified by category — code (js/ts/py/go/rs/...), doc (md/pdf/docx/...), data (json/yaml/csv/...), image (png/jpg/svg/...), archive (zip/tar/gz/...), media (mp3/mp4/...), web (html/css/scss/...), config (dockerfile/gemfile/...). Different from file paths (full paths) and media (specific media types). Routes "what file types?" to a citeable summary.

**By category:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.extensions) sections.push(renderExtension(e));
  } else {
    sections.push('### Aggregate file extensions across all files');
    for (const e of report.aggregate) sections.push(renderExtension(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.extensions) sections.push(renderExtension(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...file extensions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFileExtensions,
  buildFileExtensionsForFiles,
  renderFileExtensionsBlock,
  _internal: {
    EXT_RE,
    CATEGORIES,
    EXT_TO_CATEGORY,
    categoryFor,
  },
};
