const fs = require('fs');
const ocrEngine = require('./ocr-engine');
const fileProcessor = require('./fileProcessor');
const hierarchicalChunker = require('./document/hierarchical-document-chunker');

const MAX_CHUNK_CHARS = Number.parseInt(
  process.env.SIRAGPT_DOCINTEL_CHUNK_CHARS || '3600',
  10
);
const CHUNK_OVERLAP_CHARS = Number.parseInt(
  process.env.SIRAGPT_DOCINTEL_CHUNK_OVERLAP || '240',
  10
);
const MAX_CHUNKS = Math.max(
  80,
  Math.min(Number(process.env.DOCINTEL_MAX_CHUNKS) || 1200, 5000)
);
const MAX_TABLE_PREVIEW_ROWS = 30;
const MAX_TERMS_FOR_EVIDENCE = Number.parseInt(
  process.env.SIRAGPT_DOCINTEL_MAX_EVIDENCE_TERMS || '24',
  10
);
const MAX_EVIDENCE_CHUNKS = Number.parseInt(
  process.env.SIRAGPT_DOCINTEL_MAX_EVIDENCE_CHUNKS || '24',
  10
);
const EVIDENCE_CHUNK_NEIGHBORS = Number.parseInt(
  process.env.SIRAGPT_DOCINTEL_EVIDENCE_NEIGHBORS || '2',
  10
);

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
  const pageMatch = String(text || '').match(/PDF document\s+[—–]\s+(\d+)\s+page/i);
  const sheetMatch = String(text || '').match(/Excel workbook\s+[—–]\s+(\d+)\s+sheet/i);
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

// ── Primary buildChunks with hierarchical support ──────────────

function buildChunks(file = {}, extractedText = '') {
  const text = cleanText(extractedText);
  if (!hasUsefulText(text)) return [];

  // Try hierarchical chunker first — produces section-aware chunks
  try {
    const hierarchy = hierarchicalChunker.buildHierarchicalStructure(file, text);
    if (hierarchy.chunks && hierarchy.chunks.length > 0) {
      return hierarchy.chunks.slice(0, MAX_CHUNKS).map((chunk) => ({
        ordinal: chunk.ordinal,
        sourceType: chunk.sourceType || sourceKindForFile(file),
        sourceLabel: chunk.sourceLabel || chunk.sectionTitle || `Fragmento ${chunk.ordinal}`,
        pageNumber: chunk.pageNumber || null,
        sheetName: null,
        slideNumber: null,
        sectionTitle: chunk.sectionTitle || null,
        sectionLevel: chunk.sectionLevel || null,
        sectionPath: chunk.sectionPath || null,
        text: cleanText(chunk.text),
        charCount: cleanText(chunk.text).length,
        metadata: { sectionPath: chunk.sectionPath || null, sectionLevel: chunk.sectionLevel || null },
      })).filter((chunk) => chunk.text);
    }
  } catch (hierarchyErr) {
    // Fall through to traditional chunking
    console.warn('[document-intelligence] hierarchical chunking failed, falling back:', hierarchyErr.message);
  }

  // Fall back: structured splitting by sheets/headings/pages
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
    sectionLevel: null,
    sectionPath: null,
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
  if (!extractedText && file.path && fs.existsSync(file.path)) {
    try {
      const workbookText = readXlsxToText(file.path);
      if (workbookText) {
        return extractSpreadsheetTables(file, workbookText);
      }
    } catch (_) { /* fall through */ }
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
  
  // Try to include structural information if available
  const hasSectionInfo = chunks.some(c => c.sectionTitle || c.sectionPath);
  let structureHint = '';
  if (hasSectionInfo) {
    const sections = [...new Set(chunks.filter(c => c.sectionTitle).map(c => c.sectionTitle))];
    if (sections.length > 0 && sections.length <= 15) {
      structureHint = ` Estructura: ${sections.slice(0, 8).join(' → ')}${sections.length > 8 ? ` +${sections.length - 8} more` : ''}.`;
    }
  }
  
  const firstChunk = chunks[0]?.text ? compactString(chunks[0].text, 420) : compactString(text, 420);
  const tablePart = tables.length ? ` Incluye ${tables.length} tabla(s) detectada(s).` : '';
  return `${title}: ${text.length} caracteres extraidos en ${chunks.length} fragmento(s).${structureHint}${tablePart} Vista inicial: ${firstChunk}`;
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
    hierarchical: chunks.some(c => c.sectionPath != null),
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

/**
 * Multi-strategy evidence retrieval for large documents.
 *
 * Unlike the old single-strategy keyword match, this searches for:
 *   1. Exact term match (chunk text contains query terms)
 *   2. Section path match (queries match section titles for navigation)
 *   3. Neighbor chunks (context around matched chunks)
 *   4. Strategy weighting for balanced coverage
 *
 * Returns ranked evidence with cross-references.
 */
async function retrieveEvidence(prisma, { userId, fileId, query, limit = MAX_EVIDENCE_CHUNKS } = {}) {
  if (!userId || !fileId || !query) {
    return { evidence: [], totalChunks: 0 };
  }

  const file = await prisma.file.findFirst({ where: { id: fileId, userId } });
  if (!file) return { evidence: [], totalChunks: 0 };

  const text = cleanText(file.extractedText || '');
  if (!hasUsefulText(text)) return { evidence: [], totalChunks: 0 };

  // Prefer stored document chunks (fine-grained, with section titles)
  // over rebuilding from scratch. Stored chunks preserve the original
  // document structure (chapter/section labels) for accurate term matching.
  let chunks = [];
  try {
    const analysis = await prisma.documentAnalysis.findFirst({
      where: { fileId, userId, status: 'ready' },
      select: { id: true },
    });
    if (analysis?.id) {
      const stored = await prisma.documentChunk.findMany({
        where: { analysisId: analysis.id },
        orderBy: { ordinal: 'asc' },
      });
      if (stored && stored.length > 0) {
        chunks = stored;
      }
    }
  } catch (_) {
    // Fall through to rebuild below
  }

  // Fall back to building chunks from extracted text if no stored chunks
  if (chunks.length === 0) {
    chunks = buildChunks(file, text);
  }
  const totalChunks = chunks.length;

  if (chunks.length === 0) return { evidence: [], totalChunks: 0 };

  // Extract query terms — both original and normalized
  const queryLower = String(query || '').toLowerCase().trim();
  if (!queryLower || queryLower.length < 3) {
    return {
      evidence: chunks.slice(0, limit).map((chunk, idx) => ({
        ...chunk,
        relevanceScore: 0,
        matchedTerms: [],
        contextChunks: [],
      })),
      totalChunks,
    };
  }

  // Extract significant terms from query (words 4+ chars, skip common words)
  const stopWords = new Set([
    'dame', 'para', 'como', 'este', 'esta', 'esto', 'con', 'por', 'que', 'del',
    'las', 'los', 'una', 'uno', 'mas', 'pero', 'sino', 'todo', 'entre', 'sobre',
    'cada', 'años', 'tiene', 'puede', 'hasta', 'desde', 'donde', 'análisis',
    'resumen', 'documento', 'archivo', 'adjunto', 'quiere', 'necesito', 'sobre',
    'también', 'tambien', 'información', 'informacion', 'requiere',
    'página', 'pagina', 'buscar', 'encontrar', 'mostrar', 'decir', 'hacer',
    'the', 'this', 'that', 'with', 'from', 'have', 'which', 'their', 'about',
    'would', 'could', 'should', 'other', 'there', 'analysis', 'summary',
    'document', 'information', 'search', 'find', 'show', 'tell', 'make',
  ]);

  const terms = Array.from(new Set(
    (queryLower.match(/[a-záéíóúñ0-9]{4,}/g) || [])
      .filter((t) => !stopWords.has(t))
  )).slice(0, MAX_TERMS_FOR_EVIDENCE);

  // Strategy 1: Exact term match in chunk text
  const scored = chunks.map((chunk) => {
    const chunkLower = (chunk.text || '').toLowerCase();
    const chunkTitle = (chunk.sectionTitle || chunk.sourceLabel || '').toLowerCase();

    let score = 0;
    const matchedTerms = [];

    for (const term of terms) {
      // Title match is weighted higher
      if (chunkTitle.includes(term)) {
        score += 8;
        matchedTerms.push(term);
      }
      // Content match
      if (chunkLower.includes(term)) {
        score += 3;
        if (!matchedTerms.includes(term)) matchedTerms.push(term);
      }
    }

    // Section path match (parent section relevance)
    const sectionPath = String(chunk.sectionPath || '').toLowerCase();
    for (const term of terms) {
      if (sectionPath.includes(term) && !matchedTerms.includes(term)) {
        score += 5;
        matchedTerms.push(term);
      }
    }

    // Strategy 2: Term frequency bonus (denser matches = more relevant)
    if (matchedTerms.length >= 2) {
      score += matchedTerms.length * 2;
    }

    return { ...chunk, relevanceScore: score, matchedTerms };
  });

  // Sort by relevance score descending
  const ranked = scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Strategy 3: Top-K selection + neighbor expansion. If there are real
  // matches, do not pad with zero-score chunks (often cover/metadata) before
  // adding neighbor context.
  const topK = Math.min(8, Math.max(3, Math.floor(limit / 2)));
  const positiveMatches = ranked.filter((chunk) => chunk.relevanceScore > 0);
  const topMatches = (positiveMatches.length ? positiveMatches : ranked).slice(0, topK);

  // Strategy 4: Add neighbor chunks for context continuity
  const neighborSet = new Set(topMatches.map((c) => c.ordinal));
  const neighbors = [];
  for (const match of topMatches) {
    for (let offset = 1; offset <= EVIDENCE_CHUNK_NEIGHBORS; offset++) {
      const before = chunks.find((c) => c.ordinal === match.ordinal - offset);
      const after = chunks.find((c) => c.ordinal === match.ordinal + offset);
      for (const candidate of [before, after]) {
        if (candidate && !neighborSet.has(candidate.ordinal)) {
          neighborSet.add(candidate.ordinal);
          neighbors.push({ ...candidate, relevanceScore: 1, matchedTerms: ['context'] });
        }
      }
    }
  }

  // Strategy 5: Include first/last chunks only when they have non-zero
  // relevance to the query. This ensures that document covers, title pages,
  // or boilerplate headers aren't injected as evidence when the user is
  // asking a deep document question about specific content.
  if (chunks.length > topK && chunks.length > EVIDENCE_CHUNK_NEIGHBORS * 2) {
    const firstChunk = scored.find((chunk) => chunk.ordinal === chunks[0]?.ordinal) || chunks[0];
    const lastChunk = scored.find((chunk) => chunk.ordinal === chunks[chunks.length - 1]?.ordinal) || chunks[chunks.length - 1];
    // Only include first/last if they carry relevance to the query
    const firstRelevant = firstChunk.relevanceScore > 0;
    const lastRelevant = lastChunk.relevanceScore > 0;
    if (firstRelevant && !neighborSet.has(firstChunk.ordinal)) {
      neighborSet.add(firstChunk.ordinal);
      neighbors.push({ ...firstChunk, relevanceScore: 1, matchedTerms: ['overview'] });
    }
    if (lastRelevant && !neighborSet.has(lastChunk.ordinal)) {
      neighborSet.add(lastChunk.ordinal);
      neighbors.push({ ...lastChunk, relevanceScore: 1, matchedTerms: ['overview'] });
    }
  }

  // Merge and deduplicate
  const allEvidence = [...topMatches, ...neighbors];
  const seen = new Set();
  const deduped = [];
  for (const item of allEvidence) {
    const key = item.ordinal || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Restore original ordinal order for final output
  const sorted = deduped.sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
  const finalEvidence = sorted.slice(0, limit);

  return { evidence: finalEvidence, totalChunks };
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

module.exports = {
  analyzeFile,
  getAnalysisForFile,
  retrieveEvidence,
  buildChunks,
  buildTables,
  hasUsefulText,
  cleanText,
  inferCounts,
};
