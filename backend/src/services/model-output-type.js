'use strict';

const MODEL_TYPES = new Set(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC']);

function modalityList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase());
  if (typeof value === 'string') return value.toLowerCase().split(/[,+\s]+/).filter(Boolean);
  return [];
}

function isGrokImageModelName(name) {
  return /^(?:(?:x-ai|xai)\/)?grok-(?:imagine-image|(?:\d+(?:\.\d+)*-)?image)(?:[-.][a-z0-9.-]+)?$/i
    .test(String(name || '').trim());
}

/** A narrow addition to the verified image catalog, never an activation. */
function isActiveGrokImageModel(model = {}) {
  if (!model || typeof model !== 'object') return false;
  const provider = String(model.provider || '').trim().toLowerCase();
  return model.isActive === true
    && isGrokImageModelName(model.name)
    && ['xai', 'x-ai', 'openrouter'].includes(provider)
    && model.virtual !== true
    && !String(model.id || '').startsWith('__virtual_');
}

/** Output decides the generation lane; accepting image input means vision. */
function inferModelOutputType(modelId, apiData = {}, fallbackType = 'TEXT') {
  const data = apiData && typeof apiData === 'object' ? apiData : {};
  const architecture = data.architecture && typeof data.architecture === 'object'
    ? data.architecture : {};
  const arrowOutput = String(architecture.modality || '').split('->')[1];
  const output = [
    ...modalityList(data.supported_output_modalities),
    ...modalityList(data.output_modalities),
    ...modalityList(data.output),
    ...modalityList(architecture.output_modalities),
    ...modalityList(arrowOutput),
  ];
  if (output.includes('video')) return 'VIDEO';
  if (output.includes('image')) return 'IMAGE';
  if (output.includes('music')) return 'MUSIC';
  if (output.includes('audio')) return 'AUDIO';
  if (output.includes('text')) return 'TEXT';

  const id = String(modelId || '').toLowerCase();
  const mode = String(data.mode || '').toLowerCase();
  if (/video|veo|kling|runway|pika|luma|sora/.test(id) || mode.includes('video')) return 'VIDEO';
  if (isGrokImageModelName(id)
    || /dall-e|gpt-image|imagen|seedream|flux|recraft|ideogram/.test(id)
    || /(?:^|[\/-])image(?:$|[\/-])/.test(id)
    || mode.includes('image')) return 'IMAGE';
  if (/suno|udio|music/.test(id) || mode.includes('music')) return 'MUSIC';
  if (/whisper|tts-|\-tts|speech|eleven|audio/.test(id) || mode.includes('audio')) return 'AUDIO';
  const fallback = String(fallbackType || '').trim().toUpperCase();
  return MODEL_TYPES.has(fallback) ? fallback : 'TEXT';
}

/** Repair legacy catalog classification in the response without DB writes. */
function normalizeCatalogModelType(model = {}) {
  if (!model || typeof model !== 'object') return { type: 'TEXT' };
  const storedType = String(model.type || '').trim().toUpperCase();
  return {
    ...model,
    ...(isActiveGrokImageModel(model) ? { provider: 'xAI' } : {}),
    type: isGrokImageModelName(model.name) ? 'IMAGE'
      : MODEL_TYPES.has(storedType) ? storedType
        : inferModelOutputType(model.name || model.id, model.apiData),
  };
}

module.exports = {
  inferModelOutputType,
  isGrokImageModelName,
  isActiveGrokImageModel,
  normalizeCatalogModelType,
};
