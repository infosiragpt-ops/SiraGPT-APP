'use strict';

/**
 * custom-provider-client — request-time routing for Admin → Connections
 * rows with providerKey `custom` (Ollama, LM Studio, vLLM, …).
 *
 * Why this module exists
 * ----------------------
 * `admin-connections-bridge` injects known cloud keys into process.env.
 * `custom` is intentionally absent from that map: a local OpenAI-compatible
 * endpoint has a unique base URL per row (and often auth None). Stuffing
 * OPENAI_BASE_URL would clobber the real OpenAI client.
 *
 * Live chat must therefore read the AdminConnection row at request time and
 * point the OpenAI SDK at `connection.url`. Never api.openai.com.
 *
 * Public picker: Sira Mini never exposes Ollama / HuggingFace / moondream /
 * gemma4. Upstream (Lenovo, docker network iliagpt-app): siragpt-ollama:11434,
 * model id `SIRA_MINI_UPSTREAM_ID` (default sira-mini → gemma4:26b, num_ctx 4096,
 * num_thread 16), auth None. Mini chat uses native POST /api/chat with
 * think:false and keep_alive:-1 — Ollama 0.33.1 /v1/chat/completions ignores
 * think:false and dumps Gemma 4 reasoning. Host bind is loopback-only.
 * moondream remains a recognized fallback alias.
 */

const KEY_PREFIX = 'enc:v1:';

const SIRA_MINI_DISPLAY_NAME = 'SiraGPT Mini';
const SIRA_MINI_PUBLIC_NAME = 'sira-mini';
const SIRA_MINI_UPSTREAM_DEFAULT = 'sira-mini';
const SIRA_MINI_DEFAULT_BASE_URL = 'http://siragpt-ollama:11434/v1';
const SIRA_MINI_NATIVE_CHAT_PATH = '/api/chat';
const SIRA_MINI_KEEP_ALIVE = -1;
const SIRA_MINI_THINK = false;
const SIRA_MINI_DESCRIPTION = 'Modelo rápido multimodal de SiraGPT.';
const SIRA_RAPIDO_DISPLAY_NAME = 'Sira Rápido';
const SIRA_PRO_DISPLAY_NAME = 'Sira Pro';
const SIRA_RAPIDO_DESCRIPTION = 'Modelo rápido de SiraGPT para chat cotidiano y tareas cortas.';
const SIRA_PRO_DESCRIPTION = 'Modelo profesional de SiraGPT para razonamiento, código y documentos.';
const SIRA_MINI_UNAVAILABLE_MESSAGE =
  'SiraGPT Mini no está disponible ahora. No cambié el modelo. Revisa la conexión Custom en Admin → Conexiones e inténtalo de nuevo.';
const SIRA_MINI_ALIASES = Object.freeze([
  'sira-mini',
  'sira mini',
  'siragpt mini',
  'siragpt-mini',
  'moondream',
  'moondream:latest',
  'gemma4',
  'gemma4:26b',
]);
const SIRA_MINI_CATALOG_NAMES = Object.freeze([
  'sira-mini',
  'moondream',
  'moondream:latest',
  'gemma4',
  'gemma4:26b',
]);

const KNOWN_CLOUD_PROVIDER_KEYS = Object.freeze(new Set([
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'groq',
  'openrouter',
  'cerebras',
  'zai',
  'kimi',
  'deepseek',
  'xai',
  'together',
  'fireworks',
  'fal',
  'meta',
]));

const HIDDEN_VENDOR_RE = /ollama|hugging\s*face|huggingface|moondream|gemma4/i;
const VENDOR_MINI_DISPLAY_RE = /^(moondream|gemma4|gemma\s*4)\b/i;

function normalizeOpenAiCompatibleUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function isOpenAiCompatibleUrl(url) {
  return /\/v1$/i.test(normalizeOpenAiCompatibleUrl(url));
}

function isCustomProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'custom' || p === 'custom api' || p === 'ollama' || p === 'huggingface';
}

function isCustomConnectionRow(row) {
  if (!row) return false;
  const key = String(row.providerKey || '').trim().toLowerCase();
  if (key === 'custom') return true;
  if (KNOWN_CLOUD_PROVIDER_KEYS.has(key)) return false;
  return isOpenAiCompatibleUrl(row.url);
}

function normalizeModelName(name) {
  return String(name || '').trim().toLowerCase().replace(/:latest$/i, '');
}

function namesMatch(a, b) {
  const left = normalizeModelName(a);
  const right = normalizeModelName(b);
  return !!left && left === right;
}

function resolveSiraMiniUpstreamId(env = process.env) {
  const override = String((env && env.SIRA_MINI_UPSTREAM_ID) || '').trim();
  return override || SIRA_MINI_UPSTREAM_DEFAULT;
}

function isGemma4MiniId(name) {
  const bare = normalizeModelName(name);
  return bare === 'gemma4' || bare.startsWith('gemma4:');
}

function isSiraMiniAlias(name, env = process.env) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return false;
  if (SIRA_MINI_ALIASES.includes(raw)) return true;
  const bare = normalizeModelName(raw);
  if (bare === 'moondream' || bare === 'sira-mini' || isGemma4MiniId(raw)) return true;
  const upstream = normalizeModelName(resolveSiraMiniUpstreamId(env));
  return !!upstream && (bare === upstream || raw === String(resolveSiraMiniUpstreamId(env)).toLowerCase());
}

function catalogNameCandidates(model, env = process.env) {
  const raw = String(model || '').trim();
  if (!raw) return [];
  const out = [raw];
  const bare = raw.replace(/:latest$/i, '');
  if (bare && bare !== raw) out.push(bare);
  if (isSiraMiniAlias(raw, env)) {
    out.push(SIRA_MINI_PUBLIC_NAME, ...SIRA_MINI_CATALOG_NAMES, resolveSiraMiniUpstreamId(env));
  }
  return [...new Set(out.filter(Boolean))];
}

function publicSiraMiniName() {
  return SIRA_MINI_PUBLIC_NAME;
}

function rewriteCustomChatModel(model, env = process.env) {
  if (isSiraMiniAlias(model, env)) return resolveSiraMiniUpstreamId(env);
  return String(model || '').trim();
}

function ollamaNativeBaseUrl(openaiCompatibleUrl) {
  return normalizeOpenAiCompatibleUrl(openaiCompatibleUrl).replace(/\/v1$/i, '');
}

function ollamaNativeChatUrl(openaiCompatibleUrl) {
  const base = ollamaNativeBaseUrl(openaiCompatibleUrl);
  return base ? `${base}${SIRA_MINI_NATIVE_CHAT_PATH}` : '';
}

function flattenChatContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function toOllamaNativeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: String((message && message.role) || 'user'),
    content: flattenChatContent(message && message.content),
  }));
}

function buildOllamaNativeChatBody(openaiBody, env = process.env) {
  const stream = !!(openaiBody && openaiBody.stream);
  return {
    model: rewriteCustomChatModel(openaiBody && openaiBody.model, env),
    messages: toOllamaNativeMessages(openaiBody && openaiBody.messages),
    stream,
    think: SIRA_MINI_THINK,
    keep_alive: SIRA_MINI_KEEP_ALIVE,
  };
}

function miniUpstreamError(status) {
  const err = new Error(SIRA_MINI_UNAVAILABLE_MESSAGE);
  err.status = status || 503;
  err.code = 'SIRA_MINI_UNAVAILABLE';
  return err;
}

function openAiChunkFromOllama(content, { done = false } = {}) {
  return {
    id: SIRA_MINI_PUBLIC_NAME,
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: done ? {} : { content: content || '' },
      finish_reason: done ? 'stop' : null,
    }],
  };
}

function openAiCompletionFromOllama(json) {
  const content = json && json.message && typeof json.message.content === 'string'
    ? json.message.content
    : '';
  return {
    id: SIRA_MINI_PUBLIC_NAME,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  };
}

async function* iterResponseTextChunks(response) {
  if (!response) return;
  const body = response.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      yield typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    }
    return;
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    return;
  }
  if (typeof response.text === 'function') {
    yield await response.text();
  }
}

async function* iterateOllamaNativeChatStream(response) {
  let buf = '';
  for await (const chunk of iterResponseTextChunks(response)) {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (parsed) {
          const content = parsed.message && parsed.message.content;
          if (typeof content === 'string' && content) {
            yield openAiChunkFromOllama(content);
          }
          if (parsed.done) {
            yield openAiChunkFromOllama('', { done: true });
            return;
          }
        }
      }
      idx = buf.indexOf('\n');
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      const parsed = JSON.parse(tail);
      const content = parsed && parsed.message && parsed.message.content;
      if (typeof content === 'string' && content) yield openAiChunkFromOllama(content);
    } catch { /* ignore trailing noise */ }
  }
  yield openAiChunkFromOllama('', { done: true });
}

async function createOllamaNativeChat(connection, openaiBody, { fetchImpl, signal, env } = {}) {
  const url = ollamaNativeChatUrl(connection && connection.url);
  if (!url || /\/v1\/chat\/completions/i.test(url)) {
    throw miniUpstreamError(503);
  }
  const payload = buildOllamaNativeChatBody(openaiBody, env);
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') throw miniUpstreamError(503);
  let response;
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (connection && connection.apiKey && connection.authType !== 'None') {
      headers.Authorization = `Bearer ${connection.apiKey}`;
    }
    response = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw miniUpstreamError(503);
  }
  if (!response || !response.ok) {
    throw miniUpstreamError(response && response.status);
  }
  if (payload.stream) return iterateOllamaNativeChatStream(response);
  try {
    const json = typeof response.json === 'function' ? await response.json() : {};
    return openAiCompletionFromOllama(json);
  } catch {
    throw miniUpstreamError(502);
  }
}

function preferSiraMiniRow(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length <= 1) return list[0] || null;
  return list.find((row) => normalizeModelName(row.name) === SIRA_MINI_PUBLIC_NAME)
    || list.find((row) => normalizeModelName(row.name) === 'moondream')
    || list[0];
}

function collapseSiraMiniRows(models) {
  const list = Array.isArray(models) ? models : [];
  const mini = [];
  const rest = [];
  for (const model of list) {
    if (model && isSiraMiniAlias(model.name || model.displayName)) mini.push(model);
    else rest.push(model);
  }
  if (mini.length <= 1) return list;
  const preferred = preferSiraMiniRow(mini);
  return preferred ? [preferred, ...rest] : rest;
}

function defaultSiraMiniBaseUrl(env = process.env) {
  const override = String((env && env.SIRAGPT_CUSTOM_BASE_URL) || '').trim();
  if (override) return normalizeOpenAiCompatibleUrl(override);
  return SIRA_MINI_DEFAULT_BASE_URL;
}

function defaultSiraMiniConnection(env) {
  return {
    id: null,
    url: defaultSiraMiniBaseUrl(env),
    apiKey: null,
    authType: 'None',
    headers: null,
  };
}

function unwrapStoredKey(stored, decryptFn) {
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith(KEY_PREFIX)) return stored;
  const decrypt = typeof decryptFn === 'function' ? decryptFn : loadDecrypt();
  if (typeof decrypt !== 'function') return null;
  try {
    return decrypt(stored.slice(KEY_PREFIX.length));
  } catch (err) {
    console.error('[custom-provider-client] decrypt failed:', err && err.message);
    return null;
  }
}

function loadDecrypt() {
  try {
    // eslint-disable-next-line global-require
    return require('../../utils/encryption').decrypt;
  } catch {
    return null;
  }
}

function shapeConnection(row, { decryptFn } = {}) {
  if (!row || !row.url) return null;
  const url = normalizeOpenAiCompatibleUrl(row.url);
  if (!url) return null;
  const authType = String(row.authType || 'Bearer');
  let apiKey = null;
  if (authType !== 'None') {
    apiKey = unwrapStoredKey(row.apiKey, decryptFn);
  }
  return {
    id: row.id || null,
    url,
    apiKey,
    authType,
    headers: row.headers && typeof row.headers === 'object' ? row.headers : null,
  };
}

function pickCustomConnectionRow(rows, model) {
  const customish = (Array.isArray(rows) ? rows : []).filter(isCustomConnectionRow);
  if (!customish.length) return null;
  const wanted = normalizeModelName(model);
  const wantedIsMini = isSiraMiniAlias(model);
  if (wanted) {
    const listed = customish.find((row) => (
      Array.isArray(row.modelIds)
      && row.modelIds.some((id) => namesMatch(id, wanted) || (wantedIsMini && isSiraMiniAlias(id)))
    ));
    if (listed) return listed;
  }
  return customish[0];
}

async function findAiModelByName(prisma, model) {
  const name = String(model || '').trim();
  if (!name || !prisma || !prisma.aiModel) return null;
  const select = { name: true, displayName: true, provider: true, isActive: true, type: true };
  for (const candidate of catalogNameCandidates(name)) {
    try {
      const exact = await prisma.aiModel.findUnique({ where: { name: candidate }, select });
      if (exact) return exact;
    } catch {
      return null;
    }
  }
  if (isSiraMiniAlias(name) && typeof prisma.aiModel.findFirst === 'function') {
    try {
      return await prisma.aiModel.findFirst({
        where: {
          OR: [
            { name: { in: [...new Set([...SIRA_MINI_CATALOG_NAMES, resolveSiraMiniUpstreamId()])] } },
            { displayName: SIRA_MINI_DISPLAY_NAME },
            { displayName: 'Sira Mini' },
          ],
        },
        select,
      });
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve the Custom AdminConnection for this generate turn.
 *
 * @returns {{ isCustom: boolean, connection: object|null, catalog: object|null }}
 */
async function resolveCustomConnectionForTurn({
  provider,
  model,
  prisma,
  decryptFn,
} = {}) {
  const catalog = await findAiModelByName(prisma, model);
  const catalogIsCustom = !!(catalog && (
    isCustomProvider(catalog.provider) || isSiraMiniAlias(catalog.name) || isSiraMiniAlias(catalog.displayName)
  ));
  const providerIsCustom = isCustomProvider(provider);
  const aliasIsSiraMini = isSiraMiniAlias(model);
  const isCustomSignal = catalogIsCustom || providerIsCustom || aliasIsSiraMini;

  if (!prisma || !prisma.adminConnection || typeof prisma.adminConnection.findMany !== 'function') {
    return {
      isCustom: isCustomSignal,
      connection: isCustomSignal ? defaultSiraMiniConnection() : null,
      catalog,
    };
  }

  let rows = [];
  try {
    rows = await prisma.adminConnection.findMany({
      where: { enabled: true },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        url: true,
        providerKey: true,
        apiKey: true,
        authType: true,
        modelIds: true,
        headers: true,
        enabled: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    console.warn('[custom-provider-client] lookup failed:', err && err.message);
    return {
      isCustom: isCustomSignal,
      connection: isCustomSignal ? defaultSiraMiniConnection() : null,
      catalog,
    };
  }

  const matchedByModel = pickCustomConnectionRow(
    rows.filter((row) => Array.isArray(row.modelIds) && row.modelIds.length),
    model,
  );
  if (matchedByModel) {
    return { isCustom: true, connection: shapeConnection(matchedByModel, { decryptFn }), catalog };
  }

  if (!isCustomSignal) {
    return { isCustom: false, connection: null, catalog };
  }

  const chosen = pickCustomConnectionRow(rows, model);
  if (chosen) {
    return { isCustom: true, connection: shapeConnection(chosen, { decryptFn }), catalog };
  }

  // Lenovo: iliagpt-backend and siragpt-ollama share iliagpt-app.
  // Host bind is 127.0.0.1:11434 (not public) — the backend must use the
  // docker DNS name. Auth none.
  if (aliasIsSiraMini || catalogIsCustom) {
    return { isCustom: true, connection: defaultSiraMiniConnection(), catalog };
  }

  return { isCustom: true, connection: null, catalog };
}

/**
 * OpenAI SDK client pointed at the admin Custom connection.
 * Auth None → placeholder key (Ollama ignores it). Never defaults to api.openai.com.
 */
function createCustomProviderClient(connection, { OpenAI, fetchImpl } = {}) {
  const url = normalizeOpenAiCompatibleUrl(connection && connection.url);
  if (!url) {
    const err = new Error('Conexión Custom sin URL');
    err.code = 'CUSTOM_CONNECTION_MISSING';
    throw err;
  }
  const Ctor = OpenAI || loadOpenAI();
  const opts = {
    apiKey: (connection && connection.apiKey) || 'local',
    baseURL: url,
  };
  if (connection && connection.headers) {
    opts.defaultHeaders = connection.headers;
  }
  const client = new Ctor(opts);
  if (!client.chat) client.chat = {};
  if (!client.chat.completions) client.chat.completions = {};
  const originalCreate = typeof client.chat.completions.create === 'function'
    ? client.chat.completions.create.bind(client.chat.completions)
    : null;
  client.chat.completions.create = function create(body, options) {
    if (body && typeof body === 'object' && isSiraMiniAlias(body.model)) {
      return createOllamaNativeChat(connection, body, {
        fetchImpl,
        signal: options && options.signal,
      });
    }
    if (body && typeof body === 'object' && body.model) {
      const rewritten = rewriteCustomChatModel(body.model);
      if (rewritten !== body.model) body = { ...body, model: rewritten };
    }
    if (!originalCreate) return undefined;
    return originalCreate(body, options);
  };
  return client;
}

function loadOpenAI() {
  // eslint-disable-next-line global-require
  return require('openai');
}

/**
 * Provider label shown in the user picker. Display name stays on the model
 * row; this only stops Ollama / HuggingFace / "Custom API" leaking as a group.
 */
function publicPickerProvider(provider) {
  const raw = String(provider || '').trim();
  if (!raw) return raw;
  if (isCustomProvider(raw) || HIDDEN_VENDOR_RE.test(raw)) return 'Sira';
  return raw;
}

function isSiraProRow(model) {
  const hay = `${model && model.name ? model.name : ''} ${model && model.displayName ? model.displayName : ''}`;
  return /deepseek/i.test(hay) && /v4[-_\s]?pro/i.test(hay) && !/flash/i.test(hay);
}

function isSiraRapidoRow(model) {
  const hay = `${model && model.name ? model.name : ''} ${model && model.displayName ? model.displayName : ''}`;
  return /deepseek/i.test(hay) && /v4[-_\s]?flash/i.test(hay);
}

function publicPickerModel(model) {
  if (!model || typeof model !== 'object') return model;
  const next = { ...model, provider: publicPickerProvider(model.provider) };
  const mini = isSiraMiniAlias(model.name) || isSiraMiniAlias(model.displayName);
  if (mini) {
    next.name = SIRA_MINI_PUBLIC_NAME;
    next.displayName = SIRA_MINI_DISPLAY_NAME;
    next.provider = 'Sira';
    next.description = SIRA_MINI_DESCRIPTION;
  } else if (isSiraProRow(model)) {
    next.displayName = SIRA_PRO_DISPLAY_NAME;
    next.description = SIRA_PRO_DESCRIPTION;
  } else if (isSiraRapidoRow(model)) {
    next.displayName = SIRA_RAPIDO_DISPLAY_NAME;
    next.description = SIRA_RAPIDO_DESCRIPTION;
  } else if (next.description && HIDDEN_VENDOR_RE.test(String(next.description))) {
    next.description = String(next.description).replace(HIDDEN_VENDOR_RE, 'Sira');
  }
  return next;
}

function isLocalVisionModel(model) {
  if (isSiraMiniAlias(model)) return true;
  return /(^|\/)(llava|bakllava|minicpm-v)/i.test(String(model || ''));
}

function catalogProviderForConnection(providerKey, providerLabel) {
  const key = String(providerKey || '').trim().toLowerCase();
  if (key === 'custom') return 'Custom';
  return providerLabel || providerKey || 'Custom';
}

function defaultCustomDisplayName(name, currentDisplayName) {
  const rawName = String(name || '').trim();
  const current = String(currentDisplayName || '').trim();
  if (isSiraMiniAlias(rawName) && (!current || isSiraMiniAlias(current) || VENDOR_MINI_DISPLAY_RE.test(current))) {
    return SIRA_MINI_DISPLAY_NAME;
  }
  return current || rawName;
}

module.exports = {
  KEY_PREFIX,
  KNOWN_CLOUD_PROVIDER_KEYS,
  SIRA_MINI_DISPLAY_NAME,
  SIRA_MINI_PUBLIC_NAME,
  SIRA_MINI_UPSTREAM_DEFAULT,
  get SIRA_MINI_UPSTREAM_ID() {
    return resolveSiraMiniUpstreamId();
  },
  SIRA_MINI_DEFAULT_BASE_URL,
  SIRA_MINI_NATIVE_CHAT_PATH,
  SIRA_MINI_KEEP_ALIVE,
  SIRA_MINI_THINK,
  SIRA_MINI_UNAVAILABLE_MESSAGE,
  SIRA_RAPIDO_DISPLAY_NAME,
  SIRA_PRO_DISPLAY_NAME,
  isCustomProvider,
  isCustomConnectionRow,
  isOpenAiCompatibleUrl,
  isLocalVisionModel,
  isSiraMiniAlias,
  normalizeOpenAiCompatibleUrl,
  normalizeModelName,
  publicPickerProvider,
  publicPickerModel,
  collapseSiraMiniRows,
  catalogProviderForConnection,
  defaultCustomDisplayName,
  resolveSiraMiniUpstreamId,
  rewriteCustomChatModel,
  ollamaNativeChatUrl,
  buildOllamaNativeChatBody,
  defaultSiraMiniBaseUrl,
  unwrapStoredKey,
  shapeConnection,
  pickCustomConnectionRow,
  resolveCustomConnectionForTurn,
  createCustomProviderClient,
};
