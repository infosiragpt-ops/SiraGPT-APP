'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  extractCodeBlocks,
  extractFirstByLang,
  stripCodeBlocks,
} = require('../src/utils/code-fence-extractor');

describe('extractCodeBlocks — basic', () => {
  test('single ```js block', () => {
    const text = 'before\n```js\nconsole.log(1)\n```\nafter';
    const blocks = extractCodeBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[0].content, 'console.log(1)');
    assert.equal(blocks[0].closed, true);
  });

  test('no fence → []', () => {
    assert.deepEqual(extractCodeBlocks('plain text only'), []);
  });

  test('empty / null input → []', () => {
    assert.deepEqual(extractCodeBlocks(''), []);
    assert.deepEqual(extractCodeBlocks(null), []);
  });

  test('block without lang has empty lang', () => {
    const text = '```\nfoo\n```';
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.lang, '');
    assert.equal(b.content, 'foo');
  });
});

describe('extractCodeBlocks — fence variants', () => {
  test('tilde fence', () => {
    const text = '~~~py\nprint(1)\n~~~';
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.lang, 'py');
    assert.equal(b.content, 'print(1)');
  });

  test('longer opening fence requires equal-or-longer closer', () => {
    const text = '````json\n{"a":1}\n```\nstill inside\n````';
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.lang, 'json');
    assert.equal(b.content, '{"a":1}\n```\nstill inside');
  });

  test('mixed back-tick + tilde do not close each other', () => {
    const text = '```\nhello\n~~~\nstill inside\n```';
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.content, 'hello\n~~~\nstill inside');
  });

  test('two adjacent blocks both extracted', () => {
    const text = '```js\na\n```\n\n```py\nb\n```';
    const blocks = extractCodeBlocks(text);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[1].lang, 'py');
  });

  test('unclosed block is reported with closed:false', () => {
    const text = '```ts\nstart-only';
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.closed, false);
    assert.equal(b.content, 'start-only');
  });
});

describe('extractCodeBlocks — indented fence', () => {
  test('up-to-3-space-indent is honored and stripped from content', () => {
    const text = '   ```js\n   line1\n   line2\n   ```';
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.lang, 'js');
    assert.equal(b.content, 'line1\nline2');
  });
});

describe('extractCodeBlocks — line ranges', () => {
  test('startLine and endLine point at the fences', () => {
    const text = ['intro', '```js', 'a', 'b', '```', 'outro'].join('\n');
    const b = extractCodeBlocks(text)[0];
    assert.equal(b.startLine, 1);
    assert.equal(b.endLine, 4);
  });
});

describe('extractFirstByLang', () => {
  test('returns first match (case-insensitive)', () => {
    const text = '```py\nx\n```\n```JS\ny\n```\n```js\nz\n```';
    const b = extractFirstByLang(text, 'js');
    assert.equal(b.content, 'y');
  });
  test('null when no match', () => {
    assert.equal(extractFirstByLang('```py\nx\n```', 'rb'), null);
  });
});

describe('stripCodeBlocks', () => {
  test('removes fenced blocks, leaves prose', () => {
    const text = 'before\n```\ncode\n```\nafter';
    const out = stripCodeBlocks(text);
    assert.ok(out.includes('before'));
    assert.ok(out.includes('after'));
    assert.ok(!out.includes('code'));
  });
  test('no fences → unchanged', () => {
    assert.equal(stripCodeBlocks('hello'), 'hello');
  });
  test('empty input → empty string', () => {
    assert.equal(stripCodeBlocks(null), '');
  });
});
