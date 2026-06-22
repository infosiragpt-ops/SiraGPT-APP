'use strict';

/**
 * csv-dialect-detector — auto-detects CSV/TSV dialect properties:
 *   - delimiter (comma, tab, semicolon, pipe)
 *   - line ending (CRLF, LF, CR)
 *   - whether the first row looks like a header
 *   - quoting character (double quote, single quote)
 *   - encoding
 *
 * Works by analyzing the first 100 lines of the file and applying
 * statistical heuristics.
 */

const fs = require('fs');
const { detectEncoding } = require('./text-encoding-detector');

const SAMPLE_LINES = 100;
const MAX_SAMPLE_BYTES = 1048576; // 1 MB

const CANDIDATE_DELIMITERS = [
  { char: ',', name: 'comma' },
  { char: '\t', name: 'tab' },
  { char: ';', name: 'semicolon' },
  { char: '|', name: 'pipe' },
  { char: ':', name: 'colon' },
  { char: '\x1F', name: 'unit-separator' },
  { char: '^', name: 'caret' },
  { char: '~', name: 'tilde' },
];

/**
 * Split a CSV line by delimiter, respecting quoted fields (RFC 4180).
 * Fields wrapped in quotes may contain embedded delimiters and escaped
 * quotes (doubled quotes "" inside a quoted field).
 *
 * @param {string} line
 * @param {string} delim
 * @param {string} [quote='"']
 * @returns {string[]}
 */
function splitCSVLine(line, delim, quote = '"') {
  if (!line || typeof line !== 'string') return [];
  const fields = [];
  let current = '';
  let inQuotes = false;
  const q = quote || '"';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === q) {
        // Escaped quote (doubled) or closing quote
        if (line[i + 1] === q) {
          current += q;
          i++; // skip the second quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === q) {
        inQuotes = true;
      } else if (ch === delim) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Score a delimiter by checking consistency of column counts across rows.
 * Uses quote-aware splitting to avoid miscounting embedded delimiters.
 * Returns { delimiter, score, variance, avgCols, rowsWithDelimiter }.
 */
function scoreDelimiter(lines, delim) {
  let totalCols = 0;
  let rowCounts = [];
  let rowsWithDelimiter = 0;
  let totalRows = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    totalRows++;
    const count = splitCSVLine(trimmed, delim).length;
    if (count > 1) {
      rowsWithDelimiter++;
      rowCounts.push(count);
      totalCols += count;
    }
  }

  if (rowCounts.length < 2) return { delimiter: delim, score: 0, variance: Infinity, avgCols: 0, rowsWithDelimiter: 0 };

  const avgCols = totalCols / rowCounts.length;
  const variance = rowCounts.reduce((sum, c) => sum + Math.pow(c - avgCols, 2), 0) / rowCounts.length;
  const consistency = 1 / (1 + variance);
  const prevalence = rowsWithDelimiter / Math.max(totalRows, 1);

  return {
    delimiter: delim,
    score: consistency * 0.6 + prevalence * 0.4,
    variance,
    avgCols: Math.round(avgCols),
    rowsWithDelimiter,
  };
}

/**
 * Detect whether the first line looks like a header.
 * A header is likely if: columns contain common header patterns (lowercase,
 * underscores, short), while data rows contain numbers/dates.
 */
function detectHeader(lines, delim, avgCols) {
  if (lines.length < 2) return false;
  const firstRow = splitCSVLine(lines[0], delim).map(c => c.trim().toLowerCase());

  let headerScore = 0;
  for (const col of firstRow) {
    const isNumeric = /^\d+(\.\d+)?$/.test(col);
    const isDate = /^\d{2,4}[\/-]\d{2,4}[\/-]\d{2,4}$/.test(col);
    const isShort = col.length <= 40;
    const hasText = /[a-záéíóúñ]/.test(col);

    if (!isNumeric && !isDate && isShort && hasText) headerScore++;
    if (isNumeric || isDate) headerScore--;
  }

  const headerRatio = headerScore / Math.max(firstRow.length, 1);

  const dataRowsToCheck = Math.min(lines.length - 1, 5);
  let dataCount = 0;
  let totalDataCols = 0;
  for (let r = 1; r <= dataRowsToCheck; r++) {
    const cols = splitCSVLine(lines[r], delim).map(c => c.trim());
    for (const col of cols) {
      totalDataCols++;
      if (/^\d+(\.\d+)?$/.test(col) || /^\d{2,4}[\/-]\d{2,4}[\/-]\d{2,4}$/.test(col)) {
        dataCount++;
      }
    }
  }
  const dataRatio = totalDataCols > 0 ? dataCount / totalDataCols : 0;

return headerRatio > 0.50 || (headerRatio > 0.30 && dataRatio > 0.20);
}

/**
 * Detect the quoting character used in a CSV.
 */
function detectQuote(lines, delim) {
  let dqCount = 0;
  let sqCount = 0;
  let rowsChecked = 0;

  for (const line of lines) {
    if (rowsChecked >= 50) break;
    if (!line.includes(delim)) continue;
    rowsChecked++;
    dqCount += (line.match(/\u0022/g) || []).length;
    sqCount += (line.match(/\u0027/g) || []).length;
  }

  if (dqCount > sqCount && dqCount > 2) return '"';
  if (sqCount > dqCount && sqCount > 2) return "'";
  return '"';
}

/**
 * Detect line ending.
 */
function detectLineEnding(rawSample) {
  const text = rawSample.toString('utf8', 0, Math.min(rawSample.length, MAX_SAMPLE_BYTES));
  let crlf = 0, lf = 0, cr = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') { crlf++; i++; }
    else if (text[i] === '\n') lf++;
    else if (text[i] === '\r') cr++;
  }

  if (crlf >= lf && crlf >= cr) return '\r\n';
  if (lf >= crlf && lf >= cr) return '\n';
  if (cr >= crlf && cr >= lf) return '\r';
  return '\n';
}

/**
 * Main CSV dialect detection.
 */
async function detectDialect(input) {
  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input.length > MAX_SAMPLE_BYTES ? input.slice(0, MAX_SAMPLE_BYTES) : input;
  } else if (typeof input === 'string') {
    const fd = await fs.promises.open(input, 'r');
    try {
      const { bytesRead, buffer: buf } = await fd.read(Buffer.alloc(MAX_SAMPLE_BYTES), 0, MAX_SAMPLE_BYTES, 0);
      buffer = buf.slice(0, bytesRead);
    } finally {
      await fd.close();
    }
  } else {
    return { delimiter: ',', delimiterName: 'comma', header: true, quote: '"', lineEnding: '\n', encoding: 'utf8', avgColumns: 0, rowsAnalyzed: 0 };
  }

  if (!buffer || buffer.length === 0) {
    return { delimiter: ',', delimiterName: 'comma', header: false, quote: '"', lineEnding: '\n', encoding: 'utf8', avgColumns: 0, rowsAnalyzed: 0 };
  }

  const encodingDet = await detectEncoding(buffer);
  let text;
  try {
    text = buffer.toString(encodingDet.encoding || 'utf8');
  } catch {
    text = buffer.toString('utf8');
  }

  const allLines = text.split(/\r\n|\n|\r/);
  const skipRows = allLines.filter(l => l.startsWith('#')).length;
  const usableLines = allLines.slice(skipRows, SAMPLE_LINES + skipRows).filter(l => l.trim());
  const dataLines = usableLines.slice(skipRows);

  // Carry the human-readable name through — scoreDelimiter only returns the
  // delimiter char/score, so best.name (and thus dialect.delimiterName) used to
  // come out undefined on the success path, surfacing as
  // "Detected dialect: undefined" in formatCsvBlock.
  const scores = CANDIDATE_DELIMITERS.map(d => ({ ...scoreDelimiter(dataLines, d.char), name: d.name }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (best.score < 0.20) {
    return {
      delimiter: ',', delimiterName: 'comma', header: false, quote: '"',
      lineEnding: detectLineEnding(buffer), encoding: encodingDet.encoding,
      avgColumns: 0, rowsAnalyzed: dataLines.length,
    };
  }

  const header = detectHeader(dataLines, best.delimiter, best.avgCols);
  const quote = detectQuote(dataLines, best.delimiter);
  const lineEnding = detectLineEnding(buffer);

  return {
    delimiter: best.delimiter,
    delimiterName: best.name,
    header,
    quote,
    lineEnding,
    encoding: encodingDet.encoding,
    avgColumns: best.avgCols,
    rowsAnalyzed: dataLines.length,
  };
}
/**
 * Parse CSV data into structured rows with dialect auto-detection.
 */
async function parseCSV(filePath, opts = {}) {
  const maxRows = opts.maxRows || 5000;
  const dialect = await detectDialect(filePath);
  let text;
  try {
    text = fs.readFileSync(filePath, dialect.encoding || 'utf8');
  } catch {
    text = fs.readFileSync(filePath, 'utf8');
  }

  const allLines = text.split(dialect.lineEnding || '\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  let headers = [];
  let dataStart = 0;
  if (dialect.header && allLines.length > 0) {
    headers = splitCSVLine(allLines[0], dialect.delimiter, dialect.quote).map(c => c.trim());
    dataStart = 1;
  }

  const rows = [];
  for (let i = dataStart; i < Math.min(allLines.length, maxRows + dataStart); i++) {
    const cols = splitCSVLine(allLines[i], dialect.delimiter, dialect.quote).map(c => c.trim());
    rows.push(cols);
  }

  return { headers, rows, dialect, encoding: dialect.encoding };
}

/**
 * Format parsed CSV data as a readable text block.
 */
function formatCsvBlock({ headers, rows, dialect, encoding }) {
  const blocks = [];
  if (dialect.delimiterName !== 'comma') {
    blocks.push(`# Detected dialect: ${dialect.delimiterName} (encoding: ${encoding || 'utf8'})`);
  }
  if (headers.length > 0) {
    blocks.push(`# Columns: ${headers.join(' | ')}`);
    blocks.push(headers.join(dialect.delimiter));
  }
  blocks.push(rows.map(r => r.join(dialect.delimiter)).join('\n'));
  return blocks.join('\n');
}

module.exports = {
  detectDialect,
  parseCSV,
  formatCsvBlock,
  splitCSVLine,
  CANDIDATE_DELIMITERS,
};
