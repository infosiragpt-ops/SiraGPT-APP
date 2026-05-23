/**
 * xlsx-workbook-validator — phase 6 of the Validation Fabric (XLSX).
 *
 * Static integrity check for XLSX artifacts. Opens the workbook
 * as a JSZip, reads `xl/workbook.xml` for the sheet manifest,
 * confirms each referenced sheet has a corresponding
 * `xl/worksheets/sheetN.xml` body, and (when the prompt asked for
 * content) refuses to ship a workbook with zero cells.
 *
 * Static-only — does NOT spin up openpyxl or LibreOffice. The
 * failure modes that bite in production are caught by reading
 * the ZIP entries and the workbook manifest:
 *   - manifest empty → 0 sheets
 *   - sheet referenced but never written → broken workbook
 *   - sheet body present but contains no <row>/<c> elements → empty
 *
 * Public API:
 *   countXlsxStructure(buffer)
 *     -> Promise<{ ok, reason?, sheetRefs, sheetFiles, cellCount }>
 *   validateXlsxWorkbook({ buffer, prompt, minCells })
 *     -> Promise<{ ok, reason?, sheetRefs, sheetFiles, cellCount, contentExpected }>
 */

const JSZip = require('jszip');

const XLSX_MIN_BYTES = 200;
const MIN_CELLS_DEFAULT = 1;

const SHEET_REF_RE = /<sheet\b[^/>]*?(?:name|sheetId|r:id|r:embed)/gi;
const SHEET_FILE_RE = /^xl\/worksheets\/sheet\d+\.xml$/i;
const CELL_RE = /<c\b/g;

async function countXlsxStructure(buffer) {
  if (!buffer
    || (Buffer.isBuffer(buffer) && buffer.length < XLSX_MIN_BYTES)
    || (typeof buffer === 'string' && !buffer.length)) {
    return { ok: false, reason: 'empty_buffer', sheetRefs: 0, sheetFiles: 0, cellCount: 0 };
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, reason: `zip_open_failed: ${err.message || 'unknown'}`, sheetRefs: 0, sheetFiles: 0, cellCount: 0 };
  }

  const workbook = zip.file('xl/workbook.xml');
  if (!workbook) {
    return { ok: false, reason: 'missing_workbook_xml', sheetRefs: 0, sheetFiles: 0, cellCount: 0 };
  }

  let workbookXml;
  try {
    workbookXml = await workbook.async('string');
  } catch (err) {
    return { ok: false, reason: `xml_read_failed: ${err.message || 'unknown'}`, sheetRefs: 0, sheetFiles: 0, cellCount: 0 };
  }

  const sheetRefs = (workbookXml.match(SHEET_REF_RE) || []).length;

  const sheetPaths = [];
  zip.forEach((relativePath) => {
    if (SHEET_FILE_RE.test(relativePath)) sheetPaths.push(relativePath);
  });

  // Cell count across every sheet. We don't bother distinguishing
  // empty cells from content-bearing cells — `<c>` only emits when
  // a cell carries something (value, formula, or style ref).
  let cellCount = 0;
  for (const sheetPath of sheetPaths) {
    try {
      const xml = await zip.file(sheetPath).async('string');
      cellCount += (xml.match(CELL_RE) || []).length;
    } catch {
      /* corrupt entry — skip; counted as 0 cells */
    }
  }

  return {
    ok: true,
    sheetRefs,
    sheetFiles: sheetPaths.length,
    cellCount,
  };
}

const CONTENT_HINT_RE = new RegExp(
  [
    'excel', 'xlsx?\\b', 'hoja\\s+de\\s+c[áa]lculo', 'spreadsheet',
    'workbook', 'tabla\\s+de\\s+datos', 'base\\s+de\\s+datos',
    'cronbach', 'spearman', 'descriptiv', 'matriz', 'likert',
  ].join('|'),
  'i',
);

// Mirrors the PDF validator's FORM_HINT_RE: a prompt asking for an
// empty template (plantilla vacía / blank workbook) legitimately
// ships with no cell data, so we suppress the contentExpected
// signal even when an xlsx keyword is present. The `.{0,30}` slack
// catches "plantilla excel vacía" / "plantilla de hoja vacía"
// (Spanish allows the format word to sit between "plantilla" and
// "vacía").
const TEMPLATE_HINT_RE = /\bplantilla\b.{0,30}\bvac[íi]a\b|\b(blank|empty)\s+(?:workbook|template|spreadsheet)\b/i;

function expectsCells(text) {
  if (!text || typeof text !== 'string') return false;
  if (TEMPLATE_HINT_RE.test(text)) return false;
  return CONTENT_HINT_RE.test(text);
}

async function validateXlsxWorkbook({ buffer, prompt, sourceText, minCells } = {}) {
  const structure = await countXlsxStructure(buffer);
  const contentExpected = expectsCells(prompt) || expectsCells(sourceText);
  if (!structure.ok) {
    return { ...structure, contentExpected };
  }
  if (structure.sheetFiles < 1) {
    return {
      ok: false,
      reason: 'no_sheets',
      sheetRefs: structure.sheetRefs,
      sheetFiles: structure.sheetFiles,
      cellCount: structure.cellCount,
      contentExpected,
    };
  }
  if (structure.sheetRefs > 0 && structure.sheetRefs !== structure.sheetFiles) {
    return {
      ok: false,
      reason: 'sheet_manifest_mismatch',
      sheetRefs: structure.sheetRefs,
      sheetFiles: structure.sheetFiles,
      cellCount: structure.cellCount,
      contentExpected,
    };
  }
  if (contentExpected) {
    const limit = Number.isFinite(minCells) ? minCells : MIN_CELLS_DEFAULT;
    if (structure.cellCount < limit) {
      return {
        ok: false,
        reason: 'no_cell_content',
        sheetRefs: structure.sheetRefs,
        sheetFiles: structure.sheetFiles,
        cellCount: structure.cellCount,
        contentExpected,
      };
    }
  }
  return { ...structure, contentExpected };
}

module.exports = {
  countXlsxStructure,
  validateXlsxWorkbook,
  expectsCells,
};
