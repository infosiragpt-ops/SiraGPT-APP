/**
 * doc-preview — convert a freshly-generated file's bytes to an HTML
 * snippet so the chat artifact can show a live in-chat preview
 * instead of making the user download the file to inspect it.
 *
 * Supported conversions:
 *   · docx → HTML via mammoth (paragraphs, headings, lists, tables,
 *            images inlined as base64).
 *   · xlsx → HTML via ExcelJS (bounded sheets/rows as styled tables).
 *   · pdf  → no conversion needed — the existing <embed/> in the
 *            frontend renders it natively.
 *   · pptx → no good pure-JS renderer exists. We skip and the card
 *            falls back to the "downloadable" layout.
 *   · svg  → pass-through (the frontend renders it directly).
 *   · csv  → HTML table preview.
 *
 * The preview HTML is deliberately self-contained. We wrap it in a
 * minimal stylesheet targeted at the preview container so it looks
 * like a real published document (fonts, spacing, table styling)
 * without leaking global CSS into the host page.
 */

const mammoth = require('mammoth');
const { sanitizePreviewHtml } = require('./preview-html-sanitizer');
const { readXlsxBuffer, worksheetRows } = require('./xlsx-safe-workbook');

const DOCX_STYLES = `
<style>
  .sgpt-doc-preview {
    font-family: 'Times New Roman', Georgia, serif;
    font-size: 13px;
    line-height: 1.7;
    color: #1a1918;
    background: #ffffff;
    padding: 32px 40px;
    max-width: 780px;
    margin: 0 auto;
  }
  .sgpt-doc-preview h1 { font-size: 18px; text-align: center; font-weight: 700; margin: 18px 0 12px; }
  .sgpt-doc-preview h2 { font-size: 15px; font-weight: 700; margin: 18px 0 8px; }
  .sgpt-doc-preview h3 { font-size: 14px; font-weight: 700; font-style: italic; margin: 14px 0 6px; }
  .sgpt-doc-preview p  { margin: 0 0 10px; text-align: justify; text-indent: 1.27cm; }
  .sgpt-doc-preview p:first-of-type { text-indent: 0; }
  .sgpt-doc-preview table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 12px; }
  .sgpt-doc-preview table th { border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 6px 8px; font-weight: 700; background: transparent; text-align: center; }
  .sgpt-doc-preview table td { padding: 5px 8px; }
  .sgpt-doc-preview table tr:last-child td { border-bottom: 1px solid #111; }
  .sgpt-doc-preview ol, .sgpt-doc-preview ul { padding-left: 22px; margin: 8px 0; }
  .sgpt-doc-preview img { max-width: 100%; height: auto; }
  .sgpt-doc-preview strong { font-weight: 700; }
  .sgpt-doc-preview em { font-style: italic; }
</style>
`;

const XLSX_STYLES = `
<style>
  .sgpt-xls-preview {
    font-family: Inter, -apple-system, system-ui, sans-serif;
    font-size: 12px;
    color: #111827;
    background: #ffffff;
    padding: 0;
  }
  .sgpt-xls-preview .sheet-tab {
    display: inline-block;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    color: #1f3a68;
    background: #f7f3ea;
    border-bottom: 2px solid #c05621;
    margin-bottom: 0;
  }
  .sgpt-xls-preview table { border-collapse: collapse; width: 100%; }
  .sgpt-xls-preview th {
    background: #1f3a68;
    color: #ffffff;
    font-weight: 600;
    text-align: left;
    padding: 8px 10px;
    font-size: 11px;
    border: 1px solid #1a3156;
    white-space: nowrap;
  }
  .sgpt-xls-preview td {
    padding: 6px 10px;
    border: 1px solid #e5e7eb;
    vertical-align: top;
    white-space: nowrap;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sgpt-xls-preview tr:nth-child(even) td { background: #f9fafb; }
  .sgpt-xls-preview .truncated {
    color: #6b7280;
    font-size: 11px;
    padding: 8px 12px;
    background: #f3f4f6;
    border-top: 1px solid #e5e7eb;
    font-style: italic;
  }
</style>
`;

// Mammoth style-map: push APA-like headings to Word's Title/Heading*
// styles so the resulting HTML reflects hierarchy correctly.
const MAMMOTH_OPTIONS = {
  styleMap: [
    "p[style-name='Title'] => h1:fresh",
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Heading 4'] => h4:fresh",
    "p[style-name='Quote'] => blockquote:fresh",
  ],
  convertImage: mammoth.images.imgElement(async (image) => {
    const buf = await image.read();
    const b64 = Buffer.from(buf).toString('base64');
    return { src: `data:${image.contentType};base64,${b64}` };
  }),
};

async function previewDocx(base64) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const { value: html } = await mammoth.convertToHtml({ buffer }, MAMMOTH_OPTIONS);
    return {
      mime: 'text/html',
      html: sanitizePreviewHtml(`${DOCX_STYLES}<div class="sgpt-doc-preview">${html}</div>`),
    };
  } catch (err) {
    console.warn('[doc-preview] docx conversion failed:', err?.message);
    return null;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function previewXlsx(base64, { maxRows = 60, maxSheets = 3 } = {}) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const wb = await readXlsxBuffer(buffer);
    const sheets = wb.worksheets.slice(0, maxSheets);
    const parts = [XLSX_STYLES, '<div class="sgpt-xls-preview">'];
    for (const worksheet of sheets) {
      const rows = worksheetRows(worksheet, { maxRows });
      parts.push(`<div class="sheet-tab">${escapeHtml(worksheet.name)}</div>`);
      if (rows.length === 0) {
        parts.push('<div class="truncated">Hoja vacía</div>');
        continue;
      }
      parts.push('<table>');
      rows.forEach((row, rowIdx) => {
        const Tag = rowIdx === 0 ? 'th' : 'td';
        parts.push('<tr>');
        for (const cell of row) {
          const v = cell === undefined || cell === null ? '' : cell;
          parts.push(`<${Tag}>${escapeHtml(v)}</${Tag}>`);
        }
        parts.push('</tr>');
      });
      parts.push('</table>');
      if (worksheet.actualRowCount > maxRows) {
        parts.push(
          `<div class="truncated">…${worksheet.actualRowCount - maxRows} filas más. Descarga el archivo para verlas todas.</div>`
        );
      }
    }
    if (wb.worksheets.length > maxSheets) {
      parts.push(
        `<div class="truncated">Se muestran ${maxSheets} de ${wb.worksheets.length} hojas.</div>`
      );
    }
    parts.push('</div>');
    return { mime: 'text/html', html: sanitizePreviewHtml(parts.join('')) };
  } catch (err) {
    console.warn('[doc-preview] xlsx conversion failed:', err?.message);
    return null;
  }
}

function parseCsv(text, maxRows = 80) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) break;
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (rows.length < maxRows) rows.push(row);
  }
  return rows;
}

async function previewCsv(base64, { maxRows = 80 } = {}) {
  try {
    const text = Buffer.from(base64, 'base64').toString('utf8');
    const rows = parseCsv(text, maxRows);
    const parts = [XLSX_STYLES, '<div class="sgpt-xls-preview">'];
    parts.push('<div class="sheet-tab">CSV</div>');
    if (rows.length === 0) {
      parts.push('<div class="truncated">Archivo CSV vacío</div>');
    } else {
      parts.push('<table>');
      rows.forEach((row, rowIdx) => {
        const Tag = rowIdx === 0 ? 'th' : 'td';
        parts.push('<tr>');
        for (const cell of row) parts.push(`<${Tag}>${escapeHtml(cell)}</${Tag}>`);
        parts.push('</tr>');
      });
      parts.push('</table>');
      const totalRows = text.split(/\r\n|\n|\r/).filter(Boolean).length;
      if (totalRows > maxRows) {
        parts.push(`<div class="truncated">…${totalRows - maxRows} filas más. Descarga el archivo para verlas todas.</div>`);
      }
    }
    parts.push('</div>');
    return { mime: 'text/html', html: sanitizePreviewHtml(parts.join('')) };
  } catch (err) {
    console.warn('[doc-preview] csv conversion failed:', err?.message);
    return null;
  }
}

/**
 * Main entry point — takes the file format + its base64 body and
 * returns { mime, html } when a preview is available, or null.
 */
async function renderPreview(format, base64) {
  if (!base64 || typeof base64 !== 'string') return null;
  if (format === 'docx') return previewDocx(base64);
  if (format === 'xlsx') return previewXlsx(base64);
  if (format === 'csv') return previewCsv(base64);
  // svg is previewed as-is on the client; pdf has a native <embed>;
  // pptx has no decent pure-JS renderer, skipped.
  return null;
}

module.exports = { renderPreview };
