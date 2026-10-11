'use strict';

/**
 * What an IMAGE catalog row can do, as the image engine sees it. The picker
 * and Admin → Modelos get `capabilities.imageEdit` so a row that only
 * generates (the legacy seeds `openai/dall-e-3` / `google/imagen-3-0`,
 * Imagen, DALL-E) is visible as «no edita» before a user picks it for an
 * edit. Never throws; null for rows that are not image models.
 */

function engineProviderFor(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'openai') return 'openai';
  if (normalized === 'gemini' || normalized === 'google') return 'gemini';
  if (normalized === 'fal' || normalized === 'fal.ai') return 'fal';
  if (normalized === 'xai' || normalized === 'x-ai') return 'xai';
  return undefined;
}

function isImageRow(row) {
  try {
    return require('../model-output-type').normalizeCatalogModelType(row).type === 'IMAGE';
  } catch {
    return String(row && row.type || '').toUpperCase() === 'IMAGE';
  }
}

/**
 * @param {{ name?: string, provider?: string, type?: string }} row
 * @returns {{ imageEdit: boolean } | null}
 */
function imageModelCapabilities(row) {
  if (!row || typeof row !== 'object' || !isImageRow(row)) return null;
  let imageEdit = false;
  try {
    const engine = require('./image-engine');
    imageEdit = typeof engine.canEditImage === 'function'
      && engine.canEditImage({ model: String(row.name || ''), provider: engineProviderFor(row.provider) }) === true;
  } catch {
    imageEdit = false;
  }
  return { imageEdit };
}

/** Adds `capabilities` to an IMAGE row (other rows pass through untouched). */
function withImageCapabilities(row) {
  const capabilities = imageModelCapabilities(row);
  return capabilities ? { ...row, capabilities: { ...(row.capabilities || {}), ...capabilities } } : row;
}

module.exports = { imageModelCapabilities, withImageCapabilities, engineProviderFor };
