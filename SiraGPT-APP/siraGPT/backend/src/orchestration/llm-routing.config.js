'use strict';

const TASK_TYPES = Object.freeze({
  DEEP_REASONING: 'deep_reasoning',
  SPEED: 'speed',
  MULTIMODAL: 'multimodal',
  CODE: 'code',
  EMBEDDINGS: 'embeddings',
  DEFAULT: 'default',
});

const PROVIDERS = Object.freeze([
  {
    id: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'],
    capabilities: ['chat', 'reasoning', 'code', 'multimodal'],
    score: { quality: 0.94, latency: 0.70, cost: 0.55 },
    priority: 100,
  },
  {
    id: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    capabilities: ['chat', 'reasoning', 'code'],
    score: { quality: 0.96, latency: 0.62, cost: 0.42 },
  },
  {
    id: 'openai',
    envKey: 'OPENAI_API_KEY',
    models: ['gpt-4o', 'gpt-4o-mini'],
    capabilities: ['chat', 'reasoning', 'code', 'multimodal'],
    score: { quality: 0.88, latency: 0.76, cost: 0.58 },
  },
  {
    id: 'google',
    envKey: 'GOOGLE_AI_API_KEY',
    fallbackEnvKey: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    capabilities: ['chat', 'reasoning', 'multimodal', 'speed'],
    score: { quality: 0.86, latency: 0.86, cost: 0.72 },
  },
  {
    id: 'groq',
    envKey: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b'],
    capabilities: ['chat', 'speed'],
    score: { quality: 0.76, latency: 0.96, cost: 0.82 },
  },
  {
    id: 'cerebras',
    envKey: 'CEREBRAS_API_KEY',
    baseURL: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b'],
    capabilities: ['chat', 'speed'],
    score: { quality: 0.74, latency: 0.94, cost: 0.80 },
  },
  {
    id: 'mistral',
    envKey: 'MISTRAL_API_KEY',
    baseURL: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    capabilities: ['chat', 'code'],
    score: { quality: 0.80, latency: 0.78, cost: 0.70 },
  },
  {
    id: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-reasoner', 'deepseek-chat'],
    capabilities: ['chat', 'reasoning', 'code'],
    score: { quality: 0.84, latency: 0.72, cost: 0.90 },
  },
  {
    id: 'voyage',
    envKey: 'VOYAGE_API_KEY',
    models: ['voyage-3-large'],
    capabilities: ['embeddings'],
    score: { quality: 0.92, latency: 0.78, cost: 0.68 },
  },
  {
    id: 'jina',
    envKey: 'JINA_API_KEY',
    models: ['jina-embeddings-v3'],
    capabilities: ['embeddings'],
    score: { quality: 0.84, latency: 0.80, cost: 0.78 },
  },
]);

const TASK_MODEL_HINTS = Object.freeze({
  [TASK_TYPES.DEEP_REASONING]: ['anthropic:claude-opus-4-7', 'deepseek:deepseek-reasoner', 'openrouter:anthropic/claude-opus-4.7'],
  [TASK_TYPES.SPEED]: ['google:gemini-2.5-flash', 'groq:llama-3.3-70b-versatile', 'cerebras:llama-3.3-70b'],
  [TASK_TYPES.MULTIMODAL]: ['google:gemini-2.5-pro', 'openai:gpt-4o', 'openrouter:openai/gpt-4o'],
  [TASK_TYPES.CODE]: ['anthropic:claude-sonnet-4-6', 'openrouter:anthropic/claude-sonnet-4.6', 'mistral:mistral-large-latest'],
  [TASK_TYPES.EMBEDDINGS]: ['voyage:voyage-3-large', 'jina:jina-embeddings-v3'],
  [TASK_TYPES.DEFAULT]: ['openrouter:anthropic/claude-sonnet-4.6', 'openai:gpt-4o-mini', 'google:gemini-2.5-flash'],
});

function detectTaskType({ prompt = '', files = [], requestedCapability = '' } = {}) {
  const text = String(prompt || '').toLowerCase();
  if (requestedCapability === 'embeddings') return TASK_TYPES.EMBEDDINGS;
  if (Array.isArray(files) && files.some(f => String(f.mimeType || '').startsWith('image/'))) return TASK_TYPES.MULTIMODAL;
  if (/\b(code|programa|typescript|javascript|python|refactor|debug|repo|pull request)\b/.test(text)) return TASK_TYPES.CODE;
  if (/\b(math|matem[aá]tica|proof|demuestra|razonamiento profundo|tesis|research|paper)\b/.test(text)) return TASK_TYPES.DEEP_REASONING;
  if (/\b(r[aá]pido|quick|fast|resumen breve|solo dame)\b/.test(text)) return TASK_TYPES.SPEED;
  return TASK_TYPES.DEFAULT;
}

function providerApiKey(provider, env = process.env) {
  return env[provider.envKey] || (provider.fallbackEnvKey ? env[provider.fallbackEnvKey] : '');
}

function configuredProviders(env = process.env) {
  return PROVIDERS.filter(provider => Boolean(providerApiKey(provider, env)));
}

module.exports = {
  PROVIDERS,
  TASK_MODEL_HINTS,
  TASK_TYPES,
  configuredProviders,
  detectTaskType,
  providerApiKey,
};
