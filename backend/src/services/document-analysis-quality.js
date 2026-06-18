'use strict';

/**
 * document-analysis-quality
 * -------------------------
 * Deterministic guardrails for uploaded-document Q&A. This layer does not call
 * an LLM; it decides when a turn deserves deeper reasoning and builds the
 * prompt contract that prevents shallow "first paragraph only" answers.
 */

const DOCUMENT_ANALYSIS_RE = /\b(?:analiza|analisis|an[aá]lisis|resumen|resume|resumir|sintesis|s[ií]ntesis|conclusion|conclusiones|de\s+que\s+trata|qu[eé]\s+dice|dime|explica|explicar|interpreta|interpretar|extrae|extraer|identifica|identificar|hallazgo|hallazgos|resultado|resultados|objetivo|objetivos|metodo|m[eé]todo|metodologia|metodolog[ií]a|muestra|instrumento|autor|autores|a[nñ]o|cita|citado|apa|vancouver|mla|harvard|ieee|bibliograf|evaluacion|evaluaci[oó]n|academica|acad[eé]mica|critica|cr[ií]tica|recomendacion|recomendaciones|limitacion|limitaciones|cu[aá]nt[ao]s?|lista|listar|enumera|enumerar|tabla|hoja|fila|columna|celda|total|valor|marcador|suma|sumar|calcula|calcular|multiplica|multiplicar|promedio|media|porcentaje|diferencia|trimestre|contrato|proveedor|cliente|importe|presupuesto|acta|informe|uptime|factura|severidad|vulnerabilidades?|remediaci[oó]n)\b/i;
const EXACT_EXTRACTION_RE = /\b(?:transcrib|transcripcion|transcripci[oó]n|copia|copiar|literal|textual|verbatim|exact[oa]|primera\s+palabra|primer\s+p[aá]rrafo|extrae\s+el\s+texto|texto\s+completo)\b/i;
const SINGLE_PARAGRAPH_RE = /\b(?:un|1|uno)\s+solo\s+p[aá]rrafo\b|\b(?:un|1|uno)\s+p[aá]rrafo\b|\bp[aá]rrafo\s+(?:unico|[uú]nico)\b/i;
const MARKER_LOOKUP_RE = /\b(?:marcador|c[oó]digo|codigo|identificador|id|clave|folio|token|referencia)\b/i;
const SPREADSHEET_ARITHMETIC_RE = /\b(?:suma|sumar|calcula|calcular|promedio|media|porcentaje|diferencia|total|subtotal|ratio|proporcion|proporci[oó]n)\b/i;
const PLAIN_NUMERIC_OUTPUT_RE = /\b(?:solo\s+(?:el\s+)?n[uú]mero|solo\s+n[uú]meros|da\s+(?:ambos|los|estos)?\s*n[uú]meros|con\s+n[uú]meros)\b/i;
const FOLLOW_UP_REFERENCE_RE = /\b(?:ese|esa|eso|su|sus|dicho|dicha|anterior|mencionad[oa]|mencionados|mencionadas|that|those|previous|its)\b/i;
const IMAGE_MIME_RE = /^image\//i;
const IMAGE_NAME_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg)$/i;
const SPREADSHEET_MIME_RE = /(?:spreadsheet|excel|csv|tsv|vnd\.ms-excel|sheet)/i;
const SPREADSHEET_NAME_RE = /\.(?:xlsx|xlsm|csv|tsv)$/i;
const AGGREGATE_ROW_RE = /^(?:total|grand total|gran total|totales|subtotal)$/i;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileName(file) {
  if (typeof file === 'string') return file;
  return String(file?.name || file?.originalName || file?.filename || file?.id || file?.fileId || 'documento').trim();
}

function isImageLike(file) {
  if (!file || typeof file === 'string') return false;
  const mime = String(file.mimeType || file.mimetype || file.type || '').toLowerCase();
  const name = fileName(file).toLowerCase();
  return IMAGE_MIME_RE.test(mime) || IMAGE_NAME_RE.test(name);
}

function isSpreadsheetLike(file) {
  if (!file || typeof file === 'string') return SPREADSHEET_NAME_RE.test(fileName(file).toLowerCase());
  const mime = String(file.mimeType || file.mimetype || file.type || '').toLowerCase();
  const name = fileName(file).toLowerCase();
  return SPREADSHEET_MIME_RE.test(mime) || SPREADSHEET_NAME_RE.test(name);
}

function hasDocumentSource(files = []) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return false;
  return list.some((file) => !isImageLike(file));
}

function hasSpreadsheetSource(files = []) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  return list.some(isSpreadsheetLike);
}

function splitTableLine(line, separator) {
  return String(line || '')
    .split(separator)
    .map((cell) => String(cell || '').trim())
    .filter((cell, index, cells) => cell || cells.some(Boolean) || index === 0);
}

function parseSpreadsheetRows(files = []) {
  const rows = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!isSpreadsheetLike(file)) continue;
    const text = String(file?.extractedText || file?.text || file?.content || '');
    if (!text.trim()) continue;
    let headers = [];
    let sheet = '';
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const sheetMatch = line.match(/^Sheet:\s*(.+)$/i);
      if (sheetMatch) {
        sheet = sheetMatch[1].trim();
        headers = [];
        continue;
      }
      const headerMatch = line.match(/^Columns\s*\(\d+\):\s*(.+)$/i);
      if (headerMatch) {
        headers = splitTableLine(headerMatch[1], '|');
        continue;
      }
      if (!line.includes('\t') || line.startsWith('---') || /^Total data rows:/i.test(line)) continue;
      const cells = splitTableLine(line, '\t');
      if (cells.length < 2) continue;
      const valuesByHeader = {};
      headers.forEach((header, index) => {
        if (header) valuesByHeader[normalize(header)] = cells[index] || '';
      });
      rows.push({
        file,
        sheet,
        headers,
        cells,
        label: cells[0],
        normalizedLabel: normalize(cells[0]),
        valuesByHeader,
      });
    }
  }
  return rows.filter((row) => row.normalizedLabel);
}

function paddedIncludes(text, needle) {
  const haystack = ` ${normalize(text).replace(/[^a-z0-9]+/g, ' ')} `;
  const key = ` ${normalize(needle).replace(/[^a-z0-9]+/g, ' ')} `;
  return key.trim() && haystack.includes(key);
}

function findReferencedSpreadsheetRow({ prompt = '', history = [], rows = [] } = {}) {
  const usableRows = rows.filter((row) => row.normalizedLabel && !AGGREGATE_ROW_RE.test(row.normalizedLabel));
  if (!usableRows.length) return null;

  const promptText = String(prompt || '');
  const directPromptMatches = usableRows.filter((row) => paddedIncludes(promptText, row.label));
  if (directPromptMatches.length === 1) return directPromptMatches[0];

  const normalizedHistory = (Array.isArray(history) ? history : [])
    .map((message) => ({
      role: String(message?.role || '').toLowerCase(),
      content: String(message?.content || message?.text || ''),
    }))
    .filter((message) => message.content);

  for (let i = normalizedHistory.length - 1; i >= 0; i -= 1) {
    const message = normalizedHistory[i];
    if (!message.role.includes('assistant')) continue;
    const boldSegments = Array.from(message.content.matchAll(/\*\*([^*]{1,80})\*\*/g), (match) => match[1]);
    for (const segment of boldSegments) {
      const exact = usableRows.find((row) => normalize(segment) === row.normalizedLabel);
      if (exact) return exact;
    }
    const mentioned = usableRows.filter((row) => paddedIncludes(message.content, row.label));
    if (mentioned.length === 1) return mentioned[0];
  }
  return null;
}

function requestedSpreadsheetColumn(prompt = '', row = null) {
  const text = normalize(prompt);
  const headers = Array.isArray(row?.headers) ? row.headers : [];
  const normalizedHeaders = headers.map((header) => normalize(header));
  const direct = normalizedHeaders.findIndex((header) => header && paddedIncludes(text, header));
  if (direct > 0) return direct;
  if (/\btotal(?:es)?\b/.test(text)) {
    const totalIndex = normalizedHeaders.findIndex((header) => /\btotal(?:es)?\b/.test(header));
    if (totalIndex > 0) return totalIndex;
  }
  const quarterMatch = text.match(/\bq[1-4]\b/);
  if (quarterMatch) {
    const quarterIndex = normalizedHeaders.findIndex((header) => header === quarterMatch[0]);
    if (quarterIndex > 0) return quarterIndex;
  }
  return -1;
}

function numericCellValue(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/-?\d[\d.,]*/);
  if (!match) return null;
  const compact = match[0].replace(/(?<=\d)[.,](?=\d{3}\b)/g, '');
  const normalized = compact.replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function cleanNumberForPrompt(value, prompt = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/-?\d[\d.,]*/);
  if (!match) return raw;
  let number = match[0].replace(/(?<=\d)[.,](?=\d{3}\b)/g, '');
  if (PLAIN_NUMERIC_OUTPUT_RE.test(String(prompt || ''))) return number;
  return raw;
}

function buildSpreadsheetDirectAnswer({
  prompt = '',
  response = '',
  files = [],
} = {}) {
  const text = String(prompt || '');
  const rows = parseSpreadsheetRows(files);
  if (!rows.length) return null;
  const usableRows = rows.filter((row) => row.normalizedLabel && !AGGREGATE_ROW_RE.test(row.normalizedLabel));
  const mentionedRows = usableRows.filter((row) => paddedIncludes(text, row.label));

  if (/\bcu[aá]nt[ao]s?\b/i.test(text) && /\bregiones?\b/i.test(text)) {
    const regionRows = usableRows.filter((row) => {
      const numericCells = row.cells.slice(1).filter((cell) => numericCellValue(cell) != null);
      return numericCells.length >= 2;
    });
    if (regionRows.length > 0) {
      return {
        answer: String(regionRows.length),
        operation: 'count_region_rows',
        rows: regionRows.map((row) => row.label),
        column: '',
        source: fileName(regionRows[0].file),
      };
    }
  }

  if (/\b(?:mayor|maxim[ao])\b/i.test(text) && /\btotal(?:es)?\b/i.test(text) && /(?:\bregi[oó]n\b|\bregion\b)/i.test(text)) {
    const rankedRows = usableRows
      .map((row) => {
        const columnIndex = requestedSpreadsheetColumn('total', row);
        const value = numericCellValue(columnIndex > 0 ? row.cells[columnIndex] : row.cells[row.cells.length - 1]);
        return { row, value };
      })
      .filter((item) => item.value != null)
      .sort((a, b) => b.value - a.value);
    if (rankedRows.length) {
      return {
        answer: rankedRows[0].row.label,
        operation: 'max_total_row',
        rows: [rankedRows[0].row.label],
        column: 'Total',
        source: fileName(rankedRows[0].row.file),
      };
    }
  }

  if (/\b(?:menor|minim[ao])\b/i.test(text) && /\btotal(?:es)?\b/i.test(text) && /(?:\bregi[oó]n\b|\bregion\b)/i.test(text)) {
    const rankedRows = usableRows
      .map((row) => {
        const columnIndex = requestedSpreadsheetColumn('total', row);
        const value = numericCellValue(columnIndex > 0 ? row.cells[columnIndex] : row.cells[row.cells.length - 1]);
        return { row, value };
      })
      .filter((item) => item.value != null)
      .sort((a, b) => a.value - b.value);
    if (rankedRows.length) {
      return {
        answer: rankedRows[0].row.label,
        operation: 'min_total_row',
        rows: [rankedRows[0].row.label],
        column: 'Total',
        source: fileName(rankedRows[0].row.file),
      };
    }
  }

  if (/\bsuma\b|\bsumar\b|\badd\b/i.test(text) && /\btotal(?:es)?\b/i.test(text) && mentionedRows.length >= 2) {
    const values = mentionedRows.map((row) => {
      const columnIndex = requestedSpreadsheetColumn(prompt, row);
      const value = columnIndex > 0 ? row.cells[columnIndex] : row.cells[row.cells.length - 1];
      return numericCellValue(value);
    });
    if (values.every((value) => value != null)) {
      const sum = values.reduce((acc, value) => acc + value, 0);
      const answer = Number.isInteger(sum) ? String(sum) : String(sum);
      if (normalize(response) !== normalize(answer)) {
        return {
          answer,
          operation: 'sum_rows',
          rows: mentionedRows.map((row) => row.label),
          column: 'Total',
          source: fileName(mentionedRows[0].file),
        };
      }
    }
  }

  if (/\b(?:diferencia|difference|resta|subtract)\b/i.test(text) && /\btotal(?:es)?\b/i.test(text) && mentionedRows.length >= 2) {
    const selectedRows = mentionedRows.slice(0, 2);
    const values = selectedRows.map((row) => {
      const columnIndex = requestedSpreadsheetColumn(prompt, row);
      const value = columnIndex > 0 ? row.cells[columnIndex] : row.cells[row.cells.length - 1];
      return numericCellValue(value);
    });
    if (values.every((value) => value != null)) {
      const difference = Math.abs(values[0] - values[1]);
      const answer = Number.isInteger(difference) ? String(difference) : String(difference);
      if (normalize(response) !== normalize(answer)) {
        return {
          answer,
          operation: 'difference_rows',
          rows: selectedRows.map((row) => row.label),
          column: 'Total',
          source: fileName(selectedRows[0].file),
        };
      }
    }
  }

  if (/\b(?:trimestre|quarter)\b/i.test(text) && /\b(?:mayor|maxim[ao]|highest|largest)\b/i.test(text) && mentionedRows.length === 1) {
    const row = mentionedRows[0];
    const candidates = row.cells
      .map((cell, index) => ({
        index,
        header: row.headers[index] || '',
        value: numericCellValue(cell),
      }))
      .filter((cell) => cell.index > 0 && cell.value != null && !/\btotal(?:es)?\b/i.test(normalize(cell.header)));
    if (candidates.length) {
      candidates.sort((a, b) => b.value - a.value);
      const best = candidates[0];
      const formattedValue = Number.isInteger(best.value) ? String(best.value) : String(best.value);
      const answer = `${best.header || `Columna ${best.index + 1}`} ${formattedValue}`.trim();
      const normalizedResponse = normalize(response);
      if (!normalizedResponse.includes(normalize(best.header)) || !normalizedResponse.includes(normalize(formattedValue))) {
        return {
          answer,
          operation: 'max_period_for_row',
          rows: [row.label],
          column: best.header,
          source: fileName(row.file),
        };
      }
    }
  }

  return null;
}

function buildSpreadsheetFollowUpAnswer({
  prompt = '',
  response = '',
  files = [],
  history = [],
} = {}) {
  const text = String(prompt || '');
  if (!FOLLOW_UP_REFERENCE_RE.test(text)) return null;
  if (!/\b(?:total|valor|importe|monto|exact[oa]|number|value|amount)\b/i.test(text)) return null;
  const rows = parseSpreadsheetRows(files);
  if (!rows.length) return null;
  const row = findReferencedSpreadsheetRow({ prompt, history, rows });
  if (!row) return null;
  const columnIndex = requestedSpreadsheetColumn(prompt, row);
  const value = columnIndex > 0 ? row.cells[columnIndex] : row.cells[row.cells.length - 1];
  const answer = cleanNumberForPrompt(value, prompt).trim();
  if (!answer) return null;

  const normalizedAnswer = normalize(answer);
  const normalizedResponse = normalize(response);
  if (PLAIN_NUMERIC_OUTPUT_RE.test(String(prompt || ''))) {
    if (normalizedResponse === normalizedAnswer) return null;
  } else if (normalizedResponse && normalizedResponse.includes(normalizedAnswer)) {
    return null;
  }
  return {
    answer,
    rowLabel: row.label,
    column: row.headers[columnIndex] || row.headers[row.headers.length - 1] || '',
    source: fileName(row.file),
  };
}

function countDocumentSources(files = []) {
  return (Array.isArray(files) ? files : []).filter((file) => file && !isImageLike(file)).length;
}

function isDocumentAnalysisRequest(prompt, files = []) {
  const text = String(prompt || '').trim();
  if (!text || !hasDocumentSource(files)) return false;
  if (EXACT_EXTRACTION_RE.test(text) && !DOCUMENT_ANALYSIS_RE.test(text)) return false;
  return DOCUMENT_ANALYSIS_RE.test(text);
}

function wantsSingleParagraph(prompt) {
  return SINGLE_PARAGRAPH_RE.test(String(prompt || ''));
}

function summarizeFiles(files = [], limit = 6) {
  const list = (Array.isArray(files) ? files : [])
    .filter(Boolean)
    .filter((file) => !isImageLike(file))
    .map(fileName)
    .filter(Boolean);
  const unique = Array.from(new Set(list));
  if (unique.length === 0) return 'documentos adjuntos';
  const shown = unique.slice(0, limit).join(', ');
  return unique.length > limit ? `${shown}, +${unique.length - limit} mas` : shown;
}

function buildGuardLines(prompt, opts = {}) {
  if (!isDocumentAnalysisRequest(prompt, opts.files || [])) return [];
  const singleParagraph = wantsSingleParagraph(prompt);
  const spreadsheet = hasSpreadsheetSource(opts.files || []);
  const multipleDocuments = countDocumentSources(opts.files || []) > 1;
  const markerLookup = MARKER_LOOKUP_RE.test(String(prompt || ''));
  const spreadsheetArithmetic = spreadsheet && SPREADSHEET_ARITHMETIC_RE.test(String(prompt || ''));
  const plainNumericOutput = PLAIN_NUMERIC_OUTPUT_RE.test(String(prompt || ''));
  const followUpReference = FOLLOW_UP_REFERENCE_RE.test(String(prompt || ''));
  const lang = String(opts.language || 'es').slice(0, 2).toLowerCase();
  if (lang === 'en') {
    const lines = [
      '- DEEP DOCUMENT ANALYSIS: spend enough reasoning effort to inspect the whole extracted document context before answering.',
      '- Do not answer from only the cover, dedication, table of contents, first paragraph, filename, or extraction metadata.',
      '- Build the answer from distinct zones when available: beginning/title/problem, middle/method or development, and end/results/conclusions/annexes.',
      '- For academic or thesis files, prefer this evidence order: title/topic, objective, method/design/sample/instrument, key results, conclusions, and limitations.',
      singleParagraph
        ? '- The user requested one paragraph: keep one paragraph, but make it a dense synthesis that still covers the whole document.'
        : '- If the user did not request a short format, structure the answer with concise sections and evidence-backed bullets.',
      '- If extraction is incomplete or the requested data is not visible, say that explicitly instead of inventing it.',
    ];
    if (spreadsheet) {
      lines.splice(4, 0, '- For spreadsheets or tables, inspect headers, row labels, total rows, marker cells, sheet names, and all visible numeric columns; when asked for sums, averages, percentages, or differences, compute explicitly and verify the arithmetic before finalizing.');
    }
    if (multipleDocuments) {
      lines.splice(spreadsheet ? 5 : 4, 0, '- Multi-document request: map every requested field to the correct file first, answer every requested part, and verify no requested file was skipped.');
    }
    if (spreadsheetArithmetic) {
      lines.splice(spreadsheet ? (multipleDocuments ? 6 : 5) : (multipleDocuments ? 5 : 4), 0, '- For a direct spreadsheet calculation, start the answer with the final computed value, then cite the row labels and arithmetic; do not only restate table rows.');
    }
    if (markerLookup) {
      lines.splice(spreadsheet ? (multipleDocuments ? (spreadsheetArithmetic ? 7 : 6) : (spreadsheetArithmetic ? 6 : 5)) : (multipleDocuments ? 5 : 4), 0, '- If the user asks for a marker, code, identifier, key, folio, token, or reference, search for the literal value in labels/cells/paragraphs and answer that value directly; do not replace it with totals or unrelated metrics.');
    }
    if (followUpReference) lines.push('- If this is a follow-up, resolve pronouns and references such as that/its/previous from the latest relevant user and assistant turns before using the document data. If the prior answer named a row/entity and the user asks for its total/value, use that row/entity, not an aggregate TOTAL row unless the prior answer was the aggregate.');
    if (plainNumericOutput) lines.push('- When the user asks for numbers only, output plain digits without thousands separators unless the source value is explicitly formatted as a decimal percentage.');
    return lines;
  }
  const lines = [
    '- ANALISIS DOCUMENTAL PROFUNDO: dedica suficiente razonamiento a revisar todo el contexto extraido del documento antes de responder.',
    '- No respondas solo desde portada, dedicatoria, indice, primer parrafo, nombre del archivo o metadatos de extraccion.',
    '- Construye la respuesta desde zonas distintas cuando existan: inicio/titulo/problema, desarrollo/metodo, y cierre/resultados/conclusiones/anexos.',
    '- En documentos academicos o tesis, prioriza este orden de evidencia: titulo/tema, objetivo, metodo/diseno/muestra/instrumento, resultados, conclusiones y limitaciones.',
    singleParagraph
      ? '- El usuario pidio un solo parrafo: conserva un solo parrafo, pero haz una sintesis densa que cubra el documento completo.'
      : '- Si el usuario no pidio formato breve, estructura la respuesta con secciones concisas y evidencia.',
    '- Si la extraccion esta incompleta o el dato pedido no aparece, dilo claramente en vez de inventarlo.',
  ];
  if (spreadsheet) {
    lines.splice(4, 0, '- En hojas de calculo o tablas, revisa encabezados, etiquetas de fila, filas TOTAL, celdas de marcador, nombres de hoja y todas las columnas numericas visibles; si piden sumas, promedios, porcentajes o diferencias, calcula y verifica la aritmetica antes de finalizar.');
  }
  if (multipleDocuments) {
    lines.splice(spreadsheet ? 5 : 4, 0, '- Solicitud multi-documento: asigna primero cada dato pedido al archivo correcto, responde todas las partes solicitadas y verifica que no omitiste ningun archivo pedido.');
  }
  if (spreadsheetArithmetic) {
    lines.splice(spreadsheet ? (multipleDocuments ? 6 : 5) : (multipleDocuments ? 5 : 4), 0, '- En calculos directos sobre hojas de calculo, empieza la respuesta con el valor final calculado, luego cita las etiquetas de fila y la aritmetica; no respondas solo copiando filas de la tabla.');
  }
  if (markerLookup) {
    lines.splice(spreadsheet ? (multipleDocuments ? (spreadsheetArithmetic ? 7 : 6) : (spreadsheetArithmetic ? 6 : 5)) : (multipleDocuments ? 5 : 4), 0, '- Si el usuario pide marcador, codigo, identificador, clave, folio, token o referencia, busca el valor literal en etiquetas/celdas/parrafos y responde ese valor directamente; no lo sustituyas por totales ni metricas no relacionadas.');
  }
  if (followUpReference) lines.push('- Si es una continuacion, resuelve pronombres y referencias como ese/esa/su/anterior con los turnos recientes antes de usar los datos del documento. Si la respuesta anterior nombro una fila/entidad y el usuario pide su total/valor, usa esa fila/entidad, no la fila agregada TOTAL salvo que la respuesta anterior haya sido el agregado.');
  if (plainNumericOutput) lines.push('- Cuando el usuario pida solo numeros, usa digitos simples sin separadores de miles, salvo que la fuente sea un porcentaje decimal.');
  return lines;
}

function buildPromptBlock({ prompt = '', files = [], language = 'es', source = 'chat' } = {}) {
  const lines = buildGuardLines(prompt, { files, language });
  if (lines.length === 0) return '';
  const names = summarizeFiles(files);
  const header = String(language || 'es').slice(0, 2).toLowerCase() === 'en'
    ? '## DEEP DOCUMENT ANALYSIS CONTRACT'
    : '## CONTRATO DE ANALISIS DOCUMENTAL PROFUNDO';
  return [
    header,
    `Source: ${source}`,
    `Active files: ${names}`,
    ...lines,
    'Self-check before finalizing: the answer must reflect more than the first visible fragment and must satisfy the user format without sacrificing document coverage.',
  ].join('\n');
}

function upgradeComputeForDocumentAnalysis(currentCompute = {}, { prompt = '', files = [] } = {}) {
  const current = currentCompute && typeof currentCompute === 'object' ? currentCompute : {};
  if (!isDocumentAnalysisRequest(prompt, files)) {
    return { compute: current, upgraded: false, reason: 'not_document_analysis' };
  }
  if (current.mode === 'best_of_n') {
    return {
      compute: {
        ...current,
        samples: Math.max(3, Number(current.samples) || 3),
        reasoningEffort: 'high',
        reflection: true,
      },
      upgraded: current.reasoningEffort !== 'high' || !current.reflection || (Number(current.samples) || 0) < 3,
      reason: 'document_analysis_preserve_best_of_n',
    };
  }
  const next = {
    ...current,
    mode: 'self_consistency',
    samples: Math.max(3, Number(current.samples) || 3),
    reasoningEffort: 'high',
    reflection: true,
  };
  const changed =
    current.mode !== next.mode ||
    current.reasoningEffort !== next.reasoningEffort ||
    current.reflection !== next.reflection ||
    (Number(current.samples) || 0) < next.samples;
  return { compute: next, upgraded: changed, reason: 'document_analysis_minimum_high_reasoning' };
}

module.exports = {
  buildGuardLines,
  buildPromptBlock,
  hasDocumentSource,
  isDocumentAnalysisRequest,
  upgradeComputeForDocumentAnalysis,
  wantsSingleParagraph,
  buildSpreadsheetDirectAnswer,
  _internal: {
    normalize,
    parseSpreadsheetRows,
    findReferencedSpreadsheetRow,
    requestedSpreadsheetColumn,
    numericCellValue,
    cleanNumberForPrompt,
    summarizeFiles,
    isImageLike,
    isSpreadsheetLike,
    countDocumentSources,
    markerLookupRe: MARKER_LOOKUP_RE,
    spreadsheetArithmeticRe: SPREADSHEET_ARITHMETIC_RE,
  },
  buildSpreadsheetFollowUpAnswer,
};
