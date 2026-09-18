'use strict';

/**
 * TypeSafe AI (System One / Jev) client.
 *
 * Jev is not a chat-completions model: it evaluates a `state` against a map
 * of typed questions (noul = yes/no probability, choice = option
 * distribution, score = position on a rubric) and returns calibrated
 * probabilities (trained with RLCD). Endpoint: POST /v1/systemone.
 *
 * Model ids inside SiraGPT are namespaced (`typesafe/jev-latest`,
 * `typesafe/jev-1.13`); `toApiModel()` maps them to the ids the API accepts
 * (`jev-latest`, `jev-1.13.0`). The key comes from `TYPESAFE_API_KEY`
 * (Admin → Conexiones → TypeSafe fills it through admin-connections-bridge).
 */

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

const MODEL_ALIASES = Object.freeze({
  'jev-latest': 'jev-latest',
  'jev-preview': 'jev-preview',
  'jev-1.13': 'jev-1.13.0',
  'jev-1.13.0': 'jev-1.13.0',
});

/** Catalog rows SiraGPT exposes for this provider (selector + docs). */
const TYPESAFE_MODELS = Object.freeze([
  Object.freeze({
    id: 'typesafe/jev-latest',
    apiModel: 'jev-latest',
    name: 'Jev (latest)',
    description: 'Modelo de decisiones calibradas de TypeSafe (RLCD). Responde con probabilidades, no con texto libre.',
    contextTokens: 64000,
    stateTokens: 32000,
    inputPricePerMtok: 0.042,
    outputPricePerMtok: 0,
  }),
  Object.freeze({
    id: 'typesafe/jev-1.13',
    apiModel: 'jev-1.13.0',
    name: 'Jev 1.13',
    description: 'Versión fijada de Jev 1.13.0 para umbrales de confianza estables.',
    contextTokens: 64000,
    stateTokens: 32000,
    inputPricePerMtok: 0.042,
    outputPricePerMtok: 0,
  }),
]);

const PROVIDER_ID = 'typesafe';

function isTypeSafeModel(modelId) {
  if (typeof modelId !== 'string') return false;
  const id = modelId.trim().toLowerCase().replace(/^~/, '');
  if (id.startsWith('typesafe/')) return true;
  return /^jev(-|$)/.test(id);
}

function toApiModel(modelId) {
  if (typeof modelId !== 'string') return 'jev-latest';
  let id = modelId.trim().toLowerCase().replace(/^~/, '');
  if (id.startsWith('typesafe/')) id = id.slice('typesafe/'.length);
  if (id.startsWith('typesafe:')) id = id.slice('typesafe:'.length);
  if (MODEL_ALIASES[id]) return MODEL_ALIASES[id];
  if (/^jev-\d+\.\d+$/.test(id)) return `${id}.0`;
  if (/^jev-\d+\.\d+\.\d+$/.test(id)) return id;
  return 'jev-latest';
}

function toCatalogId(apiModel) {
  const id = String(apiModel || '').toLowerCase();
  if (id === 'jev-1.13.0') return 'typesafe/jev-1.13';
  if (id.startsWith('jev-')) return `typesafe/${id.replace(/\.0$/, '')}`;
  return 'typesafe/jev-latest';
}

function apiKey(env = process.env) {
  const k = env.TYPESAFE_API_KEY || env.TYPESAFE_KEY || '';
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

function isConfigured(env = process.env) {
  return apiKey(env) !== null;
}

function baseUrl(env = process.env) {
  const b = env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL;
  return String(b).replace(/\/+$/, '');
}

class TypeSafeError extends Error {
  constructor(message, { status = 0, code = 'typesafe_error', body = null, retryable = false } = {}) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryable = retryable;
    this.provider = PROVIDER_ID;
  }
}

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'typesafe_auth';
  if (status === 422) return 'typesafe_invalid_request';
  if (status === 429) return 'typesafe_rate_limited';
  if (status === 529) return 'typesafe_overloaded';
  if (status >= 500) return 'typesafe_upstream';
  return 'typesafe_error';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelayMs(attempt, res) {
  const ra = res && typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
  const raNum = ra ? Number(ra) : NaN;
  if (Number.isFinite(raNum) && raNum >= 0) return Math.min(raNum * 1000, 10000);
  return Math.min(300 * 2 ** attempt, 4000) + Math.floor(Math.random() * 100);
}

// ─── Question validation (mirrors the HTTP schema so 422s are caught locally) ───

const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);
const MAX_QUESTIONS = 64;
const MAX_CHOICE_OPTIONS = 255;

function isEntry(v) {
  return v === null || typeof v === 'string' || Array.isArray(v) || (typeof v === 'object');
}

function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new TypeSafeError('questions must be an object map', { status: 422, code: 'typesafe_invalid_request' });
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new TypeSafeError('at least one question is required', { status: 422, code: 'typesafe_invalid_request' });
  if (ids.length > MAX_QUESTIONS) throw new TypeSafeError(`too many questions (max ${MAX_QUESTIONS})`, { status: 422, code: 'typesafe_invalid_request' });
  const out = {};
  for (const id of ids) {
    const q = questions[id];
    if (!q || typeof q !== 'object') throw new TypeSafeError(`question "${id}" must be an object`, { status: 422, code: 'typesafe_invalid_request' });
    const type = String(q.type || '').toLowerCase();
    if (!QUESTION_TYPES.has(type)) throw new TypeSafeError(`question "${id}" has unknown type "${q.type}"`, { status: 422, code: 'typesafe_invalid_request' });
    if (!isEntry(q.instructions) || q.instructions === undefined) {
      throw new TypeSafeError(`question "${id}" needs instructions`, { status: 422, code: 'typesafe_invalid_request' });
    }
    const clean = { type, instructions: q.instructions };
    if (type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        throw new TypeSafeError(`choice "${id}" needs criteria {option: description}`, { status: 422, code: 'typesafe_invalid_request' });
      }
      const opts = Object.keys(q.criteria);
      if (opts.length < 2) throw new TypeSafeError(`choice "${id}" needs at least two options`, { status: 422, code: 'typesafe_invalid_request' });
      if (opts.length > MAX_CHOICE_OPTIONS) throw new TypeSafeError(`choice "${id}" has too many options`, { status: 422, code: 'typesafe_invalid_request' });
      clean.criteria = q.criteria;
    } else if (type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw new TypeSafeError(`score "${id}" needs an array of at least two levels`, { status: 422, code: 'typesafe_invalid_request' });
      }
      clean.criteria = q.criteria;
    } else if (q.criteria !== undefined && q.criteria !== null) {
      if (typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        throw new TypeSafeError(`noul "${id}" criteria must be {true, false}`, { status: 422, code: 'typesafe_invalid_request' });
      }
      clean.criteria = q.criteria;
    }
    out[id] = clean;
  }
  return out;
}

// ─── HTTP ───

async function request(path, { method = 'GET', body, env = process.env, timeoutMs, retries, fetchImpl, signal } = {}) {
  const key = apiKey(env);
  if (!key) throw new TypeSafeError('TYPESAFE_API_KEY is not configured', { status: 401, code: 'typesafe_not_configured' });
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${baseUrl(env)}${path}`;
  const maxRetries = Number.isFinite(retries) ? retries : Number(env.TYPESAFE_RETRIES ?? DEFAULT_RETRIES);
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : Number(env.TYPESAFE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const onOuterAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new TypeSafeError('aborted', { code: 'typesafe_aborted' }); }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      if (signal && signal.aborted) throw new TypeSafeError('aborted', { code: 'typesafe_aborted' });
      lastErr = new TypeSafeError(
        err && err.name === 'AbortError' ? `TypeSafe request timed out after ${timeout} ms` : `TypeSafe network error: ${err && err.message}`,
        { code: err && err.name === 'AbortError' ? 'typesafe_timeout' : 'typesafe_network', retryable: true },
      );
      if (attempt < maxRetries) { await sleep(retryDelayMs(attempt, null)); continue; }
      throw lastErr;
    }
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    let payload = null;
    const text = await res.text();
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 500) }; }
    if (res.ok) return payload;
    const retryable = RETRYABLE_STATUS.has(res.status);
    lastErr = new TypeSafeError(
      `TypeSafe ${res.status}: ${(payload && (payload.message || payload.error || payload.detail)) ? JSON.stringify(payload.message || payload.error || payload.detail).slice(0, 300) : res.statusText}`,
      { status: res.status, code: codeForStatus(res.status), body: payload, retryable },
    );
    if (retryable && attempt < maxRetries) { await sleep(retryDelayMs(attempt, res)); continue; }
    throw lastErr;
  }
  throw lastErr || new TypeSafeError('TypeSafe request failed', {});
}

/**
 * Evaluate `state` against `questions`.
 * @returns {{ model:string, answers:object, usage:{input_tokens:number,output_tokens:number}, latencyMs:number }}
 */
async function evaluate({ state, questions, model = 'jev-latest', env = process.env, timeoutMs, retries, fetchImpl, signal } = {}) {
  if (state === undefined || state === null) {
    throw new TypeSafeError('state is required', { status: 422, code: 'typesafe_invalid_request' });
  }
  const clean = validateQuestions(questions);
  const started = Date.now();
  const payload = await request('/v1/systemone', {
    method: 'POST',
    body: { state, model: toApiModel(model), questions: clean },
    env, timeoutMs, retries, fetchImpl, signal,
  });
  const answers = payload && typeof payload.answers === 'object' ? payload.answers : {};
  const usage = payload && payload.usage ? payload.usage : { input_tokens: 0, output_tokens: 0 };
  return {
    model: (payload && payload.model) || toApiModel(model),
    answers,
    usage: {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
    },
    latencyMs: Date.now() - started,
  };
}

async function listModels({ env = process.env, fetchImpl, timeoutMs } = {}) {
  const payload = await request('/v1/models', { env, fetchImpl, timeoutMs, retries: 0 });
  const rows = Array.isArray(payload && payload.models) ? payload.models : [];
  return rows.map((m) => ({
    name: m.name,
    description: m.description || '',
    releaseDate: m.release_date || null,
    id: toCatalogId(m.name),
  }));
}

// ─── Answer helpers ───

/** Normalise an answer into {kind, value, confidence, probabilities, top}. */
function summarizeAnswer(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const type = String(answer.type || '').toLowerCase();
  if (type === 'noul') {
    const p = clamp01(Number(answer.noul));
    return { kind: 'noul', value: p, yes: p >= 0.5, confidence: Math.abs(p - 0.5) * 2, probabilities: { true: p, false: 1 - p } };
  }
  if (type === 'choice') {
    const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {};
    const ranked = Object.entries(probabilities).map(([k, v]) => [k, Number(v) || 0]).sort((a, b) => b[1] - a[1]);
    return {
      kind: 'choice',
      value: answer.choice ?? (ranked[0] ? ranked[0][0] : null),
      confidence: clamp01(Number(answer.confidence)),
      probabilities,
      ranked,
      margin: ranked.length > 1 ? ranked[0][1] - ranked[1][1] : (ranked[0] ? ranked[0][1] : 0),
    };
  }
  if (type === 'score') {
    const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {};
    const legend = answer.legend && typeof answer.legend === 'object' ? answer.legend : {};
    const levels = Object.keys(legend).length;
    const score = Number(answer.score);
    const nearest = Number.isFinite(score) ? String(Math.max(0, Math.min(levels - 1, Math.round(score)))) : null;
    return {
      kind: 'score',
      value: Number.isFinite(score) ? score : null,
      normalized: Number.isFinite(score) && levels > 1 ? score / (levels - 1) : null,
      label: nearest !== null ? legend[nearest] || null : null,
      confidence: clamp01(Number(answer.confidence)),
      probabilities,
      legend,
    };
  }
  return null;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Three-band policy from docs.typesafe.ai/confidence: act / confirm / escalate.
 */
function confidenceBand(confidence, { act = 0.75, confirm = 0.5 } = {}) {
  const c = clamp01(Number(confidence));
  if (c >= act) return 'act';
  if (c >= confirm) return 'confirm';
  return 'escalate';
}

module.exports = {
  PROVIDER_ID,
  DEFAULT_BASE_URL,
  TYPESAFE_MODELS,
  MODEL_ALIASES,
  TypeSafeError,
  isTypeSafeModel,
  toApiModel,
  toCatalogId,
  isConfigured,
  apiKey,
  baseUrl,
  validateQuestions,
  evaluate,
  listModels,
  summarizeAnswer,
  confidenceBand,
  _internal: { request, retryDelayMs, codeForStatus },
};
