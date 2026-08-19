'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-feature-flags');
const { extractFeatureFlags, buildFeatureFlagsForFiles, renderFeatureFlagsBlock, _internal } = engine;
const { looksLikeFlag } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractFeatureFlags('').total, 0);
  assert.equal(extractFeatureFlags(null).total, 0);
});

test('looksLikeFlag: requires separator or PascalCase', () => {
  assert.equal(looksLikeFlag('new-checkout-flow'), true);
  assert.equal(looksLikeFlag('newCheckoutFlow'), true);
  assert.equal(looksLikeFlag('foo'), false);
  assert.equal(looksLikeFlag('true'), false);
});

test('detects LaunchDarkly variation()', () => {
  const r = extractFeatureFlags("client.variation('new-checkout-flow', user, false);");
  assert.ok(r.entries.some((e) => e.key === 'new-checkout-flow'));
});

test('detects GrowthBook isOn()', () => {
  const r = extractFeatureFlags("growthbook.isOn('dark-mode-v2')");
  assert.ok(r.entries.some((e) => e.key === 'dark-mode-v2'));
});

test('detects Split getTreatment()', () => {
  const r = extractFeatureFlags("split.getTreatment('show-banner')");
  assert.ok(r.entries.some((e) => e.key === 'show-banner'));
});

test('detects Unleash isEnabled()', () => {
  const r = extractFeatureFlags("unleash.isEnabled('beta-features')");
  assert.ok(r.entries.some((e) => e.key === 'beta-features'));
});

test('detects PostHog isFeatureEnabled()', () => {
  const r = extractFeatureFlags("posthog.isFeatureEnabled('experiment-foo')");
  assert.ok(r.entries.some((e) => e.key === 'experiment-foo'));
});

test('detects React useFeatureFlag()', () => {
  const r = extractFeatureFlags("const enabled = useFeatureFlag('new-dashboard');");
  assert.ok(r.entries.some((e) => e.key === 'new-dashboard'));
});

test('detects FEATURE_ constants', () => {
  const r = extractFeatureFlags('if (FEATURE_DARK_MODE) { ... }');
  assert.ok(r.entries.some((e) => e.key === 'DARK_MODE'));
});

test('rejects reserved words', () => {
  const r = extractFeatureFlags("client.variation('true', user)");
  assert.equal(r.entries.length, 0);
});

test('dedupes identical keys', () => {
  const r = extractFeatureFlags("isOn('foo-bar') and isOn('foo-bar') again");
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `isEnabled('flag-name-${i}'); `;
  const r = extractFeatureFlags(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractFeatureFlags("isOn('a-b') and useFeatureFlag('c-d') and FEATURE_X_Y enabled");
  assert.ok(r.totals.sdk >= 1);
  assert.ok(r.totals.hook >= 1);
  assert.ok(r.totals.constant >= 1);
});

test('buildFeatureFlagsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.js', extractedText: "isOn('foo-bar')" },
    { name: 'b.js', extractedText: "useFlag('baz-qux')" },
  ];
  const r = buildFeatureFlagsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFeatureFlagsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'a.js', extractedText: "isOn('foo-bar')" }];
  const r = buildFeatureFlagsForFiles(files);
  const md = renderFeatureFlagsBlock(r);
  assert.match(md, /^## FEATURE FLAGS/);
});

test('renderFeatureFlagsBlock empty when nothing surfaces', () => {
  assert.equal(renderFeatureFlagsBlock({ perFile: [] }), '');
  assert.equal(renderFeatureFlagsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFeatureFlagsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: "isOn('foo-bar')" },
  ]);
  assert.equal(r.perFile.length, 1);
});
