'use strict';

/**
 * Single-model publication for Admin → Modelos IA.
 *
 * The public picker (`GET /api/ai/models`) is backed exclusively by
 * `AiModel.isActive`. This helper is the only write path the Estado
 * switch should use: one row, one boolean, no catalog-wide UPDATE.
 */

function parseIsActive(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

async function countPublication(prisma) {
  const [total, active] = await Promise.all([
    prisma.aiModel.count(),
    prisma.aiModel.count({ where: { isActive: true } }),
  ]);
  return {
    total,
    active,
    inactive: Math.max(0, total - active),
  };
}

async function setAiModelActive(prisma, { id, isActive, invalidateCache } = {}) {
  const parsed = parseIsActive(isActive);
  if (typeof parsed !== 'boolean') {
    const error = new Error('isActive debe ser un booleano');
    error.status = 400;
    error.code = 'E_PARAMS';
    throw error;
  }
  const modelId = typeof id === 'string' ? id.trim() : '';
  if (!modelId) {
    const error = new Error('Modelo no encontrado');
    error.status = 400;
    error.code = 'E_PARAMS';
    throw error;
  }

  try {
    const model = await prisma.aiModel.update({
      where: { id: modelId },
      data: { isActive: parsed },
    });
    if (typeof invalidateCache === 'function') {
      await invalidateCache();
    }
    const stats = await countPublication(prisma);
    return { model, stats };
  } catch (error) {
    if (error && error.code === 'P2025') {
      const notFound = new Error('Modelo no encontrado');
      notFound.status = 404;
      notFound.code = 'P2025';
      throw notFound;
    }
    throw error;
  }
}

function pickerIncludesActiveModel(catalog, model) {
  if (!model || model.isActive !== true) return false;
  const id = String(model.id || '').trim();
  const name = String(model.name || '').trim();
  return (Array.isArray(catalog) ? catalog : []).some((entry) => {
    if (!entry) return false;
    if (id && String(entry.id || '').trim() === id) return true;
    return name && String(entry.name || '').trim() === name;
  });
}

module.exports = {
  parseIsActive,
  countPublication,
  setAiModelActive,
  pickerIncludesActiveModel,
};
