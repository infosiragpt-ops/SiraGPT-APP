'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createPriorityQueue } = require('../src/utils/priority-queue');

describe('createPriorityQueue — min-heap', () => {
  test('pop returns smallest first', () => {
    const pq = createPriorityQueue({});
    [5, 3, 9, 1, 7].forEach((n) => pq.push(n));
    const out = pq.drain();
    assert.deepEqual(out, [1, 3, 5, 7, 9]);
  });

  test('peek does not consume', () => {
    const pq = createPriorityQueue({});
    pq.push(2); pq.push(5); pq.push(1);
    assert.equal(pq.peek(), 1);
    assert.equal(pq.size(), 3);
  });

  test('pop on empty returns undefined', () => {
    const pq = createPriorityQueue({});
    assert.equal(pq.pop(), undefined);
    assert.equal(pq.peek(), undefined);
  });
});

describe('createPriorityQueue — max-heap', () => {
  test('pop returns largest first when max:true', () => {
    const pq = createPriorityQueue({ max: true });
    [5, 3, 9, 1, 7].forEach((n) => pq.push(n));
    assert.deepEqual(pq.drain(), [9, 7, 5, 3, 1]);
  });
});

describe('createPriorityQueue — key extractor', () => {
  test('object items ordered by key()', () => {
    const pq = createPriorityQueue({ key: (x) => x.priority });
    pq.push({ id: 'a', priority: 5 });
    pq.push({ id: 'b', priority: 1 });
    pq.push({ id: 'c', priority: 3 });
    assert.deepEqual(pq.drain().map((x) => x.id), ['b', 'c', 'a']);
  });

  test('non-finite key throws', () => {
    const pq = createPriorityQueue({ key: (x) => x.k });
    assert.throws(() => pq.push({ k: NaN }), TypeError);
    assert.throws(() => pq.push({ k: Infinity }), TypeError);
  });
});

describe('createPriorityQueue — stable ordering on ties', () => {
  test('insertion order preserved when priorities equal', () => {
    const pq = createPriorityQueue({ key: (x) => x.p });
    pq.push({ id: 'first', p: 1 });
    pq.push({ id: 'second', p: 1 });
    pq.push({ id: 'third', p: 1 });
    assert.deepEqual(pq.drain().map((x) => x.id), ['first', 'second', 'third']);
  });
});

describe('createPriorityQueue — size / clear / toArray', () => {
  test('size tracks pushes and pops', () => {
    const pq = createPriorityQueue({});
    assert.equal(pq.size(), 0);
    pq.push(1); pq.push(2);
    assert.equal(pq.size(), 2);
    pq.pop();
    assert.equal(pq.size(), 1);
  });

  test('clear empties the heap', () => {
    const pq = createPriorityQueue({});
    pq.push(1); pq.push(2);
    pq.clear();
    assert.equal(pq.size(), 0);
  });

  test('toArray returns underlying items (heap order, NOT sorted)', () => {
    const pq = createPriorityQueue({});
    [3, 1, 2].forEach((n) => pq.push(n));
    const arr = pq.toArray();
    assert.equal(arr.length, 3);
    assert.equal(arr[0], 1); // min at root
  });
});

describe('createPriorityQueue — large input', () => {
  test('1000 random pushes drain in ascending order', () => {
    const pq = createPriorityQueue({});
    const xs = [];
    for (let i = 0; i < 1000; i++) {
      const v = Math.floor(Math.random() * 100_000);
      pq.push(v); xs.push(v);
    }
    const sortedRef = xs.slice().sort((a, b) => a - b);
    assert.deepEqual(pq.drain(), sortedRef);
  });
});
