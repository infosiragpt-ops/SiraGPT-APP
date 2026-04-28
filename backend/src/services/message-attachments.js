const fs = require('fs');
const path = require('path');
const ocrEngine = require('./ocr-engine');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

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
  return Array.from(new Set(ids.map(String).filter(Boolean))).slice(0, 20);
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
  const ids = Array.from(new Set(fileIds.map(String).filter(Boolean))).slice(0, 20);
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
  if (!row || row.documentAnalysis || !prisma?.documentAnalysis) return row;
  try {
    const documentIntelligence = require('./document-intelligence');
    const analysis = await documentIntelligence.analyzeFile(prisma, {
      userId,
      fileRecord: row,
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

async function resolveTranscriptionFileIds(prisma, {
  userId,
  chatId = null,
  providedFileIds = [],
  recentWindowMs = 15 * 60 * 1000,
} = {}) {
  const provided = Array.from(new Set((Array.isArray(providedFileIds) ? providedFileIds : []).map(String).filter(Boolean))).slice(0, 20);
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

      const unique = Array.from(new Set(ids.map(String).filter(Boolean))).slice(0, 20);
      if (unique.length > 0) {
        const rows = await loadFileRows(prisma, userId, unique);
        const allowed = new Set(rows.filter(isReadableFileCandidate).map((row) => row.id));
        const resolved = unique.filter((id) => allowed.has(id)).slice(0, 8);
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

async function serializeMessageAttachments(prisma, { userId, fileIds = [], clientMetadata = [] } = {}) {
  const ids = Array.from(new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))).slice(0, 20);
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

async function buildUploadedFileContext(prisma, { userId, fileIds = [], maxChars = 18000 } = {}) {
  const ids = Array.from(new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))).slice(0, 8);
  if (ids.length === 0) return '';
  const rows = await loadFileRows(prisma, userId, ids);
  const ocrRows = await Promise.all(rows.map((row) => ensureImageOcr(prisma, row, userId)));
  const enrichedRows = await Promise.all(ocrRows.map((row) => ensureDocumentAnalysis(prisma, row, userId)));
  const withText = enrichedRows.filter((row) => hasUsefulExtractedText(row.extractedText));
  if (withText.length === 0) return '';

  const perFileBudget = Math.max(1500, Math.floor(maxChars / withText.length));
  const blocks = withText.map((row, index) => {
    const analysis = row.documentAnalysis || null;
    const chunks = Array.isArray(analysis?.chunks) ? analysis.chunks : [];
    const tables = Array.isArray(analysis?.tables) ? analysis.tables : [];
    const text = safeText(row.extractedText, '').slice(0, perFileBudget);
    const clipped = row.extractedText.length > text.length ? '\n[Extracto truncado; usa rag_retrieve si necesitas mas contexto.]' : '';
    const evidence = chunks.length
      ? [
        '',
        'Evidencia estructurada disponible:',
        ...chunks.map((chunk) => `- ${chunk.sourceLabel || chunk.sectionTitle || `Fragmento ${chunk.ordinal}`}: ${safeText(chunk.text, '').slice(0, 500).replace(/\s+/g, ' ')}`),
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
      '',
      text + clipped + evidence + tableSummary,
    ].filter(Boolean).join('\n');
  });

  return [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'Usa este contenido para responder sobre el documento pegado/subido. Si necesitas mas detalle, llama rag_retrieve.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

async function buildTranscriptionTextFromFiles(prisma, { userId, fileIds = [], maxChars = 120000 } = {}) {
  const ids = Array.from(new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))).slice(0, 8);
  if (ids.length === 0) return '';

  const rows = await loadFileRows(prisma, userId, ids);
  const ocrRows = await Promise.all(rows.map((row) => ensureImageOcr(prisma, row, userId)));
  const enrichedRows = await Promise.all(ocrRows.map((row) => ensureDocumentAnalysis(prisma, row, userId)));
  const withText = enrichedRows
    .map((row) => ({
      id: row.id,
      name: safeText(row.originalName || row.filename || row.id, 'Archivo'),
      text: safeText(row.extractedText, '') || analysisChunksToText(row.documentAnalysis, maxChars),
    }))
    .filter((row) => hasUsefulExtractedText(row.text));

  if (withText.length === 0) return '';

  if (withText.length === 1) {
    return withText[0].text.slice(0, maxChars).trim();
  }

  const perFileBudget = Math.max(1500, Math.floor(maxChars / withText.length));
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
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  extractFileIdsFromMessageFiles,
  ensureImageOcr,
  hasUsefulExtractedText,
  isPlainTranscriptionRequest,
  normalizeClientMetadata,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
};
