'use strict';

// docx-table-insert.js — insert a real, editable Word table (not an image) from
// structured data, preserving the rest of the document. Complements the chart
// embedding in document-visual-embed.js (charts → images; this → native tables).

const PizZip = require('pizzip');

const TOTAL_TABLE_WIDTH_DXA = 9360; // ~6.5in usable width

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function tableCellXml(text, { header = false, width } = {}) {
  const shd = header ? '<w:shd w:val="clear" w:color="auto" w:fill="E7EEF7"/>' : '';
  const rPr = header ? '<w:rPr><w:b/><w:sz w:val="22"/></w:rPr>' : '<w:rPr><w:sz w:val="22"/></w:rPr>';
  const jc = header ? '<w:jc w:val="center"/>' : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shd}<w:vAlign w:val="center"/></w:tcPr>`
    + `<w:p><w:pPr><w:spacing w:after="20" w:before="20"/>${jc}</w:pPr>`
    + `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`;
}

function tableRowXml(cells, widths, { header = false } = {}) {
  const tr = cells.map((cell, i) => tableCellXml(cell, { header, width: widths[i] || widths[0] })).join('');
  const trPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
  return `<w:tr>${trPr}${tr}</w:tr>`;
}

// Build a bordered <w:tbl> with a shaded/bold header row and N data rows.
function buildTableXml(headers = [], rows = []) {
  const colCount = Math.max(
    Array.isArray(headers) ? headers.length : 0,
    ...rows.map((r) => (Array.isArray(r) ? r.length : 0)),
    1,
  );
  const colWidth = Math.floor(TOTAL_TABLE_WIDTH_DXA / colCount);
  const widths = Array.from({ length: colCount }, () => colWidth);
  const pad = (arr) => Array.from({ length: colCount }, (_, i) => (arr && arr[i] != null ? arr[i] : ''));

  const border = (tag) => `<w:${tag} w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>`;
  const tblPr = '<w:tblPr><w:tblW w:w="0" w:type="auto"/>'
    + `<w:tblBorders>${border('top')}${border('left')}${border('bottom')}${border('right')}${border('insideH')}${border('insideV')}</w:tblBorders>`
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>';
  const tblGrid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;

  const headerRow = (Array.isArray(headers) && headers.length) ? tableRowXml(pad(headers), widths, { header: true }) : '';
  const dataRows = rows.map((r) => tableRowXml(pad(r), widths)).join('');
  return `<w:tbl>${tblPr}${tblGrid}${headerRow}${dataRows}</w:tbl>`;
}

function captionParagraphXml(title) {
  if (!title) return '';
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="40"/></w:pPr>`
    + `<w:r><w:rPr><w:i/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>`;
}

function insertBeforeBodyEnd(documentXml, fragment) {
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  if (bodyEnd < 0) throw new Error('DOCX inválido: no se encontró el cuerpo del documento.');
  const before = documentXml.slice(0, bodyEnd);
  const after = documentXml.slice(bodyEnd);
  const sectPrMatch = before.match(/<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/);
  if (sectPrMatch?.index != null) {
    return `${before.slice(0, sectPrMatch.index)}${fragment}${before.slice(sectPrMatch.index)}${after}`;
  }
  return `${before}${fragment}${after}`;
}

// Insert a native table into the DOCX (caption + table + trailing paragraph so
// Word stays well-formed), preserving everything else.
function insertTableIntoDocxBuffer(buffer, { headers = [], rows = [], title = '' } = {}) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const fragment = `${captionParagraphXml(title)}${buildTableXml(headers, rows)}<w:p/>`;
  zip.file('word/document.xml', insertBeforeBodyEnd(documentFile.asText(), fragment));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Parse a markdown-ish table or "a | b ; c | d" rows out of free text.
function parseTableFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pipeLines = lines.filter((l) => l.includes('|') && !/^\s*\|?\s*:?-{2,}/.test(l));
  // Slice from the first pipe so prose preceding the table (e.g. "agrega una
  // tabla con | A | B |") doesn't pollute the first cell.
  const split = (l) => {
    const fromPipe = l.indexOf('|') >= 0 ? l.slice(l.indexOf('|')) : l;
    return fromPipe.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  };
  if (pipeLines.length >= 2) {
    const headers = split(pipeLines[0]);
    const rows = pipeLines.slice(1).map(split).filter((r) => r.some(Boolean));
    if (headers.length >= 2 && rows.length) return { headers, rows };
  }
  // single-line "a | b ; c | d"
  const semicolonGroups = String(text || '').split(';').map((s) => s.trim()).filter((s) => s.includes('|'));
  if (semicolonGroups.length >= 2) {
    const headers = split(semicolonGroups[0]);
    const rows = semicolonGroups.slice(1).map(split).filter((r) => r.some(Boolean));
    if (headers.length >= 2 && rows.length) return { headers, rows };
  }
  return null;
}

const TABLE_INTENT_RE = /\b(tabla\w*|cuadro\w*|matriz)\b/;
const TABLE_CREATE_VERB_RE = /\b(agreg\w*|anad\w*|inserta\w*|crea\w*|genera\w*|incorpor\w*|incluy\w*|haz|pon|coloc\w*|elabor\w*)\b/;
const TABLE_FILL_VERB_RE = /\b(complet\w*|llen\w*|rellen\w*)\b/;

function detectTableRequest(text) {
  const norm = normalizeText(text);
  const wantsTable = TABLE_INTENT_RE.test(norm) && TABLE_CREATE_VERB_RE.test(norm) && !TABLE_FILL_VERB_RE.test(norm);
  return { wantsTable };
}

function tableSpecHasContent(spec) {
  return Boolean(spec && Array.isArray(spec.rows) && spec.rows.length && Array.isArray(spec.headers) && spec.headers.length);
}

async function extractTableSpecWithLLM({ requestText, sourceText, signal }) {
  if (!process.env.OPENAI_API_KEY) return null;
  let createContentClient;
  let DEFAULT_MODEL;
  try {
    // eslint-disable-next-line global-require
    ({ createContentClient, DEFAULT_MODEL } = require('./document-pipeline/content/llm-client'));
  } catch {
    return null;
  }
  try {
    const client = createContentClient('OpenAI');
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'Extraes una tabla a partir de la petición y el contexto del documento. No inventes cifras; usa solo datos presentes o claramente inferibles. Si no hay datos, devuelve filas vacías.' },
        { role: 'user', content: [
          `Petición: ${requestText}`,
          'Contexto (puede estar vacío):',
          String(sourceText || '').slice(0, 6000),
          '',
          'Responde SOLO JSON: {"title":"...","headers":["..."],"rows":[["..."]]}',
          'Cada fila es un arreglo de celdas de texto, alineado a headers.',
        ].join('\n') },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }, { signal, timeout: 25_000 });
    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const headers = Array.isArray(parsed.headers) ? parsed.headers.map((h) => String(h)) : [];
    const rows = Array.isArray(parsed.rows) ? parsed.rows.filter(Array.isArray).map((r) => r.map((c) => String(c == null ? '' : c))) : [];
    return { title: parsed.title ? String(parsed.title) : '', headers, rows };
  } catch {
    return null;
  }
}

// Detect a "create a table" request, build its spec (inline parse or LLM), and
// insert a native table. Returns { added, buffer, reason }. Never throws on "no".
async function addTableFromRequest(buffer, { requestText = '', sourceText = '', signal } = {}) {
  if (!detectTableRequest(requestText).wantsTable) return { added: false, buffer, reason: 'no_table_intent' };
  let spec = parseTableFromText(requestText);
  if (!tableSpecHasContent(spec)) spec = await extractTableSpecWithLLM({ requestText, sourceText, signal });
  if (!tableSpecHasContent(spec)) return { added: false, buffer, reason: 'no_data' };
  const out = insertTableIntoDocxBuffer(buffer, { headers: spec.headers, rows: spec.rows, title: spec.title || '' });
  return { added: true, buffer: out, spec: { headers: spec.headers, rowCount: spec.rows.length, title: spec.title || '' } };
}

module.exports = {
  buildTableXml,
  insertTableIntoDocxBuffer,
  parseTableFromText,
  detectTableRequest,
  addTableFromRequest,
  INTERNAL: { tableSpecHasContent, captionParagraphXml, insertBeforeBodyEnd, normalizeText },
};
