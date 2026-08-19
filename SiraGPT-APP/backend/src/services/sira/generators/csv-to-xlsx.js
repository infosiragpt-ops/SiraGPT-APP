"use strict";

/**
 * CSV → XLSX passthrough generator.
 *
 * When the source is already CSV and the target is XLSX, we don't need
 * to drag in ExcelJS or run a full spreadsheet parse: we tokenise the
 * CSV with a minimal RFC-4180 reader and emit an OOXML SpreadsheetML
 * package directly. The result is a syntactically valid `.xlsx` that
 * Excel, LibreOffice and Numbers all open.
 *
 * Plan shape:
 *   {
 *     csv:        string | Buffer        // raw CSV (required)
 *     sheetName?: string,                 // default "Sheet1"
 *     delimiter?: ",", ";", "\t" | …      // default auto-detected (",")
 *     header?:    boolean,                // bold first row (default: false)
 *     trim?:      boolean,                // trim whitespace from cells
 *   }
 *
 * Returns { buffer, mime, extension }.
 */

const { zipBuild, xmlEscape } = require("./zip-utils");

const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXT = "xlsx";

const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/;

/**
 * Parse CSV text into a 2-D array of cell values. Implements the
 * common subset of RFC 4180:
 *   - fields separated by `delimiter`
 *   - rows separated by \r\n, \n or \r
 *   - fields may be wrapped in double quotes
 *   - inside a quoted field, "" → "
 *   - unquoted leading/trailing whitespace is preserved unless trim=true
 */
function parseCsv(text, { delimiter = ",", trim = false } = {}) {
  const src = typeof text === "string" ? text : Buffer.isBuffer(text) ? text.toString("utf8") : String(text ?? "");
  // Strip BOM
  const s = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;

  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const len = s.length;

  const pushField = () => {
    row.push(trim ? field.trim() : field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === "\r") {
      pushRow();
      if (s[i + 1] === "\n") i += 2; else i++;
      continue;
    }
    if (ch === "\n") { pushRow(); i++; continue; }

    field += ch; i++;
  }

  // Trailing field / row (only if there's pending content)
  if (field.length > 0 || row.length > 0 || (rows.length === 0 && len > 0)) {
    pushRow();
  }

  // Drop a single trailing empty row caused by a final newline
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
  }
  return rows;
}

function autoDetectDelimiter(text) {
  // Look at the first non-empty line; pick the candidate with the
  // highest count outside of quoted regions.
  const sample = (typeof text === "string" ? text : String(text || "")).slice(0, 4096);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQ = false;
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "\n" && !inQ) break;
      if (ch === d && !inQ) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

// 1 → "A", 26 → "Z", 27 → "AA"
function colLetter(n) {
  let s = "";
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

function isNumericCell(v) {
  if (typeof v !== "string") return false;
  if (v.length === 0) return false;
  // Reject leading zeros (likely identifiers like "00123")
  if (/^-?0\d/.test(v)) return false;
  return NUMERIC_RE.test(v);
}

function isBooleanCell(v) {
  return v === "TRUE" || v === "FALSE" || v === "true" || v === "false";
}

function buildSheetXml(rows, { header = false } = {}) {
  let maxCols = 0;
  for (const r of rows) if (r.length > maxCols) maxCols = r.length;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');

  if (maxCols > 0 && rows.length > 0) {
    const ref = `A1:${colLetter(maxCols)}${rows.length}`;
    lines.push(`<dimension ref="${ref}"/>`);
  }

  lines.push("<sheetData>");
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowNum = r + 1;
    const isHeaderRow = header && r === 0;
    const styleAttr = isHeaderRow ? ' s="1"' : "";
    lines.push(`<row r="${rowNum}">`);
    for (let c = 0; c < row.length; c++) {
      const ref = `${colLetter(c + 1)}${rowNum}`;
      const raw = row[c];
      if (raw === "" || raw === null || raw === undefined) continue;
      if (!isHeaderRow && isNumericCell(raw)) {
        lines.push(`<c r="${ref}"><v>${raw}</v></c>`);
      } else if (!isHeaderRow && isBooleanCell(raw)) {
        const b = raw.toLowerCase() === "true" ? 1 : 0;
        lines.push(`<c r="${ref}" t="b"><v>${b}</v></c>`);
      } else {
        lines.push(`<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(raw))}</t></is></c>`);
      }
    }
    lines.push("</row>");
  }
  lines.push("</sheetData>");
  lines.push("</worksheet>");
  return lines.join("");
}

function buildContentTypes() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    "</Types>",
  ].join("");
}

function buildRootRels() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    "</Relationships>",
  ].join("");
}

function buildWorkbookRels() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>",
  ].join("");
}

function buildWorkbook(sheetName) {
  const safe = sanitiseSheetName(sheetName);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheets>",
    `<sheet name="${xmlEscape(safe)}" sheetId="1" r:id="rId1"/>`,
    "</sheets>",
    "</workbook>",
  ].join("");
}

function buildStyles() {
  // Two cellXfs: 0 = default, 1 = bold (header)
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border/></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="2">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    "</cellXfs>",
    "</styleSheet>",
  ].join("");
}

// Excel sheet names are 1-31 chars and may not contain : \ / ? * [ ]
function sanitiseSheetName(name) {
  let s = String(name == null || name === "" ? "Sheet1" : name);
  s = s.replace(/[:\\/?*\[\]]/g, "_");
  if (s.length === 0) s = "Sheet1";
  if (s.length > 31) s = s.slice(0, 31);
  return s;
}

/**
 * @param {object} plan
 * @returns {{ buffer: Buffer, mime: string, extension: string }}
 */
function generateCsvToXlsx(plan) {
  if (!plan || (typeof plan !== "object" && typeof plan !== "string")) {
    throw new Error("csv-to-xlsx: plan must be an object or CSV string");
  }
  const opts = typeof plan === "string" ? { csv: plan } : plan;
  const csv = opts.csv;
  if (csv == null || (typeof csv !== "string" && !Buffer.isBuffer(csv))) {
    throw new Error("csv-to-xlsx: plan.csv must be a string or Buffer");
  }
  const csvText = typeof csv === "string" ? csv : csv.toString("utf8");
  const delimiter = opts.delimiter || autoDetectDelimiter(csvText);
  const rows = parseCsv(csvText, { delimiter, trim: !!opts.trim });

  const sheetXml = buildSheetXml(rows, { header: !!opts.header });

  const entries = [
    // The order doesn't matter for XLSX; keep it readable.
    { name: "[Content_Types].xml", data: buildContentTypes() },
    { name: "_rels/.rels", data: buildRootRels() },
    { name: "xl/workbook.xml", data: buildWorkbook(opts.sheetName) },
    { name: "xl/_rels/workbook.xml.rels", data: buildWorkbookRels() },
    { name: "xl/styles.xml", data: buildStyles() },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
  ];

  const buffer = zipBuild(entries);
  return { buffer, mime: MIME, extension: EXT, rowCount: rows.length };
}

module.exports = {
  generateCsvToXlsx,
  parseCsv,
  autoDetectDelimiter,
  colLetter,
  MIME,
  EXT,
};
