'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  splitText,
  splitWithMetadata,
  DEFAULT_CHUNK_SIZE,
} = require('../src/services/rag/recursive-splitter');

describe('splitText — short input', () => {
  test('text under chunkSize is returned as a single chunk', () => {
    const r = splitText('hello world', { chunkSize: 100 });
    assert.deepEqual(r, ['hello world']);
  });

  test('empty / non-string returns []', () => {
    assert.deepEqual(splitText(''), []);
    assert.deepEqual(splitText(null), []);
  });
});

describe('splitText — chunkSize enforcement', () => {
  test('every chunk is ≤ chunkSize', () => {
    const big = 'palabra '.repeat(500); // ~4000 chars
    const chunks = splitText(big, { chunkSize: 200, chunkOverlap: 0 });
    for (const c of chunks) assert.ok(c.length <= 200, `chunk len ${c.length}`);
  });

  test('long single word forces hard chop at chunk boundary', () => {
    const big = 'a'.repeat(500);
    const chunks = splitText(big, { chunkSize: 100, chunkOverlap: 0 });
    assert.equal(chunks.length, 5);
    for (const c of chunks) assert.equal(c.length, 100);
  });
});

describe('splitText — semantic boundary preference', () => {
  test('paragraph break preferred over mid-sentence cut', () => {
    const text = 'p1 paragraph one content here.\n\np2 second paragraph here.';
    const chunks = splitText(text, { chunkSize: 35, chunkOverlap: 0 });
    // The \n\n should be preferred — both paragraphs should land in
    // their own chunk.
    assert.ok(chunks.some((c) => c.includes('p1')));
    assert.ok(chunks.some((c) => c.includes('p2')));
  });
});

describe('splitText — overlap', () => {
  test('overlap carries tail into next chunk', () => {
    const text = ('seg-a '.repeat(20) + 'seg-b '.repeat(20)).trim();
    const chunks = splitText(text, { chunkSize: 60, chunkOverlap: 20 });
    assert.ok(chunks.length >= 2);
    // Each non-first chunk should start with content from previous chunk's tail.
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-20);
      assert.ok(chunks[i].startsWith(tail), `chunk ${i} missing overlap`);
    }
  });

  test('overlap=0 produces no carryover', () => {
    const text = 'abcdef '.repeat(50);
    const chunks = splitText(text, { chunkSize: 30, chunkOverlap: 0 });
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(!chunks[i].startsWith(chunks[i - 1].slice(-5)));
    }
  });

  test('overlap >= chunkSize throws', () => {
    assert.throws(() => splitText('x'.repeat(100), { chunkSize: 10, chunkOverlap: 10 }), RangeError);
  });
});

describe('splitText — defaults', () => {
  test('default chunkSize is 1000', () => {
    assert.equal(DEFAULT_CHUNK_SIZE, 1000);
  });

  test('uses defaults when no options provided', () => {
    const r = splitText('short');
    assert.deepEqual(r, ['short']);
  });
});

describe('splitText — custom separators', () => {
  test('custom separator ladder is honored', () => {
    const text = 'A|B|C|D|E';
    const chunks = splitText(text, { chunkSize: 2, chunkOverlap: 0, separators: ['|', ''] });
    assert.deepEqual(chunks, ['A', 'B', 'C', 'D', 'E']);
  });
});

describe('splitWithMetadata', () => {
  test('returns text + start/end + index for each chunk', () => {
    const text = 'palabra '.repeat(50);
    const chunks = splitWithMetadata(text, { chunkSize: 80, chunkOverlap: 0 });
    assert.ok(chunks.length > 1);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].index, i);
      assert.ok(chunks[i].text.length > 0);
      assert.ok(chunks[i].start >= 0);
      assert.equal(chunks[i].end, chunks[i].start + chunks[i].text.length);
    }
  });

  test('first chunk starts at offset 0', () => {
    const r = splitWithMetadata('A '.repeat(100), { chunkSize: 50 });
    assert.equal(r[0].start, 0);
  });
});
