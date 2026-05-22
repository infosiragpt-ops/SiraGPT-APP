'use strict';

/**
 * Drift guard: the litellm Proxy yaml's `fallbacks` block must mirror
 * the chains declared in `backend/src/services/ai/failover-policy.js`.
 * If you intentionally diverge (e.g. dropping a deprecated model from
 * the proxy), add it to INTENTIONAL_DIVERGENCES below with a comment
 * so the next reader knows why.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _DEFAULT_CHAINS } = require('../src/services/ai/failover-policy');

const YAML_PATH = path.join(__dirname, '..', '..', 'infra', 'litellm', 'config.example.yaml');

// Tiny inline parser — we only need `model_list[].model_name` and the
// `fallbacks:` block under `litellm_settings`. Pulling in js-yaml just
// for a drift test would be overkill.
function parseYamlEssentials(text) {
  const lines = text.split(/\r?\n/);
  const modelNames = [];
  const fallbackChains = {}; // primary → string[]
  let inFallbacks = false;
  let fallbacksIndent = -1;
  for (const line of lines) {
    const modelMatch = line.match(/^\s*-\s*model_name:\s*(\S+)\s*$/);
    if (modelMatch) modelNames.push(modelMatch[1]);

    if (/^\s*fallbacks:\s*$/.test(line)) {
      inFallbacks = true;
      fallbacksIndent = line.match(/^(\s*)/)[1].length;
      continue;
    }
    if (inFallbacks) {
      const stripped = line.replace(/\s+$/, '');
      if (!stripped.trim()) continue;
      const indent = line.match(/^(\s*)/)[1].length;
      // Fallbacks block ends when indentation drops back to or past the
      // `fallbacks:` indent and the line isn't a list item.
      if (indent <= fallbacksIndent && !/^\s*-\s/.test(line)) {
        inFallbacks = false;
        continue;
      }
      const entry = line.match(/^\s*-\s*([A-Za-z0-9._/-]+):\s*\[([^\]]*)\]\s*$/);
      if (entry) {
        const [, key, arr] = entry;
        const chain = arr
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        fallbackChains[key] = chain;
      }
    }
  }
  return { modelNames, fallbackChains };
}

// Models from failover-policy that are intentionally NOT routed through
// the proxy (left to the legacy direct path for some reason).
const INTENTIONAL_DIVERGENCES = new Set([
  // none yet — add with a rationale comment.
]);

test('yaml model_list contains every model named in failover-policy chains', () => {
  const yamlText = fs.readFileSync(YAML_PATH, 'utf8');
  const { modelNames, fallbackChains } = parseYamlEssentials(yamlText);

  const referenced = new Set();
  for (const [primary, chain] of Object.entries(_DEFAULT_CHAINS)) {
    referenced.add(primary);
    for (const m of chain) referenced.add(m);
  }
  // Also include every fallback model the yaml itself references — those
  // must exist in model_list or the proxy will 500 at runtime.
  for (const [primary, chain] of Object.entries(fallbackChains)) {
    referenced.add(primary);
    for (const m of chain) referenced.add(m);
  }

  const declared = new Set(modelNames);
  const missing = [...referenced].filter(
    (m) => !declared.has(m) && !INTENTIONAL_DIVERGENCES.has(m),
  );
  assert.deepEqual(
    missing,
    [],
    `Models referenced in failover chains but missing from yaml model_list: ${missing.join(', ')}`,
  );
});

test('yaml fallback chains mirror failover-policy DEFAULT_CHAINS (tail-equal)', () => {
  const yamlText = fs.readFileSync(YAML_PATH, 'utf8');
  const { fallbackChains } = parseYamlEssentials(yamlText);

  const mismatches = [];
  for (const [primary, chain] of Object.entries(_DEFAULT_CHAINS)) {
    if (INTENTIONAL_DIVERGENCES.has(primary)) continue;
    // failover-policy chains lead with the primary itself; the yaml
    // `fallbacks:` block lists only the *tail* (the proxy already knows
    // the primary because it's the dict key).
    const expectedTail = chain.filter((m) => m !== primary);
    const actualTail = fallbackChains[primary];
    if (!actualTail) {
      mismatches.push(`${primary}: missing in yaml`);
      continue;
    }
    if (JSON.stringify(actualTail) !== JSON.stringify(expectedTail)) {
      mismatches.push(
        `${primary}: yaml=[${actualTail.join(',')}] expected=[${expectedTail.join(',')}]`,
      );
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    `yaml fallback chains drifted from failover-policy:\n  ${mismatches.join('\n  ')}`,
  );
});
