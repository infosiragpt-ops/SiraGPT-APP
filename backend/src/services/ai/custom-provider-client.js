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
 * Public picker: Custom-sourced models keep their displayName (e.g. "Sira Mini")
 * and never expose Ollama / HuggingFace / DeepSeek as the provider label.
 */

const KEY_PREFIX = 'enc:v1:';

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

const HIDDEN_VENDOR_RE = /ollama|hugging\s*face|huggingface/i;

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
  try {
    const exact = await prisma.aiModel.findUnique({ where: { name }, select });
    if (exact) return exact;
  } catch {
    return null;
  }
  const bare = name.replace(/:latest$/i, '');
  if (bare && bare !== name) {
    try {
      return await prisma.aiModel.findUnique({ where: { name: bare }, select });
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
  const catalogIsCustom = !!(catalog && isCustomProvider(catalog.provider));
  const providerIsCustom = isCustomProvider(provider);
  const isCustomSignal = catalogIsCustom || providerIsCustom;

  if (!prisma || !prisma.adminConnection || typeof prisma.adminConnection.findMany !== 'function') {
    return { isCustom: isCustomSignal, connection: null, catalog };
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
    return { isCustom: isCustomSignal, connection: null, catalog };
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
  return {
    isCustom: true,
    connection: chosen ? shapeConnection(chosen, { decryptFn }) : null,
    catalog,
  };
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
  return new Ctor(opts);
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

function isLocalVisionModel(model) {
  return /(^|\/)(moondream|llava|bakllava|minicpm-v)/i.test(String(model || ''));
}

function catalogProviderForConnection(providerKey, providerLabel) {
  const key = String(providerKey || '').trim().toLowerCase();
  if (key === 'custom') return 'Custom';
  return providerLabel || providerKey || 'Custom';
}

function defaultCustomDisplayName(name, currentDisplayName) {
  const rawName = String(name || '').trim();
  const current = String(currentDisplayName || '').trim();
  if (/^moondream\b/i.test(rawName) && (!current || /^moondream\b/i.test(current))) {
    return 'Sira Mini';
  }
  return current || rawName;
}

module.exports = {
  KEY_PREFIX,
  KNOWN_CLOUD_PROVIDER_KEYS,
  isCustomProvider,
  isCustomConnectionRow,
  isOpenAiCompatibleUrl,
  isLocalVisionModel,
  normalizeOpenAiCompatibleUrl,
  normalizeModelName,
  publicPickerProvider,
  catalogProviderForConnection,
  defaultCustomDisplayName,
  unwrapStoredKey,
  shapeConnection,
  pickCustomConnectionRow,
  resolveCustomConnectionForTurn,
  createCustomProviderClient,
};
