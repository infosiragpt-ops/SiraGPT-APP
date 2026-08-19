/**
 * Tests for db/critical-queries.js — Critical Query Plan Registry.
 *
 * Mocks ./explain + ./query-plan-regression via require-cache injection
 * so we can drive runCriticalQueryRegression without a real database.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const EXPLAIN_PATH = require.resolve('../src/db/explain');
const REGR_PATH = require.resolve('../src/db/query-plan-regression');
const CRIT_PATH = require.resolve('../src/db/critical-queries');

const explainMock = {
  _next: async () => ({ plan: { 'Node Type': 'Index Scan' } }),
  explain: (...args) => explainMock._next(...args),
};
const regrMock = {
  _detect: () => [],
  _fingerprint: () => 'fp-1',
  _summarize: (p) => p,
  detectRegressions: (...args) => regrMock._detect(...args),
  fingerprint: (...args) => regrMock._fingerprint(...args),
  summarizePlan: (...args) => regrMock._summarize(...args),
};

let origExplain, origRegr, origCrit;

function installMocks() {
  origExplain = require.cache[EXPLAIN_PATH];
  origRegr = require.cache[REGR_PATH];
  origCrit = require.cache[CRIT_PATH];

  function entry(p, exports_) {
    const m = new Module(p);
    m.filename = p;
    m.loaded = true;
    m.exports = exports_;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    return m;
  }
  require.cache[EXPLAIN_PATH] = entry(EXPLAIN_PATH, explainMock);
  require.cache[REGR_PATH] = entry(REGR_PATH, regrMock);
  delete require.cache[CRIT_PATH];
}

function restoreMocks() {
  if (origExplain) require.cache[EXPLAIN_PATH] = origExplain;
  else delete require.cache[EXPLAIN_PATH];
  if (origRegr) require.cache[REGR_PATH] = origRegr;
  else delete require.cache[REGR_PATH];
  if (origCrit) require.cache[CRIT_PATH] = origCrit;
  else delete require.cache[CRIT_PATH];
}

let crit;

before(() => {
  installMocks();
  crit = require('../src/db/critical-queries');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  explainMock._next = async () => ({ plan: { 'Node Type': 'Index Scan' } });
  regrMock._detect = () => [];
  regrMock._fingerprint = () => 'fp-1';
  regrMock._summarize = (p) => p;
});

// ── CRITICAL_QUERIES catalog ────────────────────────────────────

describe('CRITICAL_QUERIES catalog', () => {
  it('contains the 3 documented critical queries', () => {
    assert.equal(crit.CRITICAL_QUERIES.length, 3);
    const names = crit.CRITICAL_QUERIES.map(q => q.name);
    assert.ok(names.includes('user_by_email'));
    assert.ok(names.includes('task_by_user_recent'));
    assert.ok(names.includes('idempotency_key_lookup'));
  });

  it('is frozen (cannot push)', () => {
    assert.throws(() => crit.CRITICAL_QUERIES.push({}), TypeError);
  });

  it('every entry has name, description, sql, params, expected', () => {
    for (const q of crit.CRITICAL_QUERIES) {
      assert.equal(typeof q.name, 'string');
      assert.equal(typeof q.description, 'string');
      assert.equal(typeof q.sql, 'string');
      assert.ok(Array.isArray(q.params));
      assert.equal(typeof q.expected, 'object');
    }
  });

  it('user_by_email enforces Index Scan + no Seq Scan on User', () => {
    const q = crit.findCriticalQuery('user_by_email');
    assert.equal(q.expected.topNodeType, 'Index Scan');
    assert.ok(q.expected.noSeqScan.includes('User'));
    assert.ok(q.expected.requireIndexes.includes('User_email_key'));
  });

  it('idempotency_key_lookup also enforces Index Scan top node', () => {
    const q = crit.findCriticalQuery('idempotency_key_lookup');
    assert.equal(q.expected.topNodeType, 'Index Scan');
  });

  it('task_by_user_recent enforces no Seq Scan on Task + composite index', () => {
    const q = crit.findCriticalQuery('task_by_user_recent');
    assert.ok(q.expected.noSeqScan.includes('Task'));
    assert.ok(q.expected.requireIndexes.includes('Task_userId_createdAt_idx'));
  });
});

// ── listCriticalQueries ─────────────────────────────────────────

describe('listCriticalQueries', () => {
  it('returns 3 entries', () => {
    assert.equal(crit.listCriticalQueries().length, 3);
  });

  it('returns shallow copies (mutation does NOT propagate to registry)', () => {
    const list = crit.listCriticalQueries();
    list[0].name = 'mutated';
    // Underlying entry untouched.
    assert.equal(crit.CRITICAL_QUERIES[0].name, 'user_by_email');
  });

  it('expected sub-object is also copied', () => {
    const list = crit.listCriticalQueries();
    list[0].expected.topNodeType = 'mutated';
    assert.equal(crit.CRITICAL_QUERIES[0].expected.topNodeType, 'Index Scan');
  });
});

// ── findCriticalQuery ──────────────────────────────────────────

describe('findCriticalQuery', () => {
  it('returns the matching entry', () => {
    const q = crit.findCriticalQuery('user_by_email');
    assert.ok(q);
    assert.equal(q.name, 'user_by_email');
  });

  it('returns null for unknown name', () => {
    assert.equal(crit.findCriticalQuery('not-here'), null);
  });
});

// ── runCriticalQueryRegression ────────────────────────────────

describe('runCriticalQueryRegression', () => {
  it('returns [] when no regressions detected', async () => {
    const out = await crit.runCriticalQueryRegression({});
    assert.deepEqual(out, []);
  });

  it('runs explain() for every query in the registry by default', async () => {
    let count = 0;
    explainMock._next = async () => {
      count += 1;
      return { plan: {} };
    };
    await crit.runCriticalQueryRegression({});
    assert.equal(count, 3);
  });

  it('honours opts.queries to limit the run', async () => {
    let count = 0;
    explainMock._next = async () => {
      count += 1;
      return { plan: {} };
    };
    const singleQuery = [crit.CRITICAL_QUERIES[0]];
    await crit.runCriticalQueryRegression({}, { queries: singleQuery });
    assert.equal(count, 1);
  });

  it('captures explain() failure as an issues entry without aborting', async () => {
    explainMock._next = async () => { throw new Error('connection lost'); };
    const out = await crit.runCriticalQueryRegression({});
    // 3 queries → 3 failure entries.
    assert.equal(out.length, 3);
    for (const f of out) {
      assert.equal(f.plan, null);
      assert.ok(f.issues[0].includes('explain() failed'));
      assert.ok(f.issues[0].includes('connection lost'));
    }
  });

  it('collects regressions when detectRegressions returns issues', async () => {
    regrMock._detect = () => ['Seq Scan detected on User', 'wrong top node type'];
    const out = await crit.runCriticalQueryRegression({});
    assert.equal(out.length, 3);
    for (const f of out) {
      assert.equal(f.issues.length, 2);
      assert.ok(f.fingerprint);
      assert.ok(f.plan);
    }
  });

  it('passes opts.analyze through to explain (default true)', async () => {
    let captured;
    explainMock._next = async (_prisma, _sql, _params, opts) => {
      captured = opts;
      return { plan: {} };
    };
    await crit.runCriticalQueryRegression({});
    assert.equal(captured.analyze, true);
  });

  it('opts.analyze=false is forwarded', async () => {
    let captured;
    explainMock._next = async (_prisma, _sql, _params, opts) => {
      captured = opts;
      return { plan: {} };
    };
    await crit.runCriticalQueryRegression({}, { analyze: false });
    assert.equal(captured.analyze, false);
  });

  it('forwards prisma + sql + params to explain()', async () => {
    let captured;
    const fakePrisma = { id: 'prisma-x' };
    explainMock._next = async (prisma, sql, params) => {
      captured = { prisma, sql, params };
      return { plan: {} };
    };
    await crit.runCriticalQueryRegression(fakePrisma, {
      queries: [crit.CRITICAL_QUERIES[0]],
    });
    assert.strictEqual(captured.prisma, fakePrisma);
    assert.equal(captured.sql, crit.CRITICAL_QUERIES[0].sql);
    assert.deepEqual(captured.params, crit.CRITICAL_QUERIES[0].params);
  });

  it('mixes success + failure when some queries regress', async () => {
    let i = 0;
    regrMock._detect = () => {
      i += 1;
      return i === 2 ? ['regression: Seq Scan'] : [];
    };
    const out = await crit.runCriticalQueryRegression({});
    assert.equal(out.length, 1);
    // Only the second query is in the failures.
    assert.equal(out[0].name, crit.CRITICAL_QUERIES[1].name);
  });

  it('empty opts.queries falls back to full registry', async () => {
    let count = 0;
    explainMock._next = async () => { count += 1; return { plan: {} }; };
    await crit.runCriticalQueryRegression({}, { queries: [] });
    assert.equal(count, 3);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/db/critical-queries');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'CRITICAL_QUERIES', 'findCriticalQuery',
      'listCriticalQueries', 'runCriticalQueryRegression',
    ]);
  });
});
