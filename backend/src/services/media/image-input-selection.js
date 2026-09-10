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

module.exports = { resolveImageGenerationFileId };
