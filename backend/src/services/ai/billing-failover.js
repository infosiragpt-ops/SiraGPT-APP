'use strict';

/**
 * billing-failover — when the provider of the model the user PICKED has no
 * credit/quota left, answer with another configured, healthy model of a
 * comparable tier and say so at the top of the reply.
 *
 * Luis's rule (memory feedback-siragpt-picked-model-routing): engines follow
 * the picked model; fail over to another configured provider only on
 * provider-level errors (auth/quota/5xx). A billing error is not transient —
 * retrying the same model can't help — so the turn is answered by a funded
 * provider instead of ending in «El modelo no pudo completar la respuesta».
 * Live failure (2026-09-27 01:30Z / 02:26Z): Claude Fable 5.1 → Anthropic 400
 * «Your credit balance is too low to access the Anthropic API».
 *
 * State is per process (production runs one backend instance). A provider
 * marked «sin saldo» is re-probed after the TTL, or immediately when an admin
 * saves a different key (fingerprint mismatch).
 */

const { fingerprint } = require('../../utils/provider-key-health');

const DEFAULT_MEMO_MS = 10 * 60 * 1000;
const outOfCredit = new Map(); // provider (lowercase) → { at, keyFp, ttlMs, status, reason }

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

// Default preference among funded providers when several can answer.
const DEFAULT_ORDER = ['xAI', 'DeepSeek', 'Gemini', 'OpenAI', 'Anthropic', 'Meta', 'Kimi', 'OpenRouter', 'Mistral', 'Groq', 'Cerebras', 'Z.ai'];

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
  return /credit balance is too low|credit_balance|insufficient[_ ]?(balance|credits?|funds|quota)|payment required|billing verification failed|exceeded your current quota|out of credits|no credits? (left|remaining)|purchase credits/i.test(text);
}

function markOutOfCredit(provider, err = null, env = process.env) {
  const name = normProvider(provider);
  if (!name) return;
  const status = Number((err && (err.status || err.statusCode)) || 0) || null;
  outOfCredit.set(name, {
    at: Date.now(),
    keyFp: fingerprint(currentKeyFor(provider, env)),
    ttlMs: memoMs(env),
    status,
    reason: String((err && err.message) || '').slice(0, 160),
  });
  // The picker lists «Sin saldo» from this memo; drop the cached list.
  try { require('../../middleware/response-cache').invalidate({ namespace: 'ai-models' }); } catch (_) { /* optional */ }
}

function isOutOfCredit(provider, env = process.env) {
  const name = normProvider(provider);
  const entry = outOfCredit.get(name);
  if (!entry) return false;
  if (Date.now() - entry.at > entry.ttlMs) { outOfCredit.delete(name); return false; }
  if (entry.keyFp !== fingerprint(currentKeyFor(provider, env))) { outOfCredit.delete(name); return false; }
  return true;
}

function clear(provider = null) {
  if (provider == null) { outOfCredit.clear(); return; }
  outOfCredit.delete(normProvider(provider));
}

function snapshot() {
  const out = {};
  for (const [name, entry] of outOfCredit) {
    out[name] = {
      since: new Date(entry.at).toISOString(),
      status: entry.status,
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

/**
 * Pick a configured, funded model of a comparable tier from the SAME list the
 * picker shows. Returns { provider, model, label, fromLabel } or null.
 */
async function pickFailoverModel({
  fromProvider,
  fromModel,
  needsVision = false,
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
    return null;
  }
  const curated = catalog.curateVisibleTextModels(rows, env);
  const fromName = normProvider(fromProvider);
  const fromRow = rows.find((r) => r && r.name === fromModel) || null;
  const wantTier = tierOf(`${fromModel || ''} ${fromRow ? fromRow.displayName || '' : ''}`);
  const order = providerOrder(env);

  const candidates = [];
  curated.forEach((row, index) => {
    if (!row || !row.name || row.comingSoon) return;
    let provider = row.provider;
    try { provider = inference.resolveGenerateProvider(row.provider, row.name) || row.provider; } catch (_) { /* keep */ }
    const pName = normProvider(provider);
    if (!pName || pName === fromName) return;
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
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.sameTier - b.sameTier || a.rank - b.rank || a.index - b.index);
  const best = candidates[0];
  return {
    provider: best.provider,
    model: best.model,
    label: best.label,
    fromLabel: fromRow ? labelFor(fromRow) : fallbackLabel(fromModel),
  };
}

function buildNotice({ fromLabel, toLabel }) {
  const from = String(fromLabel || 'El modelo elegido').trim();
  const to = String(toLabel || 'otro modelo').trim();
  return `${from} no está disponible ahora (el proveedor no tiene saldo); respondí con ${to}.`;
}

function __resetForTests() { outOfCredit.clear(); }

module.exports = {
  enabled,
  isBillingError,
  markOutOfCredit,
  isOutOfCredit,
  clear,
  snapshot,
  tierOf,
  pickFailoverModel,
  buildNotice,
  currentKeyFor,
  normProvider,
  DEFAULT_MEMO_MS,
  __resetForTests,
};
