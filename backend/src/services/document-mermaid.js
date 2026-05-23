'use strict';

/**
 * document-mermaid.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Mermaid diagram fenced blocks (\`\`\`mermaid … \`\`\`) and
 * classifies each by diagram type — flowchart, sequence, class,
 * state, ER, gantt, pie, journey, timeline, gitGraph, mindmap,
 * quadrant, sankey, requirement, c4. Routes "what does the diagram
 * show?" / "is there a flowchart?" to a structured preview.
 *
 * Different from document-code-blocks (generic fenced blocks): this
 * specifically parses the FIRST line of mermaid bodies to surface
 * the diagram type + first-node hints.
 *
 * Public API:
 *   extractMermaid(text)             → MermaidReport
 *   buildMermaidForFiles(files)      → { perFile, aggregate }
 *   renderMermaidBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 8;
const MAX_AGGREGATE = 14;
const MAX_BLOCK_CHARS = 4000;
const MAX_PREVIEW_LINES = 8;
const MAX_LINE_LEN = 140;

const MERMAID_FENCE_RE = /(?:^|\n)```\s*mermaid\s*\n([\s\S]*?)\n```/gi;
const TYPE_PATTERNS = [
  { type: 'flowchart',  re: /^\s*(?:flowchart|graph)\s+(?:TD|TB|BT|RL|LR)\b/i },
  { type: 'sequence',   re: /^\s*sequenceDiagram\b/i },
  { type: 'class',      re: /^\s*classDiagram\b/i },
  { type: 'state',      re: /^\s*stateDiagram(?:-v2)?\b/i },
  { type: 'er',         re: /^\s*erDiagram\b/i },
  { type: 'gantt',      re: /^\s*gantt\b/i },
  { type: 'pie',        re: /^\s*pie\b/i },
  { type: 'journey',    re: /^\s*journey\b/i },
  { type: 'timeline',   re: /^\s*timeline\b/i },
  { type: 'gitGraph',   re: /^\s*gitGraph\b/i },
  { type: 'mindmap',    re: /^\s*mindmap\b/i },
  { type: 'quadrant',   re: /^\s*quadrantChart\b/i },
  { type: 'sankey',     re: /^\s*sankey-?beta\b/i },
  { type: 'requirement',re: /^\s*requirementDiagram\b/i },
  { type: 'c4',         re: /^\s*C4(?:Context|Container|Component|Deployment|Dynamic)?\b/i },
];

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

function detectType(body) {
  if (!body) return null;
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(firstLine)) return type;
  }
  return null;
}

function extractMermaid(input) {
  const text = safeText(input);
  if (!text) return { diagrams: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const diagrams = [];
  const seen = new Set();
  for (const m of head.matchAll(MERMAID_FENCE_RE)) {
    if (diagrams.length >= MAX_PER_FILE) break;
    const body = (m[1] || '').trim();
    if (!body) continue;
    const type = detectType(body) || 'unknown';
    const allLines = body.split('\n');
    const previewLines = allLines.slice(0, MAX_PREVIEW_LINES).map(clipLine);
    const key = `${type}|${body.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagrams.push({
      type,
      preview: previewLines,
      totalLines: allLines.length,
      chars: body.length,
    });
  }
  return { diagrams, total: diagrams.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildMermaidForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractMermaid(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, diagrams: r.diagrams });
    aggregate = aggregate.concat(r.diagrams.map((d) => ({ ...d, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderDiagram(d, opts = {}) {
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  const lines = [`**${d.type}**${file} — ${d.totalLines} line${d.totalLines === 1 ? '' : 's'}, ${d.chars} chars`];
  lines.push('```mermaid');
  for (const line of d.preview) lines.push(line);
  if (d.totalLines > d.preview.length) lines.push(`%% ... (${d.totalLines - d.preview.length} more line${d.totalLines - d.preview.length === 1 ? '' : 's'} not shown)`);
  lines.push('```');
  return lines.join('\n');
}

function renderMermaidBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## MERMAID DIAGRAMS
Mermaid fenced blocks surfaced from the attached document(s), classified by diagram type (flowchart / sequence / class / state / er / gantt / pie / journey / timeline / gitGraph / mindmap / quadrant / sankey / requirement / c4 / unknown) with the first 8 lines as a preview. Routes "what does the diagram show?" / "is there a flowchart?" to a structured citeable preview.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.diagrams) sections.push(renderDiagram(d));
  } else {
    sections.push('### Aggregate diagrams across all files');
    for (const d of report.aggregate) sections.push(renderDiagram(d, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.diagrams) sections.push(renderDiagram(d));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...mermaid block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMermaid,
  buildMermaidForFiles,
  renderMermaidBlock,
  _internal: {
    detectType,
    TYPE_PATTERNS,
    MERMAID_FENCE_RE,
  },
};
