'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ai = require('../src/utils/async-iter');

async function* gen(arr) {
  for (const v of arr) yield v;
}

describe('toAsync', () => {
  test('wraps sync iterable', async () => {
    const out = [];
    for await (const v of ai.toAsync([1, 2, 3])) out.push(v);
    assert.deepEqual(out, [1, 2, 3]);
  });
  test('passes through async iterable', async () => {
    const out = [];
    for await (const v of ai.toAsync(gen([4, 5]))) out.push(v);
    assert.deepEqual(out, [4, 5]);
  });
  test('throws on non-iterable', async () => {
    await assert.rejects(async () => { for await (const _ of ai.toAsync(42)) {} }, TypeError);
  });
});

describe('asyncMap / asyncFilter', () => {
  test('map transforms each value', async () => {
    const out = await ai.asyncCollect(ai.asyncMap(gen([1, 2, 3]), (n) => n * 2));
    assert.deepEqual(out, [2, 4, 6]);
  });
  test('map awaits async fn', async () => {
    const out = await ai.asyncCollect(ai.asyncMap(gen([1, 2]), async (n) => n + 1));
    assert.deepEqual(out, [2, 3]);
  });
  test('filter keeps only matching', async () => {
    const out = await ai.asyncCollect(ai.asyncFilter(gen([1, 2, 3, 4]), (n) => n % 2 === 0));
    assert.deepEqual(out, [2, 4]);
  });
  test('rejects bad fn args', async () => {
    await assert.rejects(async () => { for await (const _ of ai.asyncMap(gen([1]), 'nope')) {} }, TypeError);
    await assert.rejects(async () => { for await (const _ of ai.asyncFilter(gen([1]), 'nope')) {} }, TypeError);
  });
});

describe('asyncTake / asyncSkip', () => {
  test('take returns only first N items', async () => {
    const out = await ai.asyncCollect(ai.asyncTake(gen([1, 2, 3, 4, 5]), 3));
    assert.deepEqual(out, [1, 2, 3]);
  });
  test('take with N=0 yields nothing', async () => {
    const out = await ai.asyncCollect(ai.asyncTake(gen([1, 2, 3]), 0));
    assert.deepEqual(out, []);
  });
  test('skip drops first N items', async () => {
    const out = await ai.asyncCollect(ai.asyncSkip(gen([1, 2, 3, 4, 5]), 2));
    assert.deepEqual(out, [3, 4, 5]);
  });
});

describe('asyncBatch', () => {
  test('groups items into arrays of `size`', async () => {
    const out = await ai.asyncCollect(ai.asyncBatch(gen([1, 2, 3, 4, 5]), 2));
    assert.deepEqual(out, [[1, 2], [3, 4], [5]]);
  });
  test('size=1 → singleton arrays', async () => {
    const out = await ai.asyncCollect(ai.asyncBatch(gen([1, 2]), 1));
    assert.deepEqual(out, [[1], [2]]);
  });
});

describe('asyncReduce', () => {
  test('with initial value', async () => {
    const sum = await ai.asyncReduce(gen([1, 2, 3]), (a, b) => a + b, 10);
    assert.equal(sum, 16);
  });
  test('without initial uses first item', async () => {
    const sum = await ai.asyncReduce(gen([1, 2, 3]), (a, b) => a + b);
    assert.equal(sum, 6);
  });
  test('empty + no initial throws', async () => {
    await assert.rejects(ai.asyncReduce(gen([]), (a, b) => a + b), TypeError);
  });
  test('empty + initial returns initial', async () => {
    const v = await ai.asyncReduce(gen([]), (a, b) => a + b, 99);
    assert.equal(v, 99);
  });
});

describe('asyncForEach / asyncCount', () => {
  test('forEach visits every item with index', async () => {
    const seen = [];
    await ai.asyncForEach(gen(['a', 'b', 'c']), (v, i) => seen.push([v, i]));
    assert.deepEqual(seen, [['a', 0], ['b', 1], ['c', 2]]);
  });
  test('asyncCount counts items', async () => {
    assert.equal(await ai.asyncCount(gen([1, 2, 3])), 3);
    assert.equal(await ai.asyncCount(gen([])), 0);
  });
});

describe('composition', () => {
  test('map → filter → take is lazy', async () => {
    let mapped = 0;
    const pipeline = ai.asyncTake(
      ai.asyncFilter(
        ai.asyncMap(gen([1, 2, 3, 4, 5, 6, 7, 8]), (n) => { mapped += 1; return n * 2; }),
        (n) => n > 4,
      ),
      2,
    );
    const out = await ai.asyncCollect(pipeline);
    assert.deepEqual(out, [6, 8]);
    // map should have run lazily, not over the whole input
    assert.ok(mapped <= 5, `mapped ${mapped} times — pipeline not lazy?`);
  });
});
