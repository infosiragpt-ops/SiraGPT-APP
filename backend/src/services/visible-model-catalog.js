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
    aliases: ['gemini-3.5', 'gemini-3.5-pro', 'google/gemini-3.5-pro', 'google/gemini-3.5-flash'],
  },
  {
    name: 'x-ai/grok-4.20',
    displayName: 'Grok 4.2',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'GrokLogo',
    description: 'Grok 4.2 via OpenRouter para razonamiento, busqueda conversacional y tareas generales.',
    // OpenRouter's canonical id is `x-ai/grok-4.20` ("x-ai/grok-4.2" is NOT a
    // valid model id and returns a 400). Keep the legacy ids as aliases so any
    // historical selection still resolves to the corrected model.
    aliases: ['grok-4.2', 'x-ai/grok-4.2', 'grok-4.20', 'x-ai/grok-4'],
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
  {
    name: 'deepseek/deepseek-v4-pro',
    displayName: 'Deepseek V4 PRO',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'DeepseekLogo',
    description: 'Deepseek V4 PRO via OpenRouter para razonamiento profesional, codigo y documentos complejos.',
    aliases: ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
  },
  {
    name: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'OpenAI',
    type: 'TEXT',
    icon: 'ChatGPTLogo',
    description: 'GPT-4o multimodal de OpenAI: chat, vision, codigo y documentos.',
    aliases: ['gpt-4o', 'openai/gpt-4o'],
  },
  {
    name: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'OpenAI',
    type: 'TEXT',
    icon: 'ChatGPTLogo',
    description: 'GPT-4o Mini de OpenAI: rapido, eficiente y economico para chat diario.',
    aliases: ['gpt-4o-mini', 'openai/gpt-4o-mini'],
  },
  {
    name: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'Gemini',
    type: 'TEXT',
    icon: 'GeminiLogo',
    description: 'Gemini 2.5 Pro de Google: razonamiento complejo, contexto largo y multimodal.',
    aliases: ['gemini-2.5-pro', 'gemini-2.5', 'google/gemini-2.5-pro'],
  },
  {
    name: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'Gemini',
    type: 'TEXT',
    icon: 'GeminiLogo',
    description: 'Gemini 2.5 Flash de Google: rapido, resumen y analisis multimodal.',
    aliases: ['gemini-2.5-flash', 'gemini-2.5-flash-preview'],
  },
  {
    name: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    provider: 'DeepSeek',
    type: 'TEXT',
    icon: 'DeepseekLogo',
    description: 'DeepSeek Chat directo: conversacional, rapido y confiable.',
    aliases: ['deepseek-chat', 'deepseek-v3-chat'],
  },
  {
    name: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    provider: 'DeepSeek',
    type: 'TEXT',
    icon: 'DeepseekLogo',
    description: 'DeepSeek Reasoner: razonamiento profundo, planificacion y resolucion de problemas.',
    aliases: ['deepseek-reasoner', 'deepseek-r1', 'deepseek-reasoner-r1'],
  },
  {
    name: 'anthropic/claude-sonnet-4.5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    type: 'TEXT',
    icon: 'ClaudeLogo',
    description: 'Claude Sonnet 4.5 de Anthropic: razonamiento equilibrado, escritura y codigo.',
    aliases: ['claude-sonnet-4.5', 'claude-3-5-sonnet', 'claude-3.5-sonnet', 'anthropic/claude-3.5-sonnet'],
  },
  {
    name: 'claude-3-haiku',
    displayName: 'Claude 3 Haiku',
    provider: 'Anthropic',
    type: 'TEXT',
    icon: 'ClaudeLogo',
    description: 'Claude 3 Haiku de Anthropic: ultra rapido para tareas simples y conversacion.',
    aliases: ['claude-3-haiku', 'claude-3-haiku-20240307'],
  },
  {
    name: 'mistral-large',
    displayName: 'Mistral Large',
    provider: 'Mistral',
    type: 'TEXT',
    icon: 'Sparkles',
    description: 'Mistral Large: modelo de alta calidad para chat, razonamiento y codigo.',
    aliases: ['mistral-large', 'mistral-large-latest'],
  },
  {
    name: 'mistral-small',
    displayName: 'Mistral Small',
    provider: 'Mistral',
    type: 'TEXT',
    icon: 'Sparkles',
    description: 'Mistral Small: rapido y eficiente para tareas cotidianas.',
    aliases: ['mistral-small', 'mistral-small-latest'],
  },
  {
    name: 'meta-llama/llama-3.1-70b-instruct',
    displayName: 'Llama 3.1 70B',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'MetaLogo',
    description: 'Llama 3.1 70B via OpenRouter: chat multilingue, codigo y trabajo abierto.',
    aliases: ['llama-3.1-70b', 'llama-3.1-70b-instruct'],
  },
  {
    name: 'llama-3.3-70b',
    displayName: 'Llama 3.3 70B',
    provider: 'Groq',
    type: 'TEXT',
    icon: 'MetaLogo',
    description: 'Llama 3.3 70B via Groq: velocidad extrema, chat y razonamiento.',
    aliases: ['llama-3.3-70b', 'llama-3.3-70b-versatile', 'groq/llama-3.3-70b-versatile'],
  },
  {
    name: 'qwen/qwen3.6-27b',
    displayName: 'Qwen 3.6',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'Sparkles',
    description: 'Qwen 3.6 via OpenRouter: razonamiento, codigo y contexto largo.',
    aliases: ['qwen-3.6', 'qwen3.6-27b', 'qwen-2.5-72b', 'qwen/qwen-2.5-72b-instruct'],
  },
  {
    name: 'o3-mini',
    displayName: 'o3 Mini',
    provider: 'OpenAI',
    type: 'TEXT',
    icon: 'ChatGPTLogo',
    description: 'o3 Mini de OpenAI: razonamiento avanzado, matematicas y ciencia.',
    aliases: ['o3-mini', 'openai/o3-mini'],
  },
  {
    name: 'o1-mini',
    displayName: 'o1 Mini',
    provider: 'OpenAI',
    type: 'TEXT',
    icon: 'ChatGPTLogo',
    description: 'o1 Mini de OpenAI: razonamiento avanzado para STEM y problemas complejos.',
    aliases: ['o1-mini', 'openai/o1-mini'],
  },
  {
    name: 'o1-preview',
    displayName: 'o1 Preview',
    provider: 'OpenAI',
    type: 'TEXT',
    icon: 'ChatGPTLogo',
    description: 'o1 Preview de OpenAI: razonamiento de nivel de investigacion.',
    aliases: ['o1-preview', 'openai/o1-preview'],
  },
  {
    name: 'google/gemma-3-27b-it',
    displayName: 'Gemma 3 27B',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'GeminiLogo',
    description: 'Gemma 3 27B via OpenRouter: codigo, matematicas y contexto largo.',
    aliases: ['gemma-3-27b', 'gemma-3-27b-it'],
  },
  {
    name: 'cohere/command-r-plus-08-2024',
    displayName: 'Command R+',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'CohereLogo',
    description: 'Command R+ via OpenRouter: contexto largo, RAG y tareas empresariales.',
    aliases: ['command-r-plus', 'cohere/command-r-plus', 'command-r-plus-04-2024'],
  },
  {
    name: 'phi-4',
    displayName: 'Phi 4',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'MicrosoftLogo',
    description: 'Phi 4 via OpenRouter: razonamiento, codigo y calidad de nivel pequeno.',
    aliases: ['phi-4', 'microsoft/phi-4', 'phi-4-reasoning'],
  },
  {
    name: 'dolphin-72b',
    displayName: 'Dolphin 72B',
    provider: 'OpenRouter',
    type: 'TEXT',
    icon: 'Sparkles',
    description: 'Dolphin 72B via OpenRouter: chat abierto, codigo y razonamiento.',
    aliases: ['dolphin-72b', 'dolphin-72b-mistral', 'cognitivecomputations/dolphin-72b-mistral'],
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

/**
 * Optional deploy-scoped allowlist. When `VISIBLE_MODELS_ALLOWLIST` is set
 * (comma-separated model names or aliases), the visible picker is restricted
 * to ONLY those models. Unset/empty → no filtering (every deploy behaves as
 * before). This lets a single deploy (e.g. one without certain provider keys)
 * surface just the models it can actually serve, without editing this shared
 * catalog or affecting other deploys.
 */
function parseVisibleModelsAllowlist(env = process.env) {
  const raw = String(env.VISIBLE_MODELS_ALLOWLIST || '').trim();
  if (!raw) return null;
  const set = new Set(
    raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return set.size ? set : null;
}

function listVisibleTextModelDefinitions(env = process.env) {
  const all = [
    ...VISIBLE_TEXT_MODEL_DEFINITIONS.map((model) => ({ ...model, aliases: [...model.aliases] })),
    buildGemaVisibleModel(env),
  ];
  const allow = parseVisibleModelsAllowlist(env);
  if (!allow) return all;
  return all.filter((model) => {
    const candidates = [model.name, ...(model.aliases || [])]
      .filter(Boolean)
      .map((name) => String(name).trim().toLowerCase());
    return candidates.some((name) => allow.has(name));
  });
}

function curateVisibleTextModels(models = [], env = process.env) {
  const byName = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const name = String(model?.name || '').trim();
    if (!name) continue;
    if (model?.isActive === false) continue;
    if (model?.virtual === true) continue;
    const id = String(model?.id || '').trim();
    if (id.startsWith('__virtual_')) continue;
    byName.set(name.toLowerCase(), model);
  }

  return listVisibleTextModelDefinitions(env).flatMap((definition) => {
    const candidates = [definition.name, ...(definition.aliases || [])]
      .filter(Boolean)
      .map((name) => String(name).trim().toLowerCase());
    const existing = candidates.map((name) => byName.get(name)).find(Boolean) || null;
    if (!existing) return [];
    const { aliases, ...publicDefinition } = definition;

    return [{
      ...(existing || {}),
      id: existing?.id || virtualIdFor(definition.name),
      ...publicDefinition,
    }];
  });
}

function normalizeModelType(type) {
  return String(type || '').trim().toUpperCase();
}

function isVirtualModel(model = {}) {
  if (model?.virtual === true) return true;
  const id = String(model?.id || '').trim();
  return id.startsWith('__virtual_');
}

/**
 * Media pickers (IMAGE/VIDEO) are admin-controlled: they should only surface
 * real aiModel rows that are explicitly active. Static/default catalogs may
 * seed inactive rows for convenience, but must never invent public picker
 * entries when Admin has everything disabled.
 */
function curateVisibleAdminMediaModels(models = [], type, options = {}) {
  const normalizedType = normalizeModelType(type);
  if (!['IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'].includes(normalizedType)) return [];

  const allowedNames = options.allowedNames instanceof Set
    ? options.allowedNames
    : null;

  return (Array.isArray(models) ? models : []).filter((model) => {
    const name = String(model?.name || '').trim();
    if (!name) return false;
    if (normalizeModelType(model?.type) !== normalizedType) return false;
    if (model?.isActive !== true) return false;
    if (isVirtualModel(model)) return false;
    if (allowedNames && !allowedNames.has(name)) return false;
    return true;
  });
}

module.exports = {
  VISIBLE_TEXT_MODEL_DEFINITIONS,
  buildGemaVisibleModel,
  curateVisibleAdminMediaModels,
  curateVisibleTextModels,
  listVisibleTextModelDefinitions,
};
