'use strict';

/**
 * Reuse already-extracted DOCX/PDF text from fileProcessor (mammoth / pdf
 * streaming). Prefer full text + heading structure. Tag editorial lines
 * so they never enter summary evidence by default.
 */

const { tagLines, stripEditorial, collectEditorialSnippets } = require('./editorial');

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const NUMBERED_HEADING_RE = /^(\d{1,2}(?:\.\d{1,2}){0,3}\.?)\s+([A-ZÁÉÍÓÚÑ][^\n]{1,120})$/;

function fileNameOf(file) {
  return file?.originalName || file?.name || file?.filename || file?.title || 'document';
}

function rawTextOf(file) {
  if (!file) return '';
  if (typeof file.extractedText === 'string' && file.extractedText.trim()) return file.extractedText;
  if (typeof file.content === 'string' && file.content.trim()) return file.content;
  return '';
}

function stripExtractorHeader(text) {
  return String(text || '').replace(
    /^(?:Word document|PDF document|Excel spreadsheet|PowerPoint)[^\n]*\n---\n/i,
    '',
  );
}

function splitSections(text) {
  const source = stripExtractorHeader(text);
  const lines = String(source || '').split(/\r?\n/);
  const sections = [];
  let current = { heading: '', level: 0, lines: [] };

  const flush = () => {
    const body = current.lines.join('\n').trim();
    if (current.heading || body) {
      sections.push({
        heading: current.heading || (sections.length === 0 ? 'Documento' : `Sección ${sections.length + 1}`),
        level: current.level,
        text: body,
      });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const md = trimmed.match(HEADING_RE);
    const numbered = !md ? trimmed.match(NUMBERED_HEADING_RE) : null;
    if (md || numbered) {
      flush();
      current = {
        heading: md ? md[2].trim() : numbered[2].trim(),
        level: md ? md[1].length : 2,
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  flush();

  if (sections.length === 0 && source.trim()) {
    sections.push({ heading: 'Documento', level: 1, text: source.trim() });
  }
  return sections;
}

function buildDocumentBundle(file, { excludeEditorial = true } = {}) {
  const raw = stripExtractorHeader(rawTextOf(file));
  const tagged = tagLines(raw);
  const editorial = collectEditorialSnippets(raw);
  const evidenceText = excludeEditorial ? stripEditorial(raw, { keepHeadings: true }) : raw;
  const sections = splitSections(evidenceText).map((section) => {
    const sectionEditorial = collectEditorialSnippets(section.text);
    return {
      ...section,
      text: excludeEditorial ? stripEditorial(section.text, { keepHeadings: false }) : section.text,
      editorial: sectionEditorial,
    };
  }).filter((section) => section.text.trim().length > 0 || section.heading);

  return {
    name: fileNameOf(file),
    mimeType: file?.mimeType || file?.type || '',
    raw,
    evidenceText,
    tagged,
    editorial,
    sections,
    chars: evidenceText.length,
    untrusted: true,
  };
}

function extractDocuments(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  return list
    .filter((file) => file && !/image\//i.test(file.mimeType || file.type || ''))
    .map((file) => buildDocumentBundle(file, opts))
    .filter((doc) => doc.raw.trim().length >= 40);
}

module.exports = {
  fileNameOf,
  rawTextOf,
  stripExtractorHeader,
  splitSections,
  buildDocumentBundle,
  extractDocuments,
};
