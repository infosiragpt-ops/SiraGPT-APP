'use strict';

/**
 * ansi — minimal ANSI escape helpers. Pairs with the audit log (#14)
 * and structured logger (#43): when stderr/stdout from a child
 * process or a third-party library lands in our logs, strip the
 * escape sequences first or downstream JSON renderers explode.
 *
 * Public API:
 *   stripAnsi(text)                      → string  (no-throw)
 *   hasAnsi(text)                        → boolean
 *   color(text, name)                    → string  (no-op when supportsColor=false)
 *   isColorEnabled(env?)                 → boolean
 *
 * Color names: 'red','green','yellow','blue','magenta','cyan','gray',
 *              'bold','dim','reset'
 */

// Comprehensive enough for the SGR + most CSI / OSC sequences a log
// or terminal emits. Adapted from the ansi-regex pattern.
const ANSI_RE = new RegExp([
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)',
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join(''), 'g');

const COLOR_CODES = {
  reset:   '[0m',
  bold:    '[1m',
  dim:     '[2m',
  red:     '[31m',
  green:   '[32m',
  yellow:  '[33m',
  blue:    '[34m',
  magenta: '[35m',
  cyan:    '[36m',
  gray:    '[90m',
};

function stripAnsi(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(ANSI_RE, '');
}

function hasAnsi(text) {
  if (typeof text !== 'string') return false;
  ANSI_RE.lastIndex = 0;
  return ANSI_RE.test(text);
}

function isColorEnabled(env = process.env) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  // Heuristic: colors only when stdout is TTY.
  try { return Boolean(process.stdout && process.stdout.isTTY); }
  catch { return false; }
}

function color(text, name) {
  const code = COLOR_CODES[name];
  if (!code || !isColorEnabled()) return String(text);
  return `${code}${text}${COLOR_CODES.reset}`;
}

module.exports = {
  stripAnsi,
  hasAnsi,
  color,
  isColorEnabled,
  ANSI_RE,
  COLOR_CODES,
};
