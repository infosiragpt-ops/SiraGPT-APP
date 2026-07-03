'use strict';

const { resolveContentClient } = require('./llm-client');

const REQUEST_TIMEOUT_MS = 25_000;

// Structured plan for a topic-specific workbook. Kept intentionally flat so
// the openpyxl renderer can consume it without interpretation: headers +
// typed rows + which columns are numeric + reading-level insights.
const SPREADSHEET_CONTENT_SCHEMA = {
  name: 'spreadsheet_content',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sheetName: { type: 'string', description: 'Short worksheet name for the data sheet, in the request language, max 24 chars, no slashes/brackets.' },
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: '3 to 7 column headers SPECIFIC to the user request topic (e.g. a pharmacy inventory: Producto, Lote, Stock, Precio unitario, Vencimiento). Never generic Mes/Ventas/Costos unless the user asked for sales data.',
      },
      rows: {
        type: 'array',
        items: { type: 'array', items: { type: ['string', 'number'] } },
        description: '8 to 14 data rows aligned with headers. Numeric columns MUST be numbers (not strings). Realistic, plausible sample values for the topic — clearly illustrative, never invented statistics attributed to real sources.',
      },
      numericColumns: {
        type: 'array',
        items: { type: 'integer' },
        description: '0-based indexes of the numeric columns in headers.',
      },
      currencyColumns: {
        type: 'array',
        items: { type: 'integer' },
        description: '0-based indexes (subset of numericColumns) holding money values.',
      },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            finding: { type: 'string' },
            interpretation: { type: 'string' },
          },
          required: ['finding', 'interpretation'],
        },
        description: '2 to 4 topic-specific findings a reader should take from the data.',
      },
    },
    required: ['sheetName', 'headers', 'rows', 'numericColumns', 'currencyColumns', 'insights'],
  },
};

function sanitizeSheetName(name, fallback = 'Datos') {
  const clean = String(name || '').replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 24);
  return clean || fallback;
}

function normalizeContent(parsed) {
  if (!parsed || !Array.isArray(parsed.headers) || parsed.headers.length < 2) return null;
  const headers = parsed.headers.slice(0, 8).map((h) => String(h).slice(0, 40));
  const width = headers.length;
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .filter(Array.isArray)
    .slice(0, 20)
    .map((row) => {
      const out = row.slice(0, width).map((cell) => (
        typeof cell === 'number' && Number.isFinite(cell) ? cell : String(cell ?? '').slice(0, 120)
      ));
      while (out.length < width) out.push('');
      return out;
    });
  if (rows.length < 3) return null;
  const inBounds = (i) => Number.isInteger(i) && i >= 0 && i < width;
  const numericColumns = Array.from(new Set((parsed.numericColumns || []).filter(inBounds)));
  const currencyColumns = Array.from(new Set((parsed.currencyColumns || []).filter((i) => inBounds(i) && numericColumns.includes(i))));
  const insights = (Array.isArray(parsed.insights) ? parsed.insights : [])
    .filter((it) => it && it.finding && it.interpretation)
    .slice(0, 5)
    .map((it) => ({ finding: String(it.finding).slice(0, 160), interpretation: String(it.interpretation).slice(0, 300) }));
  return {
    sheetName: sanitizeSheetName(parsed.sheetName),
    headers,
    rows,
    numericColumns,
    currencyColumns,
    insights,
  };
}

/**
 * Generate topic-specific workbook content for an XLSX request.
 * Returns the normalized content object or null (caller falls back to its
 * deterministic template — fail-open, same doctrine as the section writer).
 */
async function generateSpreadsheetContent({ prompt, title, language = 'es', signal } = {}) {
  const resolved = resolveContentClient();
  if (!resolved) return null;
  try {
    const completion = await resolved.client.chat.completions.create({
      model: resolved.model,
      messages: [
        {
          role: 'system',
          content: language === 'en'
            ? 'You design professional spreadsheet datasets. Reply ONLY with the JSON described by the schema. Data must be topic-specific and realistic sample data; numbers as numbers.'
            : 'Diseñas datasets profesionales para hojas de cálculo. Responde SOLO con el JSON del schema. Los datos deben ser específicos del tema y realistas como muestra; los números como números.',
        },
        {
          role: 'user',
          content: [
            language === 'en' ? `User request: ${prompt}` : `Solicitud del usuario: ${prompt}`,
            language === 'en' ? `Workbook title: ${title}` : `Título del libro: ${title}`,
            language === 'en'
              ? 'Design the data sheet now: topic-specific headers, 8-14 realistic rows, numeric/currency column indexes and 2-4 insights.'
              : 'Diseña la hoja de datos ahora: encabezados específicos del tema, 8-14 filas realistas, índices de columnas numéricas/moneda y 2-4 hallazgos.',
          ].join('\n'),
        },
      ],
      response_format: { type: 'json_schema', json_schema: SPREADSHEET_CONTENT_SCHEMA },
      temperature: 0.4,
    }, { signal, timeout: REQUEST_TIMEOUT_MS });
    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) return null;
    return normalizeContent(JSON.parse(raw));
  } catch {
    return null;
  }
}

module.exports = { generateSpreadsheetContent, normalizeContent, sanitizeSheetName, SPREADSHEET_CONTENT_SCHEMA };
