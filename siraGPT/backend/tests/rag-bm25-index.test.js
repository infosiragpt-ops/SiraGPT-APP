'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createBm25Index,
  defaultTokenize,
  DEFAULT_STOPWORDS,
} = require('../src/services/rag/bm25');

describe('defaultTokenize', () => {
  test('lowercases and splits on non-alphanum unicode-aware', () => {
    const t = defaultTokenize('Hola, ¿cómo estás? Niño', new Set());
    assert.deepEqual(t, ['hola', 'cómo', 'estás', 'niño']);
  });
  test('drops stopwords', () => {
    const t = defaultTokenize('the cat is on the mat', new Set(['the', 'is', 'on']));
    assert.deepEqual(t, ['cat', 'mat']);
  });
  test('empty / null returns []', () => {
    assert.deepEqual(defaultTokenize('', new Set()), []);
    assert.deepEqual(defaultTokenize(null, new Set()), []);
  });
});

describe('createBm25Index — add / search basics', () => {
  test('exact-term query returns matching doc', () => {
    const idx = createBm25Index({});
    idx.add('d1', 'apples and bananas');
    idx.add('d2', 'oranges and grapes');
    const r = idx.search('apples');
    assert.equal(r[0].id, 'd1');
    assert.ok(r[0].score > 0);
  });

  test('rare term scores higher than common term', () => {
    const idx = createBm25Index({});
    idx.addBatch([
      { id: '1', text: 'cat dog' },
      { id: '2', text: 'cat fish' },
      { id: '3', text: 'cat bird' },
      { id: '4', text: 'cat penguin rare' },
    ]);
    const r = idx.search('rare');
    assert.equal(r[0].id, '4');
  });

  test('topK respected', () => {
    const idx = createBm25Index({});
    for (let i = 0; i < 10; i++) idx.add(`d${i}`, `match ${i}`);
    const r = idx.search('match', { topK: 3 });
    assert.equal(r.length, 3);
  });

  test('empty index returns []', () => {
    const idx = createBm25Index({});
    assert.deepEqual(idx.search('anything'), []);
  });

  test('query with only stopwords returns []', () => {
    const idx = createBm25Index({});
    idx.add('d1', 'hello world');
    assert.deepEqual(idx.search('the and of'), []);
  });
});

describe('createBm25Index — remove + reindex', () => {
  test('remove drops doc from search results', () => {
    const idx = createBm25Index({});
    idx.add('d1', 'apple');
    idx.add('d2', 'apple banana');
    assert.equal(idx.search('apple').length, 2);
    assert.equal(idx.remove('d1'), true);
    assert.equal(idx.search('apple').length, 1);
    assert.equal(idx.search('apple')[0].id, 'd2');
  });

  test('remove of unknown id returns false', () => {
    const idx = createBm25Index({});
    assert.equal(idx.remove('nope'), false);
  });

  test('re-adding same id replaces previous content', () => {
    const idx = createBm25Index({});
    idx.add('d1', 'apple');
    idx.add('d1', 'banana');
    assert.equal(idx.search('apple').length, 0);
    assert.equal(idx.search('banana').length, 1);
  });
});

describe('createBm25Index — length normalization', () => {
  test('shorter doc with same TF scores higher than longer doc', () => {
    const idx = createBm25Index({});
    idx.add('short', 'apple');
    idx.add('long', 'apple ' + 'filler '.repeat(50));
    const r = idx.search('apple');
    const sShort = r.find((x) => x.id === 'short').score;
    const sLong = r.find((x) => x.id === 'long').score;
    assert.ok(sShort > sLong, `short=${sShort} long=${sLong}`);
  });
});

describe('createBm25Index — guards + snapshot', () => {
  test('add rejects null id', () => {
    const idx = createBm25Index({});
    assert.throws(() => idx.add(null, 'x'), TypeError);
  });

  test('addBatch rejects non-array', () => {
    const idx = createBm25Index({});
    assert.throws(() => idx.addBatch('nope'), TypeError);
  });

  test('snapshot reports docs/uniqueTerms/avgDocLength', () => {
    const idx = createBm25Index({});
    idx.add('d1', 'apple banana');
    idx.add('d2', 'apple cherry');
    const s = idx.snapshot();
    assert.equal(s.docs, 2);
    assert.ok(s.uniqueTerms >= 3);
    assert.ok(s.avgDocLength > 0);
  });
});

describe('createBm25Index — custom tokenizer + stopwords', () => {
  test('custom tokenize hook is honored', () => {
    let calls = 0;
    const idx = createBm25Index({ tokenize: (txt) => { calls += 1; return [txt]; } });
    idx.add('d1', 'whole-as-one-token');
    idx.search('whole-as-one-token');
    assert.ok(calls >= 2);
  });

  test('custom stopwords narrow the default list', () => {
    const idx = createBm25Index({ stopwords: new Set(['x']) });
    idx.add('d1', 'the apple x');
    // 'the' is no longer a stopword, so 'the' should match.
    const r = idx.search('the');
    assert.equal(r.length, 1);
  });

  test('default stopwords cover common ES + EN', () => {
    assert.ok(DEFAULT_STOPWORDS.has('the'));
    assert.ok(DEFAULT_STOPWORDS.has('el'));
  });
});
