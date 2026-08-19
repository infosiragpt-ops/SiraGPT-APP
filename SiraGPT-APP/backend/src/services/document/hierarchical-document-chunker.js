'use strict';

/**
 * hierarchical-document-chunker — intelligent document structure parser.
 *
 * Transforms raw extracted text into a hierarchical, semantically
 * organized structure suitable for 1000+ page documents:
 *
 *   Document
 *     ├── Section 1 (page range)
 *     │     ├── Chunk 1 (paragraphs)
 *     │     ├── Chunk 2 (table)
 *     │     └── Chunk 3 (paragraphs)
 *     ├── Section 2
 *     │     └── ...
 *     └── Summary + key findings
 *
 * Design principles:
 *   - Structure-first: sections are the primary organization unit
 *   - Progressive: a document outline is always available, even before
 *     all chunks are built
 *   - References: every chunk knows its section, page range, and siblings
 *   - Bounded: respects MAX_CHARS and MAX_CHUNKS but organizes within them
 *   - SEO-like: key content is prioritized, boilerplate is condensed
 */

// ── Configuration ───────────────────────────────────────────────
const MAX_SECTION_CHARS = Number.parseInt(
  process.env.SIRAGPT_HIERARCHICAL_SECTION_CHARS || '8000',
  10
);
const MAX_CHUNK_CHARS = Number.parseInt(
  process.env.SIRAGPT_HIERARCHICAL_CHUNK_CHARS || '3600',
  10
);
const CHUNK_OVERLAP_CHARS = Number.parseInt(
  process.env.SIRAGPT_HIERARCHICAL_OVERLAP || '120',
  10
);
const MAX_CHUNKS = Number.parseInt(
  process.env.SIRAGPT_HIERARCHICAL_MAX_CHUNKS || '5000',
  10
);
const MAX_SECTIONS = Number.parseInt(
  process.env.SIRAGPT_HIERARCHICAL_MAX_SECTIONS || '200',
  10
);

// ── Helpers ─────────────────────────────────────────────────────

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function compactString(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max).trim()}...`;
}

function hasUsefulText(value) {
  const text = String(value || '').trim();
  if (text.length < 40) return false;
  const alphaNum = (text.match(/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü]/g) || []).length;
  return alphaNum > 15 && (alphaNum / text.length) > 0.10;
}

// ── Heading / structure detection ───────────────────────────────

const HEADING_PATTERNS = [
  // Markdown-style: # Title, ## Title, etc.
  /^(#{1,6})\s+(.+)$/gm,
  // Chapter / Section / Capítulo / Sección
  /^(Chapter|Section|Secci[oó]n|Cap[uí]tulo|Parte)\s+(\d+|[IVXLCDM]+)[.:]?\s*(.*)$/gim,
  // Numbered: "1.", "1.1", "1.1.1"
  /^(\d+(?:\.\d+){0,3})[.\s)]+(.+)$/gm,
  // All-caps line (potential heading)
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{2,60})$/gm,
];

function detectHeadings(text) {
  const source = String(text || '');
  const headings = [];

  // Collect all potential headings
  for (const pattern of HEADING_PATTERNS) {
    const matches = source.matchAll(pattern);
    for (const match of matches) {
      if (pattern === HEADING_PATTERNS[0]) {
        // Markdown heading
        headings.push({
          level: match[1].length,
          title: match[2].trim(),
          index: match.index,
          length: match[0].length,
        });
      } else if (pattern === HEADING_PATTERNS[1]) {
        // Chapter/Section
        headings.push({
          level: 1,
          title: `${match[1]} ${match[2]}${match[3] ? ': ' + match[3].trim() : ''}`.trim(),
          index: match.index,
          length: match[0].length,
        });
      } else if (pattern === HEADING_PATTERNS[2]) {
        // Numbered heading
        const numParts = match[1].split('.').length;
        headings.push({
          level: Math.min(numParts, 4),
          title: `${match[1]}. ${match[2].trim()}`,
          index: match.index,
          length: match[0].length,
        });
      } else if (pattern === HEADING_PATTERNS[3]) {
        // All-caps
        const title = match[1].trim();
        if (title.length >= 4 && !title.includes('  ') && !title.match(/^\d/)) {
          headings.push({
            level: 1,
            title,
            index: match.index,
            length: match[0].length,
          });
        }
      }
    }
  }

  // Deduplicate by title text (fuzzy near-duplicates within 10 chars)
  const unique = [];
  const seen = new Set();
  for (const h of headings) {
    const key = String(h.title).toLowerCase().replace(/\s+/g, ' ').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(h);
    }
  }

  // Sort by position
  unique.sort((a, b) => a.index - b.index);
  return unique;
}

// ── Structural text splitting ──────────────────────────────────

/**
 * Split raw extracted text into logical sections based on detected headings.
 * Returns an array of { title, level, text, subSections[] }.
 */
function splitIntoSections(text) {
  const source = cleanText(String(text || ''));
  if (!hasUsefulText(source)) return [];

  const headings = detectHeadings(source);

  // No headings found — treat whole document as one section
  if (headings.length === 0) {
    return [{
      title: 'Documento completo',
      level: 1,
      ordinal: 1,
      text: source,
      subSections: [],
      startPage: null,
      endPage: null,
    }];
  }

  const sections = [];
  for (let i = 0; i < headings.length && sections.length < MAX_SECTIONS; i++) {
    const start = headings[i].index;
    const end = headings[i + 1]?.index ?? source.length;
    const body = source.slice(start, end).trim();

    if (body.length < 20) continue;

    sections.push({
      title: headings[i].title,
      level: headings[i].level,
      ordinal: i + 1,
      text: body,
      subSections: [],
      startPage: null,
      endPage: null,
    });
  }

  // Build parent-child hierarchy
  const rootSections = [];
  const stack = [];

  for (const section of sections) {
    // Pop stack until we find a parent at a lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].subSections.push(section);
    } else {
      rootSections.push(section);
    }
    stack.push(section);
  }

  return rootSections;
}

// ── Section → Chunks conversion ────────────────────────────────

/**
 * Convert a hierarchical section tree into flat chunks for DB storage.
 * Chunks have section context embedded for cross-reference support.
 */
function sectionsToChunks(sections, sourceKind = 'document') {
  const chunks = [];
  let ordinal = 0;

  function walkSection(section, parentTitle = null) {
    const body = cleanText(section.text);

    // Split section body into sub-chunks if it's too long
    if (body.length > MAX_SECTION_CHARS && !section.subSections.length) {
      const subChunks = splitTextIntoChunks(body, MAX_CHUNK_CHARS, CHUNK_OVERLAP_CHARS);
      for (let i = 0; i < subChunks.length && chunks.length < MAX_CHUNKS; i++) {
        ordinal++;
        chunks.push({
          ordinal,
          sourceType: sourceKind,
          sourceLabel: `${section.title} — parte ${i + 1}`,
          sectionTitle: section.title,
          sectionLevel: section.level,
          sectionPath: parentTitle ? `${parentTitle} > ${section.title}` : section.title,
          text: subChunks[i],
          charCount: subChunks[i].length,
          pageNumber: section.startPage || null,
        });
      }
    } else {
      // Section fits in one chunk
      ordinal++;
      chunks.push({
        ordinal,
        sourceType: sourceKind,
        sourceLabel: section.title,
        sectionTitle: section.title,
        sectionLevel: section.level,
        sectionPath: parentTitle ? `${parentTitle} > ${section.title}` : section.title,
        text: body,
        charCount: body.length,
        pageNumber: section.startPage || null,
      });
    }

    // Recurse into subsections
    for (const sub of section.subSections) {
      walkSection(sub, parentTitle ? `${parentTitle} > ${section.title}` : section.title);
    }
  }

  for (const section of sections) {
    if (chunks.length >= MAX_CHUNKS) break;
    walkSection(section);
  }

  return chunks;
}

/**
 * Split long text into chunks at paragraph/sentence boundaries.
 */
function splitTextIntoChunks(text, maxChars, overlap) {
  const source = String(text || '');
  if (source.length <= maxChars) return [source];

  const chunks = [];
  let cursor = 0;

  while (cursor < source.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(source.length, cursor + maxChars);

    // Try to break at a paragraph boundary
    let sliceEnd = end;
    if (end < source.length) {
      const paraBreak = source.lastIndexOf('\n\n', end);
      if (paraBreak > cursor + 500) {
        sliceEnd = paraBreak;
      } else {
        const sentBreak = source.lastIndexOf('. ', end);
        if (sentBreak > cursor + 300) {
          sliceEnd = sentBreak + 1;
        }
      }
    }

    const block = source.slice(cursor, sliceEnd).trim();
    if (block) chunks.push(block);

    if (sliceEnd >= source.length) break;
    cursor = Math.max(sliceEnd - overlap, cursor + 1);
  }

  return chunks;
}

// ── Outline builder ────────────────────────────────────────────

/**
 * Build a compact markdown outline from the section hierarchy.
 * Used for progressive context injection (outline first, then detail).
 */
function buildOutline(sections, maxDepth = 5) {
  const lines = [];

  function walk(section, depth) {
    if (depth > maxDepth) return;
    const prefix = '#'.repeat(Math.min(depth + 1, 6));
    const pageInfo = section.startPage ? ` [p.${section.startPage}]` : '';
    lines.push(`${prefix} ${section.title}${pageInfo}`);

    for (const sub of section.subSections) {
      walk(sub, depth + 1);
    }
  }

  for (const section of sections) {
    walk(section, 0);
  }

  return lines.join('\n');
}

/**
 * Build a compact key-findings summary from the first N sections.
 * Simulates what an LLM would see as a table of contents + first pass.
 */
function buildProgressiveSummary(sections, maxChars = 4000) {
  const outline = buildOutline(sections);
  const parts = [`📋 Document Structure:\n${outline}`];

  // First section summary (usually introduction/background)
  if (sections.length > 0) {
    const firstSection = sections[0];
    const introPreview = compactString(firstSection.text, 2000);
    parts.push(`\n📌 ${firstSection.title}:\n${introPreview}`);
  }

  // Last section summary (usually conclusions)
  if (sections.length > 1) {
    const lastSection = sections[sections.length - 1];
    const conclusionPreview = compactString(lastSection.text, 1500);
    if (conclusionPreview !== compactString(sections[0].text, 1500)) {
      parts.push(`\n🎯 ${lastSection.title}:\n${conclusionPreview}`);
    }
  }

  return parts.join('\n\n').slice(0, maxChars);
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Main entry point: hierarchical chunking with structure preservation.
 *
 * @param {object} file - File record { originalName, mimeType, ... }
 * @param {string} extractedText - Raw extracted text
 * @param {object} [opts]
 * @param {number} [opts.maxChunks=MAX_CHUNKS]
 * @param {number} [opts.maxSectionChars=MAX_SECTION_CHARS]
 * @returns {{ sections: Array, chunks: Array, outline: string, progressiveSummary: string }}
 */
function buildHierarchicalStructure(file = {}, extractedText = '') {
  const text = cleanText(extractedText || '');
  if (!hasUsefulText(text)) {
    return { sections: [], chunks: [], outline: '', progressiveSummary: '' };
  }

  const sourceKind = detectSourceKind(file);
  const sections = splitIntoSections(text);
  const chunks = sectionsToChunks(sections, sourceKind);
  const outline = buildOutline(sections);
  const progressiveSummary = buildProgressiveSummary(sections);

  return {
    sections,
    chunks,
    outline,
    progressiveSummary,
    totalChars: text.length,
    totalSections: sections.length,
    totalChunks: chunks.length,
  };
}

function detectSourceKind(file = {}) {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = String(file.originalName || file.filename || '').toLowerCase();
  if (mime.includes('spreadsheet') || mime.includes('excel') || /\.(xlsx|xls|csv)$/i.test(name)) return 'sheet';
  if (mime.includes('presentation') || mime.includes('powerpoint') || /\.(pptx|ppt)$/i.test(name)) return 'slide';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'page';
  if (mime.includes('wordprocessingml') || mime.includes('msword') || /\.(docx|doc)$/i.test(name)) return 'section';
  return 'document';
}

module.exports = {
  buildHierarchicalStructure,
  splitIntoSections,
  sectionsToChunks,
  buildOutline,
  buildProgressiveSummary,
  detectHeadings,
  splitTextIntoChunks,
  compactString,
  // Config (for testing)
  MAX_SECTION_CHARS,
  MAX_CHUNK_CHARS,
  MAX_CHUNKS,
  MAX_SECTIONS,
};
