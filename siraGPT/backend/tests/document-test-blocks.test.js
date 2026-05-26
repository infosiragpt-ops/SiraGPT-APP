'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-test-blocks');
const { extractTestBlocks, buildTestBlocksForFiles, renderTestBlocksBlock, _internal } = engine;
const { classifyKw } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTestBlocks('').total, 0);
  assert.equal(extractTestBlocks(null).total, 0);
});

test('classifyKw: groups vs cases vs hooks', () => {
  assert.equal(classifyKw('describe'), 'group');
  assert.equal(classifyKw('it'), 'case');
  assert.equal(classifyKw('beforeEach'), 'hook');
});

test('detects describe()', () => {
  const r = extractTestBlocks("describe('my suite', () => { });");
  assert.ok(r.entries.some((e) => e.kw === 'describe' && e.name === 'my suite'));
});

test('detects it()', () => {
  const r = extractTestBlocks("it('does the thing', () => { });");
  assert.ok(r.entries.some((e) => e.kw === 'it' && e.kind === 'case'));
});

test('detects test()', () => {
  const r = extractTestBlocks("test('returns 42', () => { });");
  assert.ok(r.entries.some((e) => e.kw === 'test'));
});

test('detects beforeEach hook', () => {
  const r = extractTestBlocks("beforeEach('setup', () => { });");
  assert.ok(r.entries.some((e) => e.kind === 'hook'));
});

test('detects test.only / test.skip variants', () => {
  const r = extractTestBlocks("test.only('focused', () => { });");
  assert.ok(r.entries.some((e) => e.kw === 'test'));
});

test('detects Python pytest def test_foo', () => {
  const r = extractTestBlocks('def test_my_function():\n    pass');
  assert.ok(r.entries.some((e) => e.framework === 'pytest' && e.name === 'test_my_function'));
});

test('detects Java JUnit @Test method', () => {
  const r = extractTestBlocks('@Test\n    public void shouldDoThing() throws Exception {');
  assert.ok(r.entries.some((e) => e.framework === 'junit'));
});

test('detects Go testing func', () => {
  const r = extractTestBlocks('func TestMyFunc(t *testing.T) {');
  assert.ok(r.entries.some((e) => e.framework === 'go-test' && e.name === 'TestMyFunc'));
});

test('dedupes identical entries', () => {
  const r = extractTestBlocks("it('case', ()=>{}); it('case', ()=>{})");
  assert.equal(r.entries.filter((e) => e.name === 'case' && e.kw === 'it').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `it('case ${i}', () => { });\n`;
  const r = extractTestBlocks(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by kind', () => {
  const r = extractTestBlocks(`
    describe('group', () => {
      beforeEach('setup', () => {});
      it('case-a', () => {});
      it('case-b', () => {});
    });
  `);
  assert.ok(r.totals.group >= 1);
  assert.ok(r.totals.case >= 2);
  assert.ok(r.totals.hook >= 1);
});

test('buildTestBlocksForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.test.js', extractedText: "it('a', () => {})" },
    { name: 'b.test.js', extractedText: "it('b', () => {})" },
  ];
  const r = buildTestBlocksForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTestBlocksBlock returns markdown when entries exist', () => {
  const files = [{ name: 'a.test.js', extractedText: "it('case', () => {})" }];
  const r = buildTestBlocksForFiles(files);
  const md = renderTestBlocksBlock(r);
  assert.match(md, /^## TEST BLOCKS/);
});

test('renderTestBlocksBlock empty when nothing surfaces', () => {
  assert.equal(renderTestBlocksBlock({ perFile: [] }), '');
  assert.equal(renderTestBlocksBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTestBlocksForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: "it('a', () => {})" },
  ]);
  assert.equal(r.perFile.length, 1);
});
