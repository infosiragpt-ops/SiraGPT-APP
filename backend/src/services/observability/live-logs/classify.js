'use strict';

/**
 * live-logs/classify — turn one raw write into a structured log event.
 *
 *   classifyLine({ text, method, ctx }) → { level, source, tag, msg, body }
 *
 * `method` is how the text reached the process streams:
 *   console.error | console.warn | console.info | console.log | console.debug
 *   | console.trace | stdout | stderr | pino
 *
 * One write is one event: a stack trace or a BullMQ ReplyError dump printed by
 * a single console.error() arrives as one multi-line chunk and stays ONE event
 * (first line → msg, the rest → body), unlike line-splitting log viewers.
 */

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_RANK = Object.freeze({ trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 });
const PINO_LEVELS = Object.freeze({ 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' });

const BASE_BY_METHOD = Object.freeze({
  'console.error': 'error',
  'console.warn': 'warn',
  'console.info': 'info',
  'console.log': 'info',
  'console.debug': 'debug',
  'console.trace': 'debug',
  stdout: 'info',
  stderr: 'warn',
  pino: 'info',
});

const MSG_MAX = 1000;
const BODY_MAX = 8 * 1024;
const JSON_BODY_MAX = 4 * 1024;

// Strong signals: the line describes a real failure.
const FATAL_RE = /\[FATAL\]|\buncaughtException\b|\bunhandledRejection\b|\bout of memory\b|\bheap limit\b/i;
const STACK_RE = /\n\s+at\s+(?:async\s+)?[^\s]+.*(?:\(|:\d+:\d+)/;
const ERROR_WORD_RE = /(?:^|[\s[(:'"])(?:[A-Z][A-Za-z]{2,}Error|Error|Exception)(?::|\s(?=[A-Z]))|\bERR(?:_[A-Z_]+)?\b|\bE(?:CONNREFUSED|CONNRESET|CONNABORTED|TIMEDOUT|AI_AGAIN|NOENT|ACCES|PIPE|HOSTUNREACH)\b|\bworker error\b|\bPrisma\w*Error\b|\bInvalid `prisma\./;
// Soft signals: something went wrong but the process handled it.
const WARN_WORD_RE = /\b(?:failed|failure|fail(?:s|ing)?|fatal|crash(?:ed)?|panic|cannot|could not|unable to|no se pudo|fall[oó]|rechaz\w*|timed? ?out|timeout|aborted|denied|refused|invalid|unauthori[sz]ed|forbidden|not found|rate[- ]?limited|quota|insufficient|degraded|fallback|retry(?:ing)?|reintent\w*)\b/i;

const ERROR_EMOJI_RE = /[❌✖🚨⛔💥]/u;
// Diagnostic tags ([models-dbg], [perf], [timing]…) are debug noise, not failures.
const DEBUG_TAG_RE = /(?:^|[-_:\s])(?:dbg|debug|trace|timing|perf|bench|verbose)(?:$|[-_:\s])/i;
// pino-http's per-request completion line duplicates middleware/request-logger
// (which also carries the user); the admin log console's own requests are noise.
const PINO_HTTP_DONE_RE = /^request (?:completed|aborted)$/;
const SELF_PATH_RE = /^\/api\/admin\/logs\//;
const QUIET_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const QUIET_MAX_MS = 1500;

const BRACKET_TAG_RE = /^\s*(?:[^\s[]{1,4}\s+)?\[([A-Za-z0-9][A-Za-z0-9 :._/@#-]{1,47})\]/;
const WORKER_TAG_RE = /(?:worker|queue|runner|cron|job|scheduler|watchdog|sweeper|codex-runs|bull)/i;

function maxLevel(a, b) {
  return (LEVEL_RANK[b] || 0) > (LEVEL_RANK[a] || 0) ? b : a;
}

function normalizeLevelValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return PINO_LEVELS[value] || (value >= 50 ? 'error' : value >= 40 ? 'warn' : 'info');
  const s = String(value).toLowerCase();
  if (s === 'warning') return 'warn';
  if (s === 'err' || s === 'critical' || s === 'crit' || s === 'alert' || s === 'emergency') return 'error';
  return LEVELS.includes(s) ? s : null;
}

function tryParseJson(text) {
  const t = text.trim();
  if (t.length < 2 || t.length > 256 * 1024) return null;
  if (t[0] !== '{' || t[t.length - 1] !== '}') return null;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (_) {
    return null;
  }
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function statusOf(obj) {
  const candidates = [obj.status, obj.statusCode, obj.res && obj.res.statusCode, obj.response && obj.response.status];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return null;
}

// Keys already shown elsewhere (or noise) — never repeated as `key=value`.
const DETAIL_SKIP = new Set([
  'level', 'lvl', 'severity', 'time', 't', 'ts', 'timestamp', 'pid', 'hostname', 'v',
  'msg', 'message', 'event', 'action', 'component', 'name', 'module', 'tag', 'service',
  'userId', 'user_id', 'reqId', 'requestId', 'request_id', 'chatId', 'chat_id', 'conversationId',
  'ip', 'ua', 'userAgent', 'method', 'path', 'url', 'route', 'endpoint', 'status', 'statusCode',
  'durMs', 'responseTime', 'req', 'res', 'err', 'alert', 'trace_id', 'span_id', 'trace_flags',
]);
const DETAIL_PRIORITY = ['code', 'reason', 'provider', 'model', 'scope', 'stage', 'kind', 'domain', 'file', 'hits', 'count', 'durationMs', 'ms'];

/** Up to `max` short `key=value` details so metric/event lines say something. */
function scalarDetails(obj, max = 4) {
  const out = [];
  const seen = new Set();
  const add = (key) => {
    if (out.length >= max || seen.has(key) || DETAIL_SKIP.has(key)) return;
    const value = obj[key];
    if (value == null || value === '') return;
    if (typeof value === 'string' && value.length <= 60 && !/[\n\r]/.test(value)) out.push(`${key}=${value}`);
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(`${key}=${value}`);
    else if (Array.isArray(value)) out.push(`${key}=[${value.length}]`);
    else return;
    seen.add(key);
  };
  for (const key of DETAIL_PRIORITY) add(key);
  for (const key of Object.keys(obj)) add(key);
  return out;
}

/** Does a structured record itself say something failed? */
function jsonFailureSignal(obj) {
  if (obj.ok === false || obj.aborted === true) return true;
  if (typeof obj.error === 'string' ? obj.error.trim() : obj.error && obj.error.message) return true;
  return /^(?:error|critical|fatal)$/i.test(String(obj.severity || ''));
}

/** One-line human summary of a structured (JSON) log record. */
function summarizeJson(obj) {
  const method = firstString(obj.method, obj.req && obj.req.method);
  const url = firstString(obj.path, obj.url, obj.route, obj.req && obj.req.url, obj.endpoint);
  const status = statusOf(obj);
  const dur = Number(obj.durMs ?? obj.responseTime ?? obj.duration_ms ?? obj.durationMs);
  const msgText = firstString(obj.msg, obj.message);
  const eventText = firstString(obj.event, obj.action);
  // `{msg:'ai.generate', event:'ai.generate.request.accepted'}` → show the event.
  const text = eventText && msgText && eventText !== msgText && eventText.startsWith(msgText)
    ? eventText
    : firstString(msgText, eventText);
  const errMsg = obj.err && typeof obj.err === 'object' ? firstString(obj.err.message, obj.err.type) : firstString(obj.error && obj.error.message, typeof obj.error === 'string' ? obj.error : '');
  const parts = [];
  if (method && url) parts.push(`${method} ${url}`);
  if (status) parts.push(`→ ${status}`);
  if (Number.isFinite(dur) && dur >= 0 && (method || status)) parts.push(`(${Math.round(dur)} ms)`);
  if (text && !(text === 'request completed' && parts.length)) parts.push(text);
  const alert = obj.alert && typeof obj.alert === 'object' ? obj.alert : null;
  if (alert && (alert.title || alert.message)) {
    // alert_emitted → «[critical] [agent-task] run estancado 478h …»
    parts.push(`· ${alert.severity ? `[${alert.severity}] ` : ''}${firstString(alert.title, alert.message)}`);
  }
  if (errMsg && !parts.join(' ').includes(errMsg)) parts.push(`— ${errMsg}`);
  if (parts.length && !(method && url) && !alert) {
    // Event/metric lines (`doc_sandbox`, `web_search_many`…): add the key facts.
    const details = scalarDetails(obj).filter((d) => !errMsg || !d.startsWith('error='));
    if (details.length) parts.push(`· ${details.join(' ')}`);
  }
  if (!parts.length) {
    const keys = Object.keys(obj).filter((k) => !['level', 'time', 'pid', 'hostname', 'v', 'ts', 'timestamp'].includes(k)).slice(0, 4);
    parts.push(keys.map((k) => `${k}=${typeof obj[k] === 'object' ? JSON.stringify(obj[k]).slice(0, 60) : String(obj[k]).slice(0, 60)}`).join(' '));
  }
  return parts.join(' ').slice(0, MSG_MAX);
}

function inferTag(text, obj) {
  if (obj) {
    const t = firstString(obj.component, obj.name, obj.module, obj.tag, obj.service !== 'siragpt' ? obj.service : '');
    if (t) return t.slice(0, 48);
    const m = BRACKET_TAG_RE.exec(firstString(obj.msg, obj.message));
    return m ? m[1].trim() : null;
  }
  const m = BRACKET_TAG_RE.exec(text);
  return m ? m[1].trim() : null;
}

function splitMessage(text) {
  const trimmed = text.replace(/\s+$/, '');
  const nl = trimmed.indexOf('\n');
  if (nl === -1) return { msg: trimmed.slice(0, MSG_MAX), body: trimmed.length > MSG_MAX ? trimmed.slice(0, BODY_MAX) : null };
  const msg = trimmed.slice(0, nl).trim() || trimmed.trim().split('\n')[0];
  return { msg: msg.slice(0, MSG_MAX), body: trimmed.slice(0, BODY_MAX) };
}

/** Correlation ids a structured record carries itself (pino-http, request-logger). */
function jsonContext(obj) {
  if (!obj) return null;
  const out = {};
  const reqId = firstString(obj.reqId, obj.requestId, obj.request_id, obj.req && typeof obj.req.id === 'string' ? obj.req.id : '');
  if (reqId) out.reqId = reqId.slice(0, 128);
  const userId = firstString(obj.userId, obj.user_id);
  if (userId) out.userId = userId.slice(0, 64);
  const chatId = firstString(obj.chatId, obj.chat_id, obj.conversationId);
  if (chatId) out.chatId = chatId.slice(0, 64);
  return Object.keys(out).length ? out : null;
}

/**
 * @param {{ text: string, method?: string, ctx?: object|null }} input
 * @returns {{ level: string, source: string, tag: string|null, msg: string, body: string|null, status: number|null, jsonCtx: object|null } | null}
 */
function classifyLine({ text, method = 'stdout', ctx = null } = {}) {
  if (typeof text !== 'string') return null;
  const raw = text.replace(/\r\n/g, '\n');
  if (!raw.trim()) return null;

  const obj = tryParseJson(raw);
  let level = BASE_BY_METHOD[method] || 'info';
  let msg;
  let body = null;
  let status = null;

  if (method === 'console.trace') {
    // console.trace prints a stack by design — it is a debug aid, not a failure.
    const { msg: m, body: b } = splitMessage(raw);
    return { level: 'debug', source: 'backend', tag: inferTag(raw, null), msg: m || '(vacío)', body: b, status: null, jsonCtx: null };
  }

  if (obj) {
    const declared = normalizeLevelValue(obj.level ?? obj.lvl) || normalizeLevelValue(obj.severity);
    if (declared) level = declared;
    // A structured record without a level is a metric/event: which console
    // method printed it is not a failure signal — its own fields are.
    else if (!jsonFailureSignal(obj)) level = 'info';
    else if (level !== 'error') level = 'warn';
    status = statusOf(obj);
    if (status >= 500) level = maxLevel(level, 'error');
    else if (status >= 400 && status !== 401 && status !== 404) level = maxLevel(level, 'warn');
    const hasErr = Boolean(obj.err && typeof obj.err === 'object' && (obj.err.message || obj.err.stack));
    if (hasErr) level = maxLevel(level, 'error');
    const reqPath = firstString(obj.path, obj.url, obj.req && obj.req.url).split('?')[0];
    if (!hasErr && obj.req && obj.res && PINO_HTTP_DONE_RE.test(firstString(obj.msg))) return { drop: 'duplicate' };
    if (reqPath && SELF_PATH_RE.test(reqPath) && (status == null || status < 500)) return { drop: 'self' };
    const reqMethod = firstString(obj.method, obj.req && obj.req.method).toUpperCase();
    const dur = Number(obj.durMs ?? obj.responseTime);
    if (!hasErr && reqPath && QUIET_METHODS.has(reqMethod) && status != null && status < 400
      && Number.isFinite(dur) && dur < QUIET_MAX_MS && (level === 'info' || level === 'debug')) {
      // A fast, successful read (polls, catalog/credits refreshes): kept and
      // searchable, but out of the default «info y superior» view.
      level = 'debug';
    }
    msg = summarizeJson(obj);
    body = raw.trim().slice(0, JSON_BODY_MAX);
  } else {
    ({ msg, body } = splitMessage(raw));
    const strong = FATAL_RE.test(raw) || STACK_RE.test(raw) || ERROR_WORD_RE.test(raw) || ERROR_EMOJI_RE.test(msg);
    const soft = WARN_WORD_RE.test(msg);
    if (FATAL_RE.test(raw)) level = maxLevel(level, 'fatal');
    else if (strong) level = maxLevel(level, 'error');
    else if (soft) level = maxLevel(level, 'warn');
    // console.error with nothing that reads like a failure is a notice, not a red error.
    if (method === 'console.error' && !strong && !soft) level = 'warn';
    const lineTag = inferTag(raw, null);
    if (lineTag && DEBUG_TAG_RE.test(lineTag) && !strong) level = 'debug';
  }

  const tag = inferTag(raw, obj);
  let source = 'backend';
  if (ctx && ctx.queue) source = `worker:${String(ctx.queue).slice(0, 40)}`;
  else if (tag && WORKER_TAG_RE.test(tag)) source = `worker:${tag.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`;

  return { level, source, tag: tag || null, msg: msg || '(vacío)', body, status, jsonCtx: jsonContext(obj) };
}

function levelRank(level) {
  return LEVEL_RANK[level] ?? LEVEL_RANK.info;
}

module.exports = {
  classifyLine,
  levelRank,
  maxLevel,
  normalizeLevelValue,
  summarizeJson,
  LEVELS,
  LEVEL_RANK,
};
