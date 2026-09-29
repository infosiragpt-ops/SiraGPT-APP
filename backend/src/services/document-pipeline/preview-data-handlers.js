'use strict';

const { getStructuredDataPreview, dataPreviewFormat, MAX_SOURCE_BYTES } = require('./preview-data-service');

const ERROR_MESSAGES = {
  PREVIEW_SOURCE_TOO_LARGE: 'El archivo supera el tamaño disponible para la vista de datos.',
  PREVIEW_FORMAT_UNSUPPORTED: 'Este formato todavía no dispone de vista de datos.',
  PREVIEW_READER_UNAVAILABLE: 'El lector estadístico no está disponible. Puedes descargar el archivo original.',
  PREVIEW_DATA_TIMEOUT: 'La lectura tardó demasiado. Puedes volver a abrir el archivo.',
  PREVIEW_DATA_BUSY: 'La vista de datos está ocupada. Vuelve a abrir el archivo en unos segundos.',
  PREVIEW_DATA_LIMIT_EXCEEDED: 'Esta página supera el tamaño disponible para la vista de datos.',
  PREVIEW_DATA_UNREADABLE: 'No se pudo leer el archivo estadístico. Puedes descargar el original.',
};

function sendPreviewError(res, error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'PREVIEW_DATA_UNREADABLE';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 409;
  if (code === 'PREVIEW_DATA_BUSY') res.setHeader('Retry-After', '2');
  return res.status(status).json({ error: ERROR_MESSAGES[code], code });
}

function sendPreview(res, data) {
  // Statistical values may be private. Keep them out of shared caches and
  // avoid a browser disk cache; the bounded server cache rechecks ownership.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.json(data);
}

function tooLarge(size) {
  return Number.isFinite(Number(size)) && Number(size) > MAX_SOURCE_BYTES;
}

function createArtifactDataPreviewHandler({ artifactDir,
  materializeArtifactSource = require('../agents/artifact-local-source').materializeArtifactSource,
  preview = getStructuredDataPreview } = {}) {
  return async (req, res) => {
    // Match the download route's canonical content-derived ID. Do not strip
    // invalid characters into a different existing artifact identifier.
    const id = String(req.params?.id || '');
    if (!/^[a-f0-9]{1,40}$/i.test(id)) return res.status(400).json({ error: 'bad id' });
    let source;
    try {
      source = await materializeArtifactSource({ id: id.toLowerCase(), artifactDir, ownerUserId: req.user?.id });
      if (!source.ok) return res.status(source.status || 404).json({ error: source.error || 'artifact not found' });
      if (!dataPreviewFormat(source.filename)) return sendPreviewError(res, { code: 'PREVIEW_FORMAT_UNSUPPORTED', status: 415 });
      if (tooLarge(source.metadata?.sizeBytes)) return sendPreviewError(res, { code: 'PREVIEW_SOURCE_TOO_LARGE', status: 413 });
      const data = await preview({ sourcePath: source.sourcePath, filename: source.filename,
        cacheScope: `artifact:${req.user.id}:${id.toLowerCase()}`, limit: req.query?.limit, offset: req.query?.offset });
      return sendPreview(res, data);
    } catch (error) {
      return sendPreviewError(res, error);
    } finally {
      try { await source?.cleanup?.(); } catch { /* R2 temporary source cleanup */ }
    }
  };
}

function createFileDataPreviewHandler({ prisma, objectStorage,
  isPersistedPreviewSource = require('./preview-object-ready').isPersistedPreviewSource,
  preview = getStructuredDataPreview } = {}) {
  return async (req, res) => {
    let materialized;
    try {
      const file = await prisma.file.findFirst({ where: { id: req.params.id, userId: req.user.id } });
      if (!file) return res.status(404).json({ error: 'File not found' });
      if (!dataPreviewFormat(file.originalName)) return sendPreviewError(res, { code: 'PREVIEW_FORMAT_UNSUPPORTED', status: 415 });
      if (tooLarge(file.size)) return sendPreviewError(res, { code: 'PREVIEW_SOURCE_TOO_LARGE', status: 413 });
      const objectExists = await objectStorage.exists(file.path);
      if (!isPersistedPreviewSource({ id: file.id, path: file.path, sizeBytes: file.size, objectExists })) {
        res.setHeader('Retry-After', '1');
        return res.status(409).json({ error: 'File object not ready for preview', code: 'PREVIEW_OBJECT_NOT_READY' });
      }
      materialized = await objectStorage.toLocalTemp(file.path);
      const data = await preview({ sourcePath: materialized.path, filename: file.originalName,
        cacheScope: `file:${req.user.id}:${file.id}`, limit: req.query?.limit, offset: req.query?.offset });
      return sendPreview(res, data);
    } catch (error) {
      return sendPreviewError(res, error);
    } finally {
      try { await materialized?.cleanup?.(); } catch { /* R2 temporary source cleanup */ }
    }
  };
}

module.exports = { createArtifactDataPreviewHandler, createFileDataPreviewHandler, sendPreviewError };
