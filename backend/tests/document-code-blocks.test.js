'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-code-blocks');
const { extractCodeBlocks, buildCodeBlocksForFiles, renderCodeBlocksBlock, _internal } = engine;
const { normaliseLanguage } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCodeBlocks('').total, 0);
  assert.equal(extractCodeBlocks(null).total, 0);
});

test('normaliseLanguage lowercases known languages', () => {
  assert.equal(normaliseLanguage('Python'), 'python');
  assert.equal(normaliseLanguage('JS'), 'js');
});

test('normaliseLanguage returns raw lowercase for unknown', () => {
  assert.equal(normaliseLanguage('weirdo'), 'weirdo');
});

test('extracts a fenced code block with language', () => {
  const text = '```python\nprint("hi")\n```';
  const r = extractCodeBlocks(text);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].language, 'python');
  assert.deepEqual(r.blocks[0].snippet, ['print("hi")']);
});

test('extracts multiple fenced blocks', () => {
  const text = '```js\nconst a = 1;\n```\n\n```python\nprint(2)\n```';
  const r = extractCodeBlocks(text);
  assert.equal(r.blocks.length, 2);
});

test('omits language when none given', () => {
  const text = '```\nplain code\n```';
  const r = extractCodeBlocks(text);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].language, null);
});

test('captures snippet length and total line count', () => {
  let body = '';
  for (let i = 0; i < 20; i++) body += `line ${i}\n`;
  const text = '```bash\n' + body + '```';
  const r = extractCodeBlocks(text);
  assert.equal(r.blocks.length, 1);
  assert.ok(r.blocks[0].snippet.length <= 12);
  assert.ok(r.blocks[0].totalLines >= 20);
});

test('caps blocks per file', () => {
  let text = '';
  for (let i = 0; i < 15; i++) text += '```js\nconst x' + i + ' = ' + i + ';\n```\n\n';
  const r = extractCodeBlocks(text);
  assert.ok(r.blocks.length <= 10);
});

test('dedupes identical blocks', () => {
  const text = '```js\nconst x = 1;\n```\n\n```js\nconst x = 1;\n```';
  const r = extractCodeBlocks(text);
  assert.equal(r.blocks.length, 1);
});

test('buildCodeBlocksForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '```js\nconst a = 1;\n```' },
    { name: 'b.md', extractedText: '```python\nprint(2)\n```' },
  ];
  const r = buildCodeBlocksForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCodeBlocksBlock returns markdown when blocks exist', () => {
  const files = [{ name: 'doc.md', extractedText: '```js\nconsole.log(1);\n```' }];
  const r = buildCodeBlocksForFiles(files);
  const md = renderCodeBlocksBlock(r);
  assert.match(md, /^## EMBEDDED CODE BLOCKS/);
});

test('renderCodeBlocksBlock empty when nothing surfaces', () => {
  assert.equal(renderCodeBlocksBlock({ perFile: [] }), '');
  assert.equal(renderCodeBlocksBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCodeBlocksForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '```\nfoo\n```' }]);
  assert.equal(r.perFile.length, 1);
});

test('ignores body without fenced markers', () => {
  const r = extractCodeBlocks('Just prose with `inline code` and indented blocks.');
  assert.equal(r.blocks.length, 0);
});
