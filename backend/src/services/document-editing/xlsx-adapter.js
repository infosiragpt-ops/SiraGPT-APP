'use strict';

// Surgical XLSX editing via raw OOXML (pizzip) — NOT ExcelJS. Rationale:
// ExcelJS `workbook.xlsx.load()` crashes on chart-bearing workbooks
// ("Cannot read properties of undefined (reading 'anchors')") and on
// openpyxl table parts, and our own pipeline now emits xlsx WITH charts +
// tables, so users will upload them. Patching xl/worksheets/sheetN.xml and
// xl/styles.xml directly leaves charts/tables/styles/formulas byte-identical
// outside the exact cells/styles we touch. Every function is pure
// (buffer in → buffer out), no I/O.

const PizZip = require('pizzip');
const { excelColLetter } = require('../xlsx-safe-workbook');

// ── Column-letter ↔ index helpers ───────────────────────────────────────────
function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    n = n * 26 + (code - 64);
  }
  return n; // 1-based; 'A' → 1
}

function splitCellRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref).trim());
  if (!m) return null;
  return { col: m[1].toUpperCase(), colIndex: colLetterToIndex(m[1]), row: Number(m[2]) };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── Number-format catalogue (custom ids, allocated from 164 up) ─────────────
// Codes chosen to render identically in Excel and LibreOffice.
function formatCodeFor(numberFormat, currency = 'EUR') {
  switch (String(numberFormat || '').toLowerCase()) {
    case 'currency': {
      const cur = String(currency || 'EUR').toUpperCase();
      if (cur === 'USD' || cur === '$') return '"$"#,##0.00';
      if (cur === 'GBP') return '"£"#,##0.00';
      if (cur === 'PEN' || cur === 'S/') return '"S/."#,##0.00';
      return '#,##0.00\\ "€"'; // EUR default
    }
    case 'percent': return '0.0%';
    case 'date': return 'dd/mm/yyyy';
    case 'integer': return '#,##0';
    case 'decimal': return '#,##0.00';
    default: return null;
  }
}

// ── Sheet resolution: name → part path ──────────────────────────────────────
function listXlsxSheets(buffer) {
  const zip = new PizZip(buffer);
  const workbookXml = zip.file('xl/workbook.xml')?.asText() || '';
  const relsXml = zip.file('xl/_rels/workbook.xml.rels')?.asText() || '';
  const relTarget = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)) {
    relTarget[m[1]] = m[2].replace(/^\/?xl\//, '').replace(/^\.\//, '');
  }
  const hasCharts = zip.file(/^xl\/charts\//).length > 0;
  const hasTables = zip.file(/^xl\/tables\//).length > 0;
  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = (/name="([^"]*)"/.exec(tag) || [])[1] || '';
    const rid = (/r:id="([^"]+)"/.exec(tag) || [])[1] || '';
    const sheetId = (/sheetId="([^"]+)"/.exec(tag) || [])[1] || '';
    let target = relTarget[rid] || '';
    if (target && !target.startsWith('worksheets/') && !target.startsWith('xl/')) {
      target = `worksheets/${target}`;
    }
    const partName = target.startsWith('xl/') ? target : `xl/${target}`;
    sheets.push({ name, sheetId, relId: rid, partName, hasCharts, hasTables });
  }
  return sheets;
}

function resolveSheet(zip, sheetName) {
  const sheets = listXlsxSheets(zipBuffer(zip));
  if (!sheets.length) throw new Error('el libro no tiene hojas legibles');
  if (!sheetName) return sheets[0];
  const norm = (s) => String(s || '').trim().toLowerCase();
  const found = sheets.find((s) => norm(s.name) === norm(sheetName));
  return found || sheets[0];
}

// pizzip has no `.buffer` accessor helper we can rely on cross-version; keep
// the original buffer alongside the zip for re-resolution.
function zipBuffer(zip) {
  return zip.generate({ type: 'nodebuffer' });
}

// ── styles.xml surgery: register a numFmt + a cellXf that inherits the base ─
// xf's font/fill/border (so applying "currency" to a bold-blue cell keeps the
// bold blue). Returns { stylesXml, xfIndexForBase } where the caller maps each
// touched cell's current s= to the new xf index via getTargetXf().
function ensureNumFmtStyles(stylesXml, formatCode) {
  let xml = stylesXml;

  // 1. numFmts element — schema-ordered right after <styleSheet …>. Reuse an
  // existing numFmt with the same code if present.
  const escapedCode = xmlEscape(formatCode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingCode = new RegExp(`<numFmt\\b[^>]*formatCode="${escapedCode}"[^>]*numFmtId="(\\d+)"`);
  const existingCode2 = new RegExp(`<numFmt\\b[^>]*numFmtId="(\\d+)"[^>]*formatCode="${escapedCode}"`);
  let numFmtId = null;
  const em = existingCode.exec(xml) || existingCode2.exec(xml);
  if (em) {
    numFmtId = Number(em[1]);
  } else {
    // allocate max(163, existing custom ids)+1
    let maxId = 163;
    for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]));
    numFmtId = maxId + 1;
    const numFmtEl = `<numFmt numFmtId="${numFmtId}" formatCode="${xmlEscape(formatCode)}"/>`;
    if (/<numFmts\b[^>]*>/.test(xml)) {
      xml = xml.replace(/<numFmts\b([^>]*)count="(\d+)"([^>]*)>/, (_m, a, c, b) => `<numFmts${a}count="${Number(c) + 1}"${b}>`);
      xml = xml.replace(/<\/numFmts>/, `${numFmtEl}</numFmts>`);
    } else if (/<numFmts\b[^>]*\/>/.test(xml)) {
      xml = xml.replace(/<numFmts\b[^>]*\/>/, `<numFmts count="1">${numFmtEl}</numFmts>`);
    } else {
      xml = xml.replace(/(<styleSheet\b[^>]*>)/, `$1<numFmts count="1">${numFmtEl}</numFmts>`);
    }
  }

  return { stylesXml: xml, numFmtId };
}

// Parse cellXfs into an array of raw <xf …/> or <xf …>…</xf> strings.
function parseCellXfs(stylesXml) {
  const block = /<cellXfs\b([^>]*)>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!block) return { xfs: [], count: 0, raw: null };
  const xfs = [];
  for (const m of block[2].matchAll(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g)) xfs.push(m[0]);
  return { xfs, count: xfs.length, inner: block[2], attrs: block[1] };
}

// Given a base xf string, produce a clone carrying numFmtId + applyNumberFormat.
function cloneXfWithNumFmt(baseXf, numFmtId) {
  let xf = baseXf;
  // ensure single self-closing form for the clone (drop children like alignment? keep them)
  const isSelfClosing = /\/>\s*$/.test(xf.trim());
  const head = xf.replace(/<xf\b/, '<xf').match(/<xf\b[^>]*?(?:\/>|>)/)[0];
  const rest = xf.slice(head.length);
  let newHead = head
    .replace(/\s+numFmtId="\d+"/, '')
    .replace(/\s+applyNumberFormat="[^"]*"/, '')
    .replace(/(<xf\b)/, `$1 numFmtId="${numFmtId}" applyNumberFormat="1"`);
  if (isSelfClosing) return newHead;
  return newHead + rest;
}

function appendCellXf(stylesXml, xfString) {
  const block = /<cellXfs\b([^>]*)>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!block) {
    // create a minimal cellXfs (should never happen for a real workbook)
    const created = `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xfString}</cellXfs>`;
    return { stylesXml: stylesXml.replace(/(<\/styleSheet>)/, `${created}$1`), newIndex: 1 };
  }
  const countMatch = /count="(\d+)"/.exec(block[1]);
  const count = countMatch ? Number(countMatch[1]) : (block[2].match(/<xf\b/g) || []).length;
  const newIndex = count;
  let xml = stylesXml.replace(/<cellXfs\b([^>]*)>/, (m, a) => {
    if (/count="\d+"/.test(a)) return `<cellXfs${a.replace(/count="\d+"/, `count="${count + 1}"`)}>`;
    return `<cellXfs${a} count="${count + 1}">`;
  });
  xml = xml.replace(/<\/cellXfs>/, `${xfString}</cellXfs>`);
  return { stylesXml: xml, newIndex };
}

// ── Range expansion ─────────────────────────────────────────────────────────
function lastDataRow(sheetXml) {
  let maxRow = 1;
  for (const m of sheetXml.matchAll(/<c\b[^>]*\br="([A-Za-z]+)(\d+)"/g)) {
    maxRow = Math.max(maxRow, Number(m[2]));
  }
  return maxRow;
}

function expandRange({ sheetXml, range, column }) {
  // "D2:D11" → explicit; column "D" → D2..lastDataRow (skip header row 1)
  if (range && /:/.test(range)) {
    const [a, b] = range.split(':').map((r) => splitCellRef(r));
    if (!a || !b) return [];
    const cols = [];
    // Accept reversed refs (D5:B2) the same way Excel does.
    const c1 = Math.min(a.colIndex, b.colIndex), c2 = Math.max(a.colIndex, b.colIndex);
    for (let c = c1; c <= c2; c += 1) cols.push(excelColLetter(c));
    const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
    const cells = [];
    for (let r = r1; r <= r2; r += 1) for (const c of cols) cells.push(`${c}${r}`);
    return cells;
  }
  if (range && splitCellRef(range)) return [splitCellRef(range).col + splitCellRef(range).row];
  if (column) {
    const last = lastDataRow(sheetXml);
    const cells = [];
    for (let r = 2; r <= last; r += 1) cells.push(`${column.toUpperCase()}${r}`);
    return cells;
  }
  return [];
}

// ── Public op: format a range/column with a number format ───────────────────
function formatRange({ buffer, sheet, range, column, numberFormat, currency }) {
  const formatCode = formatCodeFor(numberFormat, currency);
  if (!formatCode) throw new Error(`formato numérico no soportado: ${numberFormat}`);
  const zip = new PizZip(buffer);
  const target = resolveSheet(zip, sheet);
  let sheetXml = zip.file(target.partName)?.asText();
  if (!sheetXml) throw new Error(`no pude leer la hoja «${target.name}»`);
  let stylesXml = zip.file('xl/styles.xml')?.asText();
  if (!stylesXml) throw new Error('el libro no tiene estilos (xl/styles.xml)');

  const cells = expandRange({ sheetXml, range, column });
  if (!cells.length) throw new Error('no pude interpretar el rango a formatear');

  const { stylesXml: styles1, numFmtId } = ensureNumFmtStyles(stylesXml, formatCode);
  stylesXml = styles1;

  const { xfs } = parseCellXfs(stylesXml);
  const remap = new Map(); // baseXfIndex → newXfIndex
  const baseXfIndexForNew = (baseIndex) => {
    if (remap.has(baseIndex)) return remap.get(baseIndex);
    const baseXf = xfs[baseIndex] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    const cloned = cloneXfWithNumFmt(baseXf, numFmtId);
    const { stylesXml: styles2, newIndex } = appendCellXf(stylesXml, cloned);
    stylesXml = styles2;
    remap.set(baseIndex, newIndex);
    return newIndex;
  };

  const targetSet = new Set(cells);
  let changed = 0;
  // Update existing cells' s= ; create missing cells so the format sticks.
  const seen = new Set();
  sheetXml = sheetXml.replace(/<c\b([^>]*?)\br="([A-Za-z]+\d+)"([^>]*?)(\/>|>[\s\S]*?<\/c>)/g, (whole, pre, ref, post, tail) => {
    if (!targetSet.has(ref)) return whole;
    seen.add(ref);
    const sMatch = /\bs="(\d+)"/.exec(pre + post);
    const baseIndex = sMatch ? Number(sMatch[1]) : 0;
    const newIndex = baseXfIndexForNew(baseIndex);
    changed += 1;
    let attrs = (pre + post).replace(/\s*\bs="\d+"/, '');
    return `<c${attrs} r="${ref}" s="${newIndex}"${tail}`;
  });

  // Insert empty styled cells for any target ref that didn't exist yet.
  const missing = cells.filter((ref) => !seen.has(ref));
  if (missing.length) {
    const newIndexEmpty = baseXfIndexForNew(0);
    // Group missing cells by row and inject in row order.
    const byRow = new Map();
    for (const ref of missing) {
      const sc = splitCellRef(ref);
      if (!byRow.has(sc.row)) byRow.set(sc.row, []);
      byRow.get(sc.row).push(ref);
    }
    for (const [rowNum, refs] of byRow) {
      const cellXml = refs.map((r) => `<c r="${r}" s="${newIndexEmpty}"/>`).join('');
      const rowRe = new RegExp(`(<row\\b[^>]*\\br="${rowNum}"[^>]*>)([\\s\\S]*?)(</row>)`);
      if (rowRe.test(sheetXml)) {
        sheetXml = sheetXml.replace(rowRe, (m, open, inner, close) => `${open}${inner}${cellXml}${close}`);
        changed += refs.length;
      }
      // if the row doesn't exist we skip (formatting an empty far row is rare)
    }
  }

  if (changed === 0) throw new Error('el rango indicado no tiene celdas en la hoja');

  zip.file(target.partName, sheetXml);
  zip.file('xl/styles.xml', stylesXml);
  return {
    buffer: zip.generate({ type: 'nodebuffer' }),
    sheetName: target.name,
    cellsChanged: changed,
    formatCode,
    numFmtId,
    partName: target.partName,
  };
}

// ── Public op: set a single cell's value (number / string / formula) ────────
function setCellValue({ buffer, sheet, cellRef, value }) {
  const sc = splitCellRef(cellRef);
  if (!sc) throw new Error(`referencia de celda inválida: ${cellRef}`);
  const zip = new PizZip(buffer);
  const target = resolveSheet(zip, sheet);
  let sheetXml = zip.file(target.partName)?.asText();
  if (!sheetXml) throw new Error(`no pude leer la hoja «${target.name}»`);

  const raw = String(value).trim();
  const isFormula = raw.startsWith('=');
  const isNumber = !isFormula && raw !== '' && /^-?\d[\d.,]*%?$/.test(raw) && !Number.isNaN(Number(raw.replace(/,/g, '')));
  let body; let cellAttrExtra = '';
  if (isFormula) {
    body = `<f>${xmlEscape(raw.slice(1))}</f>`;
  } else if (isNumber) {
    body = `<v>${xmlEscape(raw.replace(/,/g, ''))}</v>`;
  } else {
    cellAttrExtra = ' t="inlineStr"';
    body = `<is><t xml:space="preserve">${xmlEscape(raw)}</t></is>`;
  }

  const cellRe = new RegExp(`<c\\b([^>]*?)\\br="${sc.col}${sc.row}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  if (cellRe.test(sheetXml)) {
    sheetXml = sheetXml.replace(cellRe, (whole, pre, post) => {
      const sMatch = /\bs="(\d+)"/.exec(pre + post);
      const sAttr = sMatch ? ` s="${sMatch[1]}"` : '';
      return `<c r="${sc.col}${sc.row}"${sAttr}${cellAttrExtra}>${body}</c>`;
    });
  } else {
    // Insert into the correct row (create the row if needed), keeping column order.
    const rowRe = new RegExp(`(<row\\b[^>]*\\br="${sc.row}"[^>]*>)([\\s\\S]*?)(</row>)`);
    const newCell = `<c r="${sc.col}${sc.row}"${cellAttrExtra}>${body}</c>`;
    if (rowRe.test(sheetXml)) {
      sheetXml = sheetXml.replace(rowRe, (m, open, inner, close) => {
        // insert before the first cell whose column index is greater
        const cells = [...inner.matchAll(/<c\b[^>]*\br="([A-Za-z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)];
        let insertAt = inner.length;
        for (const cm of cells) {
          if (colLetterToIndex(cm[1]) > sc.colIndex) { insertAt = cm.index; break; }
        }
        return `${open}${inner.slice(0, insertAt)}${newCell}${inner.slice(insertAt)}${close}`;
      });
    } else {
      // create the row in <sheetData> in row order
      const newRow = `<row r="${sc.row}">${newCell}</row>`;
      sheetXml = sheetXml.replace(/(<sheetData\b[^>]*>)([\s\S]*?)(<\/sheetData>)/, (m, open, inner, close) => {
        const rows = [...inner.matchAll(/<row\b[^>]*\br="(\d+)"/g)];
        let insertAt = inner.length;
        for (const rm of rows) {
          if (Number(rm[1]) > sc.row) { insertAt = rm.index; break; }
        }
        return `${open}${inner.slice(0, insertAt)}${newRow}${inner.slice(insertAt)}${close}`;
      });
    }
  }

  zip.file(target.partName, sheetXml);
  return {
    buffer: zip.generate({ type: 'nodebuffer' }),
    sheetName: target.name,
    address: `${sc.col}${sc.row}`,
    valueKind: isFormula ? 'formula' : isNumber ? 'number' : 'string',
    partName: target.partName,
  };
}

module.exports = {
  listXlsxSheets,
  formatRange,
  setCellValue,
  // helpers exported for tests
  colLetterToIndex,
  formatCodeFor,
  splitCellRef,
};
