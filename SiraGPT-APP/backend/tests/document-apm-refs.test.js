'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-apm-refs');
const { extractApmRefs, buildApmRefsForFiles, renderApmRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractApmRefs('').total, 0);
  assert.equal(extractApmRefs(null).total, 0);
});

test('detects Sentry issue URL', () => {
  const r = extractApmRefs('https://sentry.io/organizations/my-org/issues/12345');
  assert.ok(r.entries.some((e) => e.tool === 'sentry'));
});

test('detects sentry-event-id label', () => {
  const r = extractApmRefs('sentry-event-id: abc1234def5678aa');
  assert.ok(r.entries.some((e) => e.tool === 'sentry' && e.label === 'id-label'));
});

test('detects Datadog URL', () => {
  const r = extractApmRefs('Dashboard at https://app.datadoghq.com/dashboard/abc-123-def');
  assert.ok(r.entries.some((e) => e.tool === 'datadog'));
});

test('detects dd.trace.id', () => {
  const r = extractApmRefs('dd.trace.id: 1234567890');
  assert.ok(r.entries.some((e) => e.tool === 'datadog' && /trace/.test(e.ref)));
});

test('detects New Relic URL', () => {
  const r = extractApmRefs('https://one.newrelic.com/launcher/nr1-core.explorer');
  assert.ok(r.entries.some((e) => e.tool === 'newrelic'));
});

test('detects Honeycomb dataset URL', () => {
  const r = extractApmRefs('https://ui.honeycomb.io/myteam/datasets/api-requests');
  assert.ok(r.entries.some((e) => e.tool === 'honeycomb'));
});

test('detects Bugsnag error URL', () => {
  const r = extractApmRefs('https://app.bugsnag.com/myorg/myproj/errors/abc123');
  assert.ok(r.entries.some((e) => e.tool === 'bugsnag'));
});

test('detects Rollbar item URL', () => {
  const r = extractApmRefs('https://rollbar.com/myorg/myproj/items/4567');
  assert.ok(r.entries.some((e) => e.tool === 'rollbar'));
});

test('detects PagerDuty incident URL', () => {
  const r = extractApmRefs('https://mycorp.pagerduty.com/incidents/Q1A2B3C4');
  assert.ok(r.entries.some((e) => e.tool === 'pagerduty'));
});

test('dedupes identical refs', () => {
  const r = extractApmRefs(
    'https://sentry.io/organizations/x/issues/1 and again https://sentry.io/organizations/x/issues/1'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `https://sentry.io/organizations/x/issues/${i + 1} `;
  const r = extractApmRefs(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by tool', () => {
  const r = extractApmRefs(
    'sentry-id: aabbccdd1234 and https://app.datadoghq.com/dashboards/abc'
  );
  assert.ok(r.totals.sentry >= 1);
  assert.ok(r.totals.datadog >= 1);
});

test('buildApmRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'https://sentry.io/organizations/x/issues/1' },
    { name: 'b', extractedText: 'https://app.datadoghq.com/dashboards/y' },
  ];
  const r = buildApmRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderApmRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: 'https://sentry.io/organizations/x/issues/1' }];
  const r = buildApmRefsForFiles(files);
  const md = renderApmRefsBlock(r);
  assert.match(md, /^## APM/);
});

test('renderApmRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderApmRefsBlock({ perFile: [] }), '');
  assert.equal(renderApmRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildApmRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'https://sentry.io/organizations/x/issues/1' },
  ]);
  assert.equal(r.perFile.length, 1);
});
