'use strict';

/**
 * document-evidence-map.js
 * Deterministic evidence extraction for document chat prompts.
 *
 * This does not summarize and does not call an LLM. It scans extracted text
 * for page/sheet/slide anchors plus high-signal sentences so the chat model
 * receives a compact map of citeable evidence before it sees the raw file
 * body. The goal is professional document analysis: quote less, cite more,
 * and state uncertainty when the source text does not support a claim.
 */

const DEFAULT_MAX_FILES = Number.parseInt(process.env.SIRAGPT_EVIDENCE_MAX_FILES || '8', 10);
const DEFAULT_MAX_SNIPPETS_PER_FILE = Number.parseInt(process.env.SIRAGPT_EVIDENCE_SNIPPETS_PER_FILE || '10', 10);
const DEFAULT_MAX_BLOCK_CHARS = Number.parseInt(process.env.SIRAGPT_EVIDENCE_BLOCK_CHARS || '5200', 10);
const MAX_SNIPPET_CHARS = 260;

const DATE_RE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:19|20)\d{2})\b/;
const MONEY_RE = /(?:[$€£]|Bs\.?|MX\$|USD|EUR)\s?\d[\d.,]*/i;
const PERCENT_RE = /\b\d+(?:[.,]\d+)?\s?%\b/;
const NUMBER_RE = /\b\d{2,}(?:[.,]\d+)?\b/;
const CITATION_RE = /\([A-ZÁÉÍÓÚÑ][^)]*,\s*(?:19|20)\d{2}\)|\bdoi\s*:/i;
const ACTION_RE = /\b(debe|deber[áa]n?|hay que|se requiere|accion|tarea|pendiente|deadline|plazo|must|should|required|action item|todo)\b/i;
const RISK_RE = /\b(riesgo|amenaza|incumplimiento|brecha|falla|error|cr[ií]tico|risk|threat|breach|failure|critical|blocker)\b/i;
const DECISION_RE = /\b(aprob[oó]|decidi[oó]|acord[oó]|rechaz[oó]|approved|decided|agreed|rejected)\b/i;
const CLAIM_RE = /\b(concluye|demuestra|evidencia|indica|sugiere|shows|indicates|suggests|concludes|evidence)\b/i;

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function compact(value, max = MAX_SNIPPET_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 3);
  const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('; '), slice.lastIndexOf(', '), slice.lastIndexOf(' '));
  return `${slice.slice(0, cut > 120 ? cut : slice.length).trim()}...`;
}

function fileName(file) {
  return String(file?.name || file?.originalName || file?.filename || file?.id || 'document').trim();
}

function detectAnchor(line, current) {
  const text = String(line || '').trim();
  let m = text.match(/^\[\s*page\s+(\d+)\s*\]$/i)
    || text.match(/^(?:Page|Pagina|P[aá]gina)\s+(\d+)\b/i);
  if (m) return { type: 'page', label: `page ${m[1]}`, value: m[1] };

  m = text.match(/^Sheet:\s*(.+)$/i)
    || text.match(/^(?:Hoja|Worksheet)\s*:?\s*(.+)$/i);
  if (m) return { type: 'sheet', label: `sheet ${compact(m[1], 80)}`, value: m[1].trim() };

  m = text.match(/^(?:Slide|Diapositiva)\s+(\d+)\b/i)
    || text.match(/^\[\s*slide\s+(\d+)\s*\]$/i);
  if (m) return { type: 'slide', label: `slide ${m[1]}`, value: m[1] };

  return current;
}

function sourceFromFile(file) {
  const mime = String(file?.mimeType || file?.type || '').toLowerCase();
  const name = fileName(file).toLowerCase();
  if (mime.includes('spreadsheet') || /\.(xlsx|xls|csv|tsv)$/i.test(name)) return { type: 'sheet', label: 'sheet unknown', value: null };
  if (mime.includes('presentation') || /\.(pptx|ppt)$/i.test(name)) return { type: 'slide', label: 'slide unknown', value: null };
  if (mime.includes('pdf') || name.endsWith('.pdf')) return { type: 'page', label: 'page unknown', value: null };
  return { type: 'document', label: 'document body', value: null };
}

function scoreSnippet(text, anchor) {
  let score = 0;
  const signals = [];
  const checks = [
    ['money', MONEY_RE, 5],
    ['percent', PERCENT_RE, 4],
    ['date', DATE_RE, 3],
    ['citation', CITATION_RE, 5],
    ['action', ACTION_RE, 4],
    ['risk', RISK_RE, 4],
    ['decision', DECISION_RE, 4],
    ['claim', CLAIM_RE, 3],
    ['number', NUMBER_RE, 2],
  ];
  for (const [name, re, weight] of checks) {
    if (re.test(text)) {
      score += weight;
      signals.push(name);
    }
  }
  if (anchor && anchor.type !== 'document') {
    score += 2;
    signals.push(anchor.type);
  }
  const words = (String(text).match(/\S+/g) || []).length;
  if (words >= 12 && words <= 55) score += 1;
  if (words > 80) score -= 2;
  return { score, signals };
}

function splitCandidateSentences(line) {
  const text = String(line || '').trim();
  if (!text) return [];
  if (text.length <= 360) return [text];
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ0-9])/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 30);
}

function extractEvidenceForFile(file, opts = {}) {
  const text = cleanText(file?.extractedText || file?.text || file?.content || '');
  if (!text) {
    return {
      fileId: file?.id || null,
      fileName: fileName(file),
      sourceType: sourceFromFile(file).type,
      snippets: [],
      textChars: 0,
    };
  }

  const maxSnippets = Math.max(1, opts.maxSnippetsPerFile || DEFAULT_MAX_SNIPPETS_PER_FILE);
  let anchor = sourceFromFile(file);
  const candidates = [];
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const trimmed = String(rawLine || '').trim();
    if (!trimmed) continue;
    const nextAnchor = detectAnchor(trimmed, anchor);
    if (nextAnchor !== anchor || /^\[\s*(page|slide)\s+\d+\s*\]$/i.test(trimmed) || /^Sheet:/i.test(trimmed)) {
      anchor = nextAnchor;
      if (/^\[\s*(page|slide)\s+\d+\s*\]$/i.test(trimmed) || /^Sheet:/i.test(trimmed)) continue;
    }

    for (const sentence of splitCandidateSentences(trimmed)) {
      if (sentence.length < 30) continue;
      const { score, signals } = scoreSnippet(sentence, anchor);
      if (score < 3) continue;
      candidates.push({
        anchor: { ...anchor },
        text: compact(sentence),
        score,
        signals,
      });
    }
  }

  const seen = new Set();
  const snippets = candidates
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const key = `${item.anchor.label}::${item.text.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxSnippets)
    .map((item, index) => ({ id: `E${index + 1}`, ...item }));

  return {
    fileId: file?.id || null,
    fileName: fileName(file),
    sourceType: sourceFromFile(file).type,
    snippets,
    textChars: text.length,
  };
}

function buildEvidenceMapForFiles(files, opts = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean).slice(0, opts.maxFiles || DEFAULT_MAX_FILES) : [];
  const perFile = list
    .map((file) => extractEvidenceForFile(file, opts))
    .filter((entry) => entry.textChars > 0);

  const totals = {
    files: perFile.length,
    snippets: perFile.reduce((sum, entry) => sum + entry.snippets.length, 0),
    anchors: perFile.reduce((sum, entry) => sum + new Set(entry.snippets.map((s) => s.anchor.label)).size, 0),
  };

  return { perFile, totals };
}

function renderEvidenceMapBlock(report, opts = {}) {
  const perFile = Array.isArray(report?.perFile) ? report.perFile : [];
  const withEvidence = perFile.filter((entry) => entry.snippets.length > 0);
  if (withEvidence.length === 0) return '';

  const maxChars = Math.max(1200, opts.maxChars || DEFAULT_MAX_BLOCK_CHARS);
  const lines = [
    '## DOCUMENT EVIDENCE MAP',
    'Use these citeable anchors when answering about attached documents. For every non-obvious factual claim, cite the filename and anchor (page, sheet, slide, or document body). If the evidence map is thin, say what is not supported instead of filling gaps from memory.',
  ];

  for (const entry of withEvidence) {
    lines.push('', `### ${entry.fileName}`);
    for (const snippet of entry.snippets) {
      const signals = snippet.signals.length ? ` [${snippet.signals.slice(0, 4).join(', ')}]` : '';
      lines.push(`- [${snippet.id}] ${snippet.anchor.label}: ${snippet.text}${signals}`);
    }
  }

  let block = lines.join('\n');
  if (block.length > maxChars) {
    block = `${block.slice(0, maxChars - 86).trim()}\n\n[...evidence map truncated to stay within token budget]`;
  }
  return block;
}

module.exports = {
  buildEvidenceMapForFiles,
  extractEvidenceForFile,
  renderEvidenceMapBlock,
  _internal: {
    detectAnchor,
    scoreSnippet,
    splitCandidateSentences,
  },
};
