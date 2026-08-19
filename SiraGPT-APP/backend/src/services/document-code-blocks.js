'use strict';

/**
 * document-code-blocks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts fenced code blocks (\`\`\`language … \`\`\`) and indented code
 * blocks from attached documents. Each block carries its detected
 * language (when present) + a snippet preview so the chat can answer
 * "what does the code in section N do?" / "show me the example
 * snippet" with the source verbatim.
 *
 * Public API:
 *   extractCodeBlocks(text)              → CodeReport
 *   buildCodeBlocksForFiles(files)       → { perFile, aggregate }
 *   renderCodeBlocksBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 10;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4200;
const MAX_SNIPPET_LINES = 12;
const MAX_LINE_LEN = 140;

// Fenced code block: ``` optional language \n body \n ```
const FENCED_RE = /(?:^|\n)```\s*([A-Za-z0-9_+#-]*)\s*\n([\s\S]*?)\n```/g;

const KNOWN_LANGUAGES = new Set([
  'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'java', 'kotlin', 'swift',
  'go', 'rust', 'c', 'cpp', 'c++', 'csharp', 'cs', 'ruby', 'rb', 'php', 'perl',
  'r', 'scala', 'haskell', 'elixir', 'erlang', 'lua', 'sql', 'bash', 'shell', 'sh',
  'zsh', 'powershell', 'ps', 'dockerfile', 'yaml', 'yml', 'json', 'toml', 'xml',
  'html', 'css', 'scss', 'less', 'markdown', 'md', 'graphql', 'gql', 'mermaid',
  'plantuml', 'tex', 'latex', 'matlab', 'fortran', 'jsx', 'tsx', 'vue', 'svelte',
]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipLine(line) {
  const s = String(line || '');
  if (s.length <= MAX_LINE_LEN) return s;
  return `${s.slice(0, MAX_LINE_LEN - 1)}…`;
}

function snippet(body) {
  if (!body) return { lines: [], totalLines: 0 };
  const all = body.split('\n');
  const lines = all.slice(0, MAX_SNIPPET_LINES).map(clipLine);
  return { lines, totalLines: all.length };
}

function normaliseLanguage(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase();
  return KNOWN_LANGUAGES.has(lower) ? lower : (lower || null);
}

function extractCodeBlocks(input) {
  const text = safeText(input);
  if (!text) return { blocks: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const blocks = [];
  const seen = new Set();
  for (const m of head.matchAll(FENCED_RE)) {
    if (blocks.length >= MAX_PER_FILE) break;
    const lang = normaliseLanguage((m[1] || '').trim());
    const body = (m[2] || '').replace(/\s+$/, '');
    if (!body) continue;
    const key = `${lang || ''}|${body.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snip = snippet(body);
    blocks.push({
      language: lang,
      snippet: snip.lines,
      totalLines: snip.totalLines,
      chars: body.length,
    });
  }
  return { blocks, total: blocks.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCodeBlocksForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractCodeBlocks(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, blocks: r.blocks });
    aggregate = aggregate.concat(r.blocks.map((b) => ({ ...b, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderBlock(b, opts = {}) {
  const file = opts.includeFile && b.file ? ` _(${b.file})_` : '';
  const lang = b.language ? `\`${b.language}\`` : '_(no language)_';
  const lines = [`**${lang}**${file} — ${b.totalLines} line${b.totalLines === 1 ? '' : 's'}, ${b.chars} chars`];
  lines.push('```' + (b.language || ''));
  for (const line of b.snippet) lines.push(line);
  if (b.totalLines > b.snippet.length) lines.push(`// ... (${b.totalLines - b.snippet.length} more line${b.totalLines - b.snippet.length === 1 ? '' : 's'} not shown)`);
  lines.push('```');
  return lines.join('\n');
}

function renderCodeBlocksBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## EMBEDDED CODE BLOCKS
Fenced code blocks found in the attached document(s) with their language tag (when present) and a 12-line preview. Routes "show me the example" / "what does the code in section N do?" to a citeable snippet.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const b of only.blocks) sections.push(renderBlock(b));
  } else {
    sections.push('### Aggregate code blocks across all files');
    for (const b of report.aggregate) sections.push(renderBlock(b, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const b of p.blocks) sections.push(renderBlock(b));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...code blocks block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCodeBlocks,
  buildCodeBlocksForFiles,
  renderCodeBlocksBlock,
  _internal: {
    snippet,
    normaliseLanguage,
    FENCED_RE,
    KNOWN_LANGUAGES,
  },
};
