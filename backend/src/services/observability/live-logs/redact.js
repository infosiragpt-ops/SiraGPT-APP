'use strict';

/**
 * live-logs/redact — last-mile secret scrubbing for every captured log line.
 *
 * Runs on the raw text BEFORE a line is stored in Redis or streamed to the
 * admin console. It is pattern based on purpose: a captured line can come
 * from any library (BullMQ dumps, SDK errors, console.log of an options
 * object), so we cannot rely on structured field names alone.
 *
 * Conservative: user emails, ids and prompts stay visible (the operator needs
 * them to diagnose a failed turn); only credentials are removed.
 */

const MAX_LINE_CHARS = 16 * 1024;
const MASK = '[REDACTED]';

// Order matters: specific token shapes first, generic `key=value` last.
const PATTERNS = [
  // PEM private keys (multi-line).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // scheme://user:password@host (postgres, redis, amqp, mongodb, https basic).
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/'"]*):([^\s@/'"]+)@/gi, `$1$2:${MASK}@`],
  // Authorization headers / bearer tokens.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED_JWT]'],
  // Provider API keys.
  [/\bsk-(?:ant-|proj-|or-v1-|svcacct-|live-)?[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, `xai-${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, `AIza${MASK}`],
  [/\b(gsk|csk|pplx|tvly|r8|hf|whsec|glpat|shpat|shpss)[_-][A-Za-z0-9]{16,}/g, `$1_${MASK}`],
  [/\bLLM[|_][A-Za-z0-9]{20,}/g, `LLM_${MASK}`],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, `$1_$2_${MASK}`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, `gh_${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, `xox-${MASK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${MASK}`],
  // fal.ai "uuid:hex32" keys.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/gi, '[REDACTED_KEY]'],
  // AES "enc:v1:<ciphertext>" values stored for admin connections.
  [/\benc:v1:[A-Za-z0-9+/=:_-]{16,}/g, `enc:v1:${MASK}`],
  // Cookie headers: redact the whole value (a cookie string holds many pairs).
  [/((?:^|[\s{,"'])(?:set-)?cookie["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\n]*)/gi, `$1${MASK}`],
  // Generic sensitive `name: value` / `name=value` / `"name":"value"`.
  [/((?:["']?)(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|authorization|encryption[_-]?key|private[_-]?key|signing[_-]?key|webhook[_-]?secret|sas|signature)(?:["']?)\s*[:=]\s*["']?)([^"'\s,;&}\])]{4,})/gi, `$1${MASK}`],
];

function redactText(value, { maxChars = MAX_LINE_CHARS } = {}) {
  if (value == null) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (text.length > maxChars * 2) text = text.slice(0, maxChars * 2);
  for (const [re, replacement] of PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, replacement);
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…[truncado ${text.length - maxChars} caracteres]`;
  }
  return text;
}

module.exports = {
  redactText,
  MAX_LINE_CHARS,
  _PATTERNS: PATTERNS,
};
