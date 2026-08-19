#!/usr/bin/env node
/**
 * scripts/check-locales.js
 *
 * i18n drift detector. Compares messages/en.json against every other
 * messages/<locale>.json file (primary focus: es.json) and reports:
 *   - keys present in en.json but missing in the other locale
 *   - keys present in the other locale but missing in en.json
 *   - empty string values in any locale
 *
 * Exits non-zero if any drift is detected. Wire into pre-commit / CI:
 *   node scripts/check-locales.js
 *
 * The check is recursive — nested objects are flattened to dotted paths
 * (e.g. "sidebar.newChat"). Arrays are treated as terminal values.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MESSAGES_DIR = path.resolve(__dirname, '..', 'messages');
const REFERENCE_LOCALE = 'en';
const PRIMARY_TARGET = 'es';

function flatten(obj, prefix = '', out = new Map()) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    out.set(prefix, obj);
    return out;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    out.set(prefix, obj);
    return out;
  }
  for (const k of keys) {
    const next = prefix ? `${prefix}.${k}` : k;
    flatten(obj[k], next, out);
  }
  return out;
}

function loadLocale(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function isEmptyValue(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function diffLocales(referenceMap, targetMap) {
  const missingInTarget = [];
  const extraInTarget = [];
  for (const k of referenceMap.keys()) {
    if (!targetMap.has(k)) missingInTarget.push(k);
  }
  for (const k of targetMap.keys()) {
    if (!referenceMap.has(k)) extraInTarget.push(k);
  }
  return { missingInTarget, extraInTarget };
}

function emptyValueKeys(map) {
  const out = [];
  for (const [k, v] of map) if (isEmptyValue(v)) out.push(k);
  return out;
}

function main() {
  if (!fs.existsSync(MESSAGES_DIR)) {
    console.error(`[check-locales] messages directory not found: ${MESSAGES_DIR}`);
    process.exit(2);
  }
  const files = fs
    .readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (!files.includes(`${REFERENCE_LOCALE}.json`)) {
    console.error(`[check-locales] reference locale ${REFERENCE_LOCALE}.json missing`);
    process.exit(2);
  }

  const refMap = flatten(loadLocale(path.join(MESSAGES_DIR, `${REFERENCE_LOCALE}.json`)));
  let drift = false;

  // Empty values in reference locale
  const refEmpty = emptyValueKeys(refMap);
  if (refEmpty.length) {
    drift = true;
    console.error(`\n[${REFERENCE_LOCALE}] empty values (${refEmpty.length}):`);
    refEmpty.forEach((k) => console.error(`  - ${k}`));
  }

  for (const file of files) {
    const locale = file.replace(/\.json$/, '');
    if (locale === REFERENCE_LOCALE) continue;
    const targetMap = flatten(loadLocale(path.join(MESSAGES_DIR, file)));
    const { missingInTarget, extraInTarget } = diffLocales(refMap, targetMap);
    const empties = emptyValueKeys(targetMap);

    // Primary target (es) — report both directions explicitly per task spec.
    if (locale === PRIMARY_TARGET) {
      if (missingInTarget.length) {
        drift = true;
        console.error(`\n[${locale}] keys in ${REFERENCE_LOCALE}.json but not in ${locale}.json (${missingInTarget.length}):`);
        missingInTarget.forEach((k) => console.error(`  - ${k}`));
      }
      if (extraInTarget.length) {
        drift = true;
        console.error(`\n[${locale}] keys in ${locale}.json but not in ${REFERENCE_LOCALE}.json (${extraInTarget.length}):`);
        extraInTarget.forEach((k) => console.error(`  - ${k}`));
      }
    } else {
      // Other locales — still report drift but compactly.
      if (missingInTarget.length) {
        drift = true;
        console.error(`\n[${locale}] missing ${missingInTarget.length} keys vs ${REFERENCE_LOCALE}.json (first 5): ${missingInTarget.slice(0, 5).join(', ')}`);
      }
      if (extraInTarget.length) {
        drift = true;
        console.error(`\n[${locale}] has ${extraInTarget.length} extra keys vs ${REFERENCE_LOCALE}.json (first 5): ${extraInTarget.slice(0, 5).join(', ')}`);
      }
    }

    if (empties.length) {
      drift = true;
      console.error(`\n[${locale}] empty values (${empties.length})${empties.length > 10 ? ` (first 10)` : ''}:`);
      empties.slice(0, 10).forEach((k) => console.error(`  - ${k}`));
    }
  }

  if (drift) {
    console.error('\n[check-locales] drift detected — see above.');
    process.exit(1);
  }
  console.log(`[check-locales] OK — ${files.length} locale files in sync with ${REFERENCE_LOCALE}.json`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[check-locales] fatal:', err?.stack || err?.message || err);
    process.exit(2);
  }
}

module.exports = { flatten, diffLocales, emptyValueKeys, isEmptyValue };
