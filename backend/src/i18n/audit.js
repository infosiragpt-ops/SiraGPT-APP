'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.claude',
  '.vercel',
  '.turbo',
  'android',
  'ios',
]);

function flattenKeys(value, prefix = '', acc = new Set()) {
  if (value === null || value === undefined) return acc;
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) acc.add(prefix);
    return acc;
  }
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenKeys(v, next, acc);
    } else {
      acc.add(next);
    }
  }
  return acc;
}

function loadMessagesFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);
  return flattenKeys(json);
}

function loadAllLocales(messagesDir) {
  const out = new Map();
  const entries = fs.readdirSync(messagesDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.json')) continue;
    const locale = ent.name.replace(/\.json$/, '');
    const keys = loadMessagesFile(path.join(messagesDir, ent.name));
    out.set(locale, keys);
  }
  return out;
}

const TRANSLATOR_DECL_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(useTranslations|getTranslations)\s*\(\s*(?:(['"`])([^'"`]*)\3)?\s*\)/g;

const STRING_ARG_RE = /^\s*(['"])([^'"]+)\1/;

function extractKeysFromSource(source) {
  const keys = new Set();
  const translators = new Map();

  let m;
  TRANSLATOR_DECL_RE.lastIndex = 0;
  while ((m = TRANSLATOR_DECL_RE.exec(source)) !== null) {
    const varName = m[1];
    const ns = m[4] || '';
    translators.set(varName, ns);
  }

  if (translators.size === 0) return keys;

  for (const [name, ns] of translators.entries()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callRe = new RegExp(
      `\\b${escaped}(?:\\.(?:rich|raw|markup|has))?\\s*\\(`,
      'g',
    );
    let cm;
    while ((cm = callRe.exec(source)) !== null) {
      const after = source.slice(cm.index + cm[0].length);
      const arg = after.match(STRING_ARG_RE);
      if (!arg) continue;
      const key = arg[2];
      if (!key) continue;
      if (!/^[A-Za-z_][\w.-]*$/.test(key)) continue;
      keys.add(ns ? `${ns}.${key}` : key);
    }
  }

  return keys;
}

function* walkSourceFiles(rootDir, options = {}) {
  const extensions = options.extensions || DEFAULT_CODE_EXTENSIONS;
  const ignored = options.ignoredDirs || DEFAULT_IGNORED_DIRS;
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.') {
        if (ignored.has(ent.name)) continue;
      }
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ignored.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name);
        if (extensions.has(ext)) yield full;
      }
    }
  }
}

function collectUsedKeys(codeDirs, options = {}) {
  const used = new Map();
  for (const dir of codeDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walkSourceFiles(dir, options)) {
      let source;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const keys = extractKeysFromSource(source);
      if (keys.size === 0) continue;
      for (const k of keys) {
        if (!used.has(k)) used.set(k, []);
        used.get(k).push(file);
      }
    }
  }
  return used;
}

function isPrefixOfAnyDefined(usedKey, definedKeys) {
  const prefix = `${usedKey}.`;
  for (const k of definedKeys) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

function auditI18n({ messagesDir, codeDirs, baseLocale = 'en', extensions, ignoredDirs } = {}) {
  if (!messagesDir) throw new Error('auditI18n: messagesDir required');
  if (!Array.isArray(codeDirs) || codeDirs.length === 0) {
    throw new Error('auditI18n: codeDirs required');
  }

  const localeKeys = loadAllLocales(messagesDir);
  if (!localeKeys.has(baseLocale)) {
    throw new Error(`auditI18n: base locale "${baseLocale}" not found in ${messagesDir}`);
  }

  const baseKeys = localeKeys.get(baseLocale);
  const usedMap = collectUsedKeys(codeDirs, { extensions, ignoredDirs });
  const usedKeys = new Set(usedMap.keys());

  const missing = [];
  for (const key of usedKeys) {
    if (baseKeys.has(key)) continue;
    if (isPrefixOfAnyDefined(key, baseKeys)) continue;
    missing.push({ key, files: usedMap.get(key) });
  }

  const unused = [];
  for (const key of baseKeys) {
    if (usedKeys.has(key)) continue;
    let coveredByPrefix = false;
    for (const u of usedKeys) {
      if (key.startsWith(`${u}.`)) {
        coveredByPrefix = true;
        break;
      }
    }
    if (!coveredByPrefix) unused.push(key);
  }

  const perLocale = {};
  for (const [locale, keys] of localeKeys.entries()) {
    if (locale === baseLocale) continue;
    const missingFromBase = [];
    const extraVsBase = [];
    for (const k of baseKeys) if (!keys.has(k)) missingFromBase.push(k);
    for (const k of keys) if (!baseKeys.has(k)) extraVsBase.push(k);
    perLocale[locale] = {
      total: keys.size,
      missingFromBase: missingFromBase.sort(),
      extraVsBase: extraVsBase.sort(),
    };
  }

  return {
    baseLocale,
    totalDefined: baseKeys.size,
    totalUsed: usedKeys.size,
    missing: missing.sort((a, b) => a.key.localeCompare(b.key)),
    unused: unused.sort(),
    perLocale,
  };
}

function formatReport(report) {
  const lines = [];
  lines.push(`i18n audit (base=${report.baseLocale})`);
  lines.push(`  defined: ${report.totalDefined}  used: ${report.totalUsed}`);
  lines.push(`  missing in base: ${report.missing.length}`);
  for (const { key, files } of report.missing.slice(0, 50)) {
    lines.push(`    - ${key}  (${files.length} ref${files.length === 1 ? '' : 's'})`);
  }
  if (report.missing.length > 50) {
    lines.push(`    … ${report.missing.length - 50} more`);
  }
  lines.push(`  unused in base: ${report.unused.length}`);
  for (const k of report.unused.slice(0, 50)) lines.push(`    - ${k}`);
  if (report.unused.length > 50) {
    lines.push(`    … ${report.unused.length - 50} more`);
  }
  const localeNames = Object.keys(report.perLocale).sort();
  lines.push(`  locales (${localeNames.length}):`);
  for (const loc of localeNames) {
    const info = report.perLocale[loc];
    lines.push(
      `    ${loc}: ${info.total} keys, missing ${info.missingFromBase.length}, extra ${info.extraVsBase.length}`,
    );
  }
  return lines.join('\n');
}

module.exports = {
  flattenKeys,
  loadMessagesFile,
  loadAllLocales,
  extractKeysFromSource,
  collectUsedKeys,
  auditI18n,
  formatReport,
};
