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

/** One-line human summary of a structured (JSON) log record. */
function summarizeJson(obj) {
  const method = firstString(obj.method, obj.req && obj.req.method);
  const url = firstString(obj.path, obj.url, obj.route, obj.req && obj.req.url, obj.endpoint);
  const status = statusOf(obj);
  const dur = Number(obj.durMs ?? obj.responseTime ?? obj.duration_ms ?? obj.durationMs);
  const text = firstString(obj.msg, obj.message, obj.event, obj.action);
  const errMsg = obj.err && typeof obj.err === 'object' ? firstString(obj.err.message, obj.err.type) : firstString(obj.error && obj.error.message, typeof obj.error === 'string' ? obj.error : '');
  const parts = [];
  if (method && url) parts.push(`${method} ${url}`);
  if (status) parts.push(`→ ${status}`);
  if (Number.isFinite(dur) && dur >= 0 && (method || status)) parts.push(`(${Math.round(dur)} ms)`);
  if (text && !(text === 'request completed' && parts.length)) parts.push(text);
  if (errMsg && !parts.join(' ').includes(errMsg)) parts.push(`— ${errMsg}`);
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
    const declared = normalizeLevelValue(obj.level ?? obj.severity ?? obj.lvl);
    if (declared) level = declared;
    status = statusOf(obj);
    if (status >= 500) level = maxLevel(level, 'error');
    else if (status >= 400 && status !== 401 && status !== 404) level = maxLevel(level, 'warn');
    if (obj.err && typeof obj.err === 'object' && (obj.err.message || obj.err.stack)) level = maxLevel(level, 'error');
    msg = summarizeJson(obj);
    body = raw.trim().slice(0, JSON_BODY_MAX);
  } else {
    ({ msg, body } = splitMessage(raw));
    if (FATAL_RE.test(raw)) level = maxLevel(level, 'fatal');
    else if (STACK_RE.test(raw) || ERROR_WORD_RE.test(raw)) level = maxLevel(level, 'error');
    else if (WARN_WORD_RE.test(msg)) level = maxLevel(level, 'warn');
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
