'use strict';

/**
 * billing-failover — remember providers that cannot answer (no credit, key
 * rejected) and choose a configured, healthy replacement only for internal
 * requests without a user-pinned model.
 *
 * The memo always applies: every chat, agent and runner failure feeds it, so
 * the picker shows «Sin saldo» and no ladder retries a dead account. A model
 * the user selected never fails over: it keeps its provider, the turn ends
 * with E_PROVIDER, and the error carries the cause (annotateProviderFailure)
 * so the user is told exactly what happened (buildFailureMessage).
 *
 * State is per process (production runs one backend instance). A provider
 * marked «sin saldo» is re-probed after the TTL (10 min), immediately when an
 * admin saves a different key (fingerprint mismatch), or as soon as it
 * answers again (noteProviderAnswered). A per-minute quota window is memoised
 * about a minute as 'rate_limit': the ladders skip it, the picker does not
 * call it «Sin saldo».
 */

const keyHealth = require('../../utils/provider-key-health');

const { fingerprint } = keyHealth;

const DEFAULT_MEMO_MS = 10 * 60 * 1000;
// provider (lowercase) → { at, keyFp, ttlMs, status, reason, cause }. cause
// is 'billing' (no credit: the picker shows «Sin saldo») or 'rate_limit' (a
// per-minute quota window: the ladders skip the provider for about a minute,
// the picker does not call it unfunded).
const outOfCredit = new Map();

// A chain rung skipped because its provider is already memoised unfunded.
const UNFUNDED_MEMO_CODE = 'PROVIDER_UNFUNDED_MEMO';

// Per-minute quota windows (Gemini «Quota exceeded for metric … Please retry
// in 29s») recover on their own: memoise about the window, not 10 minutes of
// «Sin saldo». Explicit credit wording always keeps the long memo.
const SHORT_WINDOW_DEFAULT_MS = 60 * 1000;
const SHORT_WINDOW_MIN_MS = 30 * 1000;
const SHORT_WINDOW_MAX_MS = 120 * 1000;
const SHORT_WINDOW_RE = /retry in \d|(?:retry|try again) (?:in|after) \d|retryDelay|per[ -]?minute|requests per|tokens per|RESOURCE_EXHAUSTED|quota exceeded for metric/i;
// Not the bare word «billing»: Gemini's per-minute 429 also says «check your
// plan and billing details».
const HARD_CREDIT_RE = /credit|balance|insufficient_quota|payment|spending|billing (?:hard )?limit/i;
const AUTH_RE = /invalid[_ ]api[_ ]key|incorrect api key|api key not valid|authentication_error/i;
// OpenRouter «You requested up to N tokens, but can only afford M»: the
// account still has credit, only this reservation is too large (same rule as
// doc-agent/llm-runtime). A tiny allowance is an empty account.
// OpenRouter's 402 carries both phrases («…or fewer max_tokens. … can only
// afford N»): read the amount first so a near-empty account is still billing.
const AFFORDABLE_TOKENS_RE = /can only afford\s+(\d+)/i;
const RESERVATION_HINT_RE = /fewer max_tokens/i;
const MIN_USEFUL_AFFORDABLE_TOKENS = 1024;

const PROVIDER_KEY_ENVS = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  meta: ['MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  'z.ai': ['ZAI_API_KEY'],
});

// Default preference among funded providers when several can answer. The
// cheap, prepaid-free rungs go first (prod 2026-09-28: OpenAI, Anthropic and
// xAI ran out of credit the same night; DeepSeek/Cerebras/Gemini kept
// answering).
const DEFAULT_ORDER = ['DeepSeek', 'Cerebras', 'Gemini', 'Groq', 'Mistral', 'OpenRouter', 'xAI', 'OpenAI', 'Anthropic', 'Meta', 'Kimi', 'Z.ai'];

// Never a failover target: decision model, local Mini, custom endpoints.
const NON_CHAT_PROVIDER_RE = /^(typesafe|custom|sira|ollama|huggingface)$/i;

const FAST_TIER_RE = /(flash|mini|haiku|fast|lite|small|nano|instant|turbo)\b/i;

function enabled(env = process.env) {
  return String(env.SIRAGPT_BILLING_FAILOVER || '').trim() !== '0';
}

function normProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'x-ai' || p === 'grok') return 'xai';
  if (p === 'google') return 'gemini';
  if (p === 'moonshot') return 'kimi';
  if (p === 'llama') return 'meta';
  if (p === 'zai') return 'z.ai';
  return p;
}

function currentKeyFor(provider, env = process.env) {
  const names = PROVIDER_KEY_ENVS[normProvider(provider)] || [];
  for (const name of names) {
    const value = String((env && env[name]) || '').trim();
    if (value) return value;
  }
  return '';
}

function memoMs(env = process.env) {
  const n = Number(env.SIRAGPT_BILLING_FAILOVER_MEMO_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_MEMO_MS;
}

function errorText(err) {
  if (!err) return '';
  const nested = err.error && typeof err.error === 'object'
    ? `${err.error.type || ''} ${err.error.code || ''} ${err.error.message || ''}`
    : '';
  return `${err.code || ''} ${err.type || ''} ${err.message || ''} ${nested}`;
}

function statusOf(err) {
  return Number((err && (err.status || err.statusCode || (err.response && err.response.status))) || 0) || 0;
}

function headerValue(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name);
  } catch (_) { /* plain object below */ }
  const value = headers[name];
  return value == null ? null : value;
}

function headerRetryMs(err) {
  const headers = err && (err.headers || (err.response && err.response.headers));
  if (!headers) return null;
  const ms = Number(headerValue(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headerValue(headers, 'retry-after');
  if (raw == null || !String(raw).trim()) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Wait hint from a retry-after header or the provider text («retry in 29.3s»), in ms. */
function retryAfterMs(err) {
  if (!err) return null;
  const fromHeader = headerRetryMs(err);
  if (fromHeader != null) return fromHeader;
  const text = errorText(err);
  const m = text.match(/(?:retry|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?\b/i)
    || text.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)(s)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = String(m[2] || 's').toLowerCase();
  if (unit === 'ms' || unit.startsWith('milli')) return n;
  if (unit.startsWith('m')) return n * 60 * 1000;
  return n * 1000;
}

function isAbortLike(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return true;
  if (err.constructor && err.constructor.name === 'APIUserAbortError') return true;
  return !statusOf(err) && /\baborted\b/i.test(String(err.message || ''));
}

/**
 * True for a per-minute quota window (retry hint, «per minute», Gemini
 * RESOURCE_EXHAUSTED) without explicit credit wording.
 */
function isShortQuotaWindow(err) {
  if (!err) return false;
  const text = errorText(err);
  if (HARD_CREDIT_RE.test(text)) return false;
  return SHORT_WINDOW_RE.test(text) || headerRetryMs(err) != null;
}

/** Memo TTL for this failure: about the quota window, or the long «sin saldo» memo. */
function quotaWindowMs(err, env = process.env) {
  if (!isShortQuotaWindow(err)) return memoMs(env);
  const hint = retryAfterMs(err);
  const ms = Number.isFinite(hint) && hint > 0 ? hint : SHORT_WINDOW_DEFAULT_MS;
  return Math.min(SHORT_WINDOW_MAX_MS, Math.max(SHORT_WINDOW_MIN_MS, Math.round(ms)));
}

/**
 * True for «the account has no credit/quota» — not for rate limits, auth
 * rejections, bad requests or transient faults.
 */
function isBillingError(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status) || 0);
  const text = errorText(err);
  if (/rate[_ ]?limit(?!.*quota)|too many requests/i.test(text) && !/quota|credit|balance/i.test(text)) return false;
  if (status === 402) return true;
  return /credit balance is too low|credit_balance|insufficient[_ ]?(balance|credits?|funds|quota)|payment required|billing verification failed|exceeded your current quota|out of credits?|no credits? (left|remaining)|purchase credits|used all (?:of )?(?:your |the )?(?:available )?credits|spending (?:limit|cap)|billing (?:hard )?limit|(?:top up|recharge|add) (?:your )?(?:credits|balance)|quota exceeded|plan quota|monthly (?:api |plan |)?(?:limit|quota) exceeded/i.test(text);
}

function isReservationSizeError(err) {
  const text = errorText(err);
  const amount = AFFORDABLE_TOKENS_RE.exec(text);
  if (amount) return Number(amount[1]) >= MIN_USEFUL_AFFORDABLE_TOKENS;
  return RESERVATION_HINT_RE.test(text);
}

function markOutOfCredit(provider, err = null, env = process.env, opts = {}) {
  const name = normProvider(provider);
  if (!name) return;
  const status = Number((err && (err.status || err.statusCode)) || 0) || null;
  const key = currentKeyFor(provider, env);
  const ttlMs = (opts && opts.ttlMs) ?? quotaWindowMs(err, env);
  const cause = (opts && opts.cause) || (isShortQuotaWindow(err) ? 'rate_limit' : 'billing');
  outOfCredit.set(name, {
    at: Date.now(),
    keyFp: fingerprint(key),
    ttlMs,
    status,
    reason: String((err && err.message) || '').slice(0, 160),
    cause,
  });
  // Every ladder that consults provider-key-health (agent runner failover,
  // embeddings, vision, contract resolver) skips the unfunded key too.
  if (key) {
    try { keyHealth.markRejected(name, key, err, env, { reason: 'billing', ttlMs }); } catch (_) { /* advisory */ }
  }
  // The picker lists «Sin saldo» from this memo; drop the cached list.
  try { require('../../middleware/response-cache').invalidate({ namespace: 'ai-models' }); } catch (_) { /* optional */ }
}

function liveEntry(provider, env = process.env) {
  const name = normProvider(provider);
  const entry = outOfCredit.get(name);
  if (!entry) return null;
  if (Date.now() - entry.at > entry.ttlMs) { outOfCredit.delete(name); return null; }
  if (entry.keyFp !== fingerprint(currentKeyFor(provider, env))) { outOfCredit.delete(name); return null; }
  return entry;
}

/**
 * True when the provider has no credit («Sin saldo» in the picker). A
 * per-minute quota window is not «sin saldo»: the ladders still skip it
 * through its short key-health entry (isUnfunded / keyHealth.isRejected).
 */
function isOutOfCredit(provider, env = process.env) {
  const entry = liveEntry(provider, env);
  return Boolean(entry) && entry.cause !== 'rate_limit';
}

/** 'billing' | 'rate_limit' | null — why the provider is memoised right now. */
function outOfCreditCause(provider, env = process.env) {
  const entry = liveEntry(provider, env);
  return entry ? entry.cause || 'billing' : null;
}

/** Seconds left on the provider's memo, or null. */
function memoRetryAfterSeconds(provider, env = process.env) {
  const entry = liveEntry(provider, env);
  if (!entry) return null;
  const left = entry.ttlMs - (Date.now() - entry.at);
  return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : null;
}

/**
 * The provider just answered with content: a «sin saldo» / per-minute memo of
 * the current key is stale (a top-up, the window passed). Drops the memo, its
 * billing key-health entry and the cached picker list. An auth rejection is
 * left alone (it may come from Files/embeddings). Never throws.
 */
function noteProviderAnswered(provider, env = process.env) {
  try {
    const name = normProvider(provider);
    if (!name || !outOfCredit.has(name)) return false;
    outOfCredit.delete(name);
    const key = currentKeyFor(provider, env);
    if (key && typeof keyHealth.rejectionReason === 'function' && keyHealth.rejectionReason(name, key) === 'billing') {
      keyHealth.clear(name);
    }
    try { require('../../middleware/response-cache').invalidate({ namespace: 'ai-models' }); } catch (_) { /* optional */ }
    return true;
  } catch (_) {
    return false;
  }
}

function clear(provider = null) {
  if (provider == null) { outOfCredit.clear(); return; }
  outOfCredit.delete(normProvider(provider));
}

/**
 * True when the provider cannot answer for billing reasons right now: its
 * own memo, or a key-health rejection (auth or billing) of the current key.
 */
function isUnfunded(provider, env = process.env, health = keyHealth) {
  if (isOutOfCredit(provider, env)) return true;
  const key = currentKeyFor(provider, env);
  return Boolean(key) && Boolean(health && typeof health.isRejected === 'function' && health.isRejected(normProvider(provider), key));
}

/**
 * Why a provider failure may move an internal request to another provider:
 * 'unfunded_memo' | 'breaker' | 'unconfigured' | 'billing' | 'auth' |
 * 'forbidden', or null (rate limits, timeouts, bad requests, aborts). A plain
 * 429 «Resource has been exhausted» / «check quota» is a throttle, never
 * billing.
 */
function failoverReasonFor(err) {
  if (!err || isAbortLike(err)) return null;
  if (err.code === UNFUNDED_MEMO_CODE) return 'unfunded_memo';
  if (err.name === 'CircuitBreakerError') return 'breaker';
  if (err.code === 'PROVIDER_CONNECTION_UNAVAILABLE') return 'unconfigured';
  // A reservation larger than the balance is not an empty account.
  if (isReservationSizeError(err)) return null;
  if (isBillingError(err)) return 'billing';
  const status = statusOf(err);
  if (status === 401 || AUTH_RE.test(errorText(err))) return 'auth';
  if (status === 403) return 'forbidden';
  return null;
}

/**
 * Feed the memo from any caller (chat stream, react-agent, agent tasks):
 * billing → «sin saldo» memo (+ key health), auth → key-health rejection of
 * the current key. Breakers, 403s, missing connections and memo skips are
 * not recorded. Never throws. Returns the recorded reason or null.
 */
function recordProviderFailure(provider, err, reason = failoverReasonFor(err), env = process.env) {
  try {
    const name = normProvider(provider);
    if (!name || NON_CHAT_PROVIDER_RE.test(name)) return null;
    if (reason === 'billing') {
      markOutOfCredit(provider, err, env);
      return 'billing';
    }
    if (reason === 'auth') {
      const key = currentKeyFor(provider, env);
      if (!key) return null;
      keyHealth.markRejected(name, key, err, env, { reason: 'auth' });
      return 'auth';
    }
  } catch (_) { /* advisory */ }
  return null;
}

/**
 * 'billing' | 'rate_limit' | 'auth' | null — why the provider cannot answer
 * right now. A generic 403 key-health memo (Files, embeddings) never blocks
 * chat: 'auth' only for a recorded 401.
 */
function unfundedReason(provider, env = process.env, health = keyHealth) {
  const memo = outOfCreditCause(provider, env);
  if (memo) return memo;
  const key = currentKeyFor(provider, env);
  if (!key || !health) return null;
  const name = normProvider(provider);
  let reason = null;
  try { reason = typeof health.rejectionReason === 'function' ? health.rejectionReason(name, key) : null; } catch (_) { reason = null; }
  if (reason === 'billing') return 'billing';
  if (reason === 'auth') {
    let status = null;
    try { status = typeof health.rejectionStatus === 'function' ? health.rejectionStatus(name, key) : null; } catch (_) { status = null; }
    if (Number(status) === 401) return 'auth';
  }
  return null;
}

function unfundedMemoError(provider) {
  return Object.assign(new Error(`${provider} sin saldo o clave rechazada`), {
    status: 402,
    code: UNFUNDED_MEMO_CODE,
    provider,
  });
}

function snapshot() {
  const out = {};
  for (const [name, entry] of outOfCredit) {
    out[name] = {
      since: new Date(entry.at).toISOString(),
      status: entry.status,
      cause: entry.cause || 'billing',
      expiresInMs: Math.max(0, entry.ttlMs - (Date.now() - entry.at)),
    };
  }
  return out;
}

function tierOf(model) {
  return FAST_TIER_RE.test(String(model || '')) ? 'fast' : 'pro';
}

function providerOrder(env = process.env) {
  const raw = String(env.SIRAGPT_BILLING_FAILOVER_ORDER || '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORDER;
  return list.map(normProvider);
}

function fallbackLabel(model) {
  const m = String(model || '').trim().replace(/^[^/]+\//, '');
  return m || 'otro modelo';
}

/**
 * User-facing label for a picker row (original names, never raw ids).
 */
function labelFor(row) {
  if (!row) return '';
  try {
    const { publicPickerModel } = require('./custom-provider-client');
    const pub = publicPickerModel({ ...row });
    if (pub && pub.displayName) return String(pub.displayName);
  } catch (_) { /* fall through */ }
  return String(row.displayName || fallbackLabel(row.name));
}

// Last resort when the picker list is unreadable or has no funded candidate:
// the cheap models that kept answering in prod (DeepSeek V4 Flash direct or
// through its second transport, Gemini for image turns).
const LAST_RESORT_RUNGS = Object.freeze([
  { provider: 'DeepSeek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vision: false },
  { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', vision: false },
  { provider: 'Gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true },
]);

function lastResortEnabled(env = process.env) {
  return String(env.SIRAGPT_BILLING_FAILOVER_LAST_RESORT || '').trim() !== '0';
}

function pickLastResort({ excluded, needsVision, env, inference, keyHealth: health, fromLabel }) {
  if (!lastResortEnabled(env)) return null;
  for (const rung of LAST_RESORT_RUNGS) {
    const pName = normProvider(rung.provider);
    if (excluded.has(pName)) continue;
    if (needsVision && !rung.vision) continue;
    const key = currentKeyFor(rung.provider, env);
    if (!key) continue;
    if (inference && typeof inference.providerConnectionReady === 'function' && !inference.providerConnectionReady(rung.provider, env)) continue;
    if (isOutOfCredit(rung.provider, env)) continue;
    if (health && typeof health.isRejected === 'function' && health.isRejected(pName, key)) continue;
    return { provider: rung.provider, model: rung.model, label: rung.label, fromLabel };
  }
  return null;
}

/**
 * Pick a configured, funded model of a comparable tier from the SAME list the
 * picker shows (then the last-resort rungs). Returns
 * { provider, model, label, fromLabel } or null.
 */
async function pickFailoverModel({
  fromProvider,
  fromModel,
  needsVision = false,
  // Providers already tried in this turn (a fallback that turned out to be
  // unfunded too). Always skipped, even before their memo lands.
  excludeProviders = [],
  prisma = null,
  env = process.env,
  deps = {},
} = {}) {
  if (!enabled(env)) return null;
  const db = prisma || deps.prisma || require('../../config/database');
  const catalog = deps.catalog || require('../visible-model-catalog');
  const inference = deps.inference || require('./provider-inference');
  const keyHealth = deps.keyHealth || require('../../utils/provider-key-health');
  const caps = deps.capabilities || require('../agent-harness/model-capabilities');

  const fromName = normProvider(fromProvider);
  const excluded = new Set([fromName, ...(Array.isArray(excludeProviders) ? excludeProviders : [])].map(normProvider).filter(Boolean));
  const lastResort = (fromLabel) => pickLastResort({ excluded, needsVision, env, inference, keyHealth, fromLabel });

  let rows = [];
  try {
    rows = await db.aiModel.findMany({
      where: { isActive: true, type: { in: ['TEXT', 'IMAGE'] } },
      // curateVisibleTextModels keeps only rows with isActive === true — the
      // same select as GET /api/ai/models, or every row is dropped (live bug
      // 2026-09-27: 18 active rows → 0 candidates → no failover).
      select: { id: true, name: true, displayName: true, provider: true, type: true, description: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  } catch (_) {
    return lastResort(publicModelLabel(fromModel, fromProvider));
  }
  const curated = catalog.curateVisibleTextModels(rows, env);
  const fromRow = rows.find((r) => r && r.name === fromModel) || null;
  // Without its picker row the model is named only by a known display name;
  // never a raw id (the notice then says «El modelo elegido»).
  const fromLabel = fromRow ? labelFor(fromRow) : publicModelLabel(fromModel, fromProvider);
  const wantTier = tierOf(`${fromModel || ''} ${fromRow ? fromRow.displayName || '' : ''}`);
  const order = providerOrder(env);

  const candidates = [];
  curated.forEach((row, index) => {
    if (!row || !row.name || row.comingSoon) return;
    let provider = row.provider;
    try { provider = inference.resolveGenerateProvider(row.provider, row.name) || row.provider; } catch (_) { /* keep */ }
    const pName = normProvider(provider);
    if (!pName || excluded.has(pName)) return;
    if (NON_CHAT_PROVIDER_RE.test(pName)) return;
    if (typeof inference.providerConnectionReady === 'function' && !inference.providerConnectionReady(provider, env)) return;
    if (isOutOfCredit(provider, env)) return;
    const key = currentKeyFor(provider, env);
    if (key && keyHealth.isRejected(pName, key)) return;
    if (needsVision) {
      let vision = false;
      try { vision = Boolean(caps.resolveModelCapabilities(row.name, { provider }).supportsImages); } catch (_) { vision = false; }
      if (!vision) return;
    }
    const rank = order.indexOf(pName);
    candidates.push({
      provider,
      model: row.name,
      label: labelFor(row),
      sameTier: tierOf(`${row.name} ${row.displayName || ''}`) === wantTier ? 0 : 1,
      rank: rank === -1 ? order.length : rank,
      index,
    });
  });
  if (!candidates.length) return lastResort(fromLabel);
  candidates.sort((a, b) => a.sameTier - b.sameTier || a.rank - b.rank || a.index - b.index);
  const best = candidates[0];
  return {
    provider: best.provider,
    model: best.model,
    label: best.label,
    fromLabel,
  };
}

// Cause shown to the user for each failure reason (failoverReasonFor, plus
// 'rate_limit' / 'unavailable' from failureCauseFor).
const NOTICE_CAUSES = Object.freeze({
  billing: 'el proveedor no tiene saldo',
  unfunded_memo: 'el proveedor no tiene saldo',
  auth: 'el proveedor rechazó la conexión',
  breaker: 'el proveedor no está respondiendo',
  forbidden: 'el proveedor no permite este modelo ahora',
  unconfigured: 'su conexión no está configurada',
  rate_limit: 'el proveedor alcanzó su límite de solicitudes por minuto',
  unavailable: 'el proveedor no está respondiendo',
});

function buildNotice({ fromLabel, toLabel, reason = 'billing' }) {
  const from = String(fromLabel || 'El modelo elegido').trim();
  const to = String(toLabel || 'otro modelo').trim();
  const cause = NOTICE_CAUSES[reason] || 'el proveedor no respondió';
  return `${from} no está disponible ahora (${cause}); respondí con ${to}.`;
}

/**
 * User-facing cause of a failure, for the transparent error of a pinned
 * model: failoverReasonFor, except that a per-minute quota window is
 * 'rate_limit' (not «sin saldo»), plus 'rate_limit' for 429 throttles and
 * 'unavailable' for timeouts / 5xx / network faults. null when unknown.
 */
function failureCauseFor(err) {
  if (!err || isAbortLike(err)) return null;
  const reason = failoverReasonFor(err);
  if (reason === 'billing' && isShortQuotaWindow(err)) return 'rate_limit';
  if (reason === 'unfunded_memo') return 'billing';
  if (reason) return reason;
  const status = statusOf(err);
  const text = errorText(err);
  if (status === 429 || /rate[_ ]?limit|too many requests|RESOURCE_EXHAUSTED|resource has been exhausted/i.test(text)) return 'rate_limit';
  if (status === 408 || status >= 500 || err.code === 'TIMEOUT'
    || /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed|overloaded/i.test(text)) return 'unavailable';
  return null;
}

/** Display name for a model id when one is known without a DB read, else ''. */
function publicModelLabel(model, provider = '') {
  const name = String(model || '').trim();
  if (!name) return '';
  try {
    const { publicPickerModel } = require('./custom-provider-client');
    const pub = publicPickerModel({ name, provider });
    if (pub && pub.displayName) return String(pub.displayName);
  } catch (_) { /* unknown */ }
  // The static picker catalog, by exact id only: its aliases also map legacy
  // ids to newer models (gpt-5 → GPT 5.5), which would name the wrong model.
  try {
    const { listVisibleTextModelDefinitions } = require('../visible-model-catalog');
    const lower = name.toLowerCase();
    const row = listVisibleTextModelDefinitions().find((r) => r && String(r.name || '').toLowerCase() === lower);
    if (row && row.displayName) return String(row.displayName);
  } catch (_) { /* catalog unavailable */ }
  return '';
}

/**
 * Attach the transparent cause to the error a pinned model's turn ends with
 * (the thrown code stays E_PROVIDER at the SSE close): siraFailureReason,
 * siraProvider, siraModel, siraModelLabel (only a real display name) and
 * siraRetryAfterSeconds. Never throws; returns the error.
 */
function annotateProviderFailure(err, { provider = '', model = '', reason = null, env = process.env } = {}) {
  if (!err || typeof err !== 'object') return err;
  try {
    // A reservation larger than the balance (OpenRouter «can only afford N»,
    // N ≥ 1024) is not an empty account, but it is the exact cause.
    let cause = reason || failureCauseFor(err) || (isReservationSizeError(err) ? 'reservation' : null);
    let memoWait = null;
    if (cause === 'breaker' && provider) {
      // A breaker opened while the provider kept answering «no credit» / a
      // per-minute limit (or before those stopped counting): the memo knows
      // the real cause, which is what the user must be told.
      const memo = outOfCreditCause(provider, env);
      if (memo) {
        cause = memo;
        if (memo === 'rate_limit') memoWait = memoRetryAfterSeconds(provider, env);
      } else if (unfundedReason(provider, env) === 'auth') {
        cause = 'auth';
      }
    }
    if (cause && !err.siraFailureReason) err.siraFailureReason = cause;
    if (provider && !err.siraProvider) err.siraProvider = String(provider);
    if (model && !err.siraModel) err.siraModel = String(model);
    const label = publicModelLabel(model, provider);
    if (label && !err.siraModelLabel) err.siraModelLabel = label;
    if (err.siraFailureReason === 'rate_limit' && err.siraRetryAfterSeconds == null) {
      const ms = retryAfterMs(err);
      if (Number.isFinite(ms) && ms > 0) err.siraRetryAfterSeconds = Math.max(1, Math.ceil(ms / 1000));
      else if (memoWait) err.siraRetryAfterSeconds = memoWait;
    }
  } catch (_) { /* advisory */ }
  return err;
}

/**
 * Spanish, 100% transparent message for a pinned model that could not
 * answer: which model and which cause. Never a raw id, never a vendor
 * transport. null for an unknown cause (the caller keeps its generic copy).
 */
function buildFailureMessage({ modelLabel = '', reason = null, retryAfterSeconds = null } = {}) {
  const label = String(modelLabel || '').trim() || 'El modelo elegido';
  const tail = 'No cambié de modelo; elige otro en el selector o inténtalo más tarde.';
  switch (reason) {
    case 'billing':
    case 'unfunded_memo':
      return `${label} no pudo responder: su proveedor no tiene saldo ahora. ${tail}`;
    case 'auth':
      return `${label} no pudo responder: su proveedor rechazó la clave de conexión. ${tail}`;
    case 'breaker':
    case 'unavailable':
      return `${label} no pudo responder: su proveedor no está respondiendo ahora. ${tail}`;
    case 'forbidden':
      return `${label} no pudo responder: su proveedor no permite usar este modelo ahora. ${tail}`;
    case 'unconfigured':
      return `${label} no pudo responder: su conexión no está configurada. ${tail}`;
    case 'reservation':
      return `${label} no pudo responder: su proveedor no tiene saldo suficiente para una respuesta de este tamaño. No cambié de modelo; pide algo más breve, elige otro en el selector o inténtalo más tarde.`;
    case 'rate_limit': {
      const secs = Number(retryAfterSeconds);
      const wait = Number.isFinite(secs) && secs > 0
        ? `Espera ${Math.ceil(secs)} s y vuelve a intentarlo.`
        : 'Espera un momento y vuelve a intentarlo.';
      return `${label} no pudo responder: su proveedor alcanzó el límite de solicitudes por minuto. ${wait} No cambié de modelo.`;
    }
    default:
      return null;
  }
}

function __resetForTests() { outOfCredit.clear(); try { keyHealth.clear(); } catch (_) { /* optional */ } }

module.exports = {
  enabled,
  isBillingError,
  markOutOfCredit,
  isOutOfCredit,
  outOfCreditCause,
  memoRetryAfterSeconds,
  noteProviderAnswered,
  isReservationSizeError,
  isUnfunded,
  unfundedReason,
  unfundedMemoError,
  failoverReasonFor,
  failureCauseFor,
  recordProviderFailure,
  annotateProviderFailure,
  isShortQuotaWindow,
  quotaWindowMs,
  retryAfterMs,
  clear,
  snapshot,
  tierOf,
  providerOrder,
  pickFailoverModel,
  buildNotice,
  buildFailureMessage,
  publicModelLabel,
  currentKeyFor,
  normProvider,
  DEFAULT_MEMO_MS,
  UNFUNDED_MEMO_CODE,
  LAST_RESORT_RUNGS,
  __resetForTests,
};
