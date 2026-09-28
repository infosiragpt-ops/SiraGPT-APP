'use strict';

/**
 * Live progress of a chat turn («stage v3»): the only way the /api/ai/generate
 * pipeline announces what it is doing — reading the attachments, recalling
 * memory, searching the web, connecting to the model, retrying… — as `stage`
 * SSE frames the thinking timeline folds into rows with real details and
 * durations.
 *
 * Frame contract (docs: scratch stream-design §A.1; frontend
 * lib/chat/activity-log.ts appendStageActivity):
 *
 *   begin    { type:'stage', label, tool, phase, stageId, step:'tool_call',   status:'running', kind?, detail?, meta? }
 *   progress { type:'stage', label, tool, phase, stageId, step:'tool_progress', status:'running', detail?, meta? }
 *   result   { type:'stage', label, tool, phase, stageId, step:'tool_result', status:'done'|'error', ok, detail?, meta?, elapsedMs? }
 *
 * Hard invariants (pinned by tests/turn-progress.test.js):
 * - frames are built from scratch: never `content`, `replace`, `error` or
 *   `callId` (content would be glued into the answer / resume buffer, callId
 *   switches the bubble to the tool rail);
 * - `tool` is one of PIPELINE_TOOLS; a document-work tool is coerced to
 *   `pipeline` so a progress frame never counts as the provider's first byte;
 * - labels ≤ 90 chars, details ≤ 200, control characters stripped; `meta` is a
 *   whitelist of finite numbers;
 * - model names are display names only (never a raw id, never a transport);
 *   provider failures are told by category, never by `err.message`.
 *
 * Capability negotiation: a client that sent `progressProtocol: 2` gets the
 * three frame kinds; any other client (a stale tab) gets begin-only frames of
 * the legacy shape `{ type:'stage', label, tool }`. Begin / result frames are
 * never throttled; progress frames are (≤1/s per row, ≤4/s per turn, dropped
 * under socket backpressure). The helper never awaits and never throws.
 *
 * Kill switch: SIRAGPT_TURN_PROGRESS=0 → protocol 1 and only the legacy
 * phases (attachments, web, history, vision, model).
 */

const PIPELINE_TOOLS = new Set([
  'read_file', 'web_search', 'web_fetch', 'rag_retrieve', 'memory', 'compact',
  'vision', 'model', 'plan', 'verify', 'persist', 'pipeline',
]);
// generate-first-byte counts these stage tools as provider activity.
const DOCUMENT_WORK_TOOLS = new Set(['document_edit', 'agent_runner', 'create_document']);
const META_KEYS = new Set([
  'files', 'pages', 'words', 'chunks', 'hits', 'sources', 'tokens', 'attempt',
  'maxAttempts', 'step', 'maxSteps', 'bytes',
]);
const KINDS = new Set(['terminal', 'document', 'search', 'web', 'edit', 'image', 'check', 'thinking']);
const LEGACY_PHASES = new Set(['attachments', 'web', 'history', 'vision', 'model']);
const MAX_LABEL = 90;
const MAX_DETAIL = 200;
const MAX_BEGINS_PER_TURN = 48;
const PROGRESS_MIN_INTERVAL_MS = 1000;
const GLOBAL_PROGRESS_PER_WINDOW = 4;
const GLOBAL_PROGRESS_WINDOW_MS = 1000;
const GENERIC_MODEL_LABEL = 'el modelo';
// Persistence noise rule (mirrors the frontend's): a turn faster than this
// whose rows are all routine keeps no trace.
const TRIVIAL_TRACE_MS = 4000;
const TRIVIAL_TRACE_PHASES = new Set(['understanding', 'planning', 'context', 'model']);

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function capitalize(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (!META_KEYS.has(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = value;
    n += 1;
  }
  return n ? out : null;
}

function cleanTool(tool) {
  const name = String(tool || '').trim();
  if (DOCUMENT_WORK_TOOLS.has(name)) return 'pipeline';
  return PIPELINE_TOOLS.has(name) ? name : 'pipeline';
}

function cleanPhase(phase) {
  return cleanText(phase, 24).replace(/[^A-Za-z0-9_-]/g, '') || 'pipeline';
}

function killSwitchOn(env) {
  const raw = String((env && env.SIRAGPT_TURN_PROGRESS) ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

// ─── Formatters (Spanish; the frontend formats the same way) ─────────────

/** «1.240» — grouping by hand: the `es` locale does not group 4 digits. */
function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(Math.abs(n));
  const digits = String(rounded);
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += '.';
  }
  return n < 0 && rounded > 0 ? `-${out}` : out;
}

/** «180 ms» · «1,8 s» · «12 s» · «1 min 5 s» (same rounding as formatStepDuration). */
function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 999.5) return `${Math.round(n)} ms`;
  if (n < 9950) return `${String(Math.round(n / 100) / 10).replace('.', ',')} s`;
  const totalSec = Math.round(n / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** «2,3 MB» · «34 KB» · «512 B» (binary units, one decimal under 10). */
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? String(Math.round(value * 10) / 10).replace('.', ',') : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}

function plural(n, one, many) {
  return `${fmtInt(n)} ${Number(n) === 1 ? one : many}`;
}

// ─── Model names: display names only ─────────────────────────────────────

function foldId(value) {
  return String(value || '').trim().toLowerCase();
}

// Snapshot / packaging suffixes of the SAME model (claude-3-haiku-20240307,
// mistral-large-latest, gemma-3-27b-it, llama-3.3-70b-versatile…).
const SAME_MODEL_SUFFIX_RE = /^(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|latest|instruct|it|versatile|preview)$/;
// Product aliases the picker accepts as input for the DeepSeek V4 pair.
const SIRA_ALIAS_NAMES = [
  [/^sira[-_ ]?pro$/i, 'DeepSeek V4 Pro'],
  [/^sira[-_ ]?r[aá]pido$/i, 'DeepSeek V4 Flash'],
];

/** 'moonshotai/kimi-k2.6' → 'kimi-k2-6' (vendor prefix off, separators folded). */
function modelKey(value) {
  const base = String(value || '').trim().toLowerCase().replace(/^~/, '');
  const tail = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
  return tail.replace(/[\s._]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function sameModelKey(a, b) {
  if (!a || !b) return false;
  if (a === b || a.replace(/-/g, '') === b.replace(/-/g, '')) return true;
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter}-`) && SAME_MODEL_SUFFIX_RE.test(longer.slice(shorter.length + 1));
}

/**
 * The picker catalog row that IS this model: its id, or an alias that only
 * differs by vendor prefix, separators, a snapshot suffix, or that spells the
 * row's own display name. Aliases that map a legacy id to a newer model
 * (gpt-5 → GPT 5.5, claude-3-5-sonnet → Claude Sonnet 4.5) never match:
 * naming them would name a model that is not the one answering.
 */
function catalogNameFor(raw) {
  const key = modelKey(raw);
  if (!key) return '';
  try {
    const { listVisibleTextModelDefinitions } = require('./visible-model-catalog');
    // Only the row's own id and display name: an alias is accepted exactly
    // when it is one of their spellings, which this comparison covers.
    const row = listVisibleTextModelDefinitions().find((r) => r && r.displayName
      && [modelKey(r.name), modelKey(r.displayName)].some((k) => sameModelKey(key, k)));
    return row ? String(row.displayName) : '';
  } catch (_) {
    return '';
  }
}

/** The free tier's model (Cerebras): the brand the picker shows (⚡ FlashGPT). */
function freeTierNameFor(raw, provider) {
  try {
    const cfg = require('./ai/cerebras-client').getCerebrasConfig();
    if (!cfg || !cfg.model || !cfg.displayName) return '';
    const isFreeModel = foldId(raw) === foldId(cfg.model);
    const onCerebras = /^cerebras$/i.test(String(provider || '').trim());
    return isFreeModel && (onCerebras || !String(provider || '').trim()) ? String(cfg.displayName) : '';
  } catch (_) {
    return '';
  }
}

/**
 * The picker's display name for a model id, or '' when none is known. Never
 * a raw id, a prettified id or a transport name (OpenRouter…).
 */
function displayNameFor(id, provider = '') {
  const raw = String(id || '').trim();
  if (!raw) return '';
  let label = '';
  try { label = require('./ai/billing-failover').publicModelLabel(raw, provider) || ''; } catch (_) { label = ''; }
  if (!label) {
    const sira = SIRA_ALIAS_NAMES.find(([re]) => re.test(raw));
    if (sira) label = sira[1];
  }
  if (!label) label = catalogNameFor(raw);
  if (!label) label = freeTierNameFor(raw, provider);
  label = cleanText(label, 40);
  if (!label || /openrouter/i.test(label) || label.includes('/')) return '';
  return label;
}

/** Display name for a model id — `el modelo` when none is known. */
function modelLabel(id, provider = '') {
  return displayNameFor(id, provider) || GENERIC_MODEL_LABEL;
}

// ─── Label builders ──────────────────────────────────────────────────────

const THINKING_LEVEL_ES = {
  disabled: 'sin razonamiento extendido',
  minimal: 'razonamiento mínimo',
  low: 'razonamiento bajo',
  medium: 'razonamiento medio',
  high: 'razonamiento alto',
  xhigh: 'razonamiento muy alto',
  max: 'razonamiento máximo',
};

function thinkingLevelEs(level) {
  return THINKING_LEVEL_ES[String(level || '').toLowerCase()] || '';
}

/**
 * The reasoning level a provider payload really carries, for the model row:
 * 'disabled' when thinking was turned off, the level when an explicit
 * (composer) level set a reasoning knob, else null — the default level is
 * never claimed, nor a level a model without a knob silently ignored.
 */
function effectiveThinkingLevel(payload, { level = null, disabled = false, explicit = false } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const thinking = p.thinking && typeof p.thinking === 'object' ? p.thinking : null;
  if (disabled || (thinking && thinking.type === 'disabled')) return 'disabled';
  if (!explicit || !level) return null;
  const knob = Boolean(p.reasoning_effort)
    || Boolean(p.reasoning && typeof p.reasoning === 'object' && p.reasoning.effort)
    || Boolean(thinking && thinking.type)
    || Boolean(p.output_config && typeof p.output_config === 'object' && p.output_config.effort);
  return knob ? String(level) : null;
}

/**
 * Why a model attempt failed, in Spanish, from a category — never from the
 * provider's own error text.
 */
function errorCategoryEs(category, { timeoutMs = null, retryAfterSeconds = null } = {}) {
  const secs = Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs) / 1000) : null;
  const wait = Number(retryAfterSeconds) > 0 ? Math.ceil(Number(retryAfterSeconds)) : null;
  switch (String(category || '').toLowerCase()) {
    case 'timeout':
    case 'first_byte_timeout':
      return secs ? `no respondió en ${secs} s` : 'no respondió a tiempo';
    case 'billing':
    case 'unfunded_memo':
    case 'quota_exhausted':
      return 'no tiene saldo en su proveedor';
    case 'auth':
      return 'su proveedor rechazó la clave';
    case 'forbidden':
      return 'su proveedor no permite usarlo ahora';
    case 'rate_limit':
      return wait ? `alcanzó el límite por minuto · espera ${wait} s` : 'alcanzó el límite de solicitudes por minuto';
    case 'overloaded':
      return 'está saturado';
    case 'network':
      return 'conexión interrumpida';
    case 'unavailable':
    case 'provider_unavailable':
      return 'no está respondiendo ahora';
    case 'breaker':
      return 'en pausa tras varios fallos seguidos';
    case 'unconfigured':
      return 'no está configurado';
    case 'reservation':
      return 'no tiene saldo suficiente para una respuesta de este tamaño';
    case 'empty':
      return 'devolvió una respuesta vacía';
    case 'bad_request':
      return 'rechazó la solicitud';
    default:
      return 'no pudo responder';
  }
}

/**
 * The failure as a sentence whose subject is the model: «DeepSeek V4 Pro no
 * tiene saldo en su proveedor», «El proveedor de Gemini 2.5 Flash rechazó la
 * clave», «Kimi K2.6 perdió la conexión». `name` is a display name.
 */
function modelFailureText(name, category, opts = {}) {
  const subject = capitalize(String(name || GENERIC_MODEL_LABEL));
  switch (String(category || '').toLowerCase()) {
    case 'auth':
      return `El proveedor de ${name || GENERIC_MODEL_LABEL} rechazó la clave`;
    case 'forbidden':
      return `El proveedor de ${name || GENERIC_MODEL_LABEL} no permite usarlo ahora`;
    case 'network':
      return `${subject} perdió la conexión`;
    case 'breaker':
      return `${subject} está en pausa tras varios fallos seguidos`;
    default:
      return `${subject} ${errorCategoryEs(category, opts)}`;
  }
}

/** Cause in parentheses of «X no pudo responder (sin saldo)»; '' when unknown. */
function failedCauseEs(category) {
  switch (String(category || '').toLowerCase()) {
    case 'billing':
    case 'unfunded_memo':
    case 'quota_exhausted':
      return 'sin saldo';
    case 'auth': return 'clave rechazada';
    case 'forbidden': return 'acceso denegado';
    case 'rate_limit': return 'límite por minuto';
    case 'timeout':
    case 'first_byte_timeout':
      return 'sin respuesta a tiempo';
    case 'unavailable':
    case 'provider_unavailable':
      return 'sin respuesta';
    case 'overloaded': return 'saturado';
    case 'network': return 'conexión interrumpida';
    case 'breaker': return 'en pausa tras varios fallos';
    case 'unconfigured': return 'no configurado';
    case 'reservation': return 'saldo insuficiente para esta respuesta';
    case 'bad_request': return 'rechazó la solicitud';
    case 'empty': return 'respuesta vacía';
    default: return '';
  }
}

/**
 * Category of a failed model call — the cause the user is told (sin saldo,
 * clave rechazada, límite por minuto, no responde…), never the provider's own
 * error text. Shared by the plain stream (ai-service) and the agentic loop
 * (react-agent). `classified` is a litellm-gateway classifyProviderError
 * result when the caller already has one.
 */
function failureCategoryOf(err, { timedOut = false, classified = null } = {}) {
  if (timedOut) return 'timeout';
  if (!err) return 'unknown';
  if (typeof err.siraFailureReason === 'string' && err.siraFailureReason) return err.siraFailureReason;
  if (err.code === 'EMPTY_COMPLETION') return 'empty';
  if (err.code === 'TIMEOUT') return 'timeout';
  if (err.name === 'CircuitBreakerError') return 'breaker';
  let cause = null;
  try { cause = require('./ai/billing-failover').failureCauseFor(err); } catch (_) { cause = null; }
  if (cause === 'unfunded_memo') return 'billing';
  if (cause) return cause;
  let cls = classified;
  if (!cls) {
    try { cls = require('./ai-product-os/litellm-gateway').classifyProviderError(err); } catch (_) { cls = null; }
  }
  switch (cls && cls.error_class) {
    case 'timeout': return 'timeout';
    case 'bad_request': return 'bad_request';
    case 'provider_unavailable': return 'unavailable';
    case 'rate_limit': return 'rate_limit';
    case 'quota_exhausted': return 'billing';
    case 'auth': return 'auth';
    default: return 'unknown';
  }
}

/** Seconds a per-minute limit asks to wait (Retry-After), or null. */
function retryAfterSecondsOf(err) {
  if (err && Number(err.siraRetryAfterSeconds) > 0) return Math.ceil(Number(err.siraRetryAfterSeconds));
  try {
    const ms = require('./ai/billing-failover').retryAfterMs(err);
    return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : null;
  } catch (_) {
    return null;
  }
}

/** Short cause for «X no disponible (sin saldo)». */
function shortCauseEs(category) {
  switch (String(category || '').toLowerCase()) {
    case 'billing':
    case 'unfunded_memo':
    case 'quota_exhausted':
      return 'sin saldo';
    case 'auth': return 'clave rechazada';
    case 'forbidden': return 'acceso denegado';
    case 'rate_limit': return 'límite por minuto';
    case 'timeout': return 'no responde';
    case 'unavailable':
    case 'provider_unavailable':
    case 'breaker':
    case 'overloaded':
    case 'network':
      return 'no responde';
    case 'unconfigured': return 'no configurado';
    case 'reservation': return 'saldo insuficiente';
    default: return '';
  }
}

/** «Buscando en la web · “precio del cobre 2026”» (query ≤ 60 chars). */
function webLabel(query) {
  const q = cleanText(query, 60).replace(/[“”"]/g, '');
  return q ? `Buscando en la web · “${q}”` : 'Buscando en la web';
}

function domainOf(source) {
  if (!source) return '';
  const explicit = typeof source.domain === 'string' ? source.domain.trim() : '';
  if (explicit) return explicit.replace(/^www\./i, '').toLowerCase();
  try { return new URL(String(source.url || '')).hostname.replace(/^www\./i, '').toLowerCase(); } catch (_) { return ''; }
}

/** «12 fuentes · reuters.com, bbc.com, elpais.com» (top 3 distinct domains). */
function sourcesNote(sources) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!list.length) return '';
  const domains = [];
  for (const source of list) {
    const d = domainOf(source);
    if (d && !domains.includes(d)) domains.push(d);
    if (domains.length >= 3) break;
  }
  const head = plural(list.length, 'fuente', 'fuentes');
  return cleanText(domains.length ? `${head} · ${domains.join(', ')}` : head, MAX_DETAIL);
}

const QUALITY_REASON_ES = {
  too_short: 'la primera versión fue corta',
  short: 'la primera versión fue corta',
  refusal: 'la primera versión se negó a responder',
  empty: 'la primera versión llegó vacía',
  punctuation_only: 'la primera versión llegó vacía',
  thin: 'la primera versión fue superficial',
};

/**
 * Spanish label of a structured ai-service progress event (A.4). `label` is
 * the display name of the event's model (already resolved). Pure.
 */
function modelEventLabel(ev, label = GENERIC_MODEL_LABEL) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const name = String(label || GENERIC_MODEL_LABEL);
  switch (e.type) {
    case 'summarize_history':
      return `Resumiendo ${plural(e.messages, 'mensaje antiguo', 'mensajes antiguos')} para que quepan en el contexto`;
    case 'attempt_start':
      return Number(e.attempt) > 1
        ? `Reintentando con ${name} · intento ${fmtInt(e.attempt)} de ${fmtInt(e.maxAttempts || e.attempt)}`
        : `Conectando con ${name}`;
    case 'first_byte':
      return e.kind === 'reasoning'
        ? `${capitalize(name)} empezó a razonar · ${fmtMs(e.ms)}`
        : `${capitalize(name)} respondió · ${fmtMs(e.ms)}`;
    case 'attempt_failed': {
      const why = modelFailureText(name, e.category, { timeoutMs: e.timeoutMs, retryAfterSeconds: e.retryAfterSeconds });
      const retry = e.willRetry && Number(e.maxAttempts) > Number(e.attempt)
        ? ` · reintento ${fmtInt(Number(e.attempt) + 1)} de ${fmtInt(e.maxAttempts)}`
        : '';
      return `${why}${retry}`;
    }
    case 'failover': {
      // «no disponible» only for causes about the provider (no credit, key,
      // limit, no answer…); a rejected request or an empty answer says so.
      const reason = String(e.reason || '').toLowerCase();
      if (['bad_request', 'empty'].includes(reason) || !shortCauseEs(reason)) {
        const cause = failedCauseEs(reason);
        return cause ? `${capitalize(name)} no pudo responder (${cause})` : `${capitalize(name)} no pudo responder`;
      }
      return `${capitalize(name)} no disponible (${shortCauseEs(reason)})`;
    }
    case 'failed': {
      const cause = failedCauseEs(e.category);
      return cause ? `${capitalize(name)} no pudo responder (${cause})` : `${capitalize(name)} no pudo responder`;
    }
    case 'quality_pass': {
      const why = QUALITY_REASON_ES[String(e.reason || '').toLowerCase()];
      return why ? `Mejorando la respuesta (${why})` : 'Mejorando la respuesta';
    }
    default:
      return '';
  }
}

// ─── Pipeline phase helpers (route call sites pass raw facts) ────────────

function fileNameOf(file) {
  if (!file || typeof file !== 'object') return '';
  return cleanText(file.originalName || file.name || file.filename || '', 60);
}

function isImageFile(file) {
  const mime = String((file && (file.mimeType || file.type)) || '').toLowerCase();
  return mime.startsWith('image/') || (file && file.attachmentKind === 'image');
}

// Word counts run on the request path for every attachment (50 × 1 MB is a
// legal upload): scan at most this many characters per text, without
// allocating, and extrapolate the rest («~N palabras»).
const WORD_COUNT_SCAN_CHARS = 100_000;

function isSpaceCode(c) {
  // Exactly the characters `\s` matches.
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
    || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** { words, approx } — exact up to `maxChars`, extrapolated beyond. */
function countWordsBounded(text, maxChars = WORD_COUNT_SCAN_CHARS) {
  const s = typeof text === 'string' ? text : String(text || '');
  const len = s.length;
  const end = Math.min(len, Math.max(1, Number(maxChars) || WORD_COUNT_SCAN_CHARS));
  let words = 0;
  let inWord = false;
  for (let i = 0; i < end; i += 1) {
    if (isSpaceCode(s.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; words += 1; }
  }
  if (end >= len) return { words, approx: false };
  return { words: Math.round(words * (len / end)), approx: true };
}

function countWords(text) {
  return countWordsBounded(text).words;
}

/**
 * «Leyendo «contrato.pdf»» · «Leyendo 3 archivos: contrato.pdf, anexo.xlsx +1»
 * — the user's own file names; a generic line while only ids are known.
 */
function attachmentsLabel(files, { recovered = false } = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const names = list.map(fileNameOf).filter(Boolean);
  const n = list.length;
  if (recovered) {
    if (n === 1 && names[0]) return `Recuperando «${names[0]}» de un mensaje anterior`;
    return n > 1 ? `Recuperando ${fmtInt(n)} documentos de esta conversación` : 'Recuperando el documento de esta conversación';
  }
  if (n === 1) return names[0] ? `Leyendo «${names[0]}»` : 'Leyendo el archivo adjunto';
  if (!names.length) return `Leyendo ${fmtInt(n)} archivos adjuntos`;
  const shown = names.slice(0, 2).join(', ');
  const rest = n - Math.min(2, names.length);
  return `Leyendo ${fmtInt(n)} archivos: ${shown}${rest > 0 ? ` +${rest}` : ''}`;
}

/** «2 documentos · 18.200 palabras · 1 imagen» from the loaded files. */
function attachmentsNote(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const images = list.filter(isImageFile).length;
  const docs = list.length - images;
  let words = 0;
  let approx = false;
  for (const f of list) {
    if (isImageFile(f)) continue;
    const counted = countWordsBounded(f.extractedText);
    words += counted.words;
    approx = approx || counted.approx;
  }
  const parts = [];
  if (docs > 0) parts.push(plural(docs, 'documento', 'documentos'));
  if (docs > 0 && words > 0) parts.push(`${approx ? '~' : ''}${plural(words, 'palabra', 'palabras')}`);
  if (images > 0) parts.push(plural(images, 'imagen', 'imágenes'));
  return parts.join(' · ');
}

/** chat-attachment-recovery `onProgress` → the attachments row. */
function attachmentExtractSink(handle) {
  return (ev) => {
    try {
      if (!handle || !handle.open || !ev || typeof ev !== 'object') return;
      const name = cleanText(ev.file, 60);
      if (ev.type === 'extract_wait') {
        handle.update({ label: name ? `Esperando que termine la extracción de «${name}»` : 'Esperando que termine la extracción del texto' });
      } else if (ev.type === 'extract_start') {
        handle.update({ label: name ? `Extrayendo el texto de «${name}»` : 'Extrayendo el texto del archivo' });
      } else if (ev.type === 'extract_done' && Number(ev.words) > 0) {
        handle.update({ detail: `${name ? `«${name}» · ` : ''}${ev.approx ? '~' : ''}${plural(ev.words, 'palabra', 'palabras')}` });
      }
    } catch (_) { /* advisory */ }
  };
}

/**
 * operational-runtime `onProgress` → a lazily begun `rag` row: a turn whose
 * documents need no retrieval shows nothing. `finish(context, { error })`
 * settles it with what really happened.
 */
function ragProgressSink(progress) {
  let handle = null;
  let retrieveStarted = false;
  let retrieveDone = null;
  let filtered = null;
  const ensure = (label) => {
    if (!handle) handle = progress.begin('rag', label, { tool: 'rag_retrieve', kind: 'search' });
    else handle.update({ label });
  };
  const onProgress = (ev) => {
    try {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'index_start': {
          const name = cleanText(ev.file, 60);
          ensure(Number(ev.files) === 1 && name ? `Indexando «${name}»` : `Indexando ${plural(ev.files, 'documento', 'documentos')}`);
          return;
        }
        case 'index_done':
          if (handle && Number(ev.chunksAdded) > 0) handle.update({ detail: `${plural(ev.chunksAdded, 'fragmento nuevo', 'fragmentos nuevos')}` });
          return;
        case 'graph_start':
          ensure('Construyendo el mapa de entidades');
          return;
        case 'retrieve_start':
          retrieveStarted = true;
          ensure('Buscando los pasajes relevantes');
          if (Number(ev.docs) > 0) handle.update({ detail: `en ${plural(ev.docs, 'documento', 'documentos')}` });
          return;
        case 'retrieve_done':
          retrieveDone = { hits: Number(ev.hits) || 0, totalChunks: Number(ev.totalChunks) || 0, docs: Number(ev.docs) || 0 };
          return;
        case 'graph_query':
          ensure('Consultando el mapa de entidades');
          return;
        default:
      }
    } catch (_) { /* advisory */ }
  };
  const noteFiltering = () => { if (handle && handle.open) handle.update({ label: 'Filtrando los pasajes pertinentes' }); };
  const noteFiltered = (before, after) => { filtered = { before: Number(before) || 0, after: Number(after) || 0 }; };
  const finish = (context, { error = null } = {}) => {
    try {
      if (!handle || !handle.open) return;
      if (error || (retrieveStarted && !retrieveDone)) {
        handle.fail('No pude consultar tus documentos', { detail: '' });
        return;
      }
      const hits = Array.isArray(context && context.hits) ? context.hits.length : (retrieveDone ? retrieveDone.hits : 0);
      if (!hits) {
        handle.done(retrieveStarted ? 'Ningún pasaje relevante en tus documentos' : 'Documentos indexados', {});
        return;
      }
      const docs = retrieveDone && retrieveDone.docs ? retrieveDone.docs : (Array.isArray(context && context.docs) ? context.docs.length : 0);
      const total = retrieveDone ? retrieveDone.totalChunks : 0;
      const parts = [];
      if (filtered && filtered.after < filtered.before) {
        parts.push(`${fmtInt(filtered.before)} → ${plural(filtered.after, 'pasaje pertinente', 'pasajes pertinentes')}`);
      } else if (total > hits) {
        parts.push(`${fmtInt(hits)} de ${plural(total, 'fragmento', 'fragmentos')}`);
      } else {
        parts.push(plural(hits, 'pasaje', 'pasajes'));
      }
      if (docs > 0) parts.push(plural(docs, 'documento', 'documentos'));
      handle.done('Pasajes relevantes encontrados', {
        detail: parts.join(' · '),
        meta: { hits, ...(total ? { chunks: total } : {}) },
      });
    } catch (_) { /* advisory */ }
  };
  return {
    onProgress,
    noteFiltering,
    noteFiltered,
    finish,
    get handle() { return handle; },
  };
}

const DIFFICULTY_ES = {
  trivial: 'pregunta breve',
  simple: 'tarea simple',
  moderate: 'dificultad media',
  complex: 'tarea compleja',
};

function difficultyEs(bucket) {
  return DIFFICULTY_ES[String(bucket || '').toLowerCase()] || '';
}

const DOC_TYPE_ES = {
  invoice: 'factura',
  legal_contract: 'contrato',
  cv_resume: 'currículum',
  academic_paper: 'artículo académico',
  financial_statement: 'estado financiero',
  medical_clinical: 'documento clínico',
  technical_spec: 'especificación técnica',
  business_report: 'informe de negocio',
  spreadsheet_data: 'hoja de datos',
  presentation_slides: 'presentación',
  email_message: 'correo',
  book_literature: 'libro',
  image_document: 'documento escaneado',
  source_code: 'código fuente',
  configuration_file: 'archivo de configuración',
  log_file: 'registro (log)',
  meeting_transcript: 'transcripción de reunión',
  regulatory_compliance: 'documento regulatorio',
  research_proposal: 'propuesta de investigación',
  patent: 'patente',
  employment_contract: 'contrato laboral',
  bank_statement: 'extracto bancario',
  insurance_policy: 'póliza de seguro',
  incident_postmortem: 'informe de incidente',
  pitch_deck: 'presentación para inversionistas',
};

function docTypeEs(type) {
  return DOC_TYPE_ES[String(type || '')] || '';
}

// ─── The per-turn emitter ────────────────────────────────────────────────

const NOOP_HANDLE = Object.freeze({
  stageId: null,
  phase: null,
  update() {},
  done() {},
  fail() {},
  get open() { return false; },
});

function createTurnProgress({
  emitStage,
  protocol = 1,
  canWriteProgress = () => true,
  collector = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  env = process.env,
  log = null,
} = {}) {
  const killed = killSwitchOn(env);
  const proto = !killed && Number(protocol) === 2 ? 2 : 1;
  const emit = typeof emitStage === 'function' ? emitStage : () => {};
  const clock = typeof now === 'function' ? now : Date.now;
  const open = new Map();
  const pendingProgress = new Map();
  const recentProgress = [];
  let counter = 0;
  let begins = 0;
  let capLogged = false;
  let disposed = false;
  let flushTimer = null;
  let flushDueAt = 0;
  const persistedPhases = new Set();
  let persistedError = false;

  function safeNow() {
    try { const t = Number(clock()); return Number.isFinite(t) ? t : Date.now(); } catch (_) { return Date.now(); }
  }

  function send(label, extra, { persist }) {
    const frame = { type: 'stage', label, ...extra };
    if (persist && collector && typeof collector.push === 'function') {
      persistedPhases.add(extra.phase);
      if (extra.status === 'error') persistedError = true;
      try { collector.push(frame); } catch (_) { /* the trace never breaks the turn */ }
    }
    try {
      if (proto === 2) emit(label, extra);
      else if (extra.step === 'tool_call') emit(label, { tool: extra.tool });
    } catch (_) { /* emitStage already swallows socket errors */ }
  }

  function frameFor(state, step, status) {
    const extra = {
      tool: state.tool,
      phase: state.phase,
      stageId: state.stageId,
      step,
      status,
    };
    if (step === 'tool_call' && state.kind) extra.kind = state.kind;
    if (state.detail) extra.detail = state.detail;
    if (state.meta) extra.meta = { ...state.meta };
    return extra;
  }

  function pruneWindow(t) {
    while (recentProgress.length && t - recentProgress[0] >= GLOBAL_PROGRESS_WINDOW_MS) recentProgress.shift();
  }

  function armFlush(dueAt) {
    if (disposed) return;
    if (flushTimer && flushDueAt <= dueAt) return;
    if (flushTimer) { try { clearTimer(flushTimer); } catch (_) { /* noop */ } }
    flushDueAt = dueAt;
    const delay = Math.max(1, dueAt - safeNow());
    try {
      flushTimer = setTimer(() => {
        flushTimer = null;
        flushDueAt = 0;
        flushProgress();
      }, delay);
      if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
    } catch (_) { flushTimer = null; }
  }

  function flushProgress() {
    if (disposed || proto !== 2) { pendingProgress.clear(); return; }
    const t = safeNow();
    pruneWindow(t);
    let nextDue = Infinity;
    for (const [stageId, state] of pendingProgress) {
      if (!state.open) { pendingProgress.delete(stageId); continue; }
      const handleDue = state.lastProgressAt + PROGRESS_MIN_INTERVAL_MS;
      if (t < handleDue) { nextDue = Math.min(nextDue, handleDue); continue; }
      if (recentProgress.length >= GLOBAL_PROGRESS_PER_WINDOW) {
        nextDue = Math.min(nextDue, recentProgress[0] + GLOBAL_PROGRESS_WINDOW_MS);
        continue;
      }
      pendingProgress.delete(stageId);
      let writable = true;
      try { writable = canWriteProgress() !== false; } catch (_) { writable = true; }
      // Backpressure: a progress frame is advisory — drop it, never queue.
      if (!writable) continue;
      state.lastProgressAt = t;
      recentProgress.push(t);
      send(state.label, frameFor(state, 'tool_progress', 'running'), { persist: false });
    }
    if (pendingProgress.size && Number.isFinite(nextDue)) armFlush(nextDue);
  }

  function settle(state, status, label, opts = {}) {
    if (!state.open || disposed) return;
    state.open = false;
    open.delete(state.stageId);
    pendingProgress.delete(state.stageId);
    const nextLabel = cleanText(label, MAX_LABEL);
    if (nextLabel) state.label = nextLabel;
    if (opts.detail !== undefined) state.detail = cleanText(opts.detail, MAX_DETAIL);
    else if (status === 'error' && opts.category) state.detail = cleanText(capitalize(errorCategoryEs(opts.category)), MAX_DETAIL);
    if (opts.meta !== undefined) state.meta = cleanMeta(opts.meta);
    const extra = frameFor(state, 'tool_result', status);
    extra.ok = status !== 'error';
    if (!state.instant) extra.elapsedMs = Math.max(0, Math.round(safeNow() - state.startedAt));
    send(state.label, extra, { persist: true });
  }

  function makeHandle(state) {
    return {
      get stageId() { return state.stageId; },
      get phase() { return state.phase; },
      get open() { return state.open && !disposed; },
      update({ label, detail, meta } = {}) {
        if (!state.open || disposed) return;
        let changed = false;
        const nextLabel = cleanText(label, MAX_LABEL);
        if (nextLabel && nextLabel !== state.label) { state.label = nextLabel; changed = true; }
        if (detail !== undefined) {
          const nextDetail = cleanText(detail, MAX_DETAIL);
          if (nextDetail !== state.detail) { state.detail = nextDetail; changed = true; }
        }
        if (meta !== undefined) {
          const nextMeta = cleanMeta(meta);
          if (JSON.stringify(nextMeta) !== JSON.stringify(state.meta)) { state.meta = nextMeta; changed = true; }
        }
        if (!changed || proto !== 2) return;
        pendingProgress.set(state.stageId, state);
        flushProgress();
      },
      done(label, opts = {}) {
        try { settle(state, 'done', label, opts || {}); } catch (_) { /* never throws */ }
      },
      fail(label, opts = {}) {
        try { settle(state, 'error', label, opts || {}); } catch (_) { /* never throws */ }
      },
    };
  }

  function begin(phase, label, { tool, kind, detail, meta } = {}) {
    try {
      if (disposed) return NOOP_HANDLE;
      const cleanPhaseId = cleanPhase(phase);
      if (killed && !LEGACY_PHASES.has(cleanPhaseId)) return NOOP_HANDLE;
      const text = cleanText(label, MAX_LABEL);
      if (!text) return NOOP_HANDLE;
      if (begins >= MAX_BEGINS_PER_TURN) {
        if (!capLogged) {
          capLogged = true;
          try { (log && typeof log.warn === 'function' ? log.warn : console.warn)(`[turn-progress] more than ${MAX_BEGINS_PER_TURN} phases in one turn; later phases are not announced`); } catch (_) { /* noop */ }
        }
        return NOOP_HANDLE;
      }
      begins += 1;
      counter += 1;
      const state = {
        stageId: `pipe:${cleanPhaseId}:${counter}`,
        phase: cleanPhaseId,
        tool: cleanTool(tool),
        kind: KINDS.has(String(kind || '')) ? String(kind) : null,
        label: text,
        detail: cleanText(detail, MAX_DETAIL),
        meta: cleanMeta(meta),
        startedAt: safeNow(),
        lastProgressAt: -Infinity,
        open: true,
        instant: false,
      };
      open.set(state.stageId, state);
      send(state.label, frameFor(state, 'tool_call', 'running'), { persist: true });
      return makeHandle(state);
    } catch (_) {
      return NOOP_HANDLE;
    }
  }

  /**
   * An instant fact («Contexto listo · ~12.400 tokens»): one settled row, no
   * duration. Protocol 1 gets a plain begin frame.
   */
  function note(phase, label, { tool, kind, detail, meta, ok = true } = {}) {
    try {
      if (disposed) return;
      const cleanPhaseId = cleanPhase(phase);
      if (killed && !LEGACY_PHASES.has(cleanPhaseId)) return;
      const text = cleanText(label, MAX_LABEL);
      if (!text) return;
      if (begins >= MAX_BEGINS_PER_TURN) return;
      begins += 1;
      counter += 1;
      const state = {
        stageId: `pipe:${cleanPhaseId}:${counter}`,
        phase: cleanPhaseId,
        tool: cleanTool(tool),
        kind: KINDS.has(String(kind || '')) ? String(kind) : null,
        label: text,
        detail: cleanText(detail, MAX_DETAIL),
        meta: cleanMeta(meta),
        startedAt: safeNow(),
        lastProgressAt: -Infinity,
        open: true,
        instant: true,
      };
      if (proto !== 2) {
        send(state.label, frameFor(state, 'tool_call', 'running'), { persist: false });
      }
      // The persisted / v2 frame: one settled row.
      settle(state, ok === false ? 'error' : 'done', null, {});
    } catch (_) { /* never throws */ }
  }

  /** The newest open row of a phase (or null). */
  function openHandle(phase) {
    const wanted = cleanPhase(phase);
    let found = null;
    for (const state of open.values()) if (state.phase === wanted) found = state;
    return found ? makeHandle(found) : null;
  }

  /** Settle every open row with its current label (before a hand-off). */
  function settleAll() {
    for (const state of Array.from(open.values())) {
      try { settle(state, 'done', null, {}); } catch (_) { /* never throws */ }
    }
  }

  /**
   * Sink for aiService.generateStream `onProgress` events (A.4): the model
   * phase and its satellites (history summary, vision prep, quality pass).
   */
  function modelSink(ctx = {}) {
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    let modelHandle = null;
    let historyHandle = null;
    let visionHandle = null;
    let postHandle = null;
    let currentModel = null;
    // Images that really reach the model (vision_ready), for the model note.
    let imageCount = 0;
    let visionRequested = 0;
    let visionName = '';
    let visionSwitchText = '';
    // The reasoning level the provider really received, from attempt_start
    // (`thinking`); the route's ctx.thinkingLevel only for events without it.
    let effectiveThinking = null;
    let thinkingReported = false;
    // An attempt failure told as its own row after the model row closed
    // (reasoning started, then the attempt failed): «failed» adds no twin.
    let failureNoted = false;
    // The caller's display name for its model: a name, never an id or a
    // transport (same filter as displayNameFor).
    const givenLabel = cleanText(context.modelLabel, 40);
    const contextLabel = givenLabel && !/openrouter/i.test(givenLabel) && !givenLabel.includes('/') ? givenLabel : '';
    const labelFor = (id) => {
      if (id && contextLabel && context.modelId && foldId(id) === foldId(context.modelId)) return contextLabel;
      return modelLabel(id);
    };
    const contextNote = () => {
      const parts = [];
      const tokens = Number(context.contextTokens);
      if (Number.isFinite(tokens) && tokens > 0) parts.push(`contexto ~${fmtInt(tokens)} tokens`);
      // Only the level the provider really received (the user's composer
      // «Esfuerzo», or disabled on a trivial turn): the default is not
      // claimed for models that may not reason at all.
      const level = thinkingLevelEs(thinkingReported ? effectiveThinking : context.thinkingLevel);
      if (level) parts.push(level);
      if (imageCount > 0) parts.push(plural(imageCount, 'imagen', 'imágenes'));
      return parts.join(' · ');
    };
    const visionRow = () => (visionHandle && visionHandle.open ? visionHandle : openHandle('vision'));
    const settleSatellites = ({ failed = false } = {}) => {
      if (historyHandle && historyHandle.open) historyHandle.done();
      const vision = visionRow();
      // Without a vision_ready the row keeps its own «Preparando…» label: it
      // never claims the image reached the model.
      if (vision) {
        if (failed) vision.fail('La imagen no llegó al modelo', { detail: '' });
        else vision.done();
      }
    };
    const legacyModelBegin = (label) => {
      // Protocol 1 shows begin frames only: a stale tab would otherwise keep
      // «Conectando con X» while X is already reasoning.
      if (proto === 2 || disposed) return;
      try { emit(cleanText(label, MAX_LABEL), { tool: 'model' }); } catch (_) { /* emitStage swallows */ }
    };
    return function onModelProgress(ev) {
      try {
        if (!ev || typeof ev !== 'object' || disposed) return;
        switch (ev.type) {
          case 'summarize_history':
            historyHandle = begin('history', modelEventLabel(ev), {
              tool: 'compact',
              meta: { chunks: Number(ev.messages) || 0 },
            });
            return;
          case 'summarize_done':
            if (historyHandle && historyHandle.open) {
              if (ev.applied) {
                historyHandle.done('Mensajes antiguos resumidos');
              } else if (/error|failed|empty_summary/.test(String(ev.reason || ''))) {
                historyHandle.fail('No se pudieron resumir los mensajes antiguos', { detail: 'Se omitieron del contexto' });
              } else {
                historyHandle.done('Los mensajes antiguos se omitieron sin resumen');
              }
            }
            return;
          case 'vision_prep': {
            visionRequested = Math.max(0, Number(ev.files) || 0);
            imageCount = 0;
            visionName = cleanText(ev.name, 40);
            const detail = visionRequested === 1 && visionName
              ? `Preparando «${visionName}» para el modelo`
              : `Preparando ${plural(visionRequested, 'imagen', 'imágenes')} para el modelo`;
            visionHandle = openHandle('vision');
            if (visionHandle) visionHandle.update({ detail, meta: { files: visionRequested } });
            else visionHandle = begin('vision', detail, { tool: 'vision', meta: { files: visionRequested } });
            return;
          }
          case 'vision_switch': {
            const from = labelFor(ev.from);
            const to = displayNameFor(ev.to);
            const text = to
              ? `${from === GENERIC_MODEL_LABEL ? 'El modelo elegido' : from} no ve imágenes: las lee ${to}`
              : `${from === GENERIC_MODEL_LABEL ? 'El modelo elegido' : from} no ve imágenes: las lee un modelo con visión`;
            visionSwitchText = text;
            if (visionHandle && visionHandle.open) visionHandle.update({ detail: text });
            else note('vision', text, { tool: 'vision' });
            return;
          }
          case 'vision_ready': {
            // What really reached the model: loaded images, or none (every
            // load failed / the model takes no images and they were removed).
            const requested = Math.max(0, Number(ev.requested) || visionRequested || 0);
            const loaded = Math.max(0, Number(ev.loaded) || 0);
            const stripped = Math.max(0, Number(ev.stripped) || 0);
            const failedName = cleanText(ev.failedName, 40);
            imageCount = stripped > 0 ? 0 : loaded;
            let status = 'done';
            let label;
            let detail = '';
            if (loaded === 0) {
              status = 'error';
              if (requested <= 1) label = failedName || visionName ? `No pude cargar «${failedName || visionName}»` : 'No pude cargar la imagen';
              else label = `No pude cargar ninguna de las ${fmtInt(requested)} imágenes`;
              detail = 'La respuesta usa solo tu texto';
            } else if (stripped > 0) {
              status = 'error';
              const name = labelFor(ev.model);
              label = `${name === GENERIC_MODEL_LABEL ? 'El modelo' : name} no recibe imágenes: respondo con tu texto`;
            } else if (requested > loaded) {
              label = `${fmtInt(loaded)} de ${fmtInt(requested)} imágenes listas para el modelo`;
              detail = failedName ? `No pude cargar «${failedName}»` : '';
            } else {
              label = loaded > 1 ? `${fmtInt(loaded)} imágenes listas para el modelo` : 'Imagen lista para el modelo';
              detail = visionSwitchText || (loaded === 1 && visionName ? `«${visionName}»` : '');
            }
            const meta = { files: imageCount };
            const row = visionRow();
            if (row) {
              if (status === 'error') row.fail(label, { detail, meta });
              else row.done(label, { detail, meta });
            } else {
              note('vision', label, { tool: 'vision', detail, meta, ok: status !== 'error' });
            }
            visionHandle = null;
            return;
          }
          case 'attempt_start': {
            settleSatellites();
            failureNoted = false;
            if (Object.prototype.hasOwnProperty.call(ev, 'thinking')) {
              thinkingReported = true;
              effectiveThinking = ev.thinking || null;
            }
            const label = labelFor(ev.model);
            const meta = { attempt: Number(ev.attempt) || 1, maxAttempts: Number(ev.maxAttempts) || 1 };
            const tokens = Number(context.contextTokens);
            if (Number.isFinite(tokens) && tokens > 0) meta.tokens = tokens;
            if (modelHandle && modelHandle.open && currentModel === ev.model) {
              // The same model's row (opened by a failover, or a retry):
              // update it in place — nothing failed.
              modelHandle.update({ label: modelEventLabel(ev, label), detail: contextNote(), meta });
            } else {
              // A different model starts while another's row is open: that
              // one could not answer.
              if (modelHandle && modelHandle.open) modelHandle.fail();
              currentModel = ev.model;
              modelHandle = begin('model', modelEventLabel(ev, label), {
                tool: 'model',
                detail: contextNote(),
                meta,
              });
            }
            return;
          }
          case 'waiting': {
            if (!modelHandle || !modelHandle.open) return;
            const waited = Number(ev.waitedMs) || 0;
            const limitSecs = Number(ev.timeoutMs) > 0 ? Math.round(Number(ev.timeoutMs) / 1000) : null;
            let detail;
            if (waited < 20000) {
              const tokens = Number(context.contextTokens);
              detail = Number.isFinite(tokens) && tokens > 0
                ? `Sin respuesta todavía · procesando ~${fmtInt(tokens)} tokens de contexto`
                : `Sin respuesta todavía · ${fmtMs(waited)}`;
            } else if (limitSecs) {
              const next = ev.nextModel ? displayNameFor(ev.nextModel) : '';
              if (ev.retrySameModel === true || (ev.retrySameModel === undefined && ev.nextModel === undefined && ev.willRetry)) {
                detail = `Tarda más de lo habitual · reintento automático a los ${limitSecs} s`;
              } else if (ev.nextModel) {
                detail = `Tarda más de lo habitual · a los ${limitSecs} s pruebo con ${next || 'otro modelo'}`;
              } else {
                detail = `Tarda más de lo habitual · límite de espera ${limitSecs} s`;
              }
            } else {
              detail = 'Tarda más de lo habitual';
            }
            modelHandle.update({ detail });
            return;
          }
          case 'first_byte': {
            const name = labelFor(ev.model);
            if (modelHandle && modelHandle.open) {
              modelHandle.done(modelEventLabel(ev, name), { detail: contextNote() });
            }
            if (ev.kind === 'reasoning') legacyModelBegin(`${capitalize(name)} está razonando`);
            return;
          }
          case 'attempt_failed': {
            const label = modelEventLabel(ev, labelFor(ev.model));
            if (modelHandle && modelHandle.open) {
              modelHandle.update({ label });
            } else {
              // The row already closed (the model had started reasoning):
              // the failure is its own row, so a retry never looks causeless.
              note('model', label, { tool: 'model', ok: false });
              failureNoted = true;
            }
            return;
          }
          case 'failover': {
            const fromLabel = labelFor(ev.from);
            const failLabel = modelEventLabel(ev, fromLabel);
            if (modelHandle && modelHandle.open) modelHandle.fail(failLabel, { detail: '' });
            else if (!failureNoted) note('model', failLabel, { tool: 'model', ok: false });
            failureNoted = false;
            currentModel = ev.to;
            modelHandle = begin('model', `Conectando con ${labelFor(ev.to)}`, { tool: 'model', detail: contextNote() });
            return;
          }
          case 'failed': {
            settleSatellites({ failed: true });
            const label = modelEventLabel(ev, labelFor(ev.model || currentModel));
            const detail = capitalize(errorCategoryEs(ev.category, { retryAfterSeconds: ev.retryAfterSeconds }));
            if (modelHandle && modelHandle.open) modelHandle.fail(label, { detail });
            else if (!failureNoted) note('model', label, { tool: 'model', detail, ok: false });
            failureNoted = true;
            return;
          }
          case 'quality_pass':
            if (postHandle && postHandle.open) return;
            postHandle = begin('post', modelEventLabel(ev), { tool: 'verify' });
            return;
          case 'quality_done':
            if (postHandle && postHandle.open) {
              postHandle.done(ev.replaced ? 'Respuesta mejorada' : 'Se mantuvo la primera versión');
            }
            return;
          default:
        }
      } catch (_) { /* progress never breaks the stream */ }
    };
  }

  function toMetadata({ durationMs = null } = {}) {
    if (!collector || typeof collector.toMetadata !== 'function') return null;
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
    // A quick turn with only routine rows («hola»: understanding, planning,
    // context, model) is not persisted — the thinking trace hides it too,
    // and every GET of the chat would otherwise carry it.
    if (ms !== null && ms < TRIVIAL_TRACE_MS && !persistedError
      && Array.from(persistedPhases).every((phase) => TRIVIAL_TRACE_PHASES.has(phase))) {
      return null;
    }
    try {
      return collector.toMetadata({ durationMs: ms });
    } catch (_) {
      return null;
    }
  }

  function dispose() {
    disposed = true;
    pendingProgress.clear();
    if (flushTimer) {
      try { clearTimer(flushTimer); } catch (_) { /* noop */ }
      flushTimer = null;
    }
  }

  return {
    get protocol() { return proto; },
    get enabled() { return !killed; },
    begin,
    note,
    openHandle,
    settleAll,
    modelSink,
    modelLabel,
    toMetadata,
    dispose,
  };
}

module.exports = {
  createTurnProgress,
  modelLabel,
  displayNameFor,
  modelEventLabel,
  errorCategoryEs,
  modelFailureText,
  failedCauseEs,
  failureCategoryOf,
  retryAfterSecondsOf,
  shortCauseEs,
  thinkingLevelEs,
  effectiveThinkingLevel,
  webLabel,
  sourcesNote,
  attachmentsLabel,
  attachmentsNote,
  attachmentExtractSink,
  ragProgressSink,
  difficultyEs,
  docTypeEs,
  countWords,
  countWordsBounded,
  fmtInt,
  fmtMs,
  fmtBytes,
  cleanText,
  PIPELINE_TOOLS,
  LEGACY_PHASES,
  MAX_BEGINS_PER_TURN,
  NOOP_HANDLE,
};
