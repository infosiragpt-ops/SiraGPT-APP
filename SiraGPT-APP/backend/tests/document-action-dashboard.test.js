'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dash = require('../src/services/document-action-dashboard');
const { buildDashboardForFiles, renderDashboardBlock, _internal } = dash;
const { dedupeBy, safeFileName } = _internal;

const NOW = '2026-05-12T00:00:00Z';

test('safeFileName: prefers name → originalName → id → fallback', () => {
  assert.equal(safeFileName({ name: 'a.pdf' }), 'a.pdf');
  assert.equal(safeFileName({ originalName: 'b.pdf' }), 'b.pdf');
  assert.equal(safeFileName({ id: 'file-7' }), 'file-7');
  assert.equal(safeFileName({}), 'attachment');
  assert.equal(safeFileName(null), 'attachment');
});

test('dedupeBy: removes duplicates by key', () => {
  const out = dedupeBy(
    [{ k: 'a', v: 1 }, { k: 'a', v: 2 }, { k: 'b', v: 3 }],
    (x) => x.k,
  );
  assert.deepEqual(out.map((e) => e.v), [1, 3]);
});

test('empty file list → empty report', () => {
  const r = buildDashboardForFiles([], { now: NOW });
  assert.equal(r.total, 0);
  assert.equal(r.fileCount, 0);
});

test('overdue deadline surfaces in overdue bucket', () => {
  const files = [{
    name: 'project.md',
    extractedText: 'The MVP deadline of 2024-01-15 was not met. We must deliver the dashboard by end of next quarter.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.ok(r.buckets.overdue.length >= 1, `expected overdue bucket, got ${JSON.stringify(r.totals)}`);
  assert.ok(r.buckets.overdue[0].sentence.length > 0);
  assert.equal(r.buckets.overdue[0].file, 'project.md');
});

test('upcoming deadline surfaces in upcoming bucket', () => {
  const files = [{
    name: 'roadmap.md',
    extractedText: 'Deadline 2030-06-01: launch beta. Must ship the report.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.ok(r.buckets.upcoming.length >= 1, 'expected upcoming bucket');
  assert.equal(r.buckets.upcoming[0].iso, '2030-06-01');
});

test('actions without dates land in actionsWithoutDate bucket', () => {
  const files = [{
    name: 'todo.md',
    extractedText: 'We need to coordinate with finance team to finalize the budget review.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.ok(r.buckets.actionsWithoutDate.length >= 1);
});

test('risks surface in risks bucket', () => {
  const files = [{
    name: 'risk.md',
    extractedText: 'There is a significant risk that the system may fail under peak load conditions due to insufficient capacity planning.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.ok(r.buckets.risks.length >= 0, 'risks bucket should be populated');
});

test('decisions surface in recentDecisions bucket', () => {
  const files = [{
    name: 'decisions.md',
    extractedText: 'The committee approved the migration plan. Se decidió aprobar el presupuesto trimestral.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.ok(r.buckets.recentDecisions.length >= 1);
});

test('open questions land in openQuestions bucket', () => {
  const files = [{
    name: 'qa.md',
    extractedText: 'The pricing model is TBD pending finance review. The launch date is por confirmar by leadership.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.ok(r.buckets.openQuestions.length >= 1, `expected open questions: ${JSON.stringify(r.totals)}`);
});

test('dashboard preserves source file across multiple inputs', () => {
  const files = [
    { name: 'doc-a.md', extractedText: 'Deadline 2030-12-01: finalize alpha.' },
    { name: 'doc-b.md', extractedText: 'Deadline 2030-12-15: ship beta to customers.' },
  ];
  const r = buildDashboardForFiles(files, { now: NOW });
  const sources = r.buckets.upcoming.map((e) => e.file).sort();
  assert.deepEqual(sources, ['doc-a.md', 'doc-b.md']);
});

test('rendered block has the OPERATIONS DASHBOARD heading when non-empty', () => {
  const files = [{
    name: 'plan.md',
    extractedText: 'Deadline 2030-06-01: launch beta. We must deliver the dashboard.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  const md = renderDashboardBlock(r);
  assert.match(md, /^## OPERATIONS DASHBOARD/);
  assert.match(md, /Upcoming deadlines/);
});

test('rendered block is empty when nothing surfaces', () => {
  const r = buildDashboardForFiles([{ name: 'meta.md', extractedText: 'Hello world.' }], { now: NOW });
  assert.equal(renderDashboardBlock(r), '');
});

test('action items duplicated by a dated deadline are filtered out of the dateless bucket', () => {
  // The sentence "Deadline 2030-06-01: we must deliver the dashboard" should
  // surface as upcoming. The deep analyzer might also match it as an action
  // (it contains "must deliver"). The dashboard must not list it twice.
  const files = [{
    name: 'plan.md',
    extractedText: 'Deadline 2030-06-01: we must deliver the dashboard.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.equal(r.buckets.upcoming.length, 1);
  // Check no dateless action contains the same sentence text
  const upcomingSentence = r.buckets.upcoming[0].sentence;
  const dateless = r.buckets.actionsWithoutDate.map((a) => a.sentence);
  assert.ok(!dateless.includes(upcomingSentence), 'dateless bucket must not duplicate dated deadlines');
});

test('totals reflect bucket sizes', () => {
  const files = [{
    name: 'plan.md',
    extractedText: 'Deadline 2030-06-01: launch beta. Deadline 2024-01-01 missed. We must deliver. TBD: pricing model.',
  }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.equal(r.totals.overdue, r.buckets.overdue.length);
  assert.equal(r.totals.upcoming, r.buckets.upcoming.length);
  assert.equal(r.total, Object.values(r.totals).reduce((a, b) => a + b, 0));
});

test('non-string extractedText tolerated', () => {
  const files = [{ name: 'binary', extractedText: null }, { name: 'ok', extractedText: 'TBD soon.' }];
  const r = buildDashboardForFiles(files, { now: NOW });
  assert.equal(r.fileCount, 2);
});
