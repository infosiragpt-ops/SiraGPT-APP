const fs = require('fs');
const ocrEngine = require('./ocr-engine');
const fileProcessor = require('./fileProcessor');

const MAX_CHUNK_CHARS = 3600;
const CHUNK_OVERLAP_CHARS = 240;
const MAX_CHUNKS = 80;
const MAX_TABLE_PREVIEW_ROWS = 30;

function compactString(value, max = 1200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max).trim()}...`;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function hasUsefulText(value) {
  return ocrEngine.hasUsefulText(value);
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function detectLanguage(text) {
  const sample = String(text || '').slice(0, 6000).toLowerCase();
  const spanishHits = (sample.match(/\b(el|la|los|las|de|del|que|para|con|por|una|un|como|esta|este|segun|tambien|informacion)\b/g) || []).length;
  const englishHits = (sample.match(/\b(the|and|that|for|with|from|this|these|their|information|summary|analysis)\b/g) || []).length;
  if (spanishHits >= Math.max(4, englishHits)) return 'es';
  if (englishHits >= 4) return 'en';
  return null;
}

function inferCounts(file = {}, text = '') {
  const name = String(file.originalName || file.filename || '').toLowerCase();
  const mime = String(file.mimeType || '').toLowerCase();
  const pageMatch = String(text || '').match(/PDF document\s+—\s+(\d+)\s+page/i);
  const sheetMatch = String(text || '').match(/Excel workbook\s+—\s+(\d+)\s+sheet/i);
  const slideMatches = String(text || '').match(/\bSlide\s+\d+\b/gi);
  return {
    pageCount: pageMatch ? Number(pageMatch[1]) : (mime === 'application/pdf' || name.endsWith('.pdf') ? null : null),
    sheetCount: sheetMatch ? Number(sheetMatch[1]) : (isSpreadsheet(file) ? null : null),
    slideCount: slideMatches?.length || (isPresentation(file) ? null : null),
  };
}

function isSpreadsheet(file = {}) {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = String(file.originalName || file.filename || '').toLowerCase();
  return mime.includes('spreadsheet') || mime.includes('excel') || /\.(xlsx|xls|csv)$/i.test(name);
}

function isPresentation(file = {}) {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = String(file.originalName || file.filename || '').toLowerCase();
  return mime.includes('presentation') || mime.includes('powerpoint') || /\.(pptx|ppt)$/i.test(name);
}

function isPdf(file = {}) {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = String(file.originalName || file.filename || '').toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

function isWordLike(file = {}) {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = String(file.originalName || file.filename || '').toLowerCase();
  return mime.includes('wordprocessingml') || mime.includes('msword') || /\.(docx|doc)$/i.test(name);
}

function sourceKindForFile(file = {}) {
  if (isSpreadsheet(file)) return 'sheet';
  if (isPresentation(file)) return 'slide';
  if (isPdf(file)) return 'page';
  if (isWordLike(file)) return 'section';
  return 'document';
}

function sectionTitleFromText(text, fallback) {
  const firstLine = String(text || '').split('\n').find((line) => line.trim());
  if (!firstLine) return fallback;
  return compactString(firstLine.replace(/^#+\s*/, ''), 140);
}

function splitBySpreadsheetSheets(text) {
  const parts = [];
  const re = /^Sheet:\s*(.+)$/gim;
  const matches = Array.from(String(text || '').matchAll(re));
  if (!matches.length) return parts;
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index ?? text.length;
    const sheetName = matches[i][1].trim();
    const block = text.slice(start, end).trim();
    if (block) {
      parts.push({
        sourceType: 'sheet',
        sourceLabel: sheetName,
        sheetName,
        text: block,
      });
    }
  }
  return parts;
}

function splitByMarkdownHeadings(text) {
  const source = String(text || '');
  const matches = Array.from(source.matchAll(/^#{1,6}\s+(.+)$/gm));
  if (!matches.length) return [];
  const parts = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index ?? source.length;
    const block = source.slice(start, end).trim();
    if (block) {
      parts.push({
        sourceType: 'section',
        sourceLabel: compactString(matches[i][1], 140),
        sectionTitle: compactString(matches[i][1], 140),
        text: block,
      });
    }
  }
  return parts;
}

function splitByPageHints(text) {
  const source = String(text || '');
  const pageBreaks = Array.from(source.matchAll(/(?:^|\n)\s*(?:Page|Pagina|P[aá]gina)\s+(\d+)\s*(?:\n|$)/gim));
  if (!pageBreaks.length) return [];
  const parts = [];
  for (let i = 0; i < pageBreaks.length; i += 1) {
    const start = pageBreaks[i].index;
    const end = pageBreaks[i + 1]?.index ?? source.length;
    const pageNumber = Number(pageBreaks[i][1]);
    const block = source.slice(start, end).trim();
    if (block) {
      parts.push({
        sourceType: 'page',
        sourceLabel: `Pagina ${pageNumber}`,
        pageNumber,
        text: block,
      });
    }
  }
  return parts;
}

function fallbackChunks(text, file = {}) {
  const source = String(text || '');
  const sourceType = sourceKindForFile(file);
  const chunks = [];
  let cursor = 0;
  while (cursor < source.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(source.length, cursor + MAX_CHUNK_CHARS);
    let sliceEnd = end;
    if (end < source.length) {
      const paragraphBreak = source.lastIndexOf('\n\n', end);
      if (paragraphBreak > cursor + 800) sliceEnd = paragraphBreak;
    }
    const block = source.slice(cursor, sliceEnd).trim();
    if (block) {
      const ordinal = chunks.length + 1;
      chunks.push({
        sourceType,
        sourceLabel: `${sourceType} ${ordinal}`,
        sectionTitle: sourceType === 'section' ? sectionTitleFromText(block, `Seccion ${ordinal}`) : null,
        pageNumber: sourceType === 'page' ? ordinal : null,
        slideNumber: sourceType === 'slide' ? ordinal : null,
        text: block,
      });
    }
    if (sliceEnd >= source.length) break;
    cursor = Math.max(sliceEnd - CHUNK_OVERLAP_CHARS, cursor + 1);
  }
  return chunks;
}

function buildChunks(file = {}, extractedText = '') {
  const text = cleanText(extractedText);
  if (!hasUsefulText(text)) return [];
  const structured = [
    ...splitBySpreadsheetSheets(text),
    ...splitByMarkdownHeadings(text),
    ...splitByPageHints(text),
  ];
  const base = structured.length ? structured : fallbackChunks(text, file);
  return base.slice(0, MAX_CHUNKS).map((chunk, index) => ({
    ordinal: index + 1,
    sourceType: chunk.sourceType || sourceKindForFile(file),
    sourceLabel: chunk.sourceLabel || chunk.sectionTitle || `Fragmento ${index + 1}`,
    pageNumber: chunk.pageNumber || null,
    sheetName: chunk.sheetName || null,
    slideNumber: chunk.slideNumber || null,
    sectionTitle: chunk.sectionTitle || null,
    text: cleanText(chunk.text),
    charCount: cleanText(chunk.text).length,
    metadata: chunk.metadata || null,
  })).filter((chunk) => chunk.text);
}

function normalizeCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function tableToMarkdown(columns, rows) {
  if (!columns.length) return '';
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((col) => normalizeCell(row[col])).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function extractSpreadsheetTables(file = {}, extractedText = '') {
  if (!isSpreadsheet(file)) return [];
  // When the extracted text is empty but a file path exists, read the
  // workbook directly so the function works both in the async analysis
  // pipeline (where extractedText is pre-populated) and in direct
  // calls with a file path (e.g. tests or synchronous contexts).
  if (!extractedText && file.path && fs.existsSync(file.path)) {
    try {
      const workbookText = readXlsxToText(file.path);
      if (workbookText) {
        return extractSpreadsheetTables(file, workbookText);
      }
    } catch (_) {
      // fall through to empty extracted text — same as no tables
    }
  }
  const sheets = splitBySpreadsheetSheets(extractedText);
  return sheets.map((sheet, index) => {
    const lines = String(sheet.text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const columnsLine = lines.find((line) => /^Columns\s*\(/i.test(line));
    const columns = columnsLine
      ? columnsLine.replace(/^Columns\s*\(\d+\):\s*/i, '').split('|').map(normalizeCell).filter(Boolean)
      : [];
    const totalMatch = lines.find((line) => /^Total data rows:/i.test(line))?.match(/Total data rows:\s*(\d+)/i);
    const dataStart = lines.findIndex((line) => line === '---');
    const dataLines = dataStart >= 0 ? lines.slice(dataStart + 1) : [];
    const preview = dataLines
      .filter((line) => !/^\.\.\.\s*\[/.test(line))
      .slice(0, MAX_TABLE_PREVIEW_ROWS)
      .map((line) => {
        const values = line.split('\t').map(normalizeCell);
        const row = {};
        columns.forEach((col, idx) => { row[col] = values[idx] || ''; });
        return row;
      });
    return {
      ordinal: index + 1,
      sourceType: 'sheet',
      sourceLabel: sheet.sheetName,
      sheetName: sheet.sheetName,
      title: sheet.sheetName,
      columns,
      rowCount: totalMatch ? Number(totalMatch[1]) : preview.length,
      preview,
      markdown: tableToMarkdown(columns, preview),
      metadata: { workbookSheetIndex: index, source: 'extracted_text' },
    };
  }).filter((table) => table.columns.length > 0);
}

/**
 * Read an XLSX workbook file and produce the same tab-delimited text
 * format that the async extraction pipeline generates. This lets
 * extractSpreadsheetTables work both with pre-extracted text (from
 * the file processor) and directly from a file path.
 */
function readXlsxToText(filePath) {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath, { type: 'file', cellDates: false, raw: true });
  const parts = [];
  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const sheetName = workbook.SheetNames[i];
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const columns = json.length > 0 ? Object.keys(json[0]) : [];
    const lines = [];
    lines.push(`Sheet: ${sheetName}`);
    lines.push(`Columns (${columns.length}): ${columns.join('|')}`);
    lines.push(`Total data rows: ${json.length}`);
    lines.push('---');
    for (const row of json) {
      lines.push(columns.map((col) => String(row[col] ?? '')).join('\t'));
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

function extractMarkdownTables(text) {
  const lines = String(text || '').split('\n');
  const tables = [];
  let i = 0;
  while (i < lines.length - 1) {
    const header = lines[i];
    const separator = lines[i + 1];
    const isTableStart = /\|/.test(header) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator);
    if (!isTableStart) {
      i += 1;
      continue;
    }
    const tableLines = [header, separator];
    i += 2;
    while (i < lines.length && /\|/.test(lines[i])) {
      tableLines.push(lines[i]);
      i += 1;
    }
    const columns = header.split('|').map((cell) => cell.trim()).filter(Boolean);
    const previewRows = tableLines.slice(2, 2 + MAX_TABLE_PREVIEW_ROWS).map((line) => {
      const values = line.split('|').map((cell) => cell.trim()).filter((_, idx, arr) => !(idx === 0 && arr[idx] === '') && !(idx === arr.length - 1 && arr[idx] === ''));
      const row = {};
      columns.forEach((col, idx) => { row[col] = values[idx] || ''; });
      return row;
    });
    tables.push({
      ordinal: tables.length + 1,
      sourceType: 'section',
      sourceLabel: `Tabla ${tables.length + 1}`,
      title: `Tabla ${tables.length + 1}`,
      columns,
      rowCount: Math.max(0, tableLines.length - 2),
      preview: previewRows,
      markdown: tableLines.join('\n'),
      metadata: { detectedFromMarkdown: true },
    });
  }
  return tables;
}

function extractCsvTable(file = {}, text = '') {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = String(file.originalName || file.filename || '').toLowerCase();
  if (mime !== 'text/csv' && !name.endsWith('.csv')) return [];
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const columns = lines[0].split(delimiter).map((cell) => cell.trim()).filter(Boolean);
  if (!columns.length) return [];
  const preview = lines.slice(1, MAX_TABLE_PREVIEW_ROWS + 1).map((line) => {
    const values = line.split(delimiter).map((cell) => cell.trim());
    const row = {};
    columns.forEach((col, idx) => { row[col] = values[idx] || ''; });
    return row;
  });
  return [{
    ordinal: 1,
    sourceType: 'document',
    sourceLabel: file.originalName || 'CSV',
    title: file.originalName || 'CSV',
    columns,
    rowCount: Math.max(0, lines.length - 1),
    preview,
    markdown: tableToMarkdown(columns, preview),
    metadata: { delimiter },
  }];
}

function buildTables(file = {}, extractedText = '') {
  const spreadsheetTables = extractSpreadsheetTables(file, extractedText).filter((table) => table.columns.length > 0);
  const csvTables = extractCsvTable(file, extractedText);
  const markdownTables = extractMarkdownTables(extractedText);
  return [...spreadsheetTables, ...csvTables, ...markdownTables]
    .slice(0, 50)
    .map((table, index) => ({
      ordinal: index + 1,
      sourceType: table.sourceType || 'document',
      sourceLabel: table.sourceLabel || table.title || `Tabla ${index + 1}`,
      pageNumber: table.pageNumber || null,
      sheetName: table.sheetName || null,
      slideNumber: table.slideNumber || null,
      title: table.title || table.sourceLabel || `Tabla ${index + 1}`,
      columns: (table.columns || []).map(String).slice(0, 80),
      rowCount: Number(table.rowCount || 0),
      preview: table.preview || [],
      markdown: table.markdown || '',
      metadata: table.metadata || null,
    }));
}

function buildCoverage({ file, text, chunks, tables, ocr }) {
  const charCount = text.length;
  const status = hasUsefulText(text) ? 'complete' : 'empty';
  const usefulChars = (text.match(/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ]/g) || []).length;
  return {
    status,
    charCount,
    usefulChars,
    chunkCount: chunks.length,
    tableCount: tables.length,
    extractionCoverage: charCount > 0 ? Math.min(1, usefulChars / Math.max(charCount, 1)) : 0,
    mimeType: file.mimeType || null,
    ocrStatus: ocr?.status || 'skipped',
    ocrConfidence: typeof ocr?.confidence === 'number' ? ocr.confidence : null,
  };
}

function buildWarnings({ file, text, ocr, tables }) {
  const warnings = [];
  if (!hasUsefulText(text)) {
    warnings.push({
      code: 'no_text_extracted',
      message: 'No se encontro texto legible en el documento.',
      cause: ocr?.status === 'failed' ? 'ocr_failed' : 'empty_or_unsupported',
    });
  }
  if (ocr?.status === 'failed') {
    warnings.push({ code: 'ocr_failed', message: 'OCR no pudo extraer texto confiable.', cause: ocr.reason || null });
  }
  if (isSpreadsheet(file) && tables.length === 0) {
    warnings.push({ code: 'no_tables_detected', message: 'No se detectaron tablas estructuradas en la hoja de calculo.' });
  }
  return warnings;
}

function buildSummary(file = {}, text = '', chunks = [], tables = []) {
  if (!hasUsefulText(text)) {
    return `No se encontro texto legible en ${file.originalName || file.filename || 'el archivo'}.`;
  }
  const title = file.originalName || file.filename || 'Documento';
  const firstChunk = chunks[0]?.text ? compactString(chunks[0].text, 420) : compactString(text, 420);
  const tablePart = tables.length ? ` Incluye ${tables.length} tabla(s) detectada(s).` : '';
  return `${title}: ${text.length} caracteres extraidos en ${chunks.length} fragmento(s).${tablePart} Vista inicial: ${firstChunk}`;
}

async function reprocessIfNeeded(prisma, file) {
  if (hasUsefulText(file?.extractedText) || !file?.path || !fs.existsSync(file.path)) {
    return { file, result: null };
  }
  try {
    const result = await fileProcessor.processFile({
      path: file.path,
      mimetype: file.mimeType,
      originalname: file.originalName || file.filename || 'archivo',
      size: file.size || 0,
    });
    if (result?.extractedText && prisma?.file?.update) {
      await prisma.file.update({
        where: { id: file.id },
        data: { extractedText: result.extractedText },
      }).catch(() => null);
    }
    return {
      file: { ...file, extractedText: result?.extractedText || file.extractedText },
      result,
    };
  } catch (err) {
    return { file, result: { ocr: { status: 'failed', confidence: 0, provider: null, reason: err.message } } };
  }
}

function serializeAnalysis(analysis, chunks = [], tables = []) {
  if (!analysis) return null;
  return {
    id: analysis.id,
    fileId: analysis.fileId,
    status: analysis.status,
    language: analysis.language,
    mimeType: analysis.mimeType,
    pageCount: analysis.pageCount,
    sheetCount: analysis.sheetCount,
    slideCount: analysis.slideCount,
    charCount: analysis.charCount,
    chunkCount: analysis.chunkCount,
    tableCount: analysis.tableCount,
    summary: analysis.summary,
    textCoverage: safeJson(analysis.textCoverage, analysis.textCoverage),
    ocr: safeJson(analysis.ocr, analysis.ocr),
    warnings: safeJson(analysis.warnings, analysis.warnings) || [],
    metadata: safeJson(analysis.metadata, analysis.metadata),
    chunks,
    tables,
    createdAt: analysis.createdAt,
    updatedAt: analysis.updatedAt,
  };
}

async function analyzeFile(prisma, {
  userId,
  fileId,
  fileRecord = null,
  extractionResult = null,
  force = false,
} = {}) {
  if (!prisma?.file || !userId) throw new Error('DocumentIntelligenceService requires prisma and userId');
  let file = fileRecord || await prisma.file.findFirst({ where: { id: fileId, userId } });
  if (!file) throw new Error('File not found');

  if (!force && prisma.documentAnalysis?.findUnique) {
    const existing = await prisma.documentAnalysis.findUnique({
      where: { fileId: file.id },
      include: {
        chunks: { orderBy: { ordinal: 'asc' }, take: 10 },
        tables: { orderBy: { ordinal: 'asc' }, take: 10 },
      },
    }).catch(() => null);
    if (existing?.status === 'ready' && existing.updatedAt >= file.createdAt) {
      return serializeAnalysis(existing, existing.chunks || [], existing.tables || []);
    }
  }

  const reprocessed = await reprocessIfNeeded(prisma, file);
  file = reprocessed.file;
  const ocr = extractionResult?.ocr || reprocessed.result?.ocr || null;
  const text = cleanText(file.extractedText || '');
  const chunks = buildChunks(file, text);
  const tables = buildTables(file, text);
  const counts = inferCounts(file, text);
  const warnings = buildWarnings({ file, text, ocr, tables });
  const textCoverage = buildCoverage({ file, text, chunks, tables, ocr });
  const status = hasUsefulText(text) ? 'ready' : 'empty';
  const summary = buildSummary(file, text, chunks, tables);
  const metadata = {
    originalName: file.originalName,
    filename: file.filename,
    size: file.size,
    analyzedAt: new Date().toISOString(),
    extractionSource: extractionResult ? 'upload_pipeline' : (reprocessed.result ? 'reanalyzed' : 'stored_text'),
  };

  if (!prisma.documentAnalysis?.upsert) {
    return {
      id: null,
      fileId: file.id,
      status,
      language: detectLanguage(text),
      mimeType: file.mimeType,
      ...counts,
      charCount: text.length,
      chunkCount: chunks.length,
      tableCount: tables.length,
      summary,
      textCoverage,
      ocr,
      warnings,
      metadata,
      chunks,
      tables,
    };
  }

  const analysis = await prisma.documentAnalysis.upsert({
    where: { fileId: file.id },
    create: {
      userId,
      fileId: file.id,
      status,
      language: detectLanguage(text),
      mimeType: file.mimeType,
      ...counts,
      charCount: text.length,
      chunkCount: chunks.length,
      tableCount: tables.length,
      summary,
      textCoverage,
      ocr: ocr || null,
      warnings,
      metadata,
    },
    update: {
      status,
      language: detectLanguage(text),
      mimeType: file.mimeType,
      ...counts,
      charCount: text.length,
      chunkCount: chunks.length,
      tableCount: tables.length,
      summary,
      textCoverage,
      ocr: ocr || null,
      warnings,
      metadata,
    },
  });

  await prisma.$transaction([
    prisma.documentChunk.deleteMany({ where: { analysisId: analysis.id } }),
    prisma.documentTable.deleteMany({ where: { analysisId: analysis.id } }),
  ]);

  if (chunks.length) {
    await prisma.documentChunk.createMany({
      data: chunks.map((chunk) => ({
        analysisId: analysis.id,
        fileId: file.id,
        ...chunk,
      })),
    });
  }
  if (tables.length) {
    await prisma.documentTable.createMany({
      data: tables.map((table) => ({
        analysisId: analysis.id,
        fileId: file.id,
        ...table,
      })),
    });
  }

  const [createdChunks, createdTables] = await Promise.all([
    prisma.documentChunk.findMany({ where: { analysisId: analysis.id }, orderBy: { ordinal: 'asc' }, take: 10 }),
    prisma.documentTable.findMany({ where: { analysisId: analysis.id }, orderBy: { ordinal: 'asc' }, take: 10 }),
  ]);

  return serializeAnalysis(analysis, createdChunks, createdTables);
}

async function getAnalysisForFile(prisma, { userId, fileId } = {}) {
  if (!prisma?.documentAnalysis) return null;
  const analysis = await prisma.documentAnalysis.findFirst({
    where: { userId, fileId },
    include: {
      chunks: { orderBy: { ordinal: 'asc' }, take: 10 },
      tables: { orderBy: { ordinal: 'asc' }, take: 10 },
    },
  });
  return serializeAnalysis(analysis, analysis?.chunks || [], analysis?.tables || []);
}

function tokenizeQuery(query) {
  return Array.from(new Set(String(query || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) || []))
    .filter((term) => !['para', 'como', 'que', 'del', 'con', 'una', 'los', 'las', 'the', 'and', 'from', 'this'].includes(term));
}

function topTerms(text, limit = 20) {
  const stop = new Set([
    'para', 'como', 'que', 'del', 'con', 'una', 'uno', 'los', 'las', 'por', 'sobre', 'esta', 'este', 'esas', 'esos',
    'the', 'and', 'from', 'this', 'that', 'with', 'into', 'document', 'archivo', 'documento',
  ]);
  const counts = new Map();
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]{4,}/g)
    ?.forEach((term) => {
      if (!stop.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
    });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)))
    .map(([term, count]) => ({ term, count }));
}

function scoreChunk(chunk, terms) {
  if (!terms.length) return 1 / Math.max(1, chunk.ordinal || 1);
  const haystack = String(`${chunk.sectionTitle || ''} ${chunk.sourceLabel || ''} ${chunk.text || ''}`)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function retrieveEvidence(prisma, { userId, fileId, query = '', limit = 8 } = {}) {
  if (!prisma?.documentChunk) return { evidence: [], analysis: null };
  const analysis = await prisma.documentAnalysis.findFirst({ where: { userId, fileId } });
  if (!analysis) return { evidence: [], analysis: null };
  const chunks = await prisma.documentChunk.findMany({
    where: { analysisId: analysis.id },
    orderBy: { ordinal: 'asc' },
    take: 200,
  });
  const terms = tokenizeQuery(query);
  const evidence = chunks
    .map((chunk) => ({
      id: chunk.id,
      analysisId: analysis.id,
      fileId: chunk.fileId,
      ordinal: chunk.ordinal,
      sourceType: chunk.sourceType,
      sourceLabel: chunk.sourceLabel,
      pageNumber: chunk.pageNumber,
      sheetName: chunk.sheetName,
      slideNumber: chunk.slideNumber,
      sectionTitle: chunk.sectionTitle,
      text: chunk.text,
      score: scoreChunk(chunk, terms),
    }))
    .filter((item) => item.score > 0 || !terms.length)
    .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
  return { evidence, analysis: serializeAnalysis(analysis, [], []) };
}

async function getTablesForFile(prisma, { userId, fileId } = {}) {
  if (!prisma?.documentTable) return [];
  const analysis = await prisma.documentAnalysis.findFirst({ where: { userId, fileId } });
  if (!analysis) return [];
  return prisma.documentTable.findMany({
    where: { analysisId: analysis.id },
    orderBy: { ordinal: 'asc' },
  });
}

async function compareDocuments(prisma, { userId, fileIds = [], query = '', limit = 6 } = {}) {
  if (!prisma?.documentAnalysis || !userId) {
    return { comparisons: [], documents: [], sharedTerms: [], warnings: [{ code: 'docintel_unavailable', message: 'Document Intelligence no esta disponible.' }] };
  }

  const ids = Array.from(new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))).slice(0, 6);
  if (ids.length < 2) {
    return { comparisons: [], documents: [], sharedTerms: [], warnings: [{ code: 'insufficient_documents', message: 'Se requieren al menos dos documentos para comparar.' }] };
  }

  const documents = [];
  for (const fileId of ids) {
    const analysis = await analyzeFile(prisma, { userId, fileId });
    const evidenceResult = await retrieveEvidence(prisma, {
      userId,
      fileId,
      query: query || analysis?.summary || '',
      limit,
    });
    const tables = await getTablesForFile(prisma, { userId, fileId });
    const evidence = (evidenceResult.evidence || []).slice(0, Math.max(1, Math.min(Number(limit) || 6, 12)));
    const termSource = [
      analysis?.summary || '',
      ...evidence.map((item) => item.text || ''),
    ].join('\n');
    documents.push({
      fileId,
      analysisId: analysis?.id || null,
      status: analysis?.status || 'unknown',
      summary: analysis?.summary || null,
      charCount: analysis?.charCount || 0,
      chunkCount: analysis?.chunkCount || 0,
      tableCount: analysis?.tableCount || 0,
      warnings: analysis?.warnings || [],
      evidence: evidence.map((item) => ({
        id: item.id,
        sourceType: item.sourceType,
        sourceLabel: item.sourceLabel,
        pageNumber: item.pageNumber,
        sheetName: item.sheetName,
        slideNumber: item.slideNumber,
        sectionTitle: item.sectionTitle,
        text: compactString(item.text, 900),
        score: item.score,
      })),
      tables: tables.slice(0, 5).map((table) => ({
        id: table.id,
        title: table.title,
        sourceLabel: table.sourceLabel,
        sheetName: table.sheetName,
        columns: table.columns,
        rowCount: table.rowCount,
        preview: Array.isArray(table.preview) ? table.preview.slice(0, 5) : table.preview,
      })),
      terms: topTerms(termSource, 25),
    });
  }

  const termSets = documents.map((doc) => new Set(doc.terms.map((item) => item.term)));
  const sharedTerms = Array.from(termSets[0] || [])
    .filter((term) => termSets.every((set) => set.has(term)))
    .slice(0, 20);

  const comparisons = [];
  for (let i = 0; i < documents.length; i += 1) {
    for (let j = i + 1; j < documents.length; j += 1) {
      const a = documents[i];
      const b = documents[j];
      const aTerms = new Set(a.terms.map((item) => item.term));
      const bTerms = new Set(b.terms.map((item) => item.term));
      comparisons.push({
        pair: [a.fileId, b.fileId],
        sharedTerms: Array.from(aTerms).filter((term) => bTerms.has(term)).slice(0, 20),
        onlyInFirst: Array.from(aTerms).filter((term) => !bTerms.has(term)).slice(0, 15),
        onlyInSecond: Array.from(bTerms).filter((term) => !aTerms.has(term)).slice(0, 15),
        charDelta: a.charCount - b.charCount,
        tableDelta: a.tableCount - b.tableCount,
        evidenceDelta: a.evidence.length - b.evidence.length,
      });
    }
  }

  return {
    documents,
    comparisons,
    sharedTerms,
    warnings: documents.flatMap((doc) => (doc.warnings || []).map((warning) => ({ fileId: doc.fileId, ...warning }))),
  };
}

module.exports = {
  analyzeFile,
  buildChunks,
  buildSummary,
  buildTables,
  compareDocuments,
  getAnalysisForFile,
  getTablesForFile,
  hasUsefulText,
  retrieveEvidence,
  INTERNAL: {
    cleanText,
    detectLanguage,
    extractCsvTable,
    extractMarkdownTables,
    extractSpreadsheetTables,
    inferCounts,
    tokenizeQuery,
    topTerms,
  },
};
