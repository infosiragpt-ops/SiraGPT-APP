'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-checklists');
const { extractChecklists, buildChecklistsForFiles, renderChecklistsBlock, _internal } = engine;
const { classifyStatus, isHeading } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractChecklists('').total, 0);
  assert.equal(extractChecklists(null).total, 0);
});

test('classifyStatus: done / pending / in-progress / unclear', () => {
  assert.equal(classifyStatus('x'), 'done');
  assert.equal(classifyStatus('X'), 'done');
  assert.equal(classifyStatus(' '), 'pending');
  assert.equal(classifyStatus('/'), 'in-progress');
  assert.equal(classifyStatus('-'), 'in-progress');
  assert.equal(classifyStatus('?'), 'unclear');
});

test('isHeading: detects markdown / all-caps / bold', () => {
  assert.ok(isHeading('# Title'));
  assert.ok(isHeading('## Section'));
  assert.ok(isHeading('TODO LIST'));
  assert.ok(isHeading('**Strong heading**'));
  assert.ok(!isHeading('Regular paragraph.'));
});

test('extracts mixed done / pending items grouped by heading', () => {
  const text = `# Setup
- [x] Install dependencies
- [ ] Configure environment
- [/] Run migrations

# Deploy
- [ ] Provision instance
- [x] Push to main`;
  const r = extractChecklists(text);
  assert.equal(r.groups.length, 2);
  assert.equal(r.totals.done, 2);
  assert.equal(r.totals.pending, 2);
  assert.equal(r.totals['in-progress'], 1);
});

test('handles items without a preceding heading (Untitled bucket)', () => {
  const text = `Plain intro paragraph.

- [ ] First task
- [x] Second task`;
  const r = extractChecklists(text);
  assert.equal(r.groups.length, 1);
  assert.match(r.groups[0].heading, /Untitled/);
});

test('caps groups per file', () => {
  let text = '';
  for (let i = 0; i < 12; i++) text += `# H${i}\n- [ ] task ${i}\n\n`;
  const r = extractChecklists(text);
  assert.ok(r.groups.length <= 8);
});

test('caps items per group', () => {
  let text = '# H\n';
  for (let i = 0; i < 20; i++) text += `- [ ] task ${i}\n`;
  const r = extractChecklists(text);
  assert.equal(r.groups.length, 1);
  assert.ok(r.groups[0].items.length <= 12);
});

test('buildChecklistsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '# H\n- [x] task 1' },
    { name: 'b.md', extractedText: '# H\n- [ ] task 2' },
  ];
  const r = buildChecklistsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderChecklistsBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: '# Plan\n- [ ] task one' }];
  const r = buildChecklistsForFiles(files);
  const md = renderChecklistsBlock(r);
  assert.match(md, /^## CHECKLISTS/);
});

test('renderChecklistsBlock empty when nothing surfaces', () => {
  assert.equal(renderChecklistsBlock({ perFile: [] }), '');
  assert.equal(renderChecklistsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildChecklistsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '- [ ] foo' }]);
  assert.equal(r.perFile.length, 1);
});

test('ignores non-checkbox bullets', () => {
  const r = extractChecklists('- Just a regular bullet, no checkbox.');
  assert.equal(r.total, 0);
});
