'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createTrie } = require('../src/utils/trie');

describe('createTrie — basic', () => {
  test('add then has → true; missing → false', () => {
    const t = createTrie();
    t.add('search');
    assert.equal(t.has('search'), true);
    assert.equal(t.has('seek'), false);
    assert.equal(t.has(''), false);
  });

  test('add carries optional value, get returns it', () => {
    const t = createTrie();
    t.add('foo', { handler: 'fn' });
    assert.deepEqual(t.get('foo'), { handler: 'fn' });
    assert.equal(t.get('bar'), undefined);
  });

  test('add rejects empty / non-string word', () => {
    const t = createTrie();
    assert.throws(() => t.add(''), TypeError);
    assert.throws(() => t.add(null), TypeError);
  });
});

describe('createTrie — size + duplicate add', () => {
  test('size only increments on new terminal nodes', () => {
    const t = createTrie();
    t.add('a'); t.add('b'); t.add('a');
    assert.equal(t.size(), 2);
  });

  test('re-add updates value without inflating size', () => {
    const t = createTrie();
    t.add('cmd', 1);
    t.add('cmd', 2);
    assert.equal(t.size(), 1);
    assert.equal(t.get('cmd'), 2);
  });
});

describe('createTrie — remove', () => {
  test('removes terminal flag + trims dead nodes', () => {
    const t = createTrie();
    t.add('cat'); t.add('car');
    assert.equal(t.remove('cat'), true);
    assert.equal(t.has('cat'), false);
    assert.equal(t.has('car'), true);
    assert.equal(t.size(), 1);
  });

  test('does not delete prefix shared with another word', () => {
    const t = createTrie();
    t.add('search'); t.add('searcher');
    t.remove('search');
    assert.equal(t.has('searcher'), true);
  });

  test('returns false for unknown / empty word', () => {
    const t = createTrie();
    assert.equal(t.remove('never'), false);
    assert.equal(t.remove(''), false);
  });
});

describe('createTrie — prefixSearch', () => {
  test('returns all words starting with prefix', () => {
    const t = createTrie();
    ['search', 'seek', 'select', 'send'].forEach((w) => t.add(w));
    const r = t.prefixSearch('se').map((x) => x.word);
    assert.deepEqual(r.sort(), ['search', 'seek', 'select', 'send']);
  });

  test('limit caps results', () => {
    const t = createTrie();
    for (let i = 0; i < 100; i++) t.add(`cmd_${i}`);
    const r = t.prefixSearch('cmd_', { limit: 5 });
    assert.equal(r.length, 5);
  });

  test('non-existent prefix → []', () => {
    const t = createTrie();
    t.add('apple');
    assert.deepEqual(t.prefixSearch('zz'), []);
  });

  test('prefix that is itself a word includes that word', () => {
    const t = createTrie();
    t.add('go'); t.add('gone'); t.add('golf');
    const r = t.prefixSearch('go').map((x) => x.word);
    assert.ok(r.includes('go'));
    assert.ok(r.includes('gone'));
    assert.ok(r.includes('golf'));
  });

  test('empty prefix yields every word', () => {
    const t = createTrie();
    ['a', 'b', 'c'].forEach((w) => t.add(w));
    const r = t.prefixSearch('').map((x) => x.word);
    assert.deepEqual(r.sort(), ['a', 'b', 'c']);
  });
});

describe('createTrie — Unicode safety', () => {
  test('multi-byte chars work end-to-end', () => {
    const t = createTrie();
    t.add('niño');
    t.add('niñería');
    assert.equal(t.has('niño'), true);
    const r = t.prefixSearch('niñ').map((x) => x.word);
    assert.ok(r.includes('niño'));
    assert.ok(r.includes('niñería'));
  });

  test('emoji as a code-point (basic)', () => {
    const t = createTrie();
    t.add('hi👋');
    assert.equal(t.has('hi👋'), true);
  });
});
