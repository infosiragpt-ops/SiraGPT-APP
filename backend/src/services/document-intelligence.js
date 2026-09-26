const fs = require('fs');
const hierarchicalChunker = require('./document/hierarchical-document-chunker');
const { documentTokens, searchDocumentLexical } = require('./rag/document-retrieval');

const OCR_PLACEHOLDER_RE = /^(no text found in image|no text detected(?: in image pdf)?|no content available|binary file|file content could not be extracted|file ".*?" uploaded successfully|error processing file:|unsupported file type)/i;

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
  const text = cleanText(value);
  if (!text || OCR_PLACEHOLDER_RE.test(text)) return false;
  const usefulChars = (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length;
  const minUsefulChars = Number(process.env.OCR_MIN_USEFUL_CHARS);
  const threshold = Math.min(3, Number.isFinite(minUsefulChars) ? minUsefulChars : 20);
  return usefulChars >= threshold;
}

function looksLikeUnsupportedExtractionPlaceholder(value) {
  const text = String(value || '').trim();
  return /^File\s+"[^"]+"\s+uploaded successfully\.\s+Content type:\s+application\/(?:octet-stream|zip|x-zip|x-zip-compressed)\.?$/i.test(text);
}

function hasProcessableStoredText(value) {
  return hasUsefulText(value) && !looksLikeUnsupportedExtractionPlaceholder(value);
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

function splitEscapedColumns(line, trimEdges = false) {
  const cells = [];
  let cell = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && /[\\|]/.test(line[i + 1] || '')) {
      cell += line[++i];
    } else if (line[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += line[i];
  }
  cells.push(cell.trim());
  if (trimEdges && cells[0] === '') cells.shift();
  if (trimEdges && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function uniqueColumnNames(columns) {
  const used = new Set();
  return columns.map((column, index) => {
    const base = column || `Columna ${index + 1}`;
    let name = base;
    let duplicate = 2;
    while (used.has(name)) name = `${base} (${duplicate++})`;
    used.add(name);
    return name;
  });
}

function spreadsheetChunks(sheet) {
  const lines = sheet.text.split('\n');
  const separator = lines.findIndex(line => line.trim() === '---');
  if (separator < 0) return fallbackChunks(sheet.text, {}).map(chunk => ({ ...chunk, ...sheet, text: chunk.text }));
  const coordinates = lines.find(line => /^Row coordinates:/.test(line));
  const physicalRows = coordinates ? coordinates.replace(/^Row coordinates:\s*/, '').split(',').map(Number) : [];
  const rawHeader = lines.slice(0, separator).filter(line => !/^Row coordinates:/.test(line)).join('\n') + '\n';
  const headerTruncated = rawHeader.length > MAX_CHUNK_CHARS / 2;
  const header = headerTruncated
    ? rawHeader.slice(0, Math.floor(MAX_CHUNK_CHARS / 2) - 50) + '\n[truncated: oversized spreadsheet header]\n'
    : rawHeader;
  const headerFor = numbers => header + (numbers.length ? `Row coordinates: ${[...new Set(numbers)].join(',')}\n` : '') + '---\n';
  const chunks = [];
  let body = '';
  let rowNumbers = [];
  const flush = () => {
    if (!body) return;
    const rowStart = rowNumbers.length ? Math.min(...rowNumbers) : null;
    const rowEnd = rowNumbers.length ? Math.max(...rowNumbers) : null;
    const columns = rawHeader.match(/Column range:\s*([A-Z]+):([A-Z]+)/);
    const cellRange = rowStart && columns ? `${columns[1]}${rowStart}:${columns[2]}${rowEnd}` : null;
    chunks.push({
      sourceType: 'sheet',
      sheetName: sheet.sheetName,
      sourceLabel: cellRange ? `${sheet.sheetName}!${cellRange}` : sheet.sourceLabel,
      text: headerFor(rowNumbers) + body.replace(/\n$/, ''),
      metadata: { sheetName: sheet.sheetName, rowStart, rowEnd, cellRange, headerTruncated },
    });
    body = '';
    rowNumbers = [];
  };
  const dataLines = lines.slice(separator + 1);
  let indexingTruncated = false;
  for (let lineIndex = 0; lineIndex < dataLines.length; lineIndex += 1) {
    const line = dataLines[lineIndex];
    if (!line.trim()) continue;
    const rowNumber = physicalRows[lineIndex] > 0 ? physicalRows[lineIndex] : null;
    const nextRows = rowNumber ? [...rowNumbers, rowNumber] : rowNumbers;
    if (headerFor(nextRows).length + body.length + line.length + 1 > MAX_CHUNK_CHARS) flush();
    const singleRows = rowNumber ? [rowNumber] : [];
    const budget = Math.max(1, MAX_CHUNK_CHARS - headerFor(singleRows).length - 1);
    if (line.length + 1 <= budget) {
      body += line + '\n';
      if (rowNumber) rowNumbers.push(rowNumber);
    } else {
      // Long cells remain complete across continuations. Their metadata keeps
      // the same physical row; TSV fields stay compatible with other readers.
      for (let offset = 0; offset < line.length; offset += budget) {
        body = line.slice(offset, offset + budget);
        rowNumbers = singleRows;
        flush();
        if (chunks.length >= MAX_CHUNKS) {
          indexingTruncated = offset + budget < line.length;
          break;
        }
      }
    }
    if (chunks.length >= MAX_CHUNKS) {
      indexingTruncated ||= lineIndex < dataLines.length - 1 || Boolean(body);
      break;
    }
  }
  if (chunks.length < MAX_CHUNKS) flush();
  if (indexingTruncated && chunks.length) chunks[chunks.length - 1].metadata.indexingTruncated = true;
  if (!chunks.length) chunks.push({ ...sheet, text: headerFor([]).trimEnd() });
  return chunks;
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

  // Worksheets are not prose headings. Parse them before the generic hierarchy
  // so later chunks retain sheet identity, column names and exact row anchors.
  const sheets = isSpreadsheet(file) ? splitBySpreadsheetSheets(text) : [];
  if (sheets.length) {
    const all = sheets.flatMap(spreadsheetChunks);
    const selected = all.slice(0, MAX_CHUNKS);
    if (all.length > selected.length && selected.length) {
      selected[selected.length - 1].metadata = { ...selected[selected.length - 1].metadata, indexingTruncated: true };
    }
    return selected.map((chunk, index) => ({
      ...chunk, ordinal: index + 1, pageNumber: null, slideNumber: null,
      sectionTitle: null, sectionLevel: null, sectionPath: null,
      charCount: chunk.text.length,
    }));
  }

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

async function extractSpreadsheetTables(file = {}, extractedText = '') {
  if (!isSpreadsheet(file)) return [];
  if (!extractedText && file.path && fs.existsSync(file.path)) {
    try {
      const workbookText = await readXlsxToText(file.path);
      if (workbookText) {
        return extractSpreadsheetTables(file, workbookText);
      }
    } catch (_) { /* fall through */ }
  }
  const sheets = splitBySpreadsheetSheets(extractedText);
  return sheets.map((sheet, index) => {
    // Leading TSV tabs are empty cells, not whitespace to trim: removing them
    // shifts every remaining value under the wrong column name.
    const lines = String(sheet.text || '').split('\n').filter(line => line.trim());
    const columnsLine = lines.find((line) => /^Columns\s*\(/i.test(line));
    const columns = columnsLine
      ? uniqueColumnNames(splitEscapedColumns(columnsLine.replace(/^Columns\s*\(\d+\):\s*/i, '')))
      : [];
    const totalMatch = lines.find((line) => /^Total data rows:/i.test(line))?.match(/Total data rows:\s*(\d+)/i);
    const dataStart = lines.findIndex((line) => line === '---');
    const dataLines = dataStart >= 0 ? lines.slice(dataStart + 1) : [];
    const preview = dataLines
      .filter((line) => !/^(?:\.\.\.\s*)?\[truncated:|^\.\.\.\s*\[/i.test(line))
      .slice(0, MAX_TABLE_PREVIEW_ROWS)
      .map((line) => {
        const values = line.split('\t').map(value => {
          const decoded = /Cell escapes:/.test(sheet.text)
            ? value.replace(/\\([\\nt])/g, (_, escaped) => ({ '\\': '\\', n: '\n', t: '\t' })[escaped])
            : value;
          return normalizeCell(decoded);
        });
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

function cellToText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // ExcelJS rich-text / hyperlink / formula objects
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.richText)) {
      return value.richText.map((piece) => piece?.text ?? '').join('');
    }
    if ('result' in value) return cellToText(value.result);
    if ('hyperlink' in value) return String(value.hyperlink || '');
    if ('formula' in value) return String(value.formula || '');
  }
  return String(value);
}

async function readXlsxToText(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const parts = [];
  workbook.eachSheet((sheet) => {
    const sheetName = sheet.name;
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      // row.values is 1-indexed in ExcelJS
      const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (const value of raw) values.push(cellToText(value));
      rows.push(values);
    });
    if (!rows.length) {
      const lines = [];
      lines.push(`Sheet: ${sheetName}`);
      lines.push(`Columns (0): `);
      lines.push(`Total data rows: 0`);
      lines.push('---');
      parts.push(lines.join('\n'));
      return;
    }
    const headerRow = rows[0];
    const dataRows = rows.slice(1);
    // Truncate trailing empty header cells
    let lastCol = headerRow.length;
    while (lastCol > 0 && !headerRow[lastCol - 1]) lastCol -= 1;
    const columns = headerRow.slice(0, lastCol).map((value) => (value == null ? '' : String(value)));
    const lines = [];
    lines.push(`Sheet: ${sheetName}`);
    lines.push(`Columns (${columns.length}): ${columns.join('|')}`);
    lines.push(`Total data rows: ${dataRows.length}`);
    lines.push('---');
    for (const row of dataRows) {
      const padded = [];
      for (let i = 0; i < columns.length; i++) padded.push(row[i] == null ? '' : String(row[i]));
      lines.push(padded.join('\t'));
    }
    parts.push(lines.join('\n'));
  });
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
    const columns = uniqueColumnNames(splitEscapedColumns(header, true));
    const previewRows = tableLines.slice(2, 2 + MAX_TABLE_PREVIEW_ROWS).map((line) => {
      const values = splitEscapedColumns(line, true).map(cell => cell.replace(/<br\s*\/?\s*>/gi, '\n'));
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
  if (mime !== 'text/csv' && !name.endsWith('.csv') && !name.endsWith('.tsv')) return [];
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  // Multi-delimiter detection: score comma, semicolon, tab, pipe
  const delimiters = [',', ';', '\t', '|'];
  let bestDelimiter = ',';
  let bestScore = -Infinity;

  for (const d of delimiters) {
    const cols = lines[0].split(d).length;
    if (cols < 2) continue;
    // Consistency check: test first 5 lines
    const counts = [];
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      counts.push(lines[i].split(d).length);
    }
    if (counts.length < 2) continue;
    const unique = new Set(counts);
    const score = cols * 10 / (1 + unique.size);
    if (score > bestScore) { bestScore = score; bestDelimiter = d; }
  }

  const delimiter = bestDelimiter;
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

async function buildTables(file = {}, extractedText = '') {
  const spreadsheetTables = (await extractSpreadsheetTables(file, extractedText)).filter((table) => table.columns.length > 0);
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
  const partial = /\[truncated:|\[\d+ more row\(s\) omitted|\(partial —/i.test(text)
    || chunks.some(chunk => chunk.metadata?.indexingTruncated || chunk.metadata?.headerTruncated);
  const status = hasUsefulText(text) ? (partial ? 'partial' : 'complete') : 'empty';
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

function buildWarnings({ file, text, ocr, tables, chunks = [] }) {
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
  if (/\[truncated:|\[\d+ more row\(s\) omitted|\(partial —/i.test(text)) {
    warnings.push({ code: 'partial_extraction', message: 'El documento supera un límite de lectura. La información recuperada no representa todo el archivo.' });
  }
  if (chunks.some(chunk => chunk.metadata?.indexingTruncated || chunk.metadata?.headerTruncated)) {
    warnings.push({ code: 'partial_index', message: 'El índice alcanzó un límite de seguridad. Conviene consultar una parte más pequeña del documento.' });
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
  if (hasProcessableStoredText(file?.extractedText) || !file?.path || !fs.existsSync(file.path)) {
    return { file, result: null };
  }
  try {
    const fileProcessor = require('./fileProcessor');
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
  const tables = await buildTables(file, text);
  const counts = inferCounts(file, text);
  const warnings = buildWarnings({ file, text, ocr, tables, chunks });
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
    // Persist ONLY columns that exist on the DocumentChunk model. Chunk
    // objects carry extra structural fields (e.g. sectionLevel, sectionPath)
    // that live inside `metadata`, not as table columns — spreading the raw
    // chunk made createMany throw `Unknown argument` and broke analysis for
    // any sectioned document (DOCX/markdown). Whitelisting keeps this robust
    // against future chunk-shape additions without a migration.
    await prisma.documentChunk.createMany({
      data: chunks.map((chunk) => ({
        analysisId: analysis.id,
        fileId: file.id,
        ordinal: chunk.ordinal,
        sourceType: chunk.sourceType,
        sourceLabel: chunk.sourceLabel ?? null,
        pageNumber: chunk.pageNumber ?? null,
        sheetName: chunk.sheetName ?? null,
        slideNumber: chunk.slideNumber ?? null,
        sectionTitle: chunk.sectionTitle ?? null,
        text: chunk.text,
        charCount: chunk.charCount ?? (typeof chunk.text === 'string' ? chunk.text.length : 0),
        metadata: chunk.metadata ?? null,
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
  const hasStructuredSheets = isSpreadsheet(file) && splitBySpreadsheetSheets(text).length > 0;
  if (chunks.length === 0 || (hasStructuredSheets && chunks.some(chunk => !chunk.metadata?.sheetName))) {
    chunks = buildChunks(file, text);
  }
  const totalChunks = chunks.length;

  if (chunks.length === 0) return { evidence: [], totalChunks: 0 };

  // Search uses a normalized copy only: short IDs, decimals and accents must
  // not disappear, and returned evidence keeps the document's exact values.
  const terms = [...new Set(documentTokens(String(query || '')))].slice(0, MAX_TERMS_FOR_EVIDENCE);
  if (!terms.length) {
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

  const entries = chunks.map(chunk => ({
    title: [chunk.sectionTitle, chunk.sourceLabel, chunk.sectionPath || chunk.metadata?.sectionPath].filter(Boolean).join(' '),
    text: chunk.text || '',
  }));
  const lexicalHits = new Map(searchDocumentLexical(entries.map(entry => ({ text: entry.text })), terms.join(' '), chunks.length)
    .map(hit => [hit.doc._idx, hit]));
  const structuralHits = new Map(searchDocumentLexical(entries.map(entry => ({ text: entry.title })), terms.join(' '), chunks.length)
    .map(hit => [hit.doc._idx, hit]));
  // BM25 makes a specific case number stronger than boilerplate words shared
  // by every passage. Structural labels and ancestor sections remain indexed.
  const scored = chunks.map((chunk, index) => {
    const hit = lexicalHits.get(index);
    const structuralHit = structuralHits.get(index);
    const tokens = new Set(documentTokens(`${entries[index].title}\n${entries[index].text}`));
    const matchedTerms = terms.filter(term => tokens.has(term));
    // Page 7 in a source label is weaker than Case 7 in the actual content.
    // Section-path-only navigation still works through its separate score.
    const relevanceScore = (hit ? hit.score * (1 + hit.coverage) : 0)
      + (structuralHit ? 0.35 * structuralHit.score * (1 + structuralHit.coverage) : 0);
    return { ...chunk, relevanceScore, matchedTerms };
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
          // Context is not a lexical hit. BM25 scores can be below 1, so a
          // fixed bonus would let callers' score sorting evict real evidence.
          neighbors.push({ ...candidate, relevanceScore: 0, matchedTerms: ['context'] });
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
      neighbors.push({ ...firstChunk, matchedTerms: ['overview'] });
    }
    if (lastRelevant && !neighborSet.has(lastChunk.ordinal)) {
      neighborSet.add(lastChunk.ordinal);
      neighbors.push({ ...lastChunk, matchedTerms: ['overview'] });
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
  // Budget by relevance first. Sorting before slicing lets earlier neighbors
  // displace the actual match, especially when callers request one passage.
  const finalEvidence = deduped.slice(0, limit).sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));

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

/**
 * Compare two or more documents and return a comparison report with:
 *  - per-document summary + evidence for the query
 *  - shared / distinct terms between pairs
 *  - per-document table count
 */
async function compareDocuments(prisma, { userId, fileIds = [], query = '', limit = 5 } = {}) {
  if (!prisma?.file || !userId || !Array.isArray(fileIds) || fileIds.length < 2) {
    return { documents: [], comparisons: [] };
  }

  const documents = [];
  for (const fileId of fileIds) {
    let file = null;
    try {
      file = await prisma.file.findFirst({ where: { id: fileId, userId } });
    } catch (_) { file = null; }
    if (!file) continue;

    const text = cleanText(file.extractedText || '');
    const chunks = buildChunks(file, text);
    const tables = await buildTables(file, text);

    // Best-effort: persist analysis so retrieveEvidence sees stored chunks.
    try {
      await analyzeFile(prisma, { userId, fileId: file.id, fileRecord: file, force: true });
    } catch (_) { /* persistence is optional in tests/mocks */ }

    let evidence = [];
    try {
      const res = await retrieveEvidence(prisma, {
        userId,
        fileId: file.id,
        query: query || file.originalName || file.filename || 'documento',
        limit,
      });
      evidence = res.evidence || [];
    } catch (_) { evidence = []; }

    // Fallback: when no query/evidence match, surface the first chunk as
    // a deterministic representative so callers always have at least one
    // anchor per document.
    if (!evidence.length && chunks.length) {
      evidence = chunks.slice(0, 1).map((c) => ({ ...c, relevanceScore: 0, matchedTerms: [] }));
    }

    documents.push({
      fileId: file.id,
      originalName: file.originalName || file.filename || 'documento',
      mimeType: file.mimeType || null,
      summary: buildSummary(file, text, chunks, tables),
      chunkCount: chunks.length,
      tableCount: tables.length,
      evidence,
    });
  }

  // Pairwise comparisons — shared significant terms + simple deltas.
  const STOP = new Set([
    'para', 'como', 'este', 'esta', 'esto', 'con', 'por', 'que', 'del',
    'las', 'los', 'una', 'uno', 'mas', 'pero', 'sino', 'todo', 'entre', 'sobre',
    'cada', 'años', 'tiene', 'puede', 'hasta', 'desde', 'donde',
    'the', 'this', 'that', 'with', 'from', 'have', 'which', 'their', 'about',
  ]);
  function termsOf(text) {
    return new Set(
      (String(text || '').toLowerCase().match(/[a-záéíóúñ]{5,}/g) || [])
        .filter((t) => !STOP.has(t))
    );
  }

  const comparisons = [];
  for (let i = 0; i < documents.length; i++) {
    for (let j = i + 1; j < documents.length; j++) {
      const a = documents[i];
      const b = documents[j];
      const aTerms = termsOf(documents[i].summary + ' ' + (documents[i].evidence.map((e) => e.text).join(' ')));
      const bTerms = termsOf(documents[j].summary + ' ' + (documents[j].evidence.map((e) => e.text).join(' ')));
      const shared = [...aTerms].filter((t) => bTerms.has(t));
      const onlyA = [...aTerms].filter((t) => !bTerms.has(t));
      const onlyB = [...bTerms].filter((t) => !aTerms.has(t));
      comparisons.push({
        fileA: a.fileId,
        fileB: b.fileId,
        sharedTerms: shared.slice(0, 30),
        onlyInA: onlyA.slice(0, 30),
        onlyInB: onlyB.slice(0, 30),
        deltas: {
          chunkCount: a.chunkCount - b.chunkCount,
          tableCount: a.tableCount - b.tableCount,
        },
      });
    }
  }

  return { documents, comparisons };
}

module.exports = {
  analyzeFile,
  getAnalysisForFile,
  retrieveEvidence,
  buildChunks,
  buildTables,
  buildSummary,
  compareDocuments,
  hasUsefulText,
  cleanText,
  inferCounts,
};
