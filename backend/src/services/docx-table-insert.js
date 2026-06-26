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

function xmlUnescape(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphText(xml = '') {
  const pieces = [];
  const textRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let match;
  while ((match = textRe.exec(String(xml || '')))) pieces.push(xmlUnescape(match[1]));
  return pieces.join('');
}

function extractXmlSegments(xml = '', regex) {
  const segments = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(String(xml || '')))) {
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      xml: match[0],
    });
  }
  return segments;
}

function extractTableCells(rowXml = '') {
  return extractXmlSegments(rowXml, /<w:tc\b[\s\S]*?<\/w:tc>/g)
    .map((cell) => paragraphText(cell.xml).replace(/\s+/g, ' ').trim());
}

function extractTableRows(tableXml = '') {
  return extractXmlSegments(tableXml, /<w:tr\b[\s\S]*?<\/w:tr>/g)
    .map((row) => extractTableCells(row.xml))
    .filter((row) => row.some((cell) => String(cell || '').trim()));
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
function insertTableIntoDocxBuffer(buffer, { headers = [], rows = [], title = '', afterIndex = null } = {}) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const documentXml = documentFile.asText();
  const fragment = `${captionParagraphXml(title)}${buildTableXml(headers, rows)}<w:p/>`;
  const insertionIndex = Number.isFinite(afterIndex) ? Number(afterIndex) : -1;
  const nextXml = insertionIndex > 0 && insertionIndex < documentXml.lastIndexOf('</w:body>')
    ? `${documentXml.slice(0, insertionIndex)}<w:p/>${fragment}${documentXml.slice(insertionIndex)}`
    : insertBeforeBodyEnd(documentXml, fragment);
  zip.file('word/document.xml', nextXml);
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
  // "índice/lista de tablas" is an index request, not a create-table request.
  const wantsTable = TABLE_INTENT_RE.test(norm) && TABLE_CREATE_VERB_RE.test(norm)
    && !TABLE_FILL_VERB_RE.test(norm) && !INDEX_REQUEST_RE.test(norm);
  return { wantsTable };
}

function tableSpecHasContent(spec) {
  return Boolean(spec && Array.isArray(spec.rows) && spec.rows.length && Array.isArray(spec.headers) && spec.headers.length);
}

function requestWantsConsistencyMatrix(text = '') {
  const norm = normalizeText(text);
  return /\bmatriz\b/.test(norm)
    && /\b(?:consisten\w*|cosisten\w*)\b/.test(norm)
    && /\b(?:operacional\w*|operacionalizacion\w*|categorizaci\w*|categoriza\w*)\b/.test(norm);
}

function findColumn(headers = [], patterns = []) {
  const normalized = headers.map((header) => normalizeText(header));
  for (const pattern of patterns) {
    const found = normalized.findIndex((header) => pattern.test(header));
    if (found >= 0) return found;
  }
  return -1;
}

function uniqCompact(values = [], max = 6) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function joinList(values = [], fallback = '') {
  const items = uniqCompact(values);
  if (!items.length) return fallback;
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function lcFirst(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[A-ZÁÉÍÓÚÜÑ0-9\s]{2,}$/.test(text)) return text;
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function sourceTableScore(table) {
  const norm = normalizeText(`${table.context || ''} ${table.text || ''}`);
  let score = 0;
  if (/\btabla\s*0?1\b/.test(norm)) score += 4;
  if (/\bmatriz\b/.test(norm)) score += 3;
  if (/\boperacional\w*|operacionalizacion\w*\b/.test(norm)) score += 5;
  if (/\bcategorizaci\w*|categoriza\w*\b/.test(norm)) score += 4;
  if (/\bcategor[ií]a\w*|subcategor[ií]a\w*|dimension\w*|indicador\w*|variable\w*\b/.test(norm)) score += 4;
  if (table.rows.length >= 2) score += 2;
  return score;
}

function extractDocxTablesWithContext(buffer) {
  try {
    const xml = new PizZip(buffer).file('word/document.xml')?.asText() || '';
    return extractXmlSegments(xml, /<w:tbl\b[\s\S]*?<\/w:tbl>/g)
      .map((table) => {
        const contextXml = xml.slice(Math.max(0, table.start - 1800), table.start);
        const rows = extractTableRows(table.xml);
        return {
          ...table,
          rows,
          text: rows.flat().join(' '),
          context: paragraphText(contextXml),
        };
      });
  } catch {
    return [];
  }
}

function buildConsistencyMatrixSpec(buffer, { requestText = '' } = {}) {
  if (!requestWantsConsistencyMatrix(requestText)) return null;
  const candidates = extractDocxTablesWithContext(buffer)
    .filter((table) => table.rows.length >= 2)
    .map((table) => ({ table, score: sourceTableScore(table) }))
    .filter((item) => item.score >= 6)
    .sort((a, b) => b.score - a.score);
  const source = candidates[0]?.table;
  if (!source) return null;

  const headers = source.rows[0] || [];
  const dataRows = source.rows.slice(1)
    .map((row) => row.map((cell) => String(cell || '').replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some(Boolean))
    .slice(0, 18);
  if (!dataRows.length) return null;

  const categoryCol = findColumn(headers, [/\bcategor[ií]a\w*\b/, /\bvariable\w*\b/]);
  const subcategoryCol = findColumn(headers, [/\bsubcategor[ií]a\w*\b/, /\bdimension\w*\b/, /\bfactor\w*\b/]);
  const indicatorCol = findColumn(headers, [/\bindicador\w*\b/, /\bitems?\b/, /\bcriterio\w*\b/]);
  const techniqueCol = findColumn(headers, [/\bt[eé]cnica\w*\b/, /\bmetodo\w*\b/, /\bfuente\w*\b/]);
  const instrumentCol = findColumn(headers, [/\binstrumento\w*\b/, /\bgu[ií]a\w*\b/, /\bficha\w*\b/]);

  const cellAt = (row, idx) => (idx >= 0 ? row[idx] : '');
  const normalizedRows = dataRows.map((row) => {
    const category = cellAt(row, categoryCol) || row[0] || '';
    const subcategory = cellAt(row, subcategoryCol) || row[1] || '';
    const indicator = cellAt(row, indicatorCol) || row[2] || subcategory || category || '';
    const technique = cellAt(row, techniqueCol);
    const instrument = cellAt(row, instrumentCol);
    return {
      category,
      subcategory,
      indicator,
      techniqueInstrument: joinList([technique, instrument], 'Según la matriz operacional'),
    };
  }).filter((row) => row.category || row.subcategory || row.indicator);

  const deduped = [];
  const seen = new Set();
  for (const row of normalizedRows) {
    const key = normalizeText([row.category, row.subcategory, row.indicator].join('|'));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  if (!deduped.length) return null;

  const categories = joinList(deduped.map((row) => row.category), 'las categorías identificadas');
  const subcategories = joinList(deduped.map((row) => row.subcategory), 'las subcategorías identificadas');
  const indicators = joinList(deduped.map((row) => row.indicator), 'los indicadores definidos');
  const generalRow = [
    `¿Cómo se articula ${lcFirst(categories)} con ${lcFirst(indicators)}?`,
    `Analizar la articulación entre ${lcFirst(categories)} y ${lcFirst(indicators)}.`,
    `Existe correspondencia entre ${lcFirst(categories)}, ${lcFirst(subcategories)} y ${lcFirst(indicators)}.`,
    categories,
    subcategories,
    indicators,
    'Análisis documental de la matriz operacional',
  ];

  const rows = [
    generalRow,
    ...deduped.map((row, index) => {
      const focus = row.indicator || row.subcategory || row.category;
      const context = row.subcategory || row.category || 'la categoría de estudio';
      return [
        `¿Cómo se manifiesta ${lcFirst(focus)} en ${lcFirst(context)}?`,
        `Examinar ${lcFirst(focus)} en ${lcFirst(context)}.`,
        `El comportamiento de ${lcFirst(focus)} se relaciona con ${lcFirst(context)}.`,
        row.category || `Categoría ${index + 1}`,
        row.subcategory || row.category || '',
        row.indicator || row.subcategory || row.category || '',
        row.techniqueInstrument,
      ];
    }),
  ];

  return {
    kind: 'consistency_matrix',
    title: 'Matriz de consistencia basada en la matriz operacional',
    headers: [
      'Problema',
      'Objetivo',
      'Supuesto/Hipótesis',
      'Categoría/Variable',
      'Subcategoría/Dimensión',
      'Indicador',
      'Técnica/Instrumento',
    ],
    rows,
    insertAfterTableEnd: source.end,
  };
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

// Next APA-style "Tabla N" number based on captions already in the document.
function nextTableNumber(buffer) {
  try {
    const xml = new PizZip(buffer).file('word/document.xml')?.asText() || '';
    const text = (xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(' ');
    const nums = [...text.matchAll(/\bTabla\s+(\d+)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  } catch {
    return 1;
  }
}

// Detect a "create a table" request, build its spec (inline parse or LLM), and
// insert a native table. Returns { added, buffer, reason }. Never throws on "no".
async function addTableFromRequest(buffer, { requestText = '', sourceText = '', signal } = {}) {
  if (!detectTableRequest(requestText).wantsTable) return { added: false, buffer, reason: 'no_table_intent' };
  let spec = buildConsistencyMatrixSpec(buffer, { requestText, sourceText });
  if (!tableSpecHasContent(spec)) spec = parseTableFromText(requestText);
  if (!tableSpecHasContent(spec)) spec = await extractTableSpecWithLLM({ requestText, sourceText, signal });
  if (!tableSpecHasContent(spec)) return { added: false, buffer, reason: 'no_data' };
  const number = nextTableNumber(buffer);
  const base = String(spec.title || '').trim();
  const caption = base ? `Tabla ${number}. ${base}` : `Tabla ${number}`;
  const out = insertTableIntoDocxBuffer(buffer, { headers: spec.headers, rows: spec.rows, title: caption, afterIndex: spec.insertAfterTableEnd });
  return { added: true, buffer: out, spec: { headers: spec.headers, rowCount: spec.rows.length, title: caption, kind: spec.kind || 'table' } };
}

// ---------------------------------------------------------------------------
// Índice de figuras / tablas — list the "Figura N." / "Tabla N." captions the
// document already has (a thesis/APA requirement once figures & tables exist).
// ---------------------------------------------------------------------------

function headingParagraphXml(text) {
  return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>`
    + `<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function entryParagraphXml(text) {
  return `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>`
    + `<w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function buildCaptionIndex(documentXml) {
  const paragraphs = (String(documentXml || '').match(/<w:p\b[\s\S]*?<\/w:p>/g) || [])
    .map((p) => (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').trim());
  const figures = [];
  const tables = [];
  for (const text of paragraphs) {
    let m;
    if ((m = text.match(/^Figura\s+(\d+)\.?\s*(.*)$/i))) figures.push({ num: Number(m[1]), title: m[2].trim() });
    else if ((m = text.match(/^Tabla\s+(\d+)\.?\s*(.*)$/i))) tables.push({ num: Number(m[1]), title: m[2].trim() });
  }
  return { figures, tables };
}

function insertCaptionIndexIntoDocxBuffer(buffer, { scope = 'both' } = {}) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const documentXml = documentFile.asText();
  const { figures, tables } = buildCaptionIndex(documentXml);
  const wantFigures = (scope === 'both' || scope === 'figures') && figures.length;
  const wantTables = (scope === 'both' || scope === 'tables') && tables.length;
  if (!wantFigures && !wantTables) return { inserted: false, buffer, figures: figures.length, tables: tables.length };

  const entry = (kind, item) => entryParagraphXml(`${kind} ${item.num}${item.title ? `. ${item.title}` : ''}`);
  let fragment = '';
  if (wantFigures) fragment += headingParagraphXml('Índice de figuras') + figures.map((f) => entry('Figura', f)).join('');
  if (wantTables) fragment += headingParagraphXml('Índice de tablas') + tables.map((tb) => entry('Tabla', tb)).join('');
  zip.file('word/document.xml', insertBeforeBodyEnd(documentXml, fragment));
  return { inserted: true, buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), figures: figures.length, tables: tables.length };
}

const INDEX_REQUEST_RE = /\b(indice|lista|tabla)\s+(?:de\s+)?(figuras?|tablas?|graficos?|cuadros?|ilustraciones?)\b/;

function detectIndexRequest(text) {
  const norm = normalizeText(text);
  if (!INDEX_REQUEST_RE.test(norm)) return { wantsIndex: false, scope: 'both' };
  const hasFig = /\b(figuras?|graficos?|ilustraciones?)\b/.test(norm);
  const hasTab = /\b(tablas?|cuadros?)\b/.test(norm);
  const scope = hasFig && !hasTab ? 'figures' : (hasTab && !hasFig ? 'tables' : 'both');
  return { wantsIndex: true, scope };
}

async function addIndexFromRequest(buffer, { requestText = '' } = {}) {
  const det = detectIndexRequest(requestText);
  if (!det.wantsIndex) return { added: false, buffer, reason: 'no_index_intent' };
  const result = insertCaptionIndexIntoDocxBuffer(buffer, { scope: det.scope });
  if (!result.inserted) return { added: false, buffer, reason: 'no_captions' };
  return { added: true, buffer: result.buffer, spec: { scope: det.scope, figures: result.figures, tables: result.tables } };
}

module.exports = {
  buildTableXml,
  insertTableIntoDocxBuffer,
  parseTableFromText,
  detectTableRequest,
  requestWantsConsistencyMatrix,
  addTableFromRequest,
  buildCaptionIndex,
  insertCaptionIndexIntoDocxBuffer,
  detectIndexRequest,
  addIndexFromRequest,
  INTERNAL: { tableSpecHasContent, captionParagraphXml, insertBeforeBodyEnd, normalizeText, buildConsistencyMatrixSpec },
};
