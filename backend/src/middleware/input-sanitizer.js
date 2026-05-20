'use strict';

/**
 * input-sanitizer — XSS and prompt injection detection middleware.
 *
 * Operates on req.body before downstream handlers see it:
 *   1. XSS patterns (script tags, event handlers, javascript: URIs).
 *   2. Prompt injection heuristics (system override phrases, delimiter
 *      injection, role switching, ignore-previous-instructions patterns).
 *   3. Unicode homoglyph / direction override attacks.
 *
 * When a violation is found the middleware responds 400 with a structured
 * envelope. It does NOT mutate the body — the caller decides whether to
 * strip the offending content or reject the request outright.
 *
 * Env flags:
 *   SIRAGPT_INPUT_SANITIZER_MODE = 'block' (default) | 'warn' | 'off'
 *   SIRAGPT_INPUT_SANITIZER_MAX_DEPTH = max recursion for nested objects
 */

const XSS_PATTERNS = [
  [/\<script\b/i, 'xss.script_tag'],
  [/on\w+\s*=\s*["'][^"']*["']/i, 'xss.event_handler'],
  [/javascript\s*:/i, 'xss.javascript_uri'],
  [/\<iframe\b/i, 'xss.iframe'],
  [/data\s*:\s*text\/html/i, 'xss.data_html_uri'],
  [/\beval\s*\(/i, 'xss.eval_call'],
  [/document\.cookie/i, 'xss.cookie_access'],
  [/document\.location\b/i, 'xss.location_access'],
  [/window\b.*\.\b(open|close)\s*\(/i, 'xss.window_open_close'],
];

const PROMPT_INJECTION_PATTERNS = [
  [/^(?:system|developer|assistant|user)\s*:\s*$/im, 'injection.role_switch'],
  [/ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i, 'injection.ignore_instructions'],
  [/you\s+are\s+(?:now|hereby)\s+(?:a|an)\s+(?:different|new)\s+(?:model|assistant|role)/i, 'injection.redefinition'],
  [/your\s+system\s+prompt\s+(?:is|was|should\s+be)/i, 'injection.system_prompt_leak'],
  [/override\s+(?:all\s+)?(?:system|safety|security)/i, 'injection.override'],
  [/begin\s+(?:new|fresh)\s+conversation/i, 'injection.reset_attempt'],
  [/\<\<SYS\>\>[\s\S]*?\<\/SYS\>\>/i, 'injection.sys_tags'],
  [/\[INST\][\s\S]*?\[\/INST\]/i, 'injection.inst_tags'],
  [/\{\{[\w.]+\}\}/, 'injection.template_injection'],
];

const UNICODE_ATTACK_PATTERNS = [
  [/[\u202A-\u202E]/g, 'unicode.direction_override'],
  [/[\u200B\u200C\u200D\uFEFF]/g, 'unicode.zero_width'],
  [/[^\x00-\x7F]{3,}\s*(?:@|www\.|https?:\/\/)/, 'unicode.homoglyph_url'],
];

const MAX_DEPTH = Math.max(2, Number.parseInt(process.env.SIRAGPT_INPUT_SANITIZER_MAX_DEPTH || '10', 10));

function scanString(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const violations = [];

  for (const [pattern, code] of XSS_PATTERNS) {
    if (pattern.test(text)) violations.push({ code, pattern: pattern.source.slice(1, -1).replace(/\\b/g, '') });
  }

  for (const [pattern, code] of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) violations.push({ code, pattern: pattern.source.slice(1, -1).replace(/\\b/g, '').replace(/\\s\+/g, ' ') });
  }

  for (const [pattern, code] of UNICODE_ATTACK_PATTERNS) {
    if (pattern.test(text)) violations.push({ code, chars: text.match(pattern)?.join('')?.slice(0, 40) || '' });
  }

  return violations;
}

function scanValue(value, depth = 0, path = '') {
  if (depth > MAX_DEPTH) return [];
  if (value == null) return [];

  if (typeof value === 'string') {
    return scanString(value).map(v => ({ ...v, path: path || '(root)' }));
  }

  if (Array.isArray(value)) {
    const results = [];
    for (let i = 0; i < Math.min(value.length, 50); i++) {
      results.push(...scanValue(value[i], depth + 1, `${path}[${i}]`));
    }
    return results;
  }

  if (typeof value === 'object') {
    const results = [];
    const keys = Object.keys(value).slice(0, 30);
    for (const key of keys) {
      results.push(...scanValue(value[key], depth + 1, path ? `${path}.${key}` : key));
    }
    return results;
  }

  return [];
}

function createInputSanitizer(opts = {}) {
  const mode = (opts.mode || process.env.SIRAGPT_INPUT_SANITIZER_MODE || 'block').toLowerCase();
  const onViolation = typeof opts.onViolation === 'function' ? opts.onViolation : null;
  const logger = typeof opts.logger === 'object' && typeof opts.logger.warn === 'function'
    ? opts.logger
    : console;

  return function inputSanitizer(req, res, next) {
    if (mode === 'off') return next();
    if (!req.body || typeof req.body !== 'object') return next();

    const violations = scanValue(req.body);

    if (violations.length === 0) return next();

    if (onViolation) {
      try { onViolation({ req, violations, mode }); } catch { /* swallow */ }
    }

    if (mode === 'warn') {
      logger.warn?.({ violations, path: req.path, method: req.method }, 'input sanitizer detected violations (warn mode)');
      return next();
    }

    // mode === 'block'
    logger.warn?.({ violations, path: req.path, method: req.method, userId: req.user?.id }, 'input sanitizer blocked request');
    return res.status(400).json({
      error: 'Input validation failed',
      code: 'input.injection_detected',
      violations: violations.slice(0, 10).map(v => ({ code: v.code, path: v.path })),
    });
  };
}

module.exports = {
  createInputSanitizer,
  scanString,
  scanValue,
  XSS_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
  UNICODE_ATTACK_PATTERNS,
};
