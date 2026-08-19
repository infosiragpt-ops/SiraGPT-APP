'use strict';

const INJECTION_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on\w+\s*=\s*["']/i,
  /<iframe[\s>]/i,
  /<embed[\s>]/i,
  /<object[\s>]/i,
  /data\s*:\s*text\/html/i,
  /\[\s*system\s*\]\s*ignore\s+all\s+previous\s+instructions/i,
  /ignore\s+all\s+previous\s+instructions/i,
  /forget\s+all\s+previous\s+instructions/i,
  /disregard\s+all\s+previous\s+instructions/i,
];

function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function detectInjection(text) {
  if (typeof text !== 'string') return { detected: false, matches: [] };
  const matches = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) matches.push(pattern.source);
  }
  return { detected: matches.length > 0, matches };
}

function xssSanitizer(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object') return next();

  const userContent = body.messages || body.prompt || body.content || body.query || '';
  const textToCheck = typeof userContent === 'string'
    ? userContent
    : JSON.stringify(userContent);

  const { detected, matches } = detectInjection(textToCheck);
  if (detected) {
    if (process.env.SIRAGPT_BLOCK_INJECTIONS === 'true') {
      return res.status(400).json({
        error: 'Content blocked by security policy',
        code: 'INJECTION_DETECTED',
      });
    }
    res.locals.injectionWarning = true;
    res.locals.injectionMatches = matches;
  }

  return next();
}

module.exports = { xssSanitizer, detectInjection, sanitizeText, INJECTION_PATTERNS };
