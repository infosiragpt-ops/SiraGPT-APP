'use strict';

const { isDeepStrictEqual } = require('node:util');

/** Save native editor state. Uploaded OOXML originals use the binary edit pipeline. */
function createOfficeDraftHandler({ prisma, kind, dbNull }) {
  const field = kind === 'word' ? 'wordContent' : 'excelContent';
  return async (req, res) => {
    const { content, expectedContent } = req.body || {};
    const valid = kind === 'word'
      ? typeof content === 'string'
      : content && typeof content === 'object' && !Array.isArray(content) && Array.isArray(content.sheets);
    if (!valid || Buffer.byteLength(JSON.stringify(content) || '') > 2_000_000) {
      return res.status(400).json({ error: 'INVALID_DOCUMENT_CONTENT', message: 'El documento no es válido o supera el tamaño permitido.' });
    }
    try {
      const where = { id: req.params.id, userId: req.user.id };
      const chat = await prisma.chat.findFirst({ where, select: { id: true, [field]: true } });
      if (!chat) return res.status(404).json({ error: 'chat_not_found' });
      const before = chat[field] ?? null;
      // Duplicate requests are safe, including a retry after a lost response.
      if (isDeepStrictEqual(before, content)) return res.json({ saved: true });
      if (Object.hasOwn(req.body, 'expectedContent') && !isDeepStrictEqual(before, expectedContent)) {
        return res.status(409).json({ error: 'DOCUMENT_VERSION_CONFLICT', message: 'El documento cambió en otra ventana. Descarga tu copia antes de recargar.' });
      }
      const updated = await prisma.chat.updateMany({
        where: { ...where, [field]: kind === 'excel' ? { equals: before === null ? dbNull : before } : before },
        data: { [field]: content },
      });
      if (updated.count !== 1) return res.status(409).json({ error: 'DOCUMENT_VERSION_CONFLICT', message: 'El documento cambió mientras se guardaba. Tus cambios siguen en el editor.' });
      return res.json({ saved: true });
    } catch {
      return res.status(500).json({ error: 'DOCUMENT_SAVE_FAILED', message: 'No se pudo guardar el documento. Tus cambios siguen en el editor.' });
    }
  };
}

module.exports = { createOfficeDraftHandler };
