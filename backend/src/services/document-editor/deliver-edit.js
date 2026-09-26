'use strict';

/** A generated file is not a saved conversation version until persistence confirms it. */
async function deliverDocumentEdit({ result, files, persist, chatId }) {
  const content = result.ok ? result.summary : result.message;
  let assistantMessageId = null;
  try { assistantMessageId = await persist(content, files); } catch { /* report below */ }
  if (!assistantMessageId) return {
    type: 'done', ok: false, code: 'DOCUMENT_HISTORY_SAVE_FAILED',
    content: 'La edición terminó, pero no pude guardar esta versión en el chat. Descarga los archivos disponibles y vuelve a adjuntarlos para continuar; no se confirmó el guardado.',
    files, assistantMessageId: null, chatId,
  };
  return {
    type: 'done', ok: result.ok, ...(result.code ? { code: result.code } : {}),
    ...(!result.ok && files.length ? { partial: true } : {}),
    content, files, assistantMessageId, chatId,
  };
}

module.exports = { deliverDocumentEdit };
