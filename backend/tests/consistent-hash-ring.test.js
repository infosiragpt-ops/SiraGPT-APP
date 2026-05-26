'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createConsistentHashRing } = require('../src/services/ai-product-os/consistent-hash-ring');

describe('createConsistentHashRing — basic', () => {
  test('empty ring returns null on locate', () => {
    const r = createConsistentHashRing({});
    assert.equal(r.locate('any'), null);
  });

  test('single node owns every key', () => {
    const r = createConsistentHashRing({});
    r.addNode('A');
    for (let i = 0; i < 50; i++) assert.equal(r.locate(`k:${i}`), 'A');
  });

  test('addNode rejects empty id', () => {
    const r = createConsistentHashRing({});
    assert.throws(() => r.addNode(''), TypeError);
  });

  test('locate rejects null key', () => {
    const r = createConsistentHashRing({});
    r.addNode('A');
    assert.throws(() => r.locate(null), TypeError);
  });
});

describe('createConsistentHashRing — distribution', () => {
  test('three nodes get roughly equal share of keys', () => {
    const r = createConsistentHashRing({ vnodesPerNode: 128 });
    r.addNode('A'); r.addNode('B'); r.addNode('C');
    const counts = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 3000; i++) counts[r.locate(`tenant:${i}`)] += 1;
    for (const c of Object.values(counts)) {
      assert.ok(c > 700 && c < 1300, `unbalanced: ${JSON.stringify(counts)}`);
    }
  });

  test('removing a node only reshuffles ~1/N of keys', () => {
    const r = createConsistentHashRing({ vnodesPerNode: 128 });
    for (const id of ['A', 'B', 'C', 'D']) r.addNode(id);
    const before = new Map();
    for (let i = 0; i < 1000; i++) before.set(`k:${i}`, r.locate(`k:${i}`));
    r.removeNode('B');
    let moved = 0;
    for (const [k, was] of before) {
      const now = r.locate(k);
      if (now !== was && was !== 'B') moved += 1;
      // Keys that lived on B must move; keys on others mostly shouldn't.
    }
    // With 4 → 3 nodes, ~25% of keys (those on B) move to others. Of the
    // remaining 75%, near zero should move on a well-distributed ring.
    assert.ok(moved < 200, `too many keys moved: ${moved}`);
  });
});

describe('createConsistentHashRing — locateN', () => {
  test('returns N distinct nodes in walk order', () => {
    const r = createConsistentHashRing({});
    for (const id of ['A', 'B', 'C']) r.addNode(id);
    const top2 = r.locateN('key', 2);
    assert.equal(top2.length, 2);
    assert.notEqual(top2[0], top2[1]);
  });

  test('locateN(_, more than nodes) caps at nodes count', () => {
    const r = createConsistentHashRing({});
    r.addNode('A'); r.addNode('B');
    assert.equal(r.locateN('k', 10).length, 2);
  });

  test('empty ring returns []', () => {
    const r = createConsistentHashRing({});
    assert.deepEqual(r.locateN('k', 3), []);
  });
});

describe('createConsistentHashRing — lifecycle', () => {
  test('removeNode unknown returns false', () => {
    const r = createConsistentHashRing({});
    assert.equal(r.removeNode('never'), false);
  });

  test('addNode duplicate returns false', () => {
    const r = createConsistentHashRing({});
    r.addNode('A');
    assert.equal(r.addNode('A'), false);
  });

  test('snapshot reports nodes + ringSize = nodes × vnodesPerNode', () => {
    const r = createConsistentHashRing({ vnodesPerNode: 32 });
    r.addNode('A'); r.addNode('B');
    const s = r.snapshot();
    assert.equal(s.nodes, 2);
    assert.equal(s.ringSize, 64);
  });

  test('nodes() returns the current set', () => {
    const r = createConsistentHashRing({});
    r.addNode('A'); r.addNode('B');
    assert.deepEqual(r.nodes().sort(), ['A', 'B']);
  });
});

describe('createConsistentHashRing — determinism', () => {
  test('two rings with same nodes locate identically', () => {
    const a = createConsistentHashRing({ vnodesPerNode: 64 });
    const b = createConsistentHashRing({ vnodesPerNode: 64 });
    for (const id of ['x', 'y', 'z']) { a.addNode(id); b.addNode(id); }
    for (let i = 0; i < 50; i++) {
      const k = `key:${i}`;
      assert.equal(a.locate(k), b.locate(k));
    }
  });
});
