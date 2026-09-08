'use strict';

/**
 * Pattern / language guards for ast-grep structural edit.
 * User input is data, not a shell string (AGENTS.md §17).
 */

const { fail } = require('../coding-sandbox/errors');

const MAX_PATTERN_CHARS = 4_000;
const MAX_REWRITE_CHARS = 4_000;
const MAX_PATHS = 40;
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 8_000;

const ALLOWED_LANGS = Object.freeze([
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'ruby',
  'css',
  'html',
  'json',
  'c',
  'cpp',
]);

const ALLOWED_LANG_SET = new Set(ALLOWED_LANGS);

const EXT_TO_LANG = Object.freeze({
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  css: 'css',
  html: 'html',
  htm: 'html',
  json: 'json',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  h: 'c',
});

const SKIP_RE = /(^|\/)(node_modules|dist|build|\.next|\.git|coverage|\.sira|vendor|__pycache__)\//;

function hasControlChars(value) {
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
}

function normalizeLang(raw, { required = false } = {}) {
  if (raw == null || String(raw).trim() === '') {
    if (required) fail('E_PARAMS', 'Falta el lenguaje del patrón.');
    return null;
  }
  const lang = String(raw).trim().toLowerCase();
  if (!ALLOWED_LANG_SET.has(lang)) {
    fail('E_PARAMS', `Lenguaje no permitido: ${lang}.`);
  }
  return lang;
}

function inferLang(filePath, explicit) {
  if (explicit) return normalizeLang(explicit);
  const base = String(filePath || '').split('/').pop() || '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  const lang = EXT_TO_LANG[ext] || null;
  if (!lang) return null;
  return lang;
}

function validatePattern(pattern) {
  if (pattern == null || String(pattern).trim() === '') {
    fail('E_PARAMS', 'Falta el patrón estructural.');
  }
  const text = String(pattern);
  if (text.length > MAX_PATTERN_CHARS) {
    fail('E_PARAMS', 'El patrón estructural es demasiado largo.');
  }
  if (hasControlChars(text)) {
    fail('E_PARAMS', 'El patrón contiene caracteres de control.');
  }
  return text;
}

function validateRewrite(rewrite, { required = false } = {}) {
  if (rewrite == null || String(rewrite) === '') {
    if (required) fail('E_PARAMS', 'Falta la reescritura estructural.');
    return null;
  }
  const text = String(rewrite);
  if (text.length > MAX_REWRITE_CHARS) {
    fail('E_PARAMS', 'La reescritura estructural es demasiado larga.');
  }
  if (hasControlChars(text)) {
    fail('E_PARAMS', 'La reescritura contiene caracteres de control.');
  }
  return text;
}

function skipPath(p) {
  return !p || SKIP_RE.test(p);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  MAX_PATTERN_CHARS,
  MAX_REWRITE_CHARS,
  MAX_PATHS,
  MAX_MATCHES,
  MAX_FILE_BYTES,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_LANGS,
  EXT_TO_LANG,
  SKIP_RE,
  normalizeLang,
  inferLang,
  validatePattern,
  validateRewrite,
  skipPath,
  clampInt,
};
