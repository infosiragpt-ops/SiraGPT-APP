function compactString(value, max = 120000) {
  if (typeof value !== 'string') return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[Contenido truncado para almacenamiento del mensaje]`;
}

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim() || fallback;
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
        extractedText: true,
        openaiFileId: true,
      },
    });
  } catch {
    return [];
  }
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
      extractedText: compactString(row?.extractedText || null, 120000),
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
  const withText = rows.filter((row) => safeText(row.extractedText, '').length > 0);
  if (withText.length === 0) return '';

  const perFileBudget = Math.max(1500, Math.floor(maxChars / withText.length));
  const blocks = withText.map((row, index) => {
    const text = safeText(row.extractedText, '').slice(0, perFileBudget);
    const clipped = row.extractedText.length > text.length ? '\n[Extracto truncado; usa rag_retrieve si necesitas mas contexto.]' : '';
    return [
      `### Archivo adjunto ${index + 1}: ${row.originalName || row.id}`,
      `id: ${row.id}`,
      `tipo: ${row.mimeType || 'desconocido'}`,
      '',
      text + clipped,
    ].join('\n');
  });

  return [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'Usa este contenido para responder sobre el documento pegado/subido. Si necesitas mas detalle, llama rag_retrieve.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

module.exports = {
  buildUploadedFileContext,
  normalizeClientMetadata,
  serializeMessageAttachments,
};
