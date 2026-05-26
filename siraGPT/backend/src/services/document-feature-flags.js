'use strict';

/**
 * document-feature-flags.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects feature-flag identifiers across common SDK styles:
 *
 *   - LaunchDarkly:    client.variation('flag-key', user, false)
 *   - GrowthBook:      growthbook.isOn('feature-key') | growthbook.feature('x')
 *   - Split.io:        client.getTreatment('feature-name')
 *   - Unleash:         unleash.isEnabled('feature-name')
 *   - PostHog:         posthog.isFeatureEnabled('flag-name')
 *   - Generic React:   useFeatureFlag('foo-bar') | useFlag('foo')
 *   - Generic constants: FEATURE_FOO_BAR, FLAG_FOO_BAR
 *   - YAML/JSON keys:  feature_flags: { foo-bar: true }
 *
 * Public API:
 *   extractFeatureFlags(text)            → { entries, totals, total }
 *   buildFeatureFlagsForFiles(files)     → { perFile, aggregate, totals }
 *   renderFeatureFlagsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

// SDK call patterns: ident.method('flag-key' OR "flag-key")
const SDK_RE = /\b(?:variation|isOn|feature|getTreatment|isEnabled|isFeatureEnabled)\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9_\-.]{2,60})['"]/g;
// React hooks
const HOOK_RE = /\b(?:useFeatureFlag|useFlag|useFeature)\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9_\-.]{2,60})['"]/g;
// Constants
const CONST_RE = /\b(?:FEATURE|FLAG)_([A-Z][A-Z0-9_]{2,40})\b/g;
// YAML/JSON nested under feature_flags / flags / features
const NESTED_RE = /(?:feature[_-]?flags?|flags|features)\s*[:=]\s*\{[^}]{0,400}\}/gi;
const KEY_IN_NESTED_RE = /['"]?([a-zA-Z][a-zA-Z0-9_\-.]{2,50})['"]?\s*:\s*(?:true|false)/g;

const RESERVED = new Set([
  'true', 'false', 'null', 'undefined', 'enabled', 'disabled',
  'yes', 'no', 'on', 'off', 'foo', 'bar', 'baz', 'test',
]);

function looksLikeFlag(s) {
  if (!s || s.length < 3 || s.length > 60) return false;
  const lower = s.toLowerCase();
  if (RESERVED.has(lower)) return false;
  // Accept: kebab/snake/dot separator, OR PascalCase/camelCase, OR ALL_CAPS_SNAKE
  if (/[-_.]/.test(s)) return true;
  return /[a-z]/.test(s) && /[A-Z]/.test(s);
}

function classifySource(matchedAt, text) {
  const before = text.slice(Math.max(0, matchedAt - 30), matchedAt);
  if (/launchdarkly|ld\.|client\.variation/i.test(before)) return 'launchdarkly';
  if (/growthbook|gb\./i.test(before)) return 'growthbook';
  if (/split|treatments?/i.test(before)) return 'split';
  if (/unleash/i.test(before)) return 'unleash';
  if (/posthog/i.test(before)) return 'posthog';
  if (/use(?:Feature)?Flag|useFeature/.test(before)) return 'react-hook';
  return 'sdk';
}

function extractFeatureFlags(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { sdk: 0, hook: 0, constant: 0, nested: 0 };

  // SDK calls
  SDK_RE.lastIndex = 0;
  let m;
  while ((m = SDK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = m[1];
    if (!looksLikeFlag(key) || seen.has(key)) continue;
    seen.add(key);
    const src = classifySource(m.index, body);
    entries.push({ key, kind: 'sdk', source: src });
    totals.sdk += 1;
  }

  // React hooks
  if (entries.length < MAX_PER_FILE) {
    HOOK_RE.lastIndex = 0;
    while ((m = HOOK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = m[1];
      if (!looksLikeFlag(key) || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, kind: 'hook', source: 'react-hook' });
      totals.hook += 1;
    }
  }

  // Constants
  if (entries.length < MAX_PER_FILE) {
    CONST_RE.lastIndex = 0;
    while ((m = CONST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = m[1];
      if (!looksLikeFlag(key) || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, kind: 'constant', source: 'constant' });
      totals.constant += 1;
    }
  }

  // Nested YAML/JSON
  if (entries.length < MAX_PER_FILE) {
    NESTED_RE.lastIndex = 0;
    while ((m = NESTED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const block = m[0];
      KEY_IN_NESTED_RE.lastIndex = 0;
      let k;
      while ((k = KEY_IN_NESTED_RE.exec(block)) && entries.length < MAX_PER_FILE) {
        const key = k[1];
        if (!looksLikeFlag(key) || seen.has(key)) continue;
        seen.add(key);
        entries.push({ key, kind: 'nested', source: 'config' });
        totals.nested += 1;
      }
    }
  }

  return { entries, totals, total: entries.length };
}

function buildFeatureFlagsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { sdk: 0, hook: 0, constant: 0, nested: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractFeatureFlags(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.key)) continue;
      aggSeen.add(e.key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderFeatureFlagsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## FEATURE FLAGS'];
  const t = report.totals || {};
  const parts = [];
  if (t.sdk) parts.push(`SDK: ${t.sdk}`);
  if (t.hook) parts.push(`hook: ${t.hook}`);
  if (t.constant) parts.push(`constant: ${t.constant}`);
  if (t.nested) parts.push(`config: ${t.nested}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- \`${e.key}\` (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractFeatureFlags,
  buildFeatureFlagsForFiles,
  renderFeatureFlagsBlock,
  _internal: { looksLikeFlag, classifySource },
};
