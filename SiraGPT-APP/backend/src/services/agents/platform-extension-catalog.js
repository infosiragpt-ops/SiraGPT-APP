'use strict';

/**
 * SiraGPT platform extension catalog.
 *
 * This is a SiraGPT-native capability map inspired by OpenClaw's extension
 * layout. It intentionally does not load or vendor upstream extension code.
 * The catalog lets runtime/admin surfaces answer:
 *   - which capability families exist,
 *   - which providers/channels are known,
 *   - which ones are configured through environment variables,
 *   - which family best matches a requested task.
 */

const EXTENSION_FAMILIES = Object.freeze([
  {
    id: 'llm-providers',
    label: 'LLM providers',
    role: 'Text, reasoning, coding, vision, and multimodal model routing.',
    siraRuntime: ['backend/src/services/agents/provider-registry.js', 'backend/src/services/agents/providers'],
    providers: [
      { id: 'openai', env: ['OPENAI_API_KEY'], capabilities: ['text', 'reasoning', 'vision', 'code'] },
      { id: 'anthropic', env: ['ANTHROPIC_API_KEY'], capabilities: ['text', 'reasoning', 'vision', 'code'] },
      { id: 'google', env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'], capabilities: ['text', 'reasoning', 'vision'] },
      { id: 'openrouter', env: ['OPENROUTER_API_KEY'], capabilities: ['text', 'routing', 'fallback'] },
      { id: 'groq', env: ['GROQ_API_KEY'], capabilities: ['text', 'fast'] },
      { id: 'mistral', env: ['MISTRAL_API_KEY'], capabilities: ['text', 'reasoning'] },
      { id: 'deepseek', env: ['DEEPSEEK_API_KEY'], capabilities: ['text', 'code'] },
      { id: 'xai', env: ['XAI_API_KEY'], capabilities: ['text', 'reasoning'] },
      { id: 'together', env: ['TOGETHER_API_KEY'], capabilities: ['text', 'open-models'] },
      { id: 'perplexity', env: ['PERPLEXITY_API_KEY'], capabilities: ['text', 'web-grounded'] },
      { id: 'ollama', env: ['OLLAMA_BASE_URL'], capabilities: ['local-models', 'text'] },
      { id: 'lmstudio', env: ['LMSTUDIO_BASE_URL'], capabilities: ['local-models', 'text'] },
    ],
  },
  {
    id: 'media-generation',
    label: 'Media generation',
    role: 'Image, video, audio, and visual generation tools.',
    siraRuntime: ['backend/src/services/agents/visual-media-tools.js', 'backend/src/services/models/modelCatalog.js'],
    providers: [
      { id: 'fal', env: ['FAL_KEY', 'FAL_API_KEY'], capabilities: ['image', 'video', 'music'] },
      { id: 'runway', env: ['RUNWAY_API_KEY'], capabilities: ['video'] },
      { id: 'comfy', env: ['COMFYUI_BASE_URL'], capabilities: ['image', 'workflow'] },
      { id: 'replicate', env: ['REPLICATE_API_TOKEN'], capabilities: ['image', 'video', 'open-models'] },
      { id: 'stability', env: ['STABILITY_API_KEY'], capabilities: ['image'] },
    ],
  },
  {
    id: 'search-retrieval',
    label: 'Search and retrieval',
    role: 'Web search, browser extraction, RAG ingestion, and source grounding.',
    siraRuntime: ['backend/src/skills/web_search', 'backend/src/skills/read_url', 'backend/src/services/agents/web-search'],
    providers: [
      { id: 'tavily', env: ['TAVILY_API_KEY'], capabilities: ['web-search'] },
      { id: 'exa', env: ['EXA_API_KEY'], capabilities: ['web-search', 'semantic-search'] },
      { id: 'firecrawl', env: ['FIRECRAWL_API_KEY'], capabilities: ['web-crawl', 'extract'] },
      { id: 'searxng', env: ['SEARXNG_URL'], capabilities: ['web-search', 'self-hosted'] },
      { id: 'duckduckgo', env: [], capabilities: ['web-search', 'fallback'] },
      { id: 'brave', env: ['BRAVE_SEARCH_API_KEY'], capabilities: ['web-search'] },
    ],
  },
  {
    id: 'channels',
    label: 'Channels',
    role: 'Messaging, chat ingress, outbound delivery, and multichannel routing.',
    siraRuntime: ['backend/src/orchestration/multichannel', 'backend/src/services/agents/hermes-gateway-bridge.js'],
    providers: [
      { id: 'telegram', env: ['TELEGRAM_BOT_TOKEN'], capabilities: ['chat', 'bot'] },
      { id: 'whatsapp', env: ['WHATSAPP_TOKEN', 'WHATSAPP_ACCESS_TOKEN'], capabilities: ['chat', 'business'] },
      { id: 'slack', env: ['SLACK_BOT_TOKEN'], capabilities: ['chat', 'workspace'] },
      { id: 'discord', env: ['DISCORD_BOT_TOKEN'], capabilities: ['chat', 'voice'] },
      { id: 'signal', env: ['SIGNAL_CLI_PATH'], capabilities: ['chat'] },
      { id: 'mattermost', env: ['MATTERMOST_TOKEN'], capabilities: ['chat', 'workspace'] },
      { id: 'teams', env: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'], capabilities: ['chat', 'workspace'] },
    ],
  },
  {
    id: 'memory-knowledge',
    label: 'Memory and knowledge',
    role: 'Durable memory, semantic recall, active facts, and knowledge bases.',
    siraRuntime: ['backend/src/services/agents/hermes-memory-bridge.js', 'backend/src/skills/rag_retrieve'],
    providers: [
      { id: 'active-memory', env: [], capabilities: ['session-memory', 'fact-promotion'] },
      { id: 'lancedb', env: ['LANCEDB_URI'], capabilities: ['vector-store'] },
      { id: 'redis', env: ['REDIS_URL'], capabilities: ['cache', 'queue', 'state'] },
      { id: 'postgres', env: ['DATABASE_URL'], capabilities: ['durable-state'] },
      { id: 'notion', env: ['NOTION_API_KEY'], capabilities: ['knowledge-base'] },
    ],
  },
  {
    id: 'speech-audio',
    label: 'Speech and audio',
    role: 'Speech-to-text, text-to-speech, voice calls, and audio understanding.',
    siraRuntime: ['backend/src/services/agents/visual-media-tools.js'],
    providers: [
      { id: 'elevenlabs', env: ['ELEVENLABS_API_KEY'], capabilities: ['tts', 'voice'] },
      { id: 'deepgram', env: ['DEEPGRAM_API_KEY'], capabilities: ['stt', 'audio'] },
      { id: 'azure-speech', env: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], capabilities: ['tts', 'stt'] },
      { id: 'openai-whisper', env: ['OPENAI_API_KEY'], capabilities: ['stt'] },
      { id: 'local-tts', env: ['TTS_LOCAL_COMMAND'], capabilities: ['tts', 'local'] },
    ],
  },
]);

function listFamilies() {
  return EXTENSION_FAMILIES.map((family) => ({
    id: family.id,
    label: family.label,
    role: family.role,
    providerCount: family.providers.length,
    siraRuntime: family.siraRuntime.slice(),
  }));
}

function listProviders() {
  return EXTENSION_FAMILIES.flatMap((family) => family.providers.map((provider) => ({
    ...provider,
    family: family.id,
    familyLabel: family.label,
  })));
}

function envConfigured(provider, env = process.env) {
  if (!provider.env || provider.env.length === 0) return false;
  return provider.env.some((name) => Boolean(env[name]));
}

function buildExtensionCatalogReport(opts = {}) {
  const env = opts.env || process.env;
  const providers = listProviders().map((provider) => ({
    ...provider,
    configured: envConfigured(provider, env),
  }));
  const configured = providers.filter((provider) => provider.configured);
  return {
    source: {
      openclaw: 'https://github.com/openclaw/openclaw/tree/main/extensions',
      policy: 'SiraGPT-native rewrite; upstream extension code is not vendored or executed.',
    },
    counts: {
      families: EXTENSION_FAMILIES.length,
      providers: providers.length,
      configured: configured.length,
    },
    families: listFamilies(),
    providers,
  };
}

function recommendExtensionFamilies(input, limit = 5) {
  const terms = tokenize(input);
  if (terms.length === 0) return [];

  return EXTENSION_FAMILIES
    .map((family) => {
      const haystack = [
        family.id,
        family.label,
        family.role,
        ...family.siraRuntime,
        ...family.providers.flatMap((provider) => [
          provider.id,
          ...provider.capabilities,
          ...(provider.env || []),
        ]),
      ].join(' ').toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      return {
        family: family.id,
        label: family.label,
        score: matchedTerms.length + (matchedTerms.includes(family.id) ? 3 : 0),
        matchedTerms,
        providers: family.providers.map((provider) => provider.id),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.family.localeCompare(b.family))
    .slice(0, limit);
}

function tokenize(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length >= 3);
}

module.exports = {
  EXTENSION_FAMILIES,
  listFamilies,
  listProviders,
  buildExtensionCatalogReport,
  recommendExtensionFamilies,
};
