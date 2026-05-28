'use strict';

const { getGema4RuntimeConfig } = require('./model-quota-router');

const VISIBLE_TEXT_MODEL_DEFINITIONS = Object.freeze([
  {
    name: 'openai/gpt-5.5',
    displayName: 'GPT 5.5',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'ChatGPTLogo',
    description: 'GPT 5.5 via OpenRouter para chat, razonamiento, documentos y trabajo multimodal.',
    aliases: ['gpt-5.5', 'gpt-5'],
  },
  {
    name: 'anthropic/claude-opus-4.7',
    displayName: 'Opus 4.7',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'ClaudeLogo',
    description: 'Claude Opus 4.7 via OpenRouter para razonamiento profundo, escritura y codigo.',
    aliases: ['claude-opus-4-7', 'claude-opus-4.7', 'anthropic/claude-opus-4-7'],
  },
  {
    name: 'google/gemini-3.5',
    displayName: 'Gemini 3.5',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'GeminiLogo',
    description: 'Gemini 3.5 via OpenRouter para contexto largo, vision y analisis multimodal.',
    aliases: ['gemini-3.5', 'gemini-3.5-pro', 'google/gemini-3.5-pro'],
  },
  {
    name: 'x-ai/grok-4.2',
    displayName: 'Grok 4.2',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'GrokLogo',
    description: 'Grok 4.2 via OpenRouter para razonamiento, busqueda conversacional y tareas generales.',
    aliases: ['grok-4.2', 'x-ai/grok-4.2', 'x-ai/grok-4'],
  },
  {
    name: 'moonshotai/kimi-k2.6',
    displayName: 'Kimi K2.6',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'KimiLogo',
    description: 'Kimi K2.6 via OpenRouter para contexto largo, codigo y flujos agenticos.',
    aliases: ['kimi-k2.6', 'moonshotai/kimi-k2.6'],
  },
  {
    name: 'z-ai/glm-5.1',
    displayName: 'Z5.1',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'ZaiLogo',
    description: 'Z5.1 via OpenRouter para chat, razonamiento y generacion de contenido.',
    aliases: ['z5.1', 'z-ai/glm-5.1', 'glm-5.1'],
  },
]);

function virtualIdFor(name) {
  return `__virtual_${String(name).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}__`;
}

function buildGemaVisibleModel(env = process.env) {
  const config = getGema4RuntimeConfig(env);
  return {
    name: config.model,
    displayName: 'Gema 4',
    provider: config.provider,
    type: 'TEXT',
    icon: config.icon,
    description: 'Gema 4, modelo fallback de SiraGPT para tareas generales.',
    aliases: [config.model, 'Gema4-31B', 'gema4', 'gema-4', 'gema 4'],
  };
}

function listVisibleTextModelDefinitions(env = process.env) {
  return [
    ...VISIBLE_TEXT_MODEL_DEFINITIONS.map((model) => ({ ...model, aliases: [...model.aliases] })),
    buildGemaVisibleModel(env),
  ];
}

function curateVisibleTextModels(models = [], env = process.env) {
  const byName = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const name = String(model?.name || '').trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), model);
  }

  return listVisibleTextModelDefinitions(env).map((definition) => {
    const candidates = [definition.name, ...(definition.aliases || [])]
      .filter(Boolean)
      .map((name) => String(name).trim().toLowerCase());
    const existing = candidates.map((name) => byName.get(name)).find(Boolean) || null;
    const { aliases, ...publicDefinition } = definition;

    return {
      ...(existing || {}),
      id: existing?.id || virtualIdFor(definition.name),
      ...publicDefinition,
    };
  });
}

module.exports = {
  VISIBLE_TEXT_MODEL_DEFINITIONS,
  buildGemaVisibleModel,
  curateVisibleTextModels,
  listVisibleTextModelDefinitions,
};
