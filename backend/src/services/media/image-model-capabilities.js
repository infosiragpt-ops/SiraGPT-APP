'use strict';

/**
 * What an IMAGE catalog row can do, as the composer will treat it. The
 * picker and Admin → Modelos get `capabilities.imageEdit` so a row that only
 * generates (the legacy seeds `openai/dall-e-3` / `google/imagen-3-0`,
 * DALL-E, Imagen, Flux, Grok) is visible as «no edita» before a user picks
 * it for an edit. The flag is computed with the SAME provider resolution as
 * `POST /api/ai/generate-image` (`honorPickerModel` → `resolveGenerateProvider`
 * → the engine provider for that model), so it never says «edita» for a
 * row the composer refuses. Never throws; null for rows that are not image
 * models.
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

/**
 * The image-engine provider a model id actually runs on. A catalog slug
 * («google/gemini-3.1-flash-image-preview», «openai/gpt-5.4-image-2») is an
 * OpenRouter model whatever first-party provider the chat inference assigns
 * to its family: the direct Google / OpenAI image APIs do not know the slug.
 * Bare ids keep the resolved provider.
 */
function engineProviderForModel(provider, model) {
  const name = String(model || '').trim();
  if (name.includes('/')) {
    try {
      const route = require('./image-engine').resolveImageModelRoute(name);
      if (route && route.provider) return route.provider;
    } catch { /* fall through to the provider mapping */ }
  }
  return engineProviderFor(provider);
}

// OpenRouter models known to accept an input image. Other OpenRouter image
// rows (Flux, Recraft, Ideogram…) are text-to-image only and report false
// even though the engine would try; an unknown editing slug reports false
// too (a conservative «no edita» beats advertising an edit that 4xx's).
const OPENROUTER_IMAGE_INPUT_RE = /(?:gemini[^/]*-image|gpt-[\d.]*-?image|chatgpt-image|seedream|kontext|qwen[^/]*image[^/]*edit|nano-banana|hidream[^/]*e1|omnigen|step1x-edit)/i;

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
  const name = String(row.name || '').trim();
  let imageEdit = false;
  try {
    // The composer always refuses edits with a Grok image model.
    if (require('../model-output-type').isGrokImageModelName(name)) return { imageEdit: false };
    const { resolveGenerateProvider } = require('../ai/provider-inference');
    const resolvedProvider = resolveGenerateProvider(row.provider, name);
    const engineProvider = engineProviderForModel(resolvedProvider, name);
    if (engineProvider === 'openrouter') return { imageEdit: OPENROUTER_IMAGE_INPUT_RE.test(name) };
    const engine = require('./image-engine');
    imageEdit = typeof engine.canEditImage === 'function'
      && engine.canEditImage({ model: name, provider: engineProvider }) === true;
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

module.exports = { imageModelCapabilities, withImageCapabilities, engineProviderFor, engineProviderForModel, OPENROUTER_IMAGE_INPUT_RE };
