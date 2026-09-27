'use strict';

/**
 * system-errors/fingerprint — pure grouping rules for «Errores del sistema».
 *
 * An ISSUE groups every event with the same fingerprint:
 *   kind + error name + normalized message (ids, numbers, urls… → placeholders)
 *   + top in-app stack frame (file + function, never the line number, so a
 *     deploy does not split an issue) + the log tag / route when there is no
 *     stack. Also decides what is noise (config states, client aborts, our own
 *     logs) and the Spanish labels the admin reads.
 */

const crypto = require('crypto');
const { isConfigStateMessage } = require('../config-state');

const KINDS = Object.freeze({
  excepcion: 'Excepción no controlada',
  promesa: 'Promesa rechazada',
  http: 'HTTP 5xx',
  cola: 'Cola / worker',
  redis: 'Redis',
  base_de_datos: 'Base de datos',
  proveedor: 'Proveedor IA',
  sandbox: 'Sandbox',
  frontend: 'Frontend',
  backend: 'Backend',
});

const LEVELS = Object.freeze(['fatal', 'error', 'warning']);

const SECRET_RES = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED:jwt]'],
  [/\b(?:sk|pk|rk|xai|gsk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._*-]{8,}\b/gi, '[REDACTED:key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED:key]'],
  [/\b(api[_-]?key|password|passwd|secret|token|authorization)(["']?\s*[:=]\s*["']?)([^&\s"',}]+)/gi, '$1$2[REDACTED]'],
  [/(postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|amqp):\/\/[^\s@/]+@/gi, '$1://[REDACTED]@'],
];

/** Redact secrets but keep line breaks (stack traces stay readable). */
function redactMultiline(value, max = 4000) {
  if (value == null) return null;
  let text = String(value);
  for (const [re, rep] of SECRET_RES) text = text.replace(re, rep);
  text = text.replace(/[ \t]+/g, ' ').replace(/\r/g, '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function redactLine(value, max = 500) {
  const text = redactMultiline(value, 100000);
  if (text == null) return null;
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const PLACEHOLDERS = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\bhttps?:\/\/[^\s'")\]]+/gi, '<url>'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
  [/\bc[a-z0-9]{24,30}\b/g, '<id>'],
  [/\b(?:swe|al|req|run|job|task|chat|msg|file)_[A-Za-z0-9]{6,}\b/g, '<id>'],
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  [/(?:\/[\w.@%+-]+){3,}\/?/g, '<path>'],
  [/'[^'\n]{32,}'|"[^"\n]{32,}"/g, '<str>'],
];

/** Numbers → <n>, except HTTP-looking statuses (4xx/5xx) and Prisma codes. */
function replaceNumbers(text) {
  return text.replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|b|%)?\b/gi, (m) => (/^[45]\d\d$/.test(m) ? m : '<n>'));
}

function normalizeMessage(message) {
  let text = String(message || '').split('\n').find((l) => l.trim()) || '';
  for (const [re, rep] of SECRET_RES) text = text.replace(re, rep);
  for (const [re, rep] of PLACEHOLDERS) text = text.replace(re, rep);
  text = replaceNumbers(text);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

function shortFile(file) {
  const f = String(file || '').replace(/^file:\/\//, '').replace(/\\/g, '/');
  const m = /(?:^|\/)(src\/.+|index\.js|scripts\/.+|jobs\/.+)$/.exec(f);
  if (m) return m[1];
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f);
  if (nm) return `node_modules/${nm[1]}`;
  return f.split('/').slice(-2).join('/');
}

function parseStack(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n')) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const file = m[2];
    frames.push({
      fn: (m[1] || '').replace(/^async\s+/, '').trim() || null,
      file: shortFile(file),
      line: Number(m[3]),
      col: Number(m[4]),
      inApp: !/node_modules|node:internal|^internal\/|\(native\)/.test(file) && !/^node:/.test(file),
    });
    if (frames.length >= 40) break;
  }
  return frames;
}

function topFrameOf(frames) {
  if (!Array.isArray(frames) || !frames.length) return null;
  return frames.find((f) => f.inApp) || frames[0];
}

/** «[agent-task-worker] worker error: …» → «agent-task-worker» */
function logTagOf(text) {
  const m = /^\s*\[([\w./:@ -]{2,48})\]/.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

// Redis protocol error replies («ERR Your database has been temporarily
// rate-limited», «WRONGTYPE …») — case-sensitive on purpose.
const REDIS_REPLY_RE = /(?:^|[:\s])(?:ERR|WRONGTYPE|NOAUTH|NOSCRIPT|OOM|LOADING|BUSYGROUP|EXECABORT|READONLY|CLUSTERDOWN|MISCONF) [A-Za-z]/;

const KIND_RULES = [
  ['redis', /ReplyError|\bredis\b|ioredis|MISCONF|:6379\b|\[redis\]/i],
  ['cola', /\bworker error\b|\bqueue\b|bullmq|\[[\w-]*(?:worker|queue|queues|runs|swarms)\]/i],
  ['base_de_datos', /prisma|\bP[12]\d{3}\b|postgres|\bpg\b|:5432\b|(?:relation|column) "[^"]+"(?: of relation "[^"]+")? does not exist|violates (?:foreign key|unique|not-null|check) constraint|duplicate key value|database|deadlock|connection pool|Unknown argument `/i],
  ['sandbox', /sandbox|runsc|gvisor|code-runner|\bsandboxed\b/i],
  ['proveedor', /\b(openai|anthropic|deepseek|gemini|google ai|xai|grok|meta llama|llama api|cerebras|openrouter|elevenlabs|fal\.ai|\bfal\b|mistral|groq|together|fireworks|minimax|suno|perplexity|typesafe)\b.*\b(?:[45]\d\d|error|failed|rejected)\b/i],
];

function detectKind(text, fallback = 'backend') {
  const t = String(text || '');
  if (REDIS_REPLY_RE.test(t)) return 'redis';
  for (const [kind, re] of KIND_RULES) if (re.test(t)) return kind;
  return fallback;
}

// Client went away / user stopped: not a bug of ours.
const CLIENT_GONE_RE = /\bAbortError\b|\bAPIUserAbortError\b|aborted by (?:the )?(?:client|user)|client (?:disconnected|closed|gone)|ERR_STREAM_PREMATURE_CLOSE|ERR_STREAM_WRITE_AFTER_END|write after end|ERR_HTTP_HEADERS_SENT.*client|socket hang up.*client|request (?:was )?aborted|this operation was aborted/i;
// Our own plumbing, never an issue (prevents capture loops).
const SELF_RE = /^\s*\[(?:system-errors|turn-failures|audit-log)\]/i;
const BENIGN_RE = /ExperimentalWarning|DeprecationWarning|PromiseRejectionHandledWarning|punycode|Eviction policy is/i;

function isNoise({ text = '', status = null, source = 'console' } = {}) {
  const t = String(text || '');
  if (!t.trim()) return true;
  if (SELF_RE.test(t)) return true;
  if (BENIGN_RE.test(t)) return true;
  if (isConfigStateMessage(t)) return true;
  if (CLIENT_GONE_RE.test(t)) return true;
  const code = Number(status);
  if (Number.isFinite(code) && code > 0 && code < 500) return true; // expected 4xx never become issues
  if (source === 'http' && !(code >= 500)) return true;
  return false;
}

function sha(parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p || '')).join('|')).digest('hex').slice(0, 20);
}

/**
 * Describe one captured error. Pure: same inputs → same fingerprint.
 * @param {object} input { kind?, level?, name?, message, stack?, tag?, route?, method?, status?, queue? }
 */
function describeEvent(input = {}) {
  const message = String(input.message || '').trim();
  const frames = parseStack(input.stack);
  const top = topFrameOf(frames);
  const tag = input.tag || logTagOf(message);
  const kind = KINDS[input.kind] ? input.kind : detectKind(`${tag ? `[${tag}] ` : ''}${input.name || ''} ${message}`, 'backend');
  const name = input.name && input.name !== 'Error' ? String(input.name) : null;
  const normalized = normalizeMessage(message.replace(/^\s*\[[^\]]{2,48}\]\s*/, ''));
  const routeKey = input.route ? `${String(input.method || '').toUpperCase()} ${input.route}`.trim() : '';
  const fingerprint = sha([
    kind,
    name || '',
    normalized,
    top ? `${top.file}:${top.fn || '?'}` : '',
    // Without a stack the log tag is what tells two bugs apart — except for
    // Redis, where every worker logs the same outage under its own tag.
    top || kind === 'redis' ? '' : (tag || ''),
    kind === 'http' ? `${routeKey} ${input.status || ''}` : '',
    input.queue || '',
  ]);
  const firstLine = redactLine(message.split('\n').find((l) => l.trim()) || message, 200) || 'Error sin mensaje';
  let title;
  if (kind === 'http') title = `HTTP ${input.status || 500} · ${routeKey || 'petición'}${firstLine && !/^HTTP \d/.test(firstLine) ? ` — ${firstLine}` : ''}`;
  else if (name) title = `${name}: ${firstLine}`;
  else title = firstLine;
  const culprit = routeKey
    || (input.queue ? `cola ${input.queue}` : null)
    || (top ? `${top.fn ? `${top.fn} ` : ''}(${top.file})` : null)
    || (tag ? `[${tag}]` : null);
  return {
    fingerprint,
    kind,
    kindLabel: KINDS[kind],
    level: LEVELS.includes(input.level) ? input.level : 'error',
    title: title.slice(0, 240),
    culprit: culprit ? String(culprit).slice(0, 200) : null,
    tag: tag || null,
    normalized,
    topFrame: top,
    frames,
  };
}

module.exports = {
  KINDS,
  LEVELS,
  describeEvent,
  normalizeMessage,
  parseStack,
  topFrameOf,
  logTagOf,
  detectKind,
  isNoise,
  redactMultiline,
  redactLine,
  shortFile,
};
