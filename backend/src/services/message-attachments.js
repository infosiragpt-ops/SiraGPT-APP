const fs = require('fs');
const path = require('path');
const ocrEngine = require('./ocr-engine');
const outputFormat = require('./output-format-contract');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const OCR_CONCURRENCY = Math.max(1, Number(process.env.MESSAGE_ATTACHMENTS_OCR_CONCURRENCY) || 3);
const BULK_CONTEXT_THRESHOLD = 50;

let _pLimitMod;
async function loadPLimit() {
  if (!_pLimitMod) {
    _pLimitMod = (await import('p-limit')).default;
  }
  return _pLimitMod;
}

async function mapWithLimit(items, fn, concurrency = OCR_CONCURRENCY) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (items.length === 1) return [await fn(items[0], 0)];
  const pLimit = await loadPLimit();
  const limit = pLimit(Math.max(1, Math.min(concurrency, items.length)));
  return Promise.all(items.map((item, idx) => limit(() => fn(item, idx))));
}

function uniqueFileIds(fileIds = [], max = MAX_SIMULTANEOUS_DOCUMENTS) {
  if (!Array.isArray(fileIds)) return [];
  return Array.from(new Set(fileIds.map(String).filter(Boolean))).slice(0, max);
}

function perFilePromptBudget(maxChars, totalFiles, { bulkMin = 160, normalMin = 1200, headerReserve = 180 } = {}) {
  const requested = Number(maxChars) || 36000;
  const total = Math.max(1, Number(totalFiles) || 1);
  const proportional = Math.floor(requested / total) - headerReserve;
  const floor = total >= BULK_CONTEXT_THRESHOLD ? bulkMin : normalMin;
  return Math.max(floor, proportional);
}

function compactString(value, max = 120000) {
  if (typeof value !== 'string') return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[Contenido truncado para almacenamiento del mensaje]`;
}

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim() || fallback;
}

function isImageFile(row = {}) {
  const mime = String(row.mimeType || row.type || '').toLowerCase();
  const name = String(row.originalName || row.filename || '').toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(name);
}

function hasUsefulExtractedText(value) {
  return ocrEngine.hasUsefulText(value);
}

function looksLikeUnsupportedExtractionPlaceholder(value) {
  const text = String(value || '').trim();
  return /^File\s+"[^"]+"\s+uploaded successfully\.\s+Content type:\s+application\/(?:octet-stream|zip|x-zip|x-zip-compressed)\.?$/i.test(text);
}

/**
 * describeUnextractedAttachment — build an honest, type-aware placeholder
 * for an attachment whose text could NOT be extracted (empty OCR on a
 * photo/diagram, scanned/protected PDF, binary/unsupported doc). It
 * replaces the old dead-end "Binary file - content not available" string,
 * which left the model with no idea what happened — to users that read as
 * "it can't analyze my file." This message instead tells the model what
 * went wrong and what to relay to the user (describe it / re-upload a
 * text version / switch to a vision model). Pure, never throws; kept in
 * the product's primary locale (Spanish).
 */
function describeUnextractedAttachment(row = {}) {
  const r = row || {};
  const name = String(r.name || r.originalName || r.filename || 'archivo').trim() || 'archivo';
  const type = String(r.mimeType || r.type || '').toLowerCase();
  if (isImageFile(r)) {
    return `[Imagen "${name}": no se detectó texto legible mediante OCR. `
      + 'Si es una foto o un diagrama sin texto, el modelo de texto actual no puede verla directamente. '
      + 'Pídele al usuario que describa su contenido, o sugiérele cambiar a un modelo con visión.]';
  }
  if (type.includes('pdf') || /\.pdf$/i.test(name)) {
    return `[Documento PDF "${name}": no se pudo extraer texto. `
      + 'Probablemente es un PDF escaneado (solo imagen) o está protegido. '
      + 'Sugiere al usuario subir una versión con texto seleccionable.]';
  }
  if (type.startsWith('audio/') || type.startsWith('video/')) {
    return `[Archivo multimedia "${name}": no se obtuvo transcripción. `
      + 'Indica al usuario que reintente o suba un formato compatible.]';
  }
  return `[Archivo "${name}": no se pudo extraer su contenido (puede estar vacío, protegido `
    + 'o en un formato no soportado). Pide al usuario que reintente o lo suba en otro formato.]';
}

function isSpreadsheetFile(row = {}) {
  const mime = String(row.mimeType || row.type || '').toLowerCase();
  const name = String(row.originalName || row.filename || '').toLowerCase();
  return (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    (mime.includes('zip') && /\.xlsx$/i.test(name)) ||
    (mime.includes('octet-stream') && /\.xlsx$/i.test(name)) ||
    /\.(xlsx|csv|tsv)$/i.test(name)
  );
}

const TRANSCRIPTION_RE = /\b(transcrib(?:e|ir|eme|irme|iendo|irlo|irla|elo|ela)?|transcripci[oó]n|transcripcion|transcribe|transcript|transcription)\b/i;
const EXPLICIT_TRANSCRIPTION_FILE_OUTPUT_RE = /\b(?:en|como|a)\s+(?:un\s+|una\s+)?(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint)\b|\b(?:exporta(?:r|me)?|descarga(?:r|me)?|genera(?:r|me)?|crea(?:r|me)?|prepara(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|archivo\s+descargable)\b/i;

function isPlainTranscriptionRequest(value) {
  const text = String(value || '');
  return TRANSCRIPTION_RE.test(text) && !EXPLICIT_TRANSCRIPTION_FILE_OUTPUT_RE.test(text);
}

function isReadableFileCandidate(row = {}) {
  if (hasUsefulExtractedText(row.extractedText)) return true;
  const mime = String(row.mimeType || row.type || '').toLowerCase();
  const name = String(row.originalName || row.filename || '').toLowerCase();
  return (
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    /officedocument|msword|presentation|spreadsheet|wordprocessingml/.test(mime) ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|pdf|txt|md|docx?|pptx?|xlsx?|csv)$/i.test(name)
  );
}

function extractFileIdsFromMessageFiles(input) {
  if (!input) return [];
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }

  const ids = [];
  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      ids.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object') {
      const id = node.id || node.fileId || node.attachmentId;
      if (id) ids.push(String(id));
      if (Array.isArray(node.files)) node.files.forEach(visit);
      if (Array.isArray(node.attachments)) node.attachments.forEach(visit);
    }
  };

  visit(value);
  return uniqueFileIds(ids);
}

function resolveStoredFilePath(row = {}, userId = '') {
  const candidates = [];
  if (row.path) {
    candidates.push(row.path);
    candidates.push(path.resolve(row.path));
  }
  if (row.filename && userId) {
    candidates.push(path.join(BACKEND_ROOT, 'uploads', String(userId), row.filename));
    candidates.push(path.join(process.cwd(), 'uploads', String(userId), row.filename));
    candidates.push(path.join(process.cwd(), 'backend', 'uploads', String(userId), row.filename));
  }
  return candidates.find((candidate) => {
    try {
      return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

async function ensureImageOcr(prisma, row, userId) {
  if (!row || !isImageFile(row) || hasUsefulExtractedText(row.extractedText)) return row;
  const filePath = resolveStoredFilePath(row, userId);
  if (!filePath) return row;

  try {
    const result = await ocrEngine.extractFromImage(filePath, { mimeType: row.mimeType || row.type || 'image/png' });
    const extractedText = result.text || '';
    if (!hasUsefulExtractedText(extractedText)) return row;
    if (prisma?.file?.update) {
      await prisma.file.update({
        where: { id: row.id },
        data: { extractedText },
      }).catch(() => null);
    }
    return { ...row, extractedText, ocr: result.ocr };
  } catch (err) {
    console.warn(`[message-attachments] image OCR fallback failed for ${row.id}:`, err?.message || err);
    return row;
  }
}

function normalizeClientLongPasteMeta(file = {}) {
  const raw = file.longPasteMeta || file.longPasteMetadata || {};
  const title = safeText(file.longPasteTitle || raw.title, '');
  if (!title && !file.isLongPasteDocument) return null;
  return {
    kind: 'long_paste_document',
    title: title || 'Texto pegado',
    filename: safeText(raw.filename || file.filename || file.originalName || file.name, ''),
    preview: safeText(file.longPastePreview || raw.preview, '').slice(0, 1200),
    originalCharCount: Number(raw.originalCharCount || file.originalCharCount || 0) || null,
    originalWordCount: Number(raw.originalWordCount || file.originalWordCount || 0) || null,
    originalLineCount: Number(raw.originalLineCount || file.originalLineCount || 0) || null,
    createdAt: safeText(raw.createdAt || file.createdAt, ''),
  };
}

function normalizeClientMetadata(input, fileIds = []) {
  if (!Array.isArray(input)) return [];
  const allowed = new Set((Array.isArray(fileIds) ? fileIds : []).map(String));
  return input
    .map((file) => {
      if (!file || typeof file !== 'object') return null;
      const id = safeText(file.id || file.fileId || file.attachmentId, '');
      if (!id || (allowed.size > 0 && !allowed.has(id))) return null;
      const longPasteMeta = normalizeClientLongPasteMeta(file);
      return {
        id,
        name: safeText(file.name, ''),
        originalName: safeText(file.originalName || file.filename, ''),
        filename: safeText(file.filename, ''),
        mimeType: safeText(file.mimeType || file.type || file.contentType, ''),
        type: safeText(file.type || file.mimeType || file.contentType, ''),
        size: Number(file.size || 0) || null,
        url: safeText(file.url, ''),
        openaiFileId: safeText(file.openaiFileId, ''),
        sourceChannel: safeText(file.sourceChannel, ''),
        isLongPasteDocument: Boolean(file.isLongPasteDocument || longPasteMeta),
        longPasteTitle: longPasteMeta?.title || safeText(file.longPasteTitle, ''),
        longPastePreview: longPasteMeta?.preview || safeText(file.longPastePreview, ''),
        longPasteMeta,
      };
    })
    .filter(Boolean);
}

async function loadFileRows(prisma, userId, fileIds = []) {
  if (!prisma || !userId || !Array.isArray(fileIds) || fileIds.length === 0) return [];
  const ids = uniqueFileIds(fileIds);
  if (ids.length === 0) return [];
  try {
    return await prisma.file.findMany({
      where: { id: { in: ids }, userId },
      select: {
        id: true,
        filename: true,
        originalName: true,
        mimeType: true,
        size: true,
        path: true,
        extractedText: true,
        openaiFileId: true,
        documentAnalysis: {
          select: {
            id: true,
            status: true,
            summary: true,
            textCoverage: true,
            ocr: true,
            warnings: true,
            pageCount: true,
            sheetCount: true,
            slideCount: true,
            chunkCount: true,
            tableCount: true,
            chunks: {
              orderBy: { ordinal: 'asc' },
              take: 4,
              select: {
                id: true,
                ordinal: true,
                sourceType: true,
                sourceLabel: true,
                pageNumber: true,
                sheetName: true,
                slideNumber: true,
                sectionTitle: true,
                text: true,
              },
            },
            tables: {
              orderBy: { ordinal: 'asc' },
              take: 3,
              select: {
                id: true,
                ordinal: true,
                sourceType: true,
                sourceLabel: true,
                sheetName: true,
                title: true,
                columns: true,
                rowCount: true,
                preview: true,
              },
            },
          },
        },
      },
    });
  } catch {
    return [];
  }
}

async function ensureDocumentAnalysis(prisma, row, userId) {
  if (!row || !prisma?.documentAnalysis) return row;
  const forceReanalysis = isSpreadsheetFile(row) && looksLikeUnsupportedExtractionPlaceholder(row.extractedText);
  if (row.documentAnalysis && !forceReanalysis) return row;
  try {
    const documentIntelligence = require('./document-intelligence');
    const analysis = await documentIntelligence.analyzeFile(prisma, {
      userId,
      fileRecord: row,
      force: forceReanalysis,
    });
    return { ...row, documentAnalysis: analysis };
  } catch (err) {
    console.warn(`[message-attachments] document analysis unavailable for ${row.id}:`, err?.message || err);
    return row;
  }
}

function analysisChunksToText(analysis, maxChars = 120000) {
  const chunks = Array.isArray(analysis?.chunks) ? analysis.chunks : [];
  const text = chunks
    .map((chunk) => safeText(chunk.text, ''))
    .filter(Boolean)
    .join('\n\n---\n\n')
    .trim();
  return compactString(text, maxChars);
}

function documentTextForRow(row, maxChars = 120000) {
  const directText = hasUsefulExtractedText(row?.extractedText) && !looksLikeUnsupportedExtractionPlaceholder(row.extractedText)
    ? safeText(row.extractedText, '')
    : '';
  const analysisText = analysisChunksToText(row?.documentAnalysis, maxChars) || '';
  return compactString(directText || analysisText, maxChars) || '';
}

function normalizeForSearch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function countDocumentWords(value) {
  return (normalizeForSearch(value).match(/[a-z0-9]{3,}/g) || []).length;
}

function isExactDocumentExtractionQuestion(query) {
  return /\b(transcrib|transcripcion|copia|copiar|literal|textual|verbatim|exact[oa]|primera palabra|primer parrafo|primer p[aá]rrafo|extrae el texto|extraer el texto|texto completo)\b/i.test(
    String(query || '')
  );
}

function isProfessionalDocumentSynthesisRequest(query) {
  const normalized = normalizeForSearch(query);
  if (!normalized || isExactDocumentExtractionQuestion(query)) return false;
  return /\b(analiza|analisis|resumen|resume|sintesis|conclusion|conclusiones|de que trata|que dice|explica|interpreta|hallazgo|hallazgos|recomendacion|recomendaciones|evaluacion|critica)\b/.test(normalized);
}

function wantsSingleParagraphSynthesis(query) {
  return outputFormat.wantsSingleParagraphSynthesis(query);
}

// Returns the explicit number of paragraphs the user asked for (e.g. "en 2
// parrafos" -> 2), or 0 when none was requested. Capped at 6 and only honored
// for >= 2 so the dedicated single-paragraph path keeps handling "1 parrafo".
function requestedParagraphCount(query) {
  return outputFormat.requestedParagraphCount(query);
}

function stripDocumentExtractorHeader(text) {
  return String(text || '')
    .replace(/^(?:Word document|PDF document|PowerPoint document|Excel workbook|Spreadsheet|Text document)\s+[^\n]*\n---\n/i, '')
    .replace(/^---\s*\n/, '');
}

function looksLikeFrontMatterLine(line, index = 0) {
  const raw = String(line || '').trim();
  if (!raw) return true;
  const normalized = normalizeForSearch(raw).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return true;
  const linkCount = (raw.match(/\]\(/g) || []).length;
  if (index < 90 && linkCount >= 2) return true;
  if (/^(indice de contenidos|indice general|tabla de contenido|table of contents|index|indice de tablas|indice de figuras)\b/.test(normalized)) return true;
  if (index < 90 && /\b(declaratoria de autenticidad|dedicatoria|agradecimientos?|asesor|autores?|bachiller|jurado|facultad|escuela profesional)\b/.test(normalized)) return true;
  if (index < 90 && /^(?:[ivxlcdm]+|\d{1,3})$/.test(normalized)) return true;
  if (index < 90 && /^(?:declaratoria|dedicatoria|agradecimiento|indice|tabla de contenido)\b.*\b(?:[ivxlcdm]+|\d{1,3})$/.test(normalized)) return true;
  return false;
}

function dropLeadingTocBlob(text) {
  const source = String(text || '');
  const head = source.slice(0, 5000);
  if (!/\b(?:indice de contenidos|indice general|tabla de contenido|table of contents|declaratoria de autenticidad)\b/i.test(head.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
    return source;
  }
  const bodyAnchorPatterns = [
    /(?:^|\n|\s)(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*\s*)?introducci[oó]n(?:\s|\n)+(?:actualmente|el|la|los|las|este|esta|en|se|a\s+partir)\b/i,
    /(?:^|\n|\s)(?:#{1,6}\s*)?cap[ií]tulo\s+(?:[ivxlcdm]+|\d+)\s+(?:planteamiento\s+del\s+problema|marco\s+te[oó]rico|metodolog[ií]a|resultados?|discusi[oó]n|conclusiones?)\b/i,
    /(?:^|\n|\s)(?:#{1,6}\s*)?(?:resumen|abstract)\s+(?:el|la|este|esta|en|se|la\s+presente|el\s+presente)\b/i,
  ];

  const bodyStart = bodyAnchorPatterns
    .map((pattern) => head.match(pattern))
    .filter((match) => match && Number.isInteger(match.index) && match.index > 0)
    .sort((a, b) => a.index - b.index)[0];
  if (bodyStart) {
    return source.slice(bodyStart.index).trimStart();
  }
  return source;
}

function prepareDocumentTextForProfessionalSynthesis(text) {
  const original = String(text || '');
  if (!original.trim()) return '';
  let cleaned = stripDocumentExtractorHeader(original)
    .replace(/\[[^\]\n]{0,12}\.\s*#\s*/g, '# ')
    .replace(/\[\s*#\s*/g, '# ');

  cleaned = dropLeadingTocBlob(cleaned)
    .replace(/\[([^\]\n]{1,180})\]\((?:#[^)]+|[^)]*)\)/g, '$1')
    .replace(/\u00a0/g, ' ');

  const lines = cleaned
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line, index) => !looksLikeFrontMatterLine(line, index));

  cleaned = lines.join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const originalLooksLikeToc = /\b(?:indice de contenidos|indice general|tabla de contenido|table of contents|declaratoria de autenticidad)\b/i.test(
    original.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  );
  const cleanedHasBodyAnchor = /\b(?:introducci[oó]n|cap[ií]tulo\s+(?:[ivxlcdm]+|\d+)\s+(?:planteamiento|marco|metodolog[ií]a|resultados?|discusi[oó]n|conclusiones?)|resumen|abstract)\b/i.test(cleaned);
  if (countDocumentWords(cleaned) < 25 && countDocumentWords(original) >= 25 && !(originalLooksLikeToc && cleanedHasBodyAnchor && countDocumentWords(cleaned) >= 8)) {
    return stripDocumentExtractorHeader(original)
      .replace(/\[([^\]\n]{1,180})\]\((?:#[^)]+|[^)]*)\)/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  return cleaned;
}

function isDeepDocumentQuestion(query) {
  return /\b(conclusion|conclusiones|concluir|concluye|analiza|analisis|resumen|resume|sintesis|sintetiza|resultado|resultados|discusion|hallazgo|hallazgos|recomendacion|recomendaciones|objetivo|objetivos|segun|interpreta|extrae)\b/.test(
    normalizeForSearch(query)
  );
}

function isBibliographyRequest(query) {
  return /\b(bibliograf|referenc|citas?|apa|vancouver|harvard|chicago|mla)\b/.test(normalizeForSearch(query));
}

function isSpreadsheetMime(mime) {
  return /spreadsheet|excel|csv|ms-excel|sheet/i.test(String(mime || ''));
}

function isGenericDocumentOverviewQuestion(query) {
  const normalized = normalizeForSearch(query);
  if (!/\b(resumen|resume|sintesis|analisis general|de que trata|que dice|explica)\b/.test(normalized)) {
    return false;
  }
  const terms = normalized.match(/[a-z0-9]{4,}/g) || [];
  const domainTerms = terms.filter((term) => ![
    'dame', 'hazme', 'hacer', 'hace', 'quiero', 'necesito', 'puedes', 'podrias',
    'resumen', 'resume', 'sintesis', 'analisis', 'general', 'explica', 'trata',
    'dice', 'este', 'esta', 'esto', 'documento', 'archivo', 'adjunto', 'sobre',
  ].includes(term));
  return domainTerms.length === 0;
}

function sourceLabelForEvidence(item = {}) {
  const parts = [];
  if (item.sectionTitle) parts.push(item.sectionTitle);
  if (item.sourceLabel && !parts.includes(item.sourceLabel)) parts.push(item.sourceLabel);
  if (item.pageNumber) parts.push(`pagina ${item.pageNumber}`);
  if (item.sheetName) parts.push(`hoja ${item.sheetName}`);
  if (item.slideNumber) parts.push(`slide ${item.slideNumber}`);
  return parts.filter(Boolean).join(' · ') || `fragmento ${item.ordinal || item.id || ''}`.trim();
}

function buildBalancedExcerpt(text, maxChars, query = '') {
  const source = isProfessionalDocumentSynthesisRequest(query)
    ? safeText(prepareDocumentTextForProfessionalSynthesis(text), '')
    : safeText(text, '');
  const budget = Math.max(160, Number(maxChars) || 6000);
  if (source.length <= budget) return source;

  const normalized = normalizeForSearch(source);
  const terms = Array.from(new Set(normalizeForSearch(query).match(/[a-z0-9]{4,}/g) || []))
    .filter((term) => !['dame', 'para', 'como', 'documento', 'archivo', 'profesional', 'profesionales'].includes(term));
  const firstRelevant = terms
    .map((term) => normalized.indexOf(term))
    .filter((idx) => idx >= Math.floor(source.length * 0.08))
    .sort((a, b) => a - b)[0];

  const headBudget = Math.floor(budget * 0.18);
  const tailBudget = Math.floor(budget * 0.32);
  const middleBudget = budget - headBudget - tailBudget - 120;
  const head = source.slice(0, headBudget).trim();
  const tail = source.slice(Math.max(0, source.length - tailBudget)).trim();
  const middle = Number.isInteger(firstRelevant)
    ? source.slice(
      Math.max(0, firstRelevant - Math.floor(middleBudget / 2)),
      Math.min(source.length, firstRelevant + Math.floor(middleBudget / 2))
    ).trim()
    : '';

  return [
    head,
    middle ? '\n[Fragmento intermedio relevante]\n' + middle : '',
    '\n[Fragmento final del documento]\n' + tail,
  ].filter(Boolean).join('\n\n...\n\n');
}

function dedupeEvidence(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.id || `${item.ordinal}:${safeText(item.text, '').slice(0, 80)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function retrieveRelevantEvidence(prisma, { userId, row, query, limit = 16 } = {}) {
  if (!query || !row?.id || !prisma?.documentChunk || !prisma?.documentAnalysis) return [];
  try {
    const documentIntelligence = require('./document-intelligence');
    const primary = await documentIntelligence.retrieveEvidence(prisma, {
      userId,
      fileId: row.id,
      query,
      limit,
    });
    return dedupeEvidence(primary.evidence || []);
  } catch (err) {
    console.warn(`[message-attachments] document evidence unavailable for ${row.id}:`, err?.message || err);
    return [];
  }
}

async function resolveTranscriptionFileIds(prisma, {
  userId,
  chatId = null,
  providedFileIds = [],
  recentWindowMs = 15 * 60 * 1000,
} = {}) {
  const provided = uniqueFileIds(Array.isArray(providedFileIds) ? providedFileIds : []);
  if (provided.length > 0 || !prisma || !userId) return provided;

  if (chatId && prisma.chat?.findFirst && prisma.message?.findMany) {
    const chat = await prisma.chat.findFirst({
      where: { id: String(chatId), userId },
      select: { id: true },
    }).catch(() => null);

    if (chat) {
      const messages = await prisma.message.findMany({
        where: { chatId: chat.id },
        orderBy: { timestamp: 'desc' },
        take: 30,
        select: { files: true },
      }).catch(() => []);

      const ids = [];
      for (const message of messages) {
        ids.push(...extractFileIdsFromMessageFiles(message.files));
      }

      const unique = uniqueFileIds(ids);
      if (unique.length > 0) {
        const rows = await loadFileRows(prisma, userId, unique);
        const allowed = new Set(rows.filter(isReadableFileCandidate).map((row) => row.id));
        const resolved = unique.filter((id) => allowed.has(id)).slice(0, MAX_SIMULTANEOUS_DOCUMENTS);
        if (resolved.length > 0) return resolved;
      }
    }
  }

  if (prisma.file?.findMany) {
    const recentSince = new Date(Date.now() - recentWindowMs);
    const recent = await prisma.file.findMany({
      where: { userId, createdAt: { gte: recentSince } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        filename: true,
        originalName: true,
        mimeType: true,
        extractedText: true,
      },
    }).catch(() => []);

    const candidates = recent.filter(isReadableFileCandidate);
    if (candidates.length === 1) return [candidates[0].id];
  }

  return [];
}

/**
 * Does this text look like a QUESTION about an already-uploaded document
 * (a follow-up), rather than a build/research/generation task? Used to decide
 * whether to reattach a chat's prior document when no file is sent. Broad on
 * doc-understanding signals, conservative against creation/external commands so
 * an unrelated old upload is never hijacked by a "crea una app" task. Shared by
 * the chat route and the agent-task route.
 */
function looksLikeDocumentFollowupQuestion(text) {
  const v = String(text || '').trim().toLowerCase();
  if (!v || v.length > 400) return false;
  if (/\b(crea|cre[aá]me|genera|gener[aá]me|construye|desarrolla|dise[ñn]a|build|create|develop|investiga en internet|busca en (la )?(web|internet)|descarga|deploy|sube a|haz una (app|web|p[aá]gina))\b/i.test(v)) {
    return false;
  }
  return /\b(qu[eé]|cu[aá]l(es)?|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eé]n(es)?|cu[aá]nto?s?|por qu[eé]|what|which|who|where|when|how|why|resume|res[uú]men|res[uú]me|resumir|explica|expl[ií]came|analiza|an[aá]lisis|de qu[eé] trata|t[ií]tulo|title|autor|objetivo|conclusi[oó]n|secci[oó]n|cap[ií]tulo|p[aá]gina|menciona|dice|trata|contiene|summary|about|tell me|agrega\w*|a[ñn]ad\w*|borr\w*|elimin\w*|quit\w*|reemplaz\w*|complet\w*|rellen\w*|corrig\w*|edit[ae]\w*|modific\w*|insert\w*|cambi\w*)\b/i.test(v);
}

/**
 * Resolve the most recent readable document(s) attached earlier in a chat.
 *
 * The frontend drops the prior attachment when a user asks a follow-up about an
 * already-uploaded document ("cual es el titulo?"), sending `files: []`. This
 * recovers those file ids from the chat's recent message history so the turn can
 * still answer from the document instead of failing. Mirrors the chat-scan in
 * `resolveTranscriptionFileIds` but without the transcription-only recent-file
 * fallback (so it never grabs an unrelated upload from another chat).
 */
async function resolveChatDocumentFileIds(prisma, {
  userId,
  chatId = null,
  providedFileIds = [],
  take = 30,
} = {}) {
  const provided = uniqueFileIds(Array.isArray(providedFileIds) ? providedFileIds : []);
  if (provided.length > 0 || !prisma || !userId || !chatId) return provided;
  if (!prisma.chat?.findFirst || !prisma.message?.findMany) return [];

  const chat = await prisma.chat.findFirst({
    where: { id: String(chatId), userId },
    select: { id: true },
  }).catch(() => null);
  if (!chat) return [];

  const messages = await prisma.message.findMany({
    where: { chatId: chat.id },
    orderBy: { timestamp: 'desc' },
    take: Math.max(1, Math.min(100, Number(take) || 30)),
    select: { files: true },
  }).catch(() => []);

  const ids = [];
  for (const message of messages) {
    ids.push(...extractFileIdsFromMessageFiles(message.files));
  }
  const unique = uniqueFileIds(ids);
  if (unique.length === 0) return [];

  const rows = await loadFileRows(prisma, userId, unique);
  const allowed = new Set(rows.filter(isReadableFileCandidate).map((row) => row.id));
  // Preserve recency order (messages are newest-first, so `unique` is too).
  return unique.filter((id) => allowed.has(id)).slice(0, MAX_SIMULTANEOUS_DOCUMENTS);
}

async function serializeMessageAttachments(prisma, { userId, fileIds = [], clientMetadata = [] } = {}) {
  const ids = uniqueFileIds(Array.isArray(fileIds) ? fileIds : []);
  if (ids.length === 0) return [];

  const rows = await loadFileRows(prisma, userId, ids);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const client = normalizeClientMetadata(clientMetadata, ids);
  const clientById = new Map(client.map((file) => [file.id, file]));

  return ids.map((id, index) => {
    const row = rowsById.get(id);
    const meta = clientById.get(id) || {};
    const longPasteMeta = meta.longPasteMeta || null;
    const longPasteTitle = safeText(meta.longPasteTitle || longPasteMeta?.title, '');
    const serverName = safeText(row?.originalName, '');
    const clientName = safeText(meta.originalName || meta.name, '');
    const displayName = longPasteTitle || clientName || serverName || `Archivo ${index + 1}`;
    const mimeType = safeText(row?.mimeType || meta.mimeType || meta.type, '');
    const filename = safeText(row?.filename || meta.filename || serverName || clientName, '');

    return {
      id,
      name: displayName,
      originalName: displayName,
      filename,
      mimeType: mimeType || null,
      type: mimeType || null,
      size: row?.size ?? meta.size ?? null,
      url: row?.filename ? `/uploads/${userId}/${row.filename}` : (meta.url || null),
      extractedText: compactString(hasUsefulExtractedText(row?.extractedText) ? row.extractedText : null, 120000),
      openaiFileId: row?.openaiFileId || meta.openaiFileId || null,
      sourceChannel: meta.sourceChannel || null,
      isLongPasteDocument: Boolean(meta.isLongPasteDocument || longPasteMeta || longPasteTitle),
      longPasteTitle: longPasteTitle || null,
      longPastePreview: meta.longPastePreview || longPasteMeta?.preview || null,
      longPasteMeta: longPasteMeta || null,
    };
  });
}

async function buildUploadedFileContext(prisma, {
  userId,
  fileIds = [],
  query = '',
  maxChars = 36000,
  evidenceLimit = 18,
} = {}) {
  const ids = uniqueFileIds(Array.isArray(fileIds) ? fileIds : []);
  if (ids.length === 0) return '';
  const rows = await loadFileRows(prisma, userId, ids);
  const ocrRows = await mapWithLimit(rows, (row) => ensureImageOcr(prisma, row, userId));
  const enrichedRows = await mapWithLimit(ocrRows, (row) => ensureDocumentAnalysis(prisma, row, userId));
  const withText = enrichedRows
    .map((row) => ({ ...row, documentText: documentTextForRow(row, Math.max(maxChars, 240000)) }))
    .filter((row) => hasUsefulExtractedText(row.documentText));
  if (withText.length === 0) return '';

  const perFileBudget = perFilePromptBudget(maxChars, withText.length, {
    bulkMin: 180,
    normalMin: 1200,
    headerReserve: withText.length >= BULK_CONTEXT_THRESHOLD ? 180 : 120,
  });
  const bulkBatch = withText.length >= BULK_CONTEXT_THRESHOLD;
  const bibliographyRequest = isBibliographyRequest(query);
  const deepQuestion = isDeepDocumentQuestion(query) || bibliographyRequest;
  const blocks = await mapWithLimit(withText, async (row, index) => {
    const analysis = row.documentAnalysis || null;
    const chunks = Array.isArray(analysis?.chunks) ? analysis.chunks : [];
    const tables = Array.isArray(analysis?.tables) ? analysis.tables : [];
    const genericOverview = isGenericDocumentOverviewQuestion(query);
    const synthesisRequest = isProfessionalDocumentSynthesisRequest(query);
    const effectiveDocumentText = synthesisRequest
      ? prepareDocumentTextForProfessionalSynthesis(row.documentText)
      : row.documentText;
    const evidence = deepQuestion && !genericOverview
      ? await retrieveRelevantEvidence(prisma, {
        userId,
        row,
        query,
        limit: evidenceLimit,
      })
      : [];
    const effectiveEvidence = synthesisRequest
      ? evidence
        .map((item) => ({ ...item, text: prepareDocumentTextForProfessionalSynthesis(item.text) }))
        .filter((item) => countDocumentWords(item.text) >= 8)
      : evidence;
    const spreadsheetBibliography = bibliographyRequest && isSpreadsheetMime(row.mimeType);
    const tableMarkdown = spreadsheetBibliography && tables.length
      ? tables
        .map((table) => safeText(table.markdown, '').trim())
        .filter(Boolean)
        .join('\n\n')
      : '';
    const selectedText = effectiveEvidence.length
      ? [
        'Contenido relevante recuperado desde todo el documento:',
        ...effectiveEvidence.map((item, evidenceIndex) => {
          const evidenceFloor = bulkBatch ? 120 : 700;
          const text = safeText(item.text, '').slice(0, Math.max(evidenceFloor, Math.floor(perFileBudget / Math.max(1, effectiveEvidence.length))));
          return `Evidencia ${evidenceIndex + 1} [${sourceLabelForEvidence(item)}]: ${text.replace(/\s+/g, ' ')}`;
        }),
      ].join('\n\n')
      : spreadsheetBibliography
        ? compactString(
          [tableMarkdown, effectiveDocumentText].filter(Boolean).join('\n\n'),
          bulkBatch ? perFileBudget : Math.max(perFileBudget, maxChars),
        )
        : buildBalancedExcerpt(effectiveDocumentText, perFileBudget, query);
    const clipped = effectiveEvidence.length
      ? '\n[La evidencia fue recuperada buscando en todos los fragmentos disponibles del documento, no solo en la portada.]'
      : effectiveDocumentText.length > selectedText.length
        ? '\n[Extracto balanceado; si necesitas precision adicional usa docintel_retrieve con la pregunta del usuario.]'
        : '';
    const firstChunks = (!deepQuestion || !effectiveEvidence.length) && chunks.length
      ? [
        '',
        'Primeras referencias estructuradas disponibles:',
        ...chunks
          .map((chunk) => {
            const chunkText = synthesisRequest
              ? prepareDocumentTextForProfessionalSynthesis(chunk.text)
              : safeText(chunk.text, '');
            if (synthesisRequest && countDocumentWords(chunkText) < 8) return '';
            return `- ${chunk.sourceLabel || chunk.sectionTitle || `Fragmento ${chunk.ordinal}`}: ${chunkText.slice(0, 240).replace(/\s+/g, ' ')}`;
          })
          .filter(Boolean),
      ].join('\n')
      : '';
    const tableSummary = tables.length
      ? [
        '',
        'Tablas detectadas:',
        ...tables.map((table) => `- ${table.title || table.sourceLabel || `Tabla ${table.ordinal}`}: ${table.rowCount || 0} filas, columnas: ${(table.columns || []).slice(0, 12).join(', ')}`),
      ].join('\n')
      : '';
    return [
      `### Archivo adjunto ${index + 1}: ${row.originalName || row.id}`,
      `id: ${row.id}`,
      `tipo: ${row.mimeType || 'desconocido'}`,
      analysis?.id ? `analysisId: ${analysis.id}` : null,
      analysis?.summary ? `resumen tecnico: ${analysis.summary}` : null,
      analysis?.chunkCount ? `fragmentos analizados: ${analysis.chunkCount}` : null,
      query && !bulkBatch ? `pregunta del usuario: ${query}` : null,
      '',
      selectedText + clipped + firstChunks + tableSummary,
    ].filter(Boolean).join('\n');
  });

  return [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'Usa este contenido para responder sobre el documento pegado/subido. Si el usuario pide analisis, resumen o conclusiones, responde desde la evidencia relevante del documento completo y no desde portada, indice, autores o metadatos preliminares.',
    'Para analisis profesionales: sintetiza con criterio academico/ejecutivo, no copies el indice, no enumeres metadatos internos y no empieces con "Indice de contenidos".',
    ...outputFormat.buildFormatDirectiveLines(query, { lang: 'es' }),
    query ? `Pregunta del usuario: ${query}` : '',
    bulkBatch ? `Lote grande detectado: ${withText.length} documentos adjuntos. Cada bloque incluye una muestra breve y los documentos completos quedan referenciados por id para recuperación adicional.` : '',
    'Para evidencia estructurada adicional llama docintel_retrieve/docintel_extract_tables; para busqueda semantica general llama rag_retrieve.',
    '',
    blocks.join('\n\n---\n\n'),
  ].filter(Boolean).join('\n');
}

async function buildTranscriptionTextFromFiles(prisma, { userId, fileIds = [], maxChars = 120000 } = {}) {
  const ids = uniqueFileIds(Array.isArray(fileIds) ? fileIds : []);
  if (ids.length === 0) return '';

  const rows = await loadFileRows(prisma, userId, ids);
  const ocrRows = await mapWithLimit(rows, (row) => ensureImageOcr(prisma, row, userId));
  const enrichedRows = await mapWithLimit(ocrRows, (row) => ensureDocumentAnalysis(prisma, row, userId));
  const withText = enrichedRows
    .map((row) => ({
      id: row.id,
      name: safeText(row.originalName || row.filename || row.id, 'Archivo'),
      text: documentTextForRow(row, maxChars),
    }))
    .filter((row) => hasUsefulExtractedText(row.text));

  if (withText.length === 0) return '';

  if (withText.length === 1) {
    return withText[0].text.slice(0, maxChars).trim();
  }

  const perFileBudget = perFilePromptBudget(maxChars, withText.length, {
    bulkMin: 180,
    normalMin: 1500,
    headerReserve: withText.length >= BULK_CONTEXT_THRESHOLD ? 80 : 0,
  });
  return withText.map((row, index) => {
    const clipped = row.text.length > perFileBudget;
    return [
      `### ${row.name || `Archivo ${index + 1}`}`,
      '',
      row.text.slice(0, perFileBudget).trim(),
      clipped ? '\n[Transcripcion truncada por limite de longitud.]' : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n').trim();
}

module.exports = {
  buildFormatDirectiveLines: outputFormat.buildFormatDirectiveLines,
  parseOutputFormatRequest: outputFormat.parseOutputFormatRequest,
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  describeUnextractedAttachment,
  extractFileIdsFromMessageFiles,
  ensureImageOcr,
  hasUsefulExtractedText,
  isImageFile,
  isProfessionalDocumentSynthesisRequest,
  isPlainTranscriptionRequest,
  mapWithLimit,
  normalizeClientMetadata,
  prepareDocumentTextForProfessionalSynthesis,
  looksLikeDocumentFollowupQuestion,
  requestedParagraphCount,
  resolveChatDocumentFileIds,
  resolveStoredFilePath,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
  wantsSingleParagraphSynthesis,
};
