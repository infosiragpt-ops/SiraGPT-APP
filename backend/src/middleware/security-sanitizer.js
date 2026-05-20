'use strict';

const XSS_PATTERNS = Object.freeze([
  [/<script\b[^>]*>/gi, 'script_tag'],
  [/<\/script\b[^>]*>/gi, 'script_close_tag'],
  [/javascript\s*:/gi, 'javascript_uri'],
  [/on\w+\s*=\s*["'][^"']*["']/gi, 'inline_event_handler'],
  [/on\w+\s*=\s*\S+/gi, 'inline_event_handler_noquote'],
  [/\beval\s*\(/gi, 'eval_call'],
  [/\bdocument\.cookie\b/gi, 'cookie_access'],
  [/\blocalStorage\b/gi, 'localstorage'],
  [/\bsessionStorage\b/gi, 'sessionstorage'],
  [/<iframe\b[^>]*>/gi, 'iframe_tag'],
  [/<embed\b[^>]*>/gi, 'embed_tag'],
  [/<object\b[^>]*>/gi, 'object_tag'],
  [/\bvbscript\s*:/gi, 'vbscript_uri'],
  [/<meta\b[^>]*>/gi, 'meta_tag'],
  [/expression\s*\(/gi, 'css_expression'],
]);

function sanitizeAgainstXSS(input) {
  if (typeof input !== 'string') return input;
  let sanitized = input;
  for (const [pattern] of XSS_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized;
}

function detectXSS(input) {
  if (typeof input !== 'string') return { detected: false, patterns: [] };
  const patterns = [];
  for (const [pattern, id] of XSS_PATTERNS) {
    if (pattern.test(input)) {
      patterns.push(id);
    }
  }
  return { detected: patterns.length > 0, patterns };
}

function sanitizeRequestBody(body, depth = 0) {
  if (depth > 20) return body;
  if (typeof body === 'string') return sanitizeAgainstXSS(body);
  if (Array.isArray(body)) return body.map(item => sanitizeRequestBody(item, depth + 1));
  if (body && typeof body === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof key === 'string' && XSS_PATTERNS.some(([re]) => re.test(key))) {
        sanitized[key.replace(/<[^>]*>/g, '')] = sanitizeRequestBody(value, depth + 1);
      } else {
        sanitized[key] = sanitizeRequestBody(value, depth + 1);
      }
    }
    return sanitized;
  }
  return body;
}

function createXSSSanitizerMiddleware(opts = {}) {
  const maxDepth = opts.maxDepth || 20;

  return function xssSanitizer(req, res, next) {
    if (!req.body || typeof req.body !== 'object') return next();

    const sanitized = sanitizeRequestBody(req.body, 0);
    req.body = sanitized;

    next();
  };
}

function createPromptInjectionSanitizerMiddleware(opts = {}) {
  let detector = null;
  try {
    detector = require('../services/ai/prompt-injection-detector');
  } catch (_) {}

  if (!detector) return (req, res, next) => next();

  return function promptInjectionSanitizer(req, res, next) {
    if (!req.body) return next();

    const content = req.body.content || req.body.prompt || '';
    if (!content || typeof content !== 'string') return next();

    const verdict = detector.detect(content);
    if (verdict.detected && verdict.confidence > 0.8) {
      return res.status(400).json({
        error: 'Request contains potentially unsafe patterns',
        code: 'prompt_injection_suspected',
      });
    }

    if (verdict.detected) {
      req.promptInjectionVerdict = verdict;
    }

    next();
  };
}

module.exports = {
  createXSSSanitizerMiddleware,
  createPromptInjectionSanitizerMiddleware,
  sanitizeAgainstXSS,
  detectXSS,
};
