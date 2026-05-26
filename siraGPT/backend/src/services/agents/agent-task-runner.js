const OpenAI = require('openai');
const reactAgent = require('../react-agent');
const { buildTaskTools } = require('./task-tools');
const taskStore = require('./task-store');
const auditLog = require('./audit-log');
const metrics = require('./metrics');
const {
  buildExecutionProfile,
  validateFinalize,
} = require('./agentic-execution-profile');
const { buildUserIntentAlignmentProfile } = require('./user-intent-alignment');
const { buildAgentTaskPlan } = require('./agent-task-plan');
const { resolveTaskContract } = require('./task-contract-resolver');
const { listManifests } = require('./tool-manifest');
const {
  buildUniversalTaskContract,
  deriveLegacyTaskContract,
  enforceLegacyTaskContract,
} = require('./universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
} = require('./enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('./enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('./agentic-qa-board');
const { buildAgenticOperatingCore } = require('./agentic-operating-core');
const durableExecutionStore = require('./durable-execution-store');
const { buildDocumentDeliveryPolicy } = require('./document-delivery-policy');
const { getQueueName } = require('./agent-task-queue');
const persistence = require('./agent-task-persistence');
const { generateAutoDocument } = require('./auto-document-delivery');
const {
  generateVancouverMatrixDocument,
  isVancouverMatrixWordRequest,
} = require('./vancouver-table-document');
const { buildLangGraphLayer } = require('./agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('./agentic-frameworks');
const {
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  isPlainTranscriptionRequest,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
} = require('../message-attachments');
const {
  assessAttachmentContext,
  countUsefulWords,
  stripScaffolding,
} = require('./attachment-context-guard');
const apa7 = require('../marco-teorico/apa7');

const prisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

function routeInternals() {
  return require('../../routes/agent-task').INTERNAL;
}

function buildFinalizeProfile(executionProfile, universalTaskContract) {
  // Dynamic approved tool list from the manifest — no hardcoded names.
  // This stays current as new tools are registered without code changes.
  const appTools = new Set(listManifests().map((m) => m.name));
  const forbiddenTools = new Set(Array.isArray(universalTaskContract?.forbidden_tools)
    ? universalTaskContract.forbidden_tools
    : []);
  const executableContractTools = new Set(
    (universalTaskContract?.required_tools || [])
      .filter((tool) => tool !== 'finalize')
      .filter((tool) => appTools.has(tool))
      .filter((tool) => !forbiddenTools.has(tool))
  );
  return {
    ...(executionProfile || {}),
    requiredTools: Array.from(new Set([
      ...(executionProfile?.requiredTools || []),
      ...executableContractTools,
    ])).filter((tool) => !forbiddenTools.has(tool)),
    minimumToolCalls: {
      ...(executionProfile?.minimumToolCalls || {}),
      ...(universalTaskContract?.source_requirements?.verification_policy === 'strict' && executableContractTools.has('web_search')
        ? { web_search: Math.max(2, executionProfile?.minimumToolCalls?.web_search || 0) }
        : {}),
    },
  };
}

function summarizeForChat(text, policy) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const intro = `Preparé el entregable profesional en formato ${String(policy?.format || 'documento').toUpperCase()} y lo validé antes de adjuntarlo.`;
  if (!raw) return intro;
  let clipped;
  if (raw.length <= 900) {
    clipped = raw;
  } else {
    // Surrogate-safe slice: pull the cut back if the last kept code
    // unit is a high surrogate so we don't emit a dangling surrogate
    // that JSON.stringify would replace with U+FFFD.
    let cut = 900;
    const code = raw.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    clipped = `${raw.slice(0, cut).trim()}...`;
  }
  return `${intro}\n\nResumen conversacional:\n\n${clipped}`;
}

function normalizeAttachmentFallbackContent(text) {
  const tableHeaderCells = new Set([
    'n', 'no', 'titulo', 'titulo del articulo', 'autores', 'ano de publicacion',
    'enfoque y o tipo de estudio', 'muestreo', 'procedencia', 'ocupacion',
    'instrumento', 'modelo teorico', 'resultados',
  ]);
  const cells = String(text || '')
    .replace(/\*{1,3}/g, '')
    .replace(/\|/g, '\n')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-:]{2,}$/.test(line))
    .filter((line) => !/^\d{1,3}$/.test(line))
    .filter((line) => {
      const key = line
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      return !tableHeaderCells.has(key);
    });
  return cells.join('. ');
}

function normalizedKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitReadableSentences(text) {
  const seen = new Set();
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35)
    .filter((sentence) => {
      const key = normalizedKey(sentence);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 36);
}

function scoreAttachmentSentence(sentence, request = '') {
  const normalized = normalizedKey(sentence);
  let score = 0;
  if (/\b(se encontro|se evidencio|se identifico|se observo|muestra|indica|concluye|recomienda|sugiere|resultado|resultados|hallazgo|hallazgos|asocia|asociacion|relacion significativa|incrementa|reduce|mejora)\b/.test(normalized)) score += 5;
  if (/\b(ansiedad|depresion|estres|riesgo|impacto|efecto|efectos|salud mental|rendimiento|adiccion|vulnerabilidad|malestar)\b/.test(normalized)) score += 2;
  if (sentence.length >= 80 && sentence.length <= 420) score += 1;
  if (/\b(cuantitativo|cualitativo|transversal|probabilistico|conveniencia|cuestionario|escala|inventario|modelo teorico|autores|publicacion)\b/.test(normalized)) score -= 2;

  const requestTerms = Array.from(new Set(normalizedKey(request).match(/[a-z0-9]{5,}/g) || []))
    .filter((term) => !['resumen', 'resume', 'documento', 'archivo', 'adjunto', 'quiero', 'dame', 'necesito', 'analisis'].includes(term));
  for (const term of requestTerms) {
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

function selectAttachmentSentences(sentences, request = '', limit = 8) {
  const ranked = sentences.map((sentence, index) => ({ sentence, index, score: scoreAttachmentSentence(sentence, request) }));
  const strong = ranked
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return strong.length ? strong : sentences.slice(0, limit);
}

function looksLikeMissingAttachmentAnswer(text) {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return true;
  return (
    value.includes('no hay contenido disponible') ||
    value.includes('no se encontró texto disponible') ||
    value.includes('no se encontro texto disponible') ||
    value.includes('proporciona un archivo legible') ||
    value.includes('no pude acceder al contenido')
  );
}

function looksLikeEmptyOrWeakFinalAnswer(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return true;
  return (
    value === 'null' ||
    value === 'undefined' ||
    value === '(agent returned empty message)' ||
    value === 'respuesta vacía' ||
    value === 'respuesta vacia'
  );
}

function wantsBibliographyAnswer(request) {
  const value = normalizedKey(request);
  return /\b(bibliograf|referenc|citas?|apa|vancouver|harvard|chicago|mla|formato bibliograf)/.test(value);
}

function detectApaEditionLabel(request) {
  const value = normalizedKey(request);
  if (/\b(7ma|7 th|septima|séptima|apa\s*7)\b/.test(value) || /\bapa\s*7\b/.test(value)) return 'APA 7';
  return 'APA';
}

function mapSpreadsheetCitationColumns(headerCells) {
  const columnMap = { title: -1, authors: -1, year: -1, venue: -1, doi: -1 };
  headerCells.forEach((label, columnIndex) => {
    const key = normalizedKey(label);
    if (columnMap.title < 0 && /titulo|articulo|referenc|obra|nombre|tema|estudio|fuente/.test(key)) columnMap.title = columnIndex;
    if (columnMap.authors < 0 && /autor|investigador|escritor/.test(key)) columnMap.authors = columnIndex;
    if (columnMap.year < 0 && /(ano|anio|year|fecha|publicacion|publicado)/.test(key)) columnMap.year = columnIndex;
    if (columnMap.venue < 0 && /(revista|journal|fuente|medio|editorial)/.test(key)) columnMap.venue = columnIndex;
    if (columnMap.doi < 0 && /doi/.test(key)) columnMap.doi = columnIndex;
  });
  if (columnMap.title < 0 && headerCells.length >= 2) {
    columnMap.title = 0;
    columnMap.authors = headerCells.length > 1 ? 1 : -1;
    columnMap.year = headerCells.length > 2 ? 2 : -1;
  }
  return columnMap;
}

function splitSpreadsheetCells(line) {
  const trimmed = String(line || '').trim().replace(/\*{1,3}/g, '');
  if (!trimmed) return [];
  if (trimmed.includes('\t')) return trimmed.split('\t').map((cell) => cell.trim());
  if (trimmed.includes('|')) return trimmed.split(/\s*\|\s*/).map((cell) => cell.trim()).filter(Boolean);
  return [trimmed];
}

function normalizeAuthorInitials(value) {
  const tokens = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.map((token) => {
    if (/^[A-ZÁÉÍÓÚÜÑ]\.?$/u.test(token)) {
      return token.endsWith('.') ? token : `${token}.`;
    }
    return token;
  }).join(' ');
}

function parseCitationAuthorName(display) {
  const cleaned = String(display || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const inverted = cleaned.match(/^(.+?),\s*(.+)$/);
  if (inverted) {
    const family = inverted[1].trim();
    const given = normalizeAuthorInitials(inverted[2]);
    if (family && given) return { family, given, display: cleaned };
  }
  return { ...apa7.splitName(cleaned), display: cleaned };
}

function parseCitationAuthors(authorsRaw) {
  const raw = String(authorsRaw || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [{ family: 'Autor desconocido', given: null, display: 'Autor desconocido' }];

  const normalized = raw
    .replace(/\s+(?:and|y)\s+/gi, ' & ')
    .replace(/([A-ZÁÉÍÓÚÜÑ]\.)\s*,\s*(?=[^,;&]+,\s*[A-ZÁÉÍÓÚÜÑ]\.?)/gu, '$1 & ');

  const parts = normalized
    .split(/\s*(?:;|&)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const authors = (parts.length ? parts : [normalized])
    .map(parseCitationAuthorName)
    .filter(Boolean);

  return authors.length
    ? authors
    : [{ family: 'Autor desconocido', given: null, display: 'Autor desconocido' }];
}

function citationSourcesFromTabularData(headerCells, dataRows) {
  const columnMap = mapSpreadsheetCitationColumns(headerCells);
  const pickCell = (cells, index) => (index >= 0 ? String(cells[index] || '').trim() : '');
  const sources = [];

  for (const cells of dataRows) {
    if (!Array.isArray(cells) || !cells.some(Boolean)) continue;
    const title = pickCell(cells, columnMap.title >= 0 ? columnMap.title : 0);
    const authorsRaw = pickCell(cells, columnMap.authors);
    const yearCell = pickCell(cells, columnMap.year);
    const venue = pickCell(cells, columnMap.venue);
    const doiCell = pickCell(cells, columnMap.doi);
    if (!title || title.length < 4) continue;
    if (/^(n|no|titulo|autores|ano|anio|resultados|referencia)$/.test(normalizedKey(title))) continue;

    const yearMatch = yearCell.match(/\b(19|20)\d{2}\b/) || title.match(/\b(19|20)\d{2}\b/);
    const authors = parseCitationAuthors(authorsRaw);

    const doiMatch = doiCell.match(/\b10\.\d{4,9}\/[^\s|]+/i);
    sources.push({
      title: title.replace(/\s*\(\s*(19|20)\d{2}\s*\)\s*$/, '').trim(),
      authors,
      year: yearMatch ? Number(yearMatch[0]) : null,
      container: venue || null,
      doi: doiMatch ? doiMatch[0] : null,
      url: doiMatch ? `https://doi.org/${doiMatch[0]}` : null,
    });
  }
  return sources;
}

function dedupeCitationSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = normalizedKey(`${source.title}|${source.authors?.[0]?.display || ''}|${source.year || ''}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseMarkdownPipeCitationRows(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  if (lines.length < 2) return [];

  const rows = lines
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim().replace(/\*{1,3}/g, '')))
    .filter((cells) => cells.some(Boolean))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));

  let headerIndex = -1;
  for (let index = 0; index < Math.min(rows.length, 6); index += 1) {
    const headerKey = normalizedKey(rows[index].join(' '));
    if (/titulo|autor|ano|anio|year|referenc|articulo|publicacion|doi|revista|journal/.test(headerKey)) {
      headerIndex = index;
      break;
    }
  }

  const headerCells = headerIndex >= 0 ? rows[headerIndex] : rows[0];
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows.slice(1);
  return citationSourcesFromTabularData(headerCells, dataRows);
}

function parseFileProcessorExcelCitationRows(rawText) {
  const text = String(rawText || '');
  if (!/Columns\s*\(\d+\):/i.test(text)) return [];

  const sources = [];
  const sheetBlocks = text.split(/(?=^Sheet:\s)/im).filter((block) => /Columns\s*\(\d+\):/i.test(block));
  for (const block of sheetBlocks) {
    const colMatch = block.match(/^Columns\s*\(\d+\):\s*(.+)$/im);
    if (!colMatch) continue;

    const headerCells = splitSpreadsheetCells(colMatch[1]);
    const separatorIndex = block.search(/^---\s*$/m);
    const dataSection = separatorIndex >= 0 ? block.slice(separatorIndex) : block;
    const dataRows = dataSection
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^---$/.test(line))
      .filter((line) => !/^Sheet:/i.test(line))
      .filter((line) => !/^Columns\s*\(/i.test(line))
      .filter((line) => !/^Total data rows:/i.test(line))
      .filter((line) => !/^\(empty\)$/i.test(line))
      .filter((line) => !line.startsWith('... ['))
      .filter((line) => !/^Excel workbook/i.test(line))
      .map((line) => splitSpreadsheetCells(line))
      .filter((cells) => cells.some((cell) => cell.length > 0));

    sources.push(...citationSourcesFromTabularData(headerCells, dataRows));
  }
  return sources;
}

function parseSpreadsheetCitationRows(rawText) {
  const markdownSources = parseMarkdownPipeCitationRows(rawText);
  const excelSources = parseFileProcessorExcelCitationRows(rawText);
  return dedupeCitationSources([...markdownSources, ...excelSources]);
}

function buildBibliographyFallbackAnswer({ goal, uploadedFileContext }) {
  if (!wantsBibliographyAnswer(goal)) return '';
  const sources = parseSpreadsheetCitationRows(uploadedFileContext);
  if (sources.length === 0) return '';

  const edition = detectApaEditionLabel(goal);
  const references = apa7.referenceList(sources);
  return [
    `### Referencias (${edition})`,
    '',
    `Formateé **${sources.length}** entrada${sources.length === 1 ? '' : 's'} a partir de las filas legibles de tu archivo. Revísalas antes de entregar: autores, año y revista pueden requerir un ajuste manual si la hoja estaba incompleta.`,
    '',
    references,
  ].join('\n');
}

function resolveAttachmentFallbackMarkdown({ goal, uploadedFileContext, reason = '' }) {
  return (
    buildBibliographyFallbackAnswer({ goal, uploadedFileContext })
    || buildAttachmentGroundedFallbackAnswer({ goal, uploadedFileContext, reason })
    || buildAttachmentUnavailableFallbackAnswer({ goal, uploadedFileContext })
  );
}

function wantsSingleParagraphAnswer(request) {
  const value = normalizedKey(request);
  return (
    /\b(?:un|uno|1)\s+(?:solo\s+)?parrafo\b/.test(value) ||
    /\ben\s+(?:un|uno|1)\s+parrafo\b/.test(value) ||
    /\bparrafo\s+unico\b/.test(value)
  );
}

/**
 * Only emit bullet lists when the user explicitly asked for them.
 * Spanish triggers: "bullets", "viñetas", "vinetas", "lista", "puntos
 * clave", "key points", "checklist". Prose is the default — matches
 * the user-facing directive "análisis de documentos sin viñetas".
 */
function wantsBulletList(request) {
  const value = normalizedKey(request);
  return (
    /\bvinetas?\b/.test(value) ||
    /\bbullets?\b/.test(value) ||
    /\blistas?\b/.test(value) ||
    /\bpuntos?\s+(?:clave|principales)\b/.test(value) ||
    /\bchecklist\b/.test(value) ||
    /\benumera(?:r|cion)?\b/.test(value)
  );
}

function buildAttachmentGroundedFallbackAnswer({ goal, uploadedFileContext, reason = '' }) {
  void reason;
  const request = String(goal || '');
  const bibliographyAnswer = buildBibliographyFallbackAnswer({ goal: request, uploadedFileContext });
  if (bibliographyAnswer) return bibliographyAnswer;

  const cleanedRaw = stripScaffolding(uploadedFileContext);
  const cleaned = normalizeAttachmentFallbackContent(cleanedRaw)
    .replace(/\s+/g, ' ')
    .trim();
  const minUsefulWords = wantsBibliographyAnswer(request) ? 8 : 30;
  if (!cleaned || countUsefulWords(cleaned) < minUsefulWords) return '';
  const requestedParagraphs = Math.max(
    1,
    Math.min(6, Number((request.match(/\b(\d{1,2})\s+p[aá]rrafos?\b/i) || [])[1]) || 0)
  );
  const wantsConclusions = /\b(conclusi[oó]n|conclusiones|concluye|concluir)\b/i.test(request);
  const wantsSummary = /\b(resumen|resume|sintesis|s[ií]ntesis|de qu[eé] trata|qu[eé] dice|explica)\b/i.test(request);
  const wantsRecommendations = /\b(recomendaci[oó]n|recomendaciones|sugerencia|sugerencias|propuesta|propuestas)\b/i.test(request);
  const paragraphCount = requestedParagraphs || (wantsConclusions ? 3 : 2);
  const sentences = splitReadableSentences(cleaned);
  if (sentences.length === 0) {
    return cleaned.slice(0, 1600);
  }

  const bulletSentences = selectAttachmentSentences(sentences, request, 8)
    .map((sentence) => sentence.replace(/^[,;:\s]+/, '').replace(/\.{2,}/g, '.').trim())
    .filter(Boolean);

  // Bullets are now opt-in. Default to prose; only emit list markers
  // when the user explicitly asks for "viñetas / lista / puntos clave".
  const allowBullets = wantsBulletList(request);
  const executiveSummary = allowBullets
    ? bulletSentences
        .slice(0, Math.max(3, Math.min(5, bulletSentences.length)))
        .map((sentence) => `- ${sentence.length > 360 ? `${sentence.slice(0, 360).trim()}...` : sentence}`)
        .join('\n')
    : bulletSentences
        .slice(0, Math.max(3, Math.min(5, bulletSentences.length)))
        .map((sentence) => sentence.length > 360 ? `${sentence.slice(0, 360).trim()}...` : sentence)
        .join(' ');

  if (wantsSingleParagraphAnswer(request)) {
    const selected = (bulletSentences.length ? bulletSentences : sentences)
      .slice(0, Math.max(3, Math.min(5, bulletSentences.length || sentences.length)));
    const paragraph = selected.join(' ').replace(/\s+/g, ' ').trim();
    const clipped = paragraph.length > 1800 ? `${paragraph.slice(0, 1800).trim()}...` : paragraph;
    return clipped;
  }

  if (!wantsConclusions) {
    const body = sentences.slice(0, Math.max(4, paragraphCount * 2)).join(' ');
    const clippedBody = body.length > 1800 ? `${body.slice(0, 1800).trim()}...` : body;
    if (wantsSummary || wantsRecommendations) {
      // When the user didn't ask for bullets we render the executive
      // summary as a normal paragraph (`Resumen ejecutivo: prose…`).
      // Recommendations also become a final prose sentence, not a
      // list, so the whole answer stays bullet-free unless the user
      // opts in via wantsBulletList.
      const heading = '### Análisis del documento adjunto';
      const summaryBlock = executiveSummary
        ? allowBullets
          ? `**Resumen ejecutivo**\n${executiveSummary}`
          : `**Resumen ejecutivo.** ${executiveSummary}`
        : clippedBody;
      const recommendationsBlock = wantsRecommendations
        ? allowBullets
          ? '\n**Siguiente paso recomendado**\n- Usar estos hallazgos como base y pedirme una matriz, informe Word/PDF o tabla comparativa si necesitas entregable descargable.'
          : '\n**Siguiente paso recomendado.** Usa estos hallazgos como base y pídeme una matriz, informe Word/PDF o tabla comparativa si necesitas un entregable descargable.'
        : '';
      return [heading, '', summaryBlock, recommendationsBlock].filter(Boolean).join('\n');
    }
    return clippedBody;
  }

  const connectors = [
    'En primer lugar,',
    'Asimismo,',
    'Finalmente,',
    'De forma complementaria,',
    'Como cierre,',
    'En sintesis,',
  ];
  const perParagraph = Math.max(1, Math.ceil(Math.min(sentences.length, paragraphCount * 3) / paragraphCount));
  const paragraphs = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    const group = sentences.slice(index * perParagraph, (index + 1) * perParagraph);
    if (group.length === 0) break;
    paragraphs.push(`${connectors[index] || 'Ademas,'} ${group.join(' ')}`);
  }
  const evidenceBlock = executiveSummary
    ? allowBullets
      ? `\n**Evidencia base usada**\n${executiveSummary}`
      : `\n**Evidencia base usada.** ${executiveSummary}`
    : '';
  return [
    '### Conclusiones basadas en el documento adjunto',
    '',
    paragraphs.join('\n\n'),
    evidenceBlock,
  ].filter(Boolean).join('\n');
}

function buildAttachmentUnavailableFallbackAnswer({ goal = '', uploadedFileContext = '' } = {}) {
  const request = String(goal || '');
  if (wantsBibliographyAnswer(request)) {
    const partialRows = parseSpreadsheetCitationRows(uploadedFileContext);
    if (partialRows.length === 0) {
      return [
        'No pude leer bien las referencias de tu archivo para armar la bibliografía.',
        '',
        '**Para generar la bibliografía en APA 7:**',
        '1. Usa una hoja con columnas claras: **Título**, **Autor(es)**, **Año** (y revista o DOI si los tienes).',
        '2. Vuelve a subir el `.xlsx` original (no una captura ni un PDF exportado).',
        '3. O pega aquí 3–5 referencias en texto y formateo el resto con el mismo estilo.',
        '',
        'Si el chat no respondió al primer intento, **envía el mensaje otra vez** en unos segundos.',
      ].join('\n');
    }
  }

  const mentionsExcel = /excel|xlsx|hoja|spreadsheet|tabla/.test(normalizedKey(`${request} ${uploadedFileContext}`));
  return [
    'Recibí tu archivo, pero no encontré texto suficiente para responder con precisión.',
    '',
    '**Qué puedes hacer ahora:**',
    mentionsExcel
      ? '- En Excel, confirma que la hoja correcta tiene datos en celdas (no solo formato o imágenes) y vuelve a subir el `.xlsx`.'
      : '- Si es un PDF escaneado o una imagen, sube una versión más nítida o con OCR.',
    '- Si es Word, Excel o PDF con texto seleccionable, vuelve a subir el archivo original.',
    '- También puedes pegar aquí el fragmento clave y lo trabajo de inmediato.',
    '',
    'Si fue un fallo momentáneo del servicio, **reintenta el mismo mensaje** en unos segundos.',
  ].filter(Boolean).join('\n');
}

// Map a user-selected model id to the provider whose OpenAI-compatible
// chat/completions API can serve the agent runtime. The agent runner is
// built against the OpenAI Node SDK shape, but DeepSeek, OpenRouter and
// Gemini's OpenAI-compat surface all speak the same protocol, so we
// don't have to force-remap every selection to `gpt-4o-mini`.
function detectAgentRuntimeProvider(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  if (/^(gpt-|o\d|chatgpt-|ft:gpt-|ft:o)/i.test(id)) {
    return { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null };
  }
  if (/^deepseek(-|\/|$)/i.test(id)) {
    return { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' };
  }
  if (/^gemini-/i.test(id) || /^imagen-/i.test(id)) {
    return {
      provider: 'Gemini',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    };
  }
  if (/^(anthropic|meta-llama|moonshotai|x-ai|openrouter)\//i.test(id)) {
    return {
      provider: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      },
    };
  }
  return null;
}

function buildOpenAICompatibleClient(target) {
  if (!target || !target.apiKeyEnv) return null;
  const apiKey = process.env[target.apiKeyEnv];
  if (!apiKey) return null;
  const opts = { apiKey };
  if (target.baseURL) opts.baseURL = target.baseURL;
  if (target.defaultHeaders) opts.defaultHeaders = target.defaultHeaders;
  return new OpenAI(opts);
}

function normalizeAgentRuntimeModel(selectedModel) {
  const displayModel = String(selectedModel || '').trim() || 'gpt-4o';
  const configuredFallback = String(
    process.env.AGENT_TASK_OPENAI_MODEL ||
    process.env.AGENT_TASK_RUNTIME_MODEL ||
    'gpt-4o-mini'
  ).trim();
  const detected = detectAgentRuntimeProvider(displayModel);
  const isOpenAINative = detected && detected.provider === 'OpenAI';
  return {
    displayModel,
    runtimeModel: detected ? displayModel : configuredFallback,
    runtimeProvider: isOpenAINative
      ? 'selected-openai'
      : detected
        ? `selected-${detected.provider.toLowerCase()}`
        : 'openai-fallback',
    detected,
    remapped: !detected,
  };
}

// Resolve the OpenAI-compatible client the agent runtime should drive.
// Tries the user's selected provider first; if that provider has no API
// key configured, walks a small fallback list so we never hand the
// runtime null on a host that has at least one key set.
function resolveAgentRuntimeClient(profile) {
  const tried = new Set();
  const tryTarget = (target) => {
    if (!target) return null;
    const key = `${target.provider}:${target.apiKeyEnv}`;
    if (tried.has(key)) return null;
    tried.add(key);
    return buildOpenAICompatibleClient(target);
  };

  let primary = tryTarget(profile?.detected);
  if (primary) {
    return { client: primary, model: profile.runtimeModel, provider: profile.detected.provider };
  }

  const fallbackTargets = [
    { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null, model: profile?.runtimeModel || 'gpt-4o-mini' },
    { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    {
      provider: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      },
      model: 'moonshotai/kimi-k2.6',
    },
  ];
  for (const target of fallbackTargets) {
    const client = tryTarget(target);
    if (client) {
      return { client, model: target.model, provider: target.provider };
    }
  }
  return { client: null, model: profile?.runtimeModel || 'gpt-4o-mini', provider: 'unconfigured' };
}

async function persistAssistantMessage({
  chatId,
  userId,
  assistantMessageId,
  streamState,
  task,
  status,
  artifacts,
  metadata,
}) {
  if (!chatId || !prisma) return null;
  try {
    const { serializeAgentState } = routeInternals();
    const serialized = serializeAgentState(streamState);
    const data = {
      content: serialized,
      tokens: Math.ceil(serialized.length / 4),
      metadata: {
        source: 'agent-task',
        taskId: task.taskId,
        status,
        displayGoal: task.displayGoal,
        artifacts,
        updatedAt: new Date().toISOString(),
        ...metadata,
      },
    };
    if (assistantMessageId) {
      return prisma.message.update({ where: { id: assistantMessageId }, data });
    }
    const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return null;
    return prisma.message.create({
      data: { chatId, role: 'ASSISTANT', timestamp: new Date(), ...data },
    });
  } catch {
    return null;
  }
}

async function runAgentTaskJob(payload = {}, job = null) {
  const {
    taskId,
    traceId,
    user,
    goal,
    displayGoal,
    systemContract,
    files = [],
    fileMetadata = [],
    chatId = null,
    model = 'gpt-4o',
    maxSteps = 60,
    maxRuntimeMs = 2 * 60 * 60 * 1000,
  } = payload;
  if (!taskId) throw new Error('agent task payload missing taskId');
  if (!user?.id) throw new Error('agent task payload missing user.id');
  const plainTranscriptionRequest = isPlainTranscriptionRequest(goal);
  const hasAttachedFiles = Array.isArray(files) && files.length > 0;
  const deterministicVancouverRequest = isVancouverMatrixWordRequest(`${goal || ''} ${displayGoal || ''}`) &&
    hasAttachedFiles;
  if (!process.env.OPENAI_API_KEY && !plainTranscriptionRequest && !deterministicVancouverRequest && !hasAttachedFiles) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  if (payload.workflow?.pattern === 'fork_join' && !payload._skipForkJoin) {
    const { forkJoin } = require('./agent-collaboration');
    const subTasks = (payload.workflow.subTasks || []).slice(0, 3).map((st, idx) => ({
      goal: typeof st === 'string' ? st : (st.goal || goal),
      taskId: `${taskId}-fj-${idx}`,
      maxSteps: Math.min(25, maxSteps),
    }));
    if (subTasks.length >= 2) {
      taskStore.markTaskStatus({ taskId, userId: user.id }, 'running');
      const fj = await forkJoin({
        subTasks,
        user,
        options: {
          chatId,
          model,
          maxSteps: Math.min(25, maxSteps),
          maxRuntimeMs: Math.min(maxRuntimeMs, 180_000),
          onEvent: (type, data) => {
            try {
              taskStore.appendTaskEvent({ taskId, userId: user.id }, { type, payload: data });
            } catch { /* best-effort */ }
          },
        },
      });
      taskStore.markTaskStatus(
        { taskId, userId: user.id },
        fj.ok ? 'completed' : 'failed',
        { mergedSummary: fj.mergedSummary || null },
      );
      return { ok: fj.ok, pattern: 'fork_join', mergedSummary: fj.mergedSummary, results: fj.results };
    }
  }

  const internals = routeInternals();
  const controller = new AbortController();
  const startedAt = Date.now();
  const existing = taskStore.getTaskSnapshotForUser(taskId, user.id);
  let streamState = existing?.streamState || internals.initialAgentState();
  let documentPolicy = payload.documentPolicy || existing?.documentPolicy || buildDocumentDeliveryPolicy({
    goal,
    displayGoal,
    files,
  });
  const runtimeModelProfile = normalizeAgentRuntimeModel(model);

  const executionProfile = buildExecutionProfile({ goal, fileIds: files });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal, fileIds: files });
  // Attribution telemetry — runs the executive summary on the goal so we
  // can record what the system thought the user wanted before any step
  // executes. Pure local, no LLM. Posted as a task event so reviewers see
  // "I understood your goal as X (confidence Y)" alongside the run.
  try {
    if (String(process.env.SIRAGPT_AGENT_ATTRIBUTION_DISABLED || '').toLowerCase() !== '1') {
      const executiveSummary = require('../attribution-executive-summary');
      const attrSummary = executiveSummary.buildSummary({ prompt: String(goal || '') });
      try {
        taskStore.appendTaskEvent({ taskId, userId: user.id }, {
          type: 'attribution_summary',
          payload: {
            headline: attrSummary.headline,
            verdict: attrSummary.verdict,
            confidenceGrade: attrSummary.confidenceGrade,
            qualityGrade: attrSummary.qualityGrade,
            recommendedSkill: attrSummary.recommendedSkill?.id || null,
            metrics: attrSummary.metrics,
          },
        });
      } catch (_evtErr) { /* swallow */ }
    }
  } catch (_attrErr) { /* swallow */ }
  const universalTaskContract = buildUniversalTaskContract({
    rawUserRequest: goal,
    fileIds: files,
  });
  const finalizeProfile = buildFinalizeProfile(executionProfile, universalTaskContract);
  let taskContract = deriveLegacyTaskContract(universalTaskContract);
  let taskContractSource = 'fallback';
  // Resolve the actual OpenAI-compatible client (and final model id) for
  // the user's selected provider. If the user picked DeepSeek and we have
  // DEEPSEEK_API_KEY, we drive DeepSeek directly — without this, every
  // non-OpenAI selection used to be silently remapped to gpt-4o-mini and
  // would hard-fail whenever OPENAI_API_KEY was rate-limited.
  const runtimeClientResolution = resolveAgentRuntimeClient(runtimeModelProfile);
  const openai = runtimeClientResolution.client;
  if (runtimeClientResolution.client) {
    runtimeModelProfile.runtimeModel = runtimeClientResolution.model;
    runtimeModelProfile.runtimeProvider = runtimeClientResolution.provider;
    runtimeModelProfile.remapped = runtimeClientResolution.model !== runtimeModelProfile.displayModel
      || runtimeClientResolution.provider !== runtimeModelProfile.detected?.provider;
  }
  if (!plainTranscriptionRequest && openai) {
    try {
      const resolved = await resolveTaskContract({
        goal,
        openai,
        fileIds: files,
        fallback: () => deriveLegacyTaskContract(universalTaskContract),
      });
      taskContract = enforceLegacyTaskContract(resolved.contract || taskContract, universalTaskContract);
      taskContractSource = resolved.source || taskContractSource;
    } catch (err) {
      console.warn('[agent-task-runner] task-contract resolver failed:', err?.message);
    }
  }

  const taskPlan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    universalTaskContract,
    fileIds: files,
    maxRuntimeMs,
  });
  const enterpriseExecutionGraph = buildEnterpriseExecutionGraph({
    contract: universalTaskContract,
    taskId,
    userId: user.id,
    chatId,
  });
  const enterpriseToolRuntimePlan = buildToolRuntimePlan({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
  });
  const enterpriseQaBoardReview = buildAgenticQaBoardReview({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    phase: 'worker-preflight',
  });
  const agenticOperatingCore = buildAgenticOperatingCore({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    qaBoardReview: enterpriseQaBoardReview,
  });
  let durableExecution = null;
  try {
    durableExecution = durableExecutionStore.createDurableExecutionRecord({
      graph: enterpriseExecutionGraph,
      contract: universalTaskContract,
      taskId,
      userId: user.id,
      chatId,
      toolRuntimePlan: enterpriseToolRuntimePlan,
      qaBoardReview: enterpriseQaBoardReview,
    });
  } catch (err) {
    console.warn('[agent-task-runner] durable execution record failed:', err?.message || err);
  }
  const enterpriseRuntimeProfile = {
    ...buildEnterpriseRuntimeProfile(universalTaskContract, enterpriseExecutionGraph),
    agenticOperatingCore: agenticOperatingCore.summary,
    toolRuntime: enterpriseToolRuntimePlan.summary,
    qaPreflight: enterpriseQaBoardReview.summary,
    durableExecution: durableExecution
      ? {
        graphId: durableExecution.graphId,
        persisted: true,
        nodeCount: durableExecution.nodes.length,
        checkpointCount: durableExecution.checkpoints.length,
      }
      : { graphId: enterpriseExecutionGraph.graph_id, persisted: false },
  };

  const task = internals.createTaskRecord({
    taskId,
    userId: user.id,
    chatId,
    displayGoal,
    model,
    controller,
    maxSteps,
    maxRuntimeMs,
    streamState,
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    durableExecution,
    jobId: job?.id ? String(job.id) : existing?.jobId || taskId,
    queueName: getQueueName(),
    traceId: traceId || existing?.traceId || null,
    documentPolicy,
    status: 'running',
  });
  task.runtimeModel = runtimeModelProfile.runtimeModel;

  const artifacts = [];
  // Throttle in-flight progress upserts. A long-running task emits
  // hundreds of events; firing a Prisma upsert + BullMQ updateProgress
  // on every single one wastes DB connections and Redis round-trips.
  // The terminal persistProgress(status) call at the end always
  // bypasses the throttle so the final state lands authoritatively.
  const PROGRESS_THROTTLE_MS = 250;
  let lastProgressAt = 0;
  const persistProgress = (status = task.status, { force = false } = {}) => {
    const now = Date.now();
    const isTerminal = status !== 'running';
    if (!force && !isTerminal && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    void persistence.upsertAgentTask({
      ...task,
      status,
      state: streamState,
      documentPolicy,
    });
    if (job) {
      // Catch and discard: BullMQ writes progress through Redis, which
      // can reject mid-failover. Without .catch() the rejection goes
      // unhandled and (depending on Node policy) can terminate the
      // worker. Progress is best-effort observability — never fatal.
      Promise.resolve(job.updateProgress({ status, lastEventSeq: task.lastEventSeq || 0 })).catch(() => {});
    }
  };
  const emit = (event) => {
    streamState = internals.reduceAgentState(streamState, event);
    task.streamState = streamState;
    const written = taskStore.appendTaskEvent(task, event, streamState, { eventLimit: internals.TASK_EVENT_LIMIT || 600 });
    if (written) {
      task.events = written.events || task.events;
      task.checkpoints = written.checkpoints || task.checkpoints;
      task.lastEventSeq = written.lastEventSeq || task.lastEventSeq;
      task.artifacts = written.artifacts || task.artifacts;
    }
    void persistence.appendAgentTaskEvent(task, task.events?.[task.events.length - 1] || event);
    metrics.counter('agent_task_events_total', { type: event.type || 'unknown' });
    persistProgress('running');
    return event;
  };

  emit({
    type: 'queue_status',
    taskId,
    status: 'running',
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    position: null,
    estimatedWaitMs: 0,
  });
  emit({ type: 'document_policy', policy: documentPolicy });

  const langGraphLayer = await buildLangGraphLayer({ taskId, documentPolicy });
  const forbiddenToolNames = new Set(Array.isArray(universalTaskContract.forbidden_tools)
    ? universalTaskContract.forbidden_tools
    : []);
  const tools = buildTaskTools().filter((tool) => !forbiddenToolNames.has(tool.name));
  const frameworkStatus = await buildAgenticFrameworkStatus({ tools, langGraphLayer });
  emit({
    type: 'framework_status',
    taskId,
    ...frameworkStatus,
  });
  emit({
    type: 'checkpoint',
    label: langGraphLayer.enabled ? 'LangGraph durable listo' : 'Grafo durable fallback listo',
    status: 'saved',
    payload: {
      provider: langGraphLayer.provider,
      enabled: langGraphLayer.enabled,
      nodes: langGraphLayer.nodes,
      checkpointer: langGraphLayer.checkpointer || null,
      humanInTheLoop: Boolean(langGraphLayer.humanInTheLoop),
      fallback: langGraphLayer.fallback || null,
    },
  });

  emit({
    type: 'meta',
    taskId,
    goal: displayGoal,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    tools: tools.map((tool) => tool.name),
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    frameworks: frameworkStatus,
    taskContract,
    taskContractSource,
  });

  auditLog.audit({
    event: 'agent_task_worker_started',
    taskId,
    userId: user.id,
    chatId,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    modelRemapped: runtimeModelProfile.remapped,
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    traceId: task.traceId,
    documentPolicy: auditLog.slimDocumentPolicy(documentPolicy),
  });

  let assistantMessageId = existing?.assistantMessageId || null;
  const uploadedFileContext = await buildUploadedFileContext(prisma, {
    userId: user.id,
    fileIds: files,
    query: displayGoal || goal,
  });
  if (chatId && prisma) {
    try {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: user.id } });
      if (chat) {
        if (!existing?.assistantMessageId) {
          const messageFiles = await serializeMessageAttachments(prisma, {
            userId: user.id,
            fileIds: files,
            clientMetadata: fileMetadata,
          });
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: displayGoal,
              files: messageFiles.length ? messageFiles : null,
              timestamp: new Date(),
              metadata: { source: 'agent-task-user', taskId, fileIds: files },
            },
          });
        }
        const assistant = assistantMessageId
          ? null
          : await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: internals.serializeAgentState(streamState),
              timestamp: new Date(),
              metadata: {
                source: 'agent-task',
                taskId,
                status: 'running',
                displayGoal,
                documentPolicy,
              },
            },
          });
        assistantMessageId = assistantMessageId || assistant?.id || null;
        task.assistantMessageId = assistantMessageId;
        taskStore.markTaskStatus(task, 'running', { assistantMessageId, streamState });
      }
    } catch {
      // DB persistence is intentionally non-fatal for local/dev.
    }
  }

  let stepIdCounter = 0;
  let currentStepId = null;
  const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs + 5000);

  // ── BullMQ lock heartbeat ──────────────────────────────────────────
  // Agent tasks routinely run 10–20 min (max_steps=80 reached at ~19min
  // in prod logs). BullMQ's automatic lock renewal fires every
  // lockDuration/2 and any single failed renew (Upstash failover, quota
  // throttle, network blip) loses the lock for the rest of the run,
  // producing the "could not renew lock" spam and then the fatal
  // "Missing lock for job ... moveToFinished" when the work is done.
  //
  // We piggyback our own heartbeat that explicitly calls extendLock on
  // a tight cadence (every 30 s by default) using the job's token. If a
  // single tick fails we retry on the next tick instead of giving up,
  // and we throttle warns so a Redis outage logs once per minute, not
  // once per heartbeat. Cleared in the outer `finally` below.
  const lockHeartbeatIntervalMs = Math.max(
    5_000,
    Number.parseInt(process.env.AGENT_WORKER_LOCK_HEARTBEAT_MS || '30000', 10) || 30_000,
  );
  const lockHeartbeatExtendMs = Math.max(
    lockHeartbeatIntervalMs * 4,
    Number.parseInt(process.env.AGENT_WORKER_LOCK_DURATION_MS || '', 10) || 5 * 60 * 1000,
  );
  let lockHeartbeatTimer = null;
  let lockHeartbeatLastWarnAt = 0;
  if (job && typeof job.extendLock === 'function' && job.token) {
    const tick = async () => {
      try {
        await job.extendLock(job.token, lockHeartbeatExtendMs);
      } catch (err) {
        const now = Date.now();
        if (now - lockHeartbeatLastWarnAt > 60_000) {
          lockHeartbeatLastWarnAt = now;
          console.warn(
            `[agent-task-runner] lock heartbeat extendLock failed for ${taskId}: ${err?.message || err} (will keep retrying)`,
          );
        }
      }
    };
    // Refresh immediately so the first long step doesn't race the
    // initial 30s renew, then on a steady cadence.
    tick();
    lockHeartbeatTimer = setInterval(tick, lockHeartbeatIntervalMs);
    if (typeof lockHeartbeatTimer.unref === 'function') lockHeartbeatTimer.unref();
  }
  const finishDeterministicTask = async ({
    finalMarkdown,
    stoppedReason,
    steps,
    artifactsList = artifacts,
    metadata = {},
  }) => {
    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps, artifacts: artifactsList.length },
    });

    const status = 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts: artifactsList,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
        ...metadata,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps,
        artifacts: artifactsList.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts: artifactsList,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps,
            artifacts: artifactsList.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifactsList.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps,
      artifacts: artifactsList.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifactsList.length };
  };

  try {
    if (plainTranscriptionRequest) {
      const transcriptionFileIds = Array.isArray(files) && files.length
        ? files.map(String).filter(Boolean)
        : await resolveTranscriptionFileIds(prisma, {
          userId: user.id,
          chatId,
          providedFileIds: files,
        });
      const transcriptionText = await buildTranscriptionTextFromFiles(prisma, {
        userId: user.id,
        fileIds: transcriptionFileIds,
      });

      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: transcriptionText
          ? 'Solicitud de transcripción literal; se devuelve el texto extraído en el chat.'
          : 'Solicitud de transcripción literal sin contenido legible disponible.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          transcriptionOnly: true,
          fileCount: transcriptionFileIds.length,
          wordCount: transcriptionText ? transcriptionText.split(/\s+/).filter(Boolean).length : 0,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const readStepId = 's1';
      const finalStepId = 's2';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: readStepId, label: 'Leyendo archivo adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: readStepId, ok: Boolean(transcriptionText) });
      emit({
        type: 'checkpoint',
        label: transcriptionText ? 'Texto extraído' : 'Sin texto legible',
        status: transcriptionText ? 'saved' : 'warning',
        payload: { fileIds: transcriptionFileIds, textLength: transcriptionText.length },
      });
      stepIdCounter = 2;
      emit({ type: 'step_start', id: finalStepId, label: 'Preparando transcripción', icon: 'braces' });
      emit({ type: 'step_done', id: finalStepId, ok: true });

      const finalMarkdown = transcriptionText || 'No se encontró texto disponible para transcribir en los archivos adjuntos. Por favor, proporciona un archivo legible o más detalles sobre el contenido que deseas transcribir.';
      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        stats: { steps: 2, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts,
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
          transcriptionFileIds,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 2,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        },
        artifacts,
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 2,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        steps: 2,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        transcriptionFileCount: transcriptionFileIds.length,
        transcriptionTextLength: transcriptionText.length,
      });
      return { taskId, status, artifacts: 0 };
    }

    // ── Thin-attachment guard ─────────────────────────────────────────
    // If the user attached files AND the question references the attachment
    // ("de qué es esto?", "qué dice este documento?"), but extraction
    // produced only a handful of useful words, refuse to bluff. Ask the
    // user for the real content instead — better UX than a confident
    // "no se pudo determinar..." follow-up wrapped in an auto DOCX.
    const attachmentStats = assessAttachmentContext({
      uploadedFileContext,
      files,
      userText: displayGoal || goal,
    });
    if (attachmentStats.isThin) {
      const thinBibliographyFallback = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      if (thinBibliographyFallback) {
        documentPolicy = {
          ...(documentPolicy || {}),
          mode: 'chat_only',
          autoGenerate: false,
          reason: 'Bibliografía generada desde filas legibles del adjunto.',
          thresholds: {
            ...(documentPolicy?.thresholds || {}),
            attachmentFallback: true,
            thinContextWords: attachmentStats.usefulWords,
            fileCount: files.length,
          },
        };
        task.documentPolicy = documentPolicy;
        emit({ type: 'document_policy', policy: documentPolicy });
        stepIdCounter = 1;
        emit({ type: 'step_start', id: 's1', label: 'Formateando referencias', icon: 'file-text' });
        emit({ type: 'step_done', id: 's1', ok: true });
        return finishDeterministicTask({
          finalMarkdown: thinBibliographyFallback,
          stoppedReason: 'attachment_bibliography_fallback',
          steps: 1,
          artifactsList: [],
          metadata: {
            attachmentFallback: true,
            bibliographyRows: parseSpreadsheetCitationRows(uploadedFileContext).length,
            sourceFileIds: files,
          },
        });
      }

      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: 'Contexto adjunto insuficiente; se solicita material adicional al usuario.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          thinContextWords: attachmentStats.usefulWords,
          fileCount: files.length,
          transcriptionOnly: false,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const stepId = 's1';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: stepId, label: 'Revisando adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: stepId, ok: true });
      emit({
        type: 'checkpoint',
        label: 'Adjunto con contenido insuficiente',
        status: 'warning',
        payload: { usefulWords: attachmentStats.usefulWords, fileCount: files.length },
      });

      const wordsLabel = attachmentStats.usefulWords === 1 ? '1 palabra útil' : `${attachmentStats.usefulWords} palabras útiles`;
      const finalMarkdown = [
        `El material adjunto solo contiene ${wordsLabel}, lo que no me alcanza para responder tu pregunta con confianza.`,
        '',
        '**¿Puedes ayudarme con una de estas opciones?**',
        '- Pega el texto completo de la página o documento.',
        '- Sube el archivo original (PDF, DOCX, imagen completa).',
        '- Comparte el enlace de origen para revisar el contenido directamente.',
      ].join('\n');

      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: 'thin_attachment_context',
        stats: { steps: 1, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts: [],
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: 'thin_attachment_context',
          attachmentStats,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 1,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: 'thin_attachment_context',
        },
        artifacts: [],
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 1,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: 'thin_attachment_context',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: 'thin_attachment_context',
        steps: 1,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        attachmentStats,
      });
      return { taskId, status, artifacts: 0 };
    }

    if (!openai && hasAttachedFiles) {
      const recoveredMarkdown = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta generada desde el contenido del adjunto.'
          : 'Adjunto sin texto legible suficiente; se pidió material al usuario.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Analizando documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: Boolean(recoveredMarkdown) });
      emit({
        type: 'quality_gate',
        gate: 'attachment_local_fallback',
        label: recoveredMarkdown ? 'Respuesta desde el adjunto' : 'Adjunto requiere más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'Se generó la respuesta usando el texto extraído del archivo.'
          : 'Se indicó al usuario cómo aportar contenido legible.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: recoveredMarkdown ? 'attachment_local_fallback' : 'attachment_unreadable_fallback',
        steps: 1,
        artifactsList: [],
        metadata: {
          attachmentFallback: true,
          fallbackReason: 'openai_not_configured',
          sourceFileIds: files,
        },
      });
    }

    if (deterministicVancouverRequest) {
      documentPolicy = {
        ...buildDocumentDeliveryPolicy({
          goal,
          displayGoal,
          files,
          requestedFormat: 'docx',
        }),
        mode: 'doc_required',
        format: 'docx',
        autoGenerate: true,
        reason: 'Solicitud explícita de tabla en Word con estructura Vancouver.',
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Leyendo documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: true });
      emit({
        type: 'checkpoint',
        label: 'Contenido documental disponible',
        status: 'saved',
        payload: {
          fileCount: files.length,
          contextChars: String(uploadedFileContext || '').length,
        },
      });

      stepIdCounter = 2;
      emit({ type: 'step_start', id: 's2', label: 'Construyendo matriz Vancouver', icon: 'table' });
      const generated = await generateVancouverMatrixDocument({
        prisma,
        task,
        userId: user.id,
        fileIds: files,
        goal: displayGoal || goal,
        emit,
      });
      if (generated?.artifact) artifacts.push(generated.artifact);
      emit({ type: 'step_done', id: 's2', ok: true });

      stepIdCounter = 3;
      emit({ type: 'step_start', id: 's3', label: 'Preparando entrega final', icon: 'check' });
      emit({ type: 'step_done', id: 's3', ok: true });

      return finishDeterministicTask({
        finalMarkdown: generated.finalMarkdown,
        stoppedReason: 'vancouver_matrix_docx',
        steps: 3,
        artifactsList: artifacts,
        metadata: {
          vancouverMatrix: true,
          sourceFileIds: files,
          validation: generated.validation,
        },
      });
    }

    const { createAuthorizationGate } = require('./tool-authorization-gate');
    const toolManifest = require('./tool-manifest');
    const toolGate = createAuthorizationGate();
    const toolUsageMap = {};
    const toolCtx = {
      userId: user.id,
      userEmail: user.email,
      openai,
      signal: controller.signal,
      chatId,
      taskId,
      fileIds: files,
      displayGoal,
      taskContract,
      universalTaskContract,
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
      toolGate,
      toolAuthCtx: {
        userId: user.id,
        clearance: user.clearance || 'authenticated',
        scopes: user.scopes || [],
        taskId,
      },
      toolUsageMap,
      checkToolBudget: toolManifest.checkToolUsageBudget,
      enterpriseToolRuntimePlan,
      prisma,
      onEvent: (evt) => {
        const payloadEvent = { ...evt, stepId: evt.stepId || currentStepId };
        if (evt.type === 'file_artifact' && evt.artifact) {
          artifacts.push(evt.artifact);
          void persistence.persistGeneratedArtifact({ artifact: evt.artifact, task, validation: evt.artifact.validation });
        }
        if (evt.type === 'contract_review') {
          emit({
            type: 'quality_gate',
            gate: 'contract_review',
            label: 'Contrato de artefacto',
            passed: Boolean(evt.passed),
            summary: `${evt.testsPassed || 0}/${evt.testsTotal || 0} pruebas contractuales`,
            payload: evt,
          });
        }
        emit(payloadEvent);
      },
    };

    // Chat-only requests against an attachment have no artifact to
    // produce — the agent only needs to read the file, reason, and
    // answer inline. Capping at 20 steps prevents the runner from
    // looping for 3+ minutes when the attachment turns out to be
    // unreadable; the post-loop recovery (attachment_unreadable_
    // empty_response_recovery) then generates a fallback answer in
    // seconds instead of minutes. Non-attachment goals and document-
    // generation goals keep the caller-provided ceiling.
    const isChatOnlyWithAttachment = hasAttachedFiles
      && documentPolicy?.mode === 'chat_only';
    const effectiveMaxSteps = isChatOnlyWithAttachment
      ? Math.min(maxSteps, 20)
      : maxSteps;

    const result = await reactAgent.run(openai, {
      query: goal,
      tools,
      maxSteps: effectiveMaxSteps,
      maxRuntimeMs,
      model: runtimeModelProfile.runtimeModel,
      extraSystem: internals.buildAgentSystemPrompt(
        systemContract,
        files,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        taskContract,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        uploadedFileContext
      ),
      ctx: toolCtx,
      finalizeGuard: ({ steps }) => validateFinalize(finalizeProfile, steps),
      onStepStart: (step) => {
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        const thought = (step.thought || '').trim();
        const firstAction = step.actions?.[0];
        const label = thought || firstAction?.tool || 'Pensando...';
        const icon = internals.inferIconFor ? internals.inferIconFor(firstAction?.tool) : undefined;
        emit({ type: 'step_start', id: currentStepId, label: internals.shortLabel ? internals.shortLabel(label) : label, icon });
      },
      onStepDone: (step) => {
        const firstAction = step.actions?.[0];
        emit({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
        emit({
          type: 'checkpoint',
          label: `Paso ${stepIdCounter} guardado`,
          status: 'saved',
          payload: { stepId: currentStepId },
        });
        currentStepId = null;
      },
    });

    let finalMarkdown = result.finalAnswer || '';
    let stoppedReason = result.stoppedReason;
    const attachmentFinalNeedsRecovery = Array.isArray(files) && files.length > 0 && (
      looksLikeEmptyOrWeakFinalAnswer(finalMarkdown) ||
      looksLikeMissingAttachmentAnswer(finalMarkdown)
    );
    if (attachmentFinalNeedsRecovery) {
      const recoveredMarkdown = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: result.stoppedReason,
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      finalMarkdown = finalFallbackMarkdown;
      stoppedReason = recoveredMarkdown
        ? 'attachment_empty_response_recovery'
        : 'attachment_unreadable_empty_response_recovery';
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta generada desde el contenido del adjunto.'
          : 'Sin texto legible suficiente en el adjunto.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
          originalStoppedReason: result.stoppedReason,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({
        type: 'repair_attempt',
        attempt: 1,
        status: recoveredMarkdown ? 'recovered' : 'degraded',
        message: recoveredMarkdown
          ? 'Recuperé la respuesta usando el contenido de tu archivo.'
          : 'No hubía suficiente texto en el adjunto; te indico cómo continuar.',
      });
      if (stepIdCounter === 0) {
        stepIdCounter = 1;
        currentStepId = 's1';
        emit({ type: 'step_start', id: currentStepId, label: 'Recuperando respuesta desde el documento', icon: 'file-text' });
        emit({ type: 'step_done', id: currentStepId, ok: Boolean(recoveredMarkdown) });
        currentStepId = null;
      }
      emit({
        type: 'quality_gate',
        gate: 'attachment_empty_response_recovery',
        label: recoveredMarkdown ? 'Respuesta recuperada' : 'Se necesita más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'Se usó el texto del adjunto para completar la respuesta.'
          : 'Se explicó cómo aportar contenido legible en lugar de dejar el chat vacío.',
      });
    }
    documentPolicy = buildDocumentDeliveryPolicy({
      goal,
      displayGoal,
      finalText: finalMarkdown,
      files,
      requestedFormat: documentPolicy?.autoGenerate || documentPolicy?.mode === 'doc_required'
        ? documentPolicy?.format
        : null,
    });
    task.documentPolicy = documentPolicy;
    emit({ type: 'document_policy', policy: documentPolicy });

    if (documentPolicy.autoGenerate && artifacts.length === 0) {
      try {
        const generated = await generateAutoDocument({
          task,
          goal: displayGoal,
          finalText: finalMarkdown,
          policy: documentPolicy,
          signal: controller.signal,
          emit,
        });
        if (generated?.artifact) artifacts.push({
          id: generated.artifact.id,
          filename: generated.artifact.filename,
          format: generated.artifact.format,
          mime: generated.artifact.mime,
          sizeBytes: generated.artifact.sizeBytes,
          downloadUrl: generated.artifact.downloadUrl,
        });
        finalMarkdown = summarizeForChat(finalMarkdown, documentPolicy);
      } catch (err) {
        emit({
          type: 'repair_attempt',
          attempt: 1,
          status: 'failed',
          message: `La generación automática de documento falló: ${err.message}`,
        });
      }
    }

    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const completedStepCount = Math.max(result.steps.length, stepIdCounter);
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps: completedStepCount, artifacts: artifacts.length },
    });

    const status = stoppedReason === 'aborted' ? 'cancelled' : 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps: completedStepCount,
        artifacts: artifacts.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps: completedStepCount,
            artifacts: artifacts.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifacts.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps: completedStepCount,
      artifacts: artifacts.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifacts.length };
  } catch (err) {
    if (!controller.signal.aborted && hasAttachedFiles) {
      const recoveredMarkdown = buildBibliographyFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      }) || buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: err?.message,
      });
      const finalFallbackMarkdown = recoveredMarkdown || buildAttachmentUnavailableFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: recoveredMarkdown
          ? 'Respuesta generada desde el contenido del adjunto.'
          : 'Servicio interrumpido y adjunto sin texto legible suficiente.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      emit({
        type: 'repair_attempt',
        attempt: 1,
        status: recoveredMarkdown ? 'recovered' : 'degraded',
        message: recoveredMarkdown
          ? 'Recuperé la respuesta usando el contenido de tu archivo.'
          : 'El servicio falló y el adjunto no tenía texto suficiente; te indico los siguientes pasos.',
      });
      if (!currentStepId) {
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        emit({ type: 'step_start', id: currentStepId, label: 'Recuperando respuesta desde el documento', icon: 'file-text' });
      }
      emit({ type: 'step_done', id: currentStepId, ok: Boolean(recoveredMarkdown) });
      currentStepId = null;
      emit({
        type: 'quality_gate',
        gate: 'attachment_runtime_recovery',
        label: recoveredMarkdown ? 'Recuperación desde adjunto' : 'Se necesita más contenido',
        passed: Boolean(recoveredMarkdown),
        summary: recoveredMarkdown
          ? 'La respuesta se completó con el texto del adjunto.'
          : 'Se dieron instrucciones claras en lugar de un error opaco.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: recoveredMarkdown ? 'attachment_runtime_recovery' : 'attachment_unreadable_recovery',
        steps: Math.max(1, stepIdCounter),
        artifactsList: [],
        metadata: {
          attachmentFallback: true,
          fallbackReason: err?.message || 'runtime_failure',
          sourceFileIds: files,
        },
      });
    }
    const message = controller.signal.aborted ? 'Tarea detenida por el usuario.' : (err.message || 'agent task failed');
    task.status = controller.signal.aborted ? 'cancelled' : 'error';
    emit({ type: 'error', message });
    taskStore.markTaskStatus(task, task.status, {
      streamState,
      stats: { durationMs: Date.now() - startedAt, error: message },
    });
    persistProgress(task.status);
    auditLog.audit({
      event: 'agent_task_worker_failed',
      taskId,
      userId: user.id,
      chatId,
      status: task.status,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (task.status === 'error') throw err;
    return { taskId, status: task.status };
  } finally {
    clearTimeout(runtimeTimer);
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
  }
}

// ── Error introspection & recovery helpers ─────────────────────
// Used externally by the job scheduler to decide retry strategy.

// Add ±20% jitter so concurrent retries from the same upstream incident
// don't all hit at the exact same wall clock — flattens the recovery
// thundering herd without changing the average backoff.
function withJitter(baseMs) {
  if (!baseMs || baseMs <= 0) return baseMs;
  const spread = baseMs * 0.2;
  return Math.max(100, Math.round(baseMs + (Math.random() * 2 - 1) * spread));
}

/**
 * Classify an error thrown by runAgentTaskJob to determine retry eligibility.
 * Returns { retryable, reason, ttlMs } where ttlMs is how long before retry
 * (0 = immediate, >0 = backoff).
 */
const { classifyTaskError } = require('../../utils/task-error-classifier');

module.exports = {
  runAgentTaskJob,
  buildFinalizeProfile,
  classifyTaskError,
  normalizeAgentRuntimeModel,
  buildAttachmentGroundedFallbackAnswer,
  buildBibliographyFallbackAnswer,
  buildAttachmentUnavailableFallbackAnswer,
  parseSpreadsheetCitationRows,
  parseCitationAuthors,
  resolveAttachmentFallbackMarkdown,
};
