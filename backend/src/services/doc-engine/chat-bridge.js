'use strict';

/**
 * Puente /chat → doc-engine.
 * Solo corre cuando FEATURE_DOC_ENGINE=1 y el turno es un
 * transform-to-template (source + plantilla / "pasa al formato UPN").
 * Si el flag está off, devolvemos null y el path de edición por
 * párrafos existente sigue igual.
 */

const { isDocEngineEnabled, isTemplateTransformRequest } = require('./flags');
const { classifyDocxPair } = require('./transform-to-template');
const { runPipeline } = require('./pipeline');

function looksLikeTemplateName(file = {}) {
  const name = String(file.originalName || file.filename || file.name || '').toLowerCase();
  return /(formato|plantilla|template|upn|xxxxxxxx)/i.test(name);
}

async function loadPairBuffers(files, { readBuffer } = {}) {
  const { source, template, docs } = classifyDocxPair(files);
  if (!source || !template) return null;
  const reader = typeof readBuffer === 'function'
    ? readBuffer
    : async (file) => {
      if (Buffer.isBuffer(file.buffer)) return file.buffer;
      const { readSourceBuffer } = require('../source-preserving-document-edit');
      return readSourceBuffer(file);
    };
  return {
    source,
    template,
    sourceBuffer: await reader(source),
    templateBuffer: await reader(template),
    docs,
  };
}

/**
 * @returns {Promise<object|null>} mismo shape que tryGenerateSourcePreservingDocumentEdit
 */
async function tryDocEngineTransform({
  prompt,
  displayPrompt,
  files = [],
  userId,
  chatId,
  signal,
  env = process.env,
  readBuffer,
} = {}) {
  if (!isDocEngineEnabled(env)) return null;
  const requestText = displayPrompt || prompt || '';
  const intentFiles = Array.isArray(files) ? files : [];
  if (!isTemplateTransformRequest(requestText, intentFiles)
    && !intentFiles.filter(looksLikeTemplateName).length) {
    return null;
  }
  const pair = await loadPairBuffers(intentFiles, { readBuffer });
  if (!pair) return null;

  const result = await runPipeline({
    sourceBuffer: pair.sourceBuffer,
    templateBuffer: pair.templateBuffer,
    instructions: requestText,
    userId,
  });
  if (signal?.aborted) return null;
  if (!result.ok || !result.artifact) return null;

  let saved = null;
  if (userId) {
    try {
      const { saveArtifact, EXTENSION_TO_MIME } = require('../agents/task-tools');
      saved = saveArtifact({
        filename: result.artifact.filename,
        base64: Buffer.from(result.artifact.buffer).toString('base64'),
        mime: result.artifact.mime || EXTENSION_TO_MIME.docx,
        ownerUserId: userId,
        chatId,
      });
    } catch {
      saved = null;
    }
  }

  const file = {
    name: result.artifact.filename,
    filename: result.artifact.filename,
    mimeType: result.artifact.mime,
    buffer: result.artifact.buffer,
    ...(saved && typeof saved === 'object' ? saved : {}),
  };

  return {
    content: 'Documento transplantado a la plantilla (sectPr, headers y footers de la plantilla intactos).',
    file,
    format: 'docx',
    engine: 'doc-engine',
  };
}

module.exports = {
  tryDocEngineTransform,
  loadPairBuffers,
  looksLikeTemplateName,
};
