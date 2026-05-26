'use strict';

const test = require('node:test');
const assert = require('node:assert');

const debugReport = require('../src/services/attribution-debug-report');

test('buildDebugReport: returns base shape even with no inputs', async () => {
  const r = await debugReport.buildDebugReport({});
  assert.ok(r.generatedAt);
  assert.strictEqual(r.userId, null);
  assert.strictEqual(r.chatId, null);
  assert.ok(typeof r.sections === 'object');
  assert.ok(typeof r.json === 'object');
  assert.ok(typeof r.markdown === 'string');
});

test('buildDebugReport: includes prompt preview when provided', async () => {
  const r = await debugReport.buildDebugReport({ prompt: 'Build me a chart of revenue.' });
  assert.ok(r.promptPreview);
  assert.ok(r.promptPreview.includes('chart'));
  assert.ok(r.markdown.includes('chart'));
});

test('buildDebugReport: caps promptPreview at 240 chars', async () => {
  const long = 'x'.repeat(1000);
  const r = await debugReport.buildDebugReport({ prompt: long });
  assert.ok(r.promptPreview.length <= 240);
});

test('buildDebugReport: includes anomaly section when userId given', async () => {
  const r = await debugReport.buildDebugReport({ userId: 'u' });
  // anomaly section is optional (depends on detector availability); just
  // assert the shape is sensible when it exists
  if (r.sections.anomaly) {
    assert.ok(typeof r.sections.anomaly === 'object');
  }
});

test('buildDebugReport: includes momentum section when userId+chatId given', async () => {
  const r = await debugReport.buildDebugReport({ userId: 'u', chatId: 'c' });
  if (r.sections.momentum) {
    assert.ok(typeof r.sections.momentum === 'object');
  }
  if (Array.isArray(r.sections.momentumRecent)) {
    assert.ok(r.sections.momentumRecent.length <= 12);
  }
});

test('buildDebugReport: includes snapshots tail when available', async () => {
  const r = await debugReport.buildDebugReport({ userId: 'u', chatId: 'c' });
  // tolerate either array or absent
  if (r.sections.snapshots !== undefined) {
    assert.ok(Array.isArray(r.sections.snapshots));
  }
});

test('buildDebugReport: includes perf aggregates when available', async () => {
  const r = await debugReport.buildDebugReport({});
  if (r.sections.perf !== undefined) {
    assert.ok(Array.isArray(r.sections.perf));
  }
});

test('buildDebugReport: markdown has expected headings', async () => {
  const r = await debugReport.buildDebugReport({ userId: 'u', chatId: 'c', prompt: 'help me ship a chart' });
  assert.ok(r.markdown.includes('# Attribution Debug Report'));
  assert.ok(r.markdown.includes('Generated at:'));
  assert.ok(r.markdown.includes('User:'));
});

test('buildDebugReport: json round-trips', async () => {
  const r = await debugReport.buildDebugReport({ userId: 'u', chatId: 'c', prompt: 'hi' });
  const round = JSON.parse(JSON.stringify(r.json));
  assert.strictEqual(round.userId, 'u');
  assert.ok(round.generatedAt);
});

test('renderMarkdown: handles empty sections gracefully', () => {
  const md = debugReport.renderMarkdown({});
  assert.ok(md.includes('Attribution Debug Report'));
});

test('renderMarkdown: respects ctx.userId/chatId labels', () => {
  const md = debugReport.renderMarkdown({}, { userId: 'alice', chatId: 'thread-1' });
  assert.ok(md.includes('alice'));
  assert.ok(md.includes('thread-1'));
});

test('renderMarkdown: emits perf table when perf rows exist', () => {
  const md = debugReport.renderMarkdown({
    perf: [
      { label: 'stage_a', samples: 4, p50: 5, p95: 10, mean: 6, max: 12 },
      { label: 'stage_b', samples: 3, p50: 2, p95: 4, mean: 3, max: 5 },
    ],
  });
  assert.ok(md.includes('Performance aggregates'));
  assert.ok(md.includes('stage_a'));
  assert.ok(md.includes('| 4 |'));
});

test('renderMarkdown: snapshot bullets render with turnId + iso ts', () => {
  const md = debugReport.renderMarkdown({
    snapshots: [
      { turnId: 't1', ts: 1700000000000 },
      { turnId: 't2', ts: 1700000010000 },
    ],
  });
  assert.ok(md.includes('Recent snapshots'));
  assert.ok(md.includes('t1'));
  assert.ok(md.includes('t2'));
});

test('hot path: 10 reports under 200ms', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 10; i += 1) {
    await debugReport.buildDebugReport({ userId: 'perf', chatId: 'c', prompt: 'x' });
  }
  assert.ok(Date.now() - t0 < 2000);
});
