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
 * Public picker: Sira Mini never exposes Ollama / HuggingFace / moondream.
 * Upstream (Lenovo, docker network iliagpt-app): siragpt-ollama:11434/v1,
 * model id moondream:latest, auth None. Host bind is loopback-only.
 */

const KEY_PREFIX = 'enc:v1:';

const SIRA_MINI_DISPLAY_NAME = 'SiraGPT Mini';
const SIRA_MINI_PUBLIC_NAME = 'sira-mini';
const SIRA_MINI_UPSTREAM_ID = 'moondream:latest';
const SIRA_MINI_DEFAULT_BASE_URL = 'http://siragpt-ollama:11434/v1';
const SIRA_MINI_DESCRIPTION = 'Modelo rápido multimodal de SiraGPT.';
const SIRA_MINI_ALIASES = Object.freeze([
  'sira-mini',
  'sira mini',
  'siragpt mini',
  'siragpt-mini',
  'moondream',
  'moondream:latest',
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
]));

const HIDDEN_VENDOR_RE = /ollama|hugging\s*face|huggingface|moondream/i;

function normalizeOpenAiCompatibleUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function isOpenAiCompatibleUrl(url) {
  return /\/v1$/i.test(normalizeOpenAiCompatibleUrl(url));
}

function isCustomProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'custom' || p === 'custom api' || p === 'ollama';
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

function isSiraMiniAlias(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return false;
  if (SIRA_MINI_ALIASES.includes(raw)) return true;
  return normalizeModelName(raw) === 'moondream' || normalizeModelName(raw) === 'sira-mini';
}

function catalogNameCandidates(model) {
  const raw = String(model || '').trim();
  if (!raw) return [];
  const out = [raw];
  const bare = raw.replace(/:latest$/i, '');
  if (bare && bare !== raw) out.push(bare);
  if (isSiraMiniAlias(raw)) {
    out.push(SIRA_MINI_PUBLIC_NAME, 'moondream', SIRA_MINI_UPSTREAM_ID);
  }
  return [...new Set(out)];
}

function publicSiraMiniName() {
  return SIRA_MINI_PUBLIC_NAME;
}

function rewriteCustomChatModel(model) {
  if (isSiraMiniAlias(model)) return SIRA_MINI_UPSTREAM_ID;
  return String(model || '').trim();
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
  if (wanted) {
    const listed = customish.find((row) => (
      Array.isArray(row.modelIds)
      && row.modelIds.some((id) => namesMatch(id, wanted))
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
            { name: { in: ['moondream', SIRA_MINI_UPSTREAM_ID, SIRA_MINI_PUBLIC_NAME] } },
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
function createCustomProviderClient(connection, { OpenAI } = {}) {
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

function publicPickerModel(model) {
  if (!model || typeof model !== 'object') return model;
  const next = { ...model, provider: publicPickerProvider(model.provider) };
  const mini = isSiraMiniAlias(model.name) || isSiraMiniAlias(model.displayName);
  if (mini) {
    next.name = SIRA_MINI_PUBLIC_NAME;
    next.displayName = SIRA_MINI_DISPLAY_NAME;
    next.provider = 'Sira';
    next.description = SIRA_MINI_DESCRIPTION;
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
  if (isSiraMiniAlias(rawName) && (!current || isSiraMiniAlias(current) || /^moondream\b/i.test(current))) {
    return SIRA_MINI_DISPLAY_NAME;
  }
  return current || rawName;
}

module.exports = {
  KEY_PREFIX,
  KNOWN_CLOUD_PROVIDER_KEYS,
  SIRA_MINI_DISPLAY_NAME,
  SIRA_MINI_PUBLIC_NAME,
  SIRA_MINI_UPSTREAM_ID,
  SIRA_MINI_DEFAULT_BASE_URL,
  isCustomProvider,
  isCustomConnectionRow,
  isOpenAiCompatibleUrl,
  isLocalVisionModel,
  isSiraMiniAlias,
  normalizeOpenAiCompatibleUrl,
  normalizeModelName,
  publicPickerProvider,
  publicPickerModel,
  catalogProviderForConnection,
  defaultCustomDisplayName,
  rewriteCustomChatModel,
  defaultSiraMiniBaseUrl,
  unwrapStoredKey,
  shapeConnection,
  pickCustomConnectionRow,
  resolveCustomConnectionForTurn,
  createCustomProviderClient,
};
