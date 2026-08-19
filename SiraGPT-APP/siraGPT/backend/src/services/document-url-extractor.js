'use strict';

/**
 * document-url-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls URLs out of attached documents with a best-effort anchor /
 * context snippet for each. Routes "what URLs does this reference?"
 * / "where can I find more info?" to a citeable list instead of
 * inference.
 *
 * Deterministic. Bilingual is irrelevant for URLs but anchor text
 * preserved verbatim. < 10 ms on 1 MB.
 *
 * Public API:
 *   extractURLs(text)               → URLReport
 *   buildURLsForFiles(files)        → { perFile, aggregate }
 *   renderURLsBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_URLS_PER_FILE = 18;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 4000;
const MAX_URL_LEN = 280;
const MAX_CONTEXT_LEN = 100;

// Permissive URL pattern: http(s) protocol, optional userinfo / port,
// path / query / fragment.
const URL_RE = /\bhttps?:\/\/[\w.-]+(?::\d{1,5})?(?:\/[^\s<>"'`{}\\)\]]*)?/g;
const MARKDOWN_LINK_RE = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function trimTrailingPunct(url) {
  return String(url || '').replace(/[.,;:!?)\]"']+$/, '');
}

function contextSnippet(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 30);
  return clip(text.slice(start, end).replace(/\s+/g, ' ').trim(), MAX_CONTEXT_LEN);
}

function extractURLs(input) {
  const text = safeText(input);
  if (!text) return { urls: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const urls = [];

  // Markdown-style links first — they carry explicit anchor text.
  for (const m of head.matchAll(MARKDOWN_LINK_RE)) {
    if (urls.length >= MAX_URLS_PER_FILE) break;
    const anchor = (m[1] || '').trim();
    const url = trimTrailingPunct((m[2] || '').trim());
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push({ url: clip(url, MAX_URL_LEN), anchor: clip(anchor, MAX_CONTEXT_LEN), kind: 'markdown' });
  }

  // Plain URLs.
  for (const m of head.matchAll(URL_RE)) {
    if (urls.length >= MAX_URLS_PER_FILE) break;
    const url = trimTrailingPunct(m[0]);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push({ url: clip(url, MAX_URL_LEN), anchor: contextSnippet(head, m.index || 0, m[0].length), kind: 'plain' });
  }

  return { urls, total: urls.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildURLsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractURLs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, urls: r.urls });
    aggregate = aggregate.concat(r.urls.map((u) => ({ ...u, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(u, opts = {}) {
  const file = opts.includeFile && u.file ? ` _(${u.file})_` : '';
  const anchor = u.anchor ? ` — _${u.anchor}_` : '';
  return `- [${u.kind}]${file} \`${u.url}\`${anchor}`;
}

function renderURLsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## URLs & LINKS
HTTP(S) URLs and markdown-style links surfaced from the attached document(s). Each entry carries its anchor text (markdown) or surrounding-context snippet (plain). Use this block to answer "what URLs does the document reference?" / "where can I find more info?" — quote the URL verbatim.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const u of only.urls) sections.push(renderLine(u));
  } else {
    sections.push('### Aggregate URLs across all files');
    for (const u of report.aggregate) sections.push(renderLine(u, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const u of p.urls) sections.push(renderLine(u));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...URLs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractURLs,
  buildURLsForFiles,
  renderURLsBlock,
  _internal: {
    trimTrailingPunct,
    contextSnippet,
    URL_RE,
    MARKDOWN_LINK_RE,
  },
};
