/**
 * Tests for services/agents/feedback-ledger.js — RLHF-lite via
 * retrieval. In-memory per-user ledger + cosine similarity search.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  record,
  findExemplars,
  formatExemplarsBlock,
  stats,
  clearUser,
  _reset,
  _dump,
  MAX_ENTRIES_PER_USER,
} = require('../src/services/agents/feedback-ledger');

beforeEach(() => {
  _reset();
});

// ── constants ────────────────────────────────────────────────────

describe('MAX_ENTRIES_PER_USER', () => {
  it('is the documented 500 cap', () => {
    assert.equal(MAX_ENTRIES_PER_USER, 500);
  });
});

// ── record ──────────────────────────────────────────────────────

describe('record · validation', () => {
  it('throws when userId is missing', async () => {
    await assert.rejects(
      () => record({ runId: 'r1', helpful: true }),
      /userId and runId required/,
    );
  });

  it('throws when runId is missing', async () => {
    await assert.rejects(
      () => record({ userId: 'u1', helpful: true }),
      /userId and runId required/,
    );
  });

  it('throws when helpful is not boolean', async () => {
    await assert.rejects(
      () => record({ userId: 'u1', runId: 'r1', helpful: 'yes' }),
      /helpful must be boolean/,
    );
    await assert.rejects(
      () => record({ userId: 'u1', runId: 'r1' }),
      /helpful must be boolean/,
    );
  });
});

describe('record · happy path', () => {
  it('stores entry and returns { stored, total }', async () => {
    const out = await record({
      userId: 'u1', runId: 'r1', agent: 'code-gen',
      request: 'how do I sort?', response: 'use Array.sort()',
      helpful: true, notes: 'clear answer',
    });
    assert.deepEqual(out, { stored: true, total: 1 });
  });

  it('truncates request to 4000 chars', async () => {
    const long = 'q'.repeat(10_000);
    await record({ userId: 'u1', runId: 'r1', request: long, helpful: true });
    const dumped = _dump('u1');
    assert.equal(dumped[0].request.length, 4000);
  });

  it('truncates notes to 500 chars; non-string → null', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true, notes: 'n'.repeat(2000) });
    let dumped = _dump('u1');
    assert.equal(dumped[0].notes.length, 500);
    await record({ userId: 'u2', runId: 'r2', helpful: true, notes: 42 });
    dumped = _dump('u2');
    assert.equal(dumped[0].notes, null);
  });

  it('embedding stays null when no embedder provided', async () => {
    await record({ userId: 'u1', runId: 'r1', request: 'x', helpful: true });
    const dumped = _dump('u1');
    assert.equal(dumped[0].embedding, null);
  });

  it('stores embedding when embedder returns a vector', async () => {
    const embedder = async () => [new Float32Array([0.1, 0.2, 0.3])];
    await record({ userId: 'u1', runId: 'r1', request: 'x', helpful: true, embedder });
    const dumped = _dump('u1');
    assert.ok(dumped[0].embedding instanceof Float32Array);
    assert.deepEqual([...dumped[0].embedding], [0.1, 0.2, 0.3].map(n => Math.fround(n)));
  });

  it('stores entry without embedding when embedder throws (non-fatal)', async () => {
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      const embedder = async () => { throw new Error('embed down'); };
      await record({ userId: 'u1', runId: 'r1', request: 'x', helpful: true, embedder });
      const dumped = _dump('u1');
      assert.equal(dumped.length, 1);
      assert.equal(dumped[0].embedding, null);
    } finally {
      console.warn = _origWarn;
    }
  });

  it('agent defaults to null when omitted', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true });
    assert.equal(_dump('u1')[0].agent, null);
  });

  it('dedupe by runId: second record replaces first', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true, notes: 'first' });
    const out = await record({ userId: 'u1', runId: 'r1', helpful: false, notes: 'updated' });
    assert.equal(out.total, 1);
    const dumped = _dump('u1');
    assert.equal(dumped[0].helpful, false);
    assert.equal(dumped[0].notes, 'updated');
  });

  it('isolates per-user storage', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true });
    await record({ userId: 'u2', runId: 'r2', helpful: true });
    assert.equal(_dump('u1').length, 1);
    assert.equal(_dump('u2').length, 1);
  });

  it('oldest-wins eviction at MAX_ENTRIES_PER_USER', async () => {
    for (let i = 0; i < MAX_ENTRIES_PER_USER + 5; i++) {
      await record({ userId: 'u1', runId: `r${i}`, helpful: true });
    }
    const dumped = _dump('u1');
    assert.equal(dumped.length, MAX_ENTRIES_PER_USER);
    // Earliest entries removed; first remaining is r5.
    assert.equal(dumped[0].runId, 'r5');
  });
});

// ── findExemplars ───────────────────────────────────────────────

describe('findExemplars', () => {
  const embedder = async (texts) => texts.map(t => {
    // Pseudo-embed: pack first 3 char codes / 100 into a vector.
    const v = new Float32Array(3);
    for (let i = 0; i < 3; i++) v[i] = (t.charCodeAt(i) || 0) / 100;
    return v;
  });

  it('returns [] for empty user', async () => {
    const out = await findExemplars({ userId: 'none', request: 'q', embedder, k: 3 });
    assert.deepEqual(out, []);
  });

  it('returns [] when embedder is not a function', async () => {
    await record({ userId: 'u1', runId: 'r1', request: 'x', helpful: true, embedder });
    const out = await findExemplars({ userId: 'u1', request: 'x', k: 3 });
    assert.deepEqual(out, []);
  });

  it('returns [] when embedder throws on the query', async () => {
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      await record({ userId: 'u1', runId: 'r1', request: 'x', helpful: true, embedder });
      const bad = async () => { throw new Error('boom'); };
      const out = await findExemplars({ userId: 'u1', request: 'x', embedder: bad, k: 3 });
      assert.deepEqual(out, []);
    } finally {
      console.warn = _origWarn;
    }
  });

  it('returns top-K exemplars sorted by cosine similarity', async () => {
    await record({ userId: 'u1', runId: 'r1', request: 'aaaa', helpful: true, embedder });
    await record({ userId: 'u1', runId: 'r2', request: 'bbbb', helpful: true, embedder });
    await record({ userId: 'u1', runId: 'r3', request: 'cccc', helpful: true, embedder });
    const out = await findExemplars({ userId: 'u1', request: 'aaaa', embedder, k: 2 });
    assert.equal(out.length, 2);
    // The most-similar one (identical) should win.
    assert.equal(out[0].request, 'aaaa');
    assert.ok(out[0].score >= out[1].score);
  });

  it('filters to helpful=true by default', async () => {
    await record({ userId: 'u1', runId: 'r1', request: 'aaa', helpful: true, embedder });
    await record({ userId: 'u1', runId: 'r2', request: 'aab', helpful: false, embedder });
    const out = await findExemplars({ userId: 'u1', request: 'aaa', embedder, k: 5 });
    for (const e of out) assert.equal(e.helpful, true);
  });

  it('includes unhelpful when onlyHelpful=false', async () => {
    await record({ userId: 'u1', runId: 'r1', request: 'aaa', helpful: true, embedder });
    await record({ userId: 'u1', runId: 'r2', request: 'aab', helpful: false, embedder });
    const out = await findExemplars({
      userId: 'u1', request: 'aaa', embedder, k: 5, onlyHelpful: false,
    });
    assert.equal(out.length, 2);
  });

  it('filters by agent when supplied', async () => {
    await record({ userId: 'u1', runId: 'r1', agent: 'code-gen', request: 'aaa', helpful: true, embedder });
    await record({ userId: 'u1', runId: 'r2', agent: 'review', request: 'aab', helpful: true, embedder });
    const out = await findExemplars({ userId: 'u1', request: 'aaa', embedder, agent: 'code-gen' });
    assert.equal(out.length, 1);
    assert.equal(out[0].agent, 'code-gen');
  });

  it('skips entries without an embedding', async () => {
    // record without embedder → no embedding stored.
    await record({ userId: 'u1', runId: 'r1', request: 'aaa', helpful: true });
    // record with embedder → has embedding.
    await record({ userId: 'u1', runId: 'r2', request: 'aab', helpful: true, embedder });
    const out = await findExemplars({ userId: 'u1', request: 'aaa', embedder });
    // Only the one with an embedding is returned.
    assert.equal(out.length, 1);
    assert.equal(out[0].runId, 'r2');
  });

  it('k floors to 1 even when caller asks for 0', async () => {
    await record({ userId: 'u1', runId: 'r1', request: 'aaa', helpful: true, embedder });
    const out = await findExemplars({ userId: 'u1', request: 'aaa', embedder, k: 0 });
    assert.equal(out.length, 1);
  });
});

// ── formatExemplarsBlock ───────────────────────────────────────

describe('formatExemplarsBlock', () => {
  it('returns empty string for empty / non-array input', () => {
    assert.equal(formatExemplarsBlock([]), '');
    assert.equal(formatExemplarsBlock(null), '');
    assert.equal(formatExemplarsBlock('not-array'), '');
  });

  it('formats a single exemplar with header + Q/A', () => {
    const out = formatExemplarsBlock([{
      agent: 'code-gen', request: 'how to sort', response: 'use sort()',
    }]);
    assert.match(out, /# EXAMPLES from past sessions/);
    assert.match(out, /## Example 1 \(agent: code-gen\)/);
    assert.match(out, /Q: how to sort/);
    assert.match(out, /A \(helpful\): use sort\(\)/);
  });

  it('truncates response to 600 chars', () => {
    const out = formatExemplarsBlock([{
      request: 'q', response: 'a'.repeat(2000),
    }]);
    // The block contains the truncated portion + boilerplate; count
    // just the post-prefix size.
    const aLine = out.match(/A \(helpful\): (a+)/);
    assert.ok(aLine[1].length <= 600);
  });

  it('JSON-stringifies non-string response', () => {
    const out = formatExemplarsBlock([{
      request: 'q', response: { kind: 'code', text: 'function foo() {}' },
    }]);
    assert.match(out, /"kind":"code"/);
  });

  it('includes notes when present', () => {
    const out = formatExemplarsBlock([{
      request: 'q', response: 'a', notes: 'user said yes',
    }]);
    assert.match(out, /User notes: user said yes/);
  });

  it('uses agent fallback "unknown" when agent missing', () => {
    const out = formatExemplarsBlock([{ request: 'q', response: 'a' }]);
    assert.match(out, /agent: unknown/);
  });

  it('handles multiple exemplars with sequential numbering', () => {
    const out = formatExemplarsBlock([
      { request: 'q1', response: 'a1', agent: 'g1' },
      { request: 'q2', response: 'a2', agent: 'g2' },
    ]);
    assert.match(out, /## Example 1/);
    assert.match(out, /## Example 2/);
  });
});

// ── stats / clearUser / _reset / _dump ─────────────────────────

describe('stats', () => {
  it('zeros for unknown user', () => {
    assert.deepEqual(stats('nobody'), { total: 0, helpful: 0, unhelpful: 0 });
  });

  it('counts helpful vs unhelpful per user', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true });
    await record({ userId: 'u1', runId: 'r2', helpful: true });
    await record({ userId: 'u1', runId: 'r3', helpful: false });
    assert.deepEqual(stats('u1'), { total: 3, helpful: 2, unhelpful: 1 });
  });
});

describe('clearUser', () => {
  it('removes only the targeted user', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true });
    await record({ userId: 'u2', runId: 'r2', helpful: true });
    clearUser('u1');
    assert.equal(stats('u1').total, 0);
    assert.equal(stats('u2').total, 1);
  });
});

describe('_dump', () => {
  it('returns [] for unknown user', () => {
    assert.deepEqual(_dump('nobody'), []);
  });

  it('returns shallow copies (does not mutate internal state)', async () => {
    await record({ userId: 'u1', runId: 'r1', helpful: true });
    const dump = _dump('u1');
    dump[0].helpful = false;
    // The internal state should be untouched.
    const original = _dump('u1')[0];
    assert.equal(original.helpful, true);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/feedback-ledger');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'MAX_ENTRIES_PER_USER', '_dump', '_reset', 'clearUser',
      'findExemplars', 'formatExemplarsBlock', 'record', 'stats',
    ]);
  });
});
