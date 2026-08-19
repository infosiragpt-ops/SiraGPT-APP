'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-bullet-lists');
const { extractBulletLists, buildBulletListsForFiles, renderBulletListsBlock, _internal } = engine;
const { classifyLine, isHeading } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractBulletLists('').total, 0);
  assert.equal(extractBulletLists(null).total, 0);
});

test('classifyLine: bullet / numbered / non-list', () => {
  assert.equal(classifyLine('- foo').kind, 'bullet');
  assert.equal(classifyLine('* bar').kind, 'bullet');
  assert.equal(classifyLine('1. first').kind, 'numbered');
  assert.equal(classifyLine('plain prose'), null);
});

test('classifyLine: checkbox bullets are skipped', () => {
  assert.equal(classifyLine('- [ ] task'), null);
  assert.equal(classifyLine('- [x] done'), null);
});

test('isHeading: detects markdown / all-caps', () => {
  assert.ok(isHeading('# Heading'));
  assert.ok(isHeading('## Sub'));
  assert.ok(!isHeading('regular text'));
});

test('extracts a single bullet list grouped under heading', () => {
  const text = `# Options
- Option A
- Option B
- Option C`;
  const r = extractBulletLists(text);
  assert.equal(r.lists.length, 1);
  assert.equal(r.lists[0].items.length, 3);
  assert.match(r.lists[0].heading, /Options/);
});

test('extracts a numbered list', () => {
  const text = `Steps
1. First step
2. Second step
3. Third step`;
  const r = extractBulletLists(text);
  assert.equal(r.lists.length, 1);
  assert.equal(r.lists[0].kind, 'numbered');
});

test('separates multiple lists by heading', () => {
  const text = `# Pros
- A
- B

# Cons
- X
- Y`;
  const r = extractBulletLists(text);
  assert.equal(r.lists.length, 2);
});

test('drops single-item lists (noise filter)', () => {
  const text = `# Section
- only one item

Other prose.`;
  const r = extractBulletLists(text);
  assert.equal(r.lists.length, 0);
});

test('skips checkbox items (handled by document-checklists)', () => {
  const text = `# Tasks
- [ ] task 1
- [x] task 2
- normal bullet 1
- normal bullet 2`;
  const r = extractBulletLists(text);
  // Should contain only the normal bullets
  assert.equal(r.lists.length, 1);
  assert.equal(r.lists[0].items.length, 2);
});

test('caps lists per file', () => {
  let text = '';
  for (let i = 0; i < 12; i++) text += `# H${i}\n- a\n- b\n\n`;
  const r = extractBulletLists(text);
  assert.ok(r.lists.length <= 8);
});

test('caps items per list', () => {
  let text = '# H\n';
  for (let i = 0; i < 20; i++) text += `- item ${i}\n`;
  const r = extractBulletLists(text);
  assert.equal(r.lists.length, 1);
  assert.ok(r.lists[0].items.length <= 12);
});

test('buildBulletListsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '# H\n- a\n- b' },
    { name: 'b.md', extractedText: '# H\n- c\n- d' },
  ];
  const r = buildBulletListsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBulletListsBlock returns markdown when lists exist', () => {
  const files = [{ name: 'doc.md', extractedText: '# H\n- a\n- b' }];
  const r = buildBulletListsForFiles(files);
  const md = renderBulletListsBlock(r);
  assert.match(md, /^## STRUCTURED LISTS/);
});

test('renderBulletListsBlock empty when nothing surfaces', () => {
  assert.equal(renderBulletListsBlock({ perFile: [] }), '');
  assert.equal(renderBulletListsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBulletListsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '# H\n- x\n- y' }]);
  assert.equal(r.perFile.length, 1);
});
