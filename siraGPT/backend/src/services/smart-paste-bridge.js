'use strict';

const crypto = require('crypto');

const FORMAT_EXTENSIONS = {
  json: '.json',
  csv: '.csv',
  xml: '.xml',
  html: '.htm',
  yaml: '.yml',
  markdown: '.md',
  sql: '.sql',
  python: '.py',
  javascript: '.js',
  typescript: '.ts',
  log: '.log',
  shell: '.sh',
  plain: '.txt',
};

const FORMAT_MIMES = {
  json: 'application/json',
  csv: 'text/csv',
  xml: 'application/xml',
  html: 'text/html',
  yaml: 'text/yaml',
  markdown: 'text/markdown',
  sql: 'application/sql',
  python: 'text/x-python',
  javascript: 'text/javascript',
  typescript: 'text/typescript',
  log: 'text/plain',
  shell: 'text/x-shellscript',
  plain: 'text/plain',
};

const MIN_PASTE_LENGTH = 80;
const STRUCTURED_THRESHOLD = 200;

function shouldAutoFile(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  return trimmed.length >= MIN_PASTE_LENGTH;
}

function isStructuredContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (trimmed.length < STRUCTURED_THRESHOLD) return false;
  try { JSON.parse(trimmed); return true; } catch {}
  if (/^[^,]+,/.test(trimmed.split('\n')[0]) && trimmed.split('\n').length >= 3) return true;
  if (/<[^>]+>/.test(trimmed.slice(0, 500))) return true;
  if (/^#{1,6}\s/m.test(trimmed)) return true;
  if (/^\s*(import |from |def |class |const |let |function |export |require\()/m.test(trimmed)) return true;
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/im.test(trimmed.slice(0, 300))) return true;
  if (/^\w+:\s*\S/m.test(trimmed) && trimmed.split('\n').filter(l => /^\w+:\s/.test(l)).length >= 3) return true;
  return false;
}

function detectContentType(content) {
  if (!content || typeof content !== 'string') return { format: 'plain', confidence: 0 };
  const head = content.slice(0, 2000);
  try { const p = JSON.parse(head); return { format: 'json', confidence: 1, parsed: typeof p }; } catch {}
  if (/^#!\/bin\/(bash|sh|zsh)/m.test(head)) return { format: 'shell', confidence: 0.9 };
  if (/^\s*SELECT\s/im.test(head.slice(0, 200))) return { format: 'sql', confidence: 0.85 };
  if (/^#{1,6}\s/m.test(head)) return { format: 'markdown', confidence: 0.8 };
  if (/<\?xml/.test(head.slice(0, 100))) return { format: 'xml', confidence: 0.9 };
  if (/<html|<body|<div/i.test(head.slice(0, 300))) return { format: 'html', confidence: 0.8 };
  if (/^---\s*\n/m.test(head)) return { format: 'yaml', confidence: 0.7 };
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length >= 2) {
    const c1 = lines[0].split(',').length;
    const c2 = lines[1].split(',').length;
    if (c1 >= 2 && c1 === c2 && c1 > lines[0].split('\t').length) return { format: 'csv', confidence: 0.8 };
    const t1 = lines[0].split('\t').length;
    const t2 = lines[1].split('\t').length;
    if (t1 >= 2 && t1 === t2) return { format: 'tsv', confidence: 0.8 };
  }
  if (/^\s*(import |from |def |class )/m.test(head)) return { format: 'python', confidence: 0.7 };
  if (/^\s*(const |let |var |function |import |export |require\()/m.test(head)) return { format: 'javascript', confidence: 0.7 };
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/m.test(head)) return { format: 'log', confidence: 0.6 };
  return { format: 'plain', confidence: 0.3 };
}

function generateFileName(content, format) {
  const hash = crypto.createHash('sha256').update(content.slice(0, 1024)).digest('hex').slice(0, 8);
  const ext = FORMAT_EXTENSIONS[format] || '.txt';
  const dateStr = new Date().toISOString().slice(0, 10);
  return `pasted_${dateStr}_${hash}${ext}`;
}

function computeStatistics(content) {
  if (!content || typeof content !== 'string') return {};
  const lines = content.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  const words = content.split(/\s+/).filter(Boolean);
  return {
    charCount: content.length,
    lineCount: lines.length,
    nonEmptyLineCount: nonEmpty.length,
    wordCount: words.length,
    avgLineLength: nonEmpty.length > 0 ? Math.round(nonEmpty.reduce((a, l) => a + l.length, 0) / nonEmpty.length) : 0,
  };
}

async function ingestPastedContent(userId, content, opts = {}) {
  if (!content || typeof content !== 'string') {
    return { autoFiled: false, reason: 'empty_content' };
  }
  if (content.trim().length < MIN_PASTE_LENGTH) {
    return { autoFiled: false, reason: 'below_threshold', threshold: MIN_PASTE_LENGTH };
  }
  const typeInfo = detectContentType(content);
  const format = typeInfo.format;
  const fileName = opts.fileName || generateFileName(content, format);
  const mime = FORMAT_MIMES[format] || 'text/plain';
  const stats = computeStatistics(content);
  const structured = isStructuredContent(content);
  return {
    autoFiled: true,
    fileName,
    format,
    mime,
    charCount: stats.charCount,
    lineCount: stats.lineCount,
    wordCount: stats.wordCount,
    nonEmptyLineCount: stats.nonEmptyLineCount,
    avgLineLength: stats.avgLineLength,
    isStructured: structured,
    formatConfidence: typeInfo.confidence,
    userId,
    ingestedAt: new Date().toISOString(),
  };
}

module.exports = {
  shouldAutoFile,
  isStructuredContent,
  detectContentType,
  generateFileName,
  computeStatistics,
  ingestPastedContent,
  MIN_PASTE_LENGTH,
  STRUCTURED_THRESHOLD,
  FORMAT_EXTENSIONS,
  FORMAT_MIMES,
};
