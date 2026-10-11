'use strict';

/**
 * A generation-only model must not inherit an edit input from chat history.
 * Keep explicit attachments so the route can validate them and report that
 * editing is unsupported instead of silently ignoring the user's input.
 */
async function resolveImageGenerationFileId({ fileId, chatId, generationOnly, findPreviousImageFileId }) {
  if (fileId || generationOnly || !chatId) return fileId;
  return await findPreviousImageFileId(chatId) || fileId;
}

/**
 * Which operation an image request is. Explicit inputs (a pinned file,
 * references, a selection or mask) always mean an edit; otherwise the shared
 * classifier decides, with the same guard the chat loop applies so "crea una
 * imagen de un perro y quítale el fondo" stays a generation here too.
 *
 * `hasRecentImage` lets a short follow-up in a chat that already produced an
 * image ("ahora en azul", "cambia el color del logo") edit that image instead
 * of starting from a blank text-to-image prompt.
 */
function resolveImageOperation({ operation, prompt, fileId, referenceFileIds, selection, maskDataUrl, hasRecentImage = false } = {}) {
  if (operation && !['generate', 'edit', 'reframe'].includes(operation)) {
    const error = new Error('La operación de imagen no es válida.');
    error.code = 'E_PARAMS'; error.status = 400; throw error;
  }
  const directive = require('../agents/image-directive');
  const intent = require('../agents/media-intent');
  // The viewer's generic edit action also covers spoken reframing. An
  // explicitly new generation remains binding; region+reframe is rejected by
  // the canvas validator instead of silently ignoring either instruction.
  if (operation === 'edit' && directive.detectImageReframe(prompt)) return 'reframe';
  if (operation) return operation;
  const hasInputs = Boolean(fileId || referenceFileIds?.length || selection || maskDataUrl);
  const classified = intent.classifyImageRequest(prompt, {
    hasImageAttachment: Boolean(fileId || referenceFileIds?.length),
    hasRecentImage: Boolean(hasRecentImage),
  });
  if (classified.operation === 'reframe') return 'reframe';
  if (hasInputs || classified.operation === 'edit') return 'edit';
  // New requests never inherit a historical image merely because the chosen
  // model supports editing. History is consulted only for edit/reframe.
  return 'generate';
}

module.exports = { resolveImageGenerationFileId, resolveImageOperation };
