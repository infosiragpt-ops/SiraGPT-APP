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

function resolveImageOperation({ operation, prompt, fileId, selection, maskDataUrl } = {}) {
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
  if (directive.detectImageReframe(prompt)) return 'reframe';
  if (fileId || selection || maskDataUrl || intent.detectImageEditIntent(prompt)) return 'edit';
  // New requests never inherit a historical image merely because the chosen
  // model supports editing. History is consulted only for edit/reframe.
  return 'generate';
}

module.exports = { resolveImageGenerationFileId, resolveImageOperation };
