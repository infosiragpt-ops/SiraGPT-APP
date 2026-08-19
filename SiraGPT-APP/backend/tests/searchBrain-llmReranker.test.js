/**
 * Tests for services/searchBrain/llmReranker.js — Phase 3 of WebGLM:
 * 0-10 LLM rubric over candidate pool + combined-score ranking.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  rerankResults,
  RERANKER_SYSTEM,
  INTERNAL,
} = require('../src/services/searchBrain/llmReranker');

// ── RERANKER_SYSTEM ────────────────────────────────────────────

describe('RERANKER_SYSTEM', () => {
  it('describes STRICT JSON output with scores array', () => {
    assert.match(RERANKER_SYSTEM, /STRICT JSON/);
    assert.match(RERANKER_SYSTEM, /"scores"/);
    assert.match(RERANKER_SYSTEM, /idx/);
    assert.match(RERANKER_SYSTEM, /score/);
  });

  it('defines 0-10 rubric with anchor descriptions', () => {
    assert.match(RERANKER_SYSTEM, /10 = directly answers/);
    assert.match(RERANKER_SYSTEM, /0\s*=\s*off-topic/);
  });

  it('forbids score clustering at 7', () => {
    assert.match(RERANKER_SYSTEM, /don't cluster at 7/);
  });
});

// ── INTERNAL.parseJson ─────────────────────────────────────────

describe('INTERNAL.parseJson', () => {
  it('returns null for non-string', () => {
    assert.equal(INTERNAL.parseJson(null), null);
    assert.equal(INTERNAL.parseJson(42), null);
  });

  it('parses bare JSON', () => {
    assert.deepEqual(INTERNAL.parseJson('{"a":1}'), { a: 1 });
  });

  it('strips json fences', () => {
    assert.deepEqual(INTERNAL.parseJson('```json\n{"a":2}\n```'), { a: 2 });
  });

  it('strips bare fences', () => {
    assert.deepEqual(INTERNAL.parseJson('```\n{"a":3}\n```'), { a: 3 });
  });

  it('returns null on malformed JSON', () => {
    assert.equal(INTERNAL.parseJson('not json'), null);
  });
});

// ── INTERNAL.formatBatch ───────────────────────────────────────

describe('INTERNAL.formatBatch', () => {
  it('formats each candidate with [N], title, year, authors, snippet', () => {
    const out = INTERNAL.formatBatch([
      {
        title: 'Paper A', year: 2024,
        authors: ['Alice', 'Bob'],
        abstract: 'first paper abstract',
      },
      {
        title: 'Paper B', year: 2025,
        authors: ['Carol'],
        abstract: 'second paper abstract',
      },
    ]);
    assert.match(out, /\[1\] Paper A \(2024\)/);
    assert.match(out, /Alice, Bob/);
    assert.match(out, /first paper abstract/);
    assert.match(out, /\[2\] Paper B \(2025\)/);
    assert.match(out, /Carol/);
  });

  it('omits year suffix when no year', () => {
    const out = INTERNAL.formatBatch([{ title: 'No Year', authors: [], abstract: 'a' }]);
    assert.match(out, /\[1\] No Year\n/);
    assert.equal(out.includes('()'), false);
  });

  it('caps authors at 3', () => {
    const out = INTERNAL.formatBatch([{
      title: 'Many', authors: ['A', 'B', 'C', 'D', 'E'], abstract: 'x',
    }]);
    assert.match(out, /A, B, C\n/);
    assert.equal(out.includes('D'), false);
  });

  it('handles non-array authors gracefully', () => {
    const out = INTERNAL.formatBatch([{ title: 't', authors: 'not-array', abstract: 'x' }]);
    assert.match(out, /\[1\] t/);
  });

  it('collapses whitespace in abstract + truncates to 500 chars', () => {
    const out = INTERNAL.formatBatch([{
      title: 't',
      abstract: 'word1   word2\n\n\nword3\tword4 ' + 'x'.repeat(2000),
    }]);
    // No double spaces / newlines in the abstract portion.
    const abstract = out.split('    ').slice(-1)[0];
    assert.equal(abstract.includes('\n\n'), false);
    assert.equal(abstract.includes('\t'), false);
    assert.ok(abstract.length <= 500);
  });

  it('handles missing abstract', () => {
    const out = INTERNAL.formatBatch([{ title: 't', authors: [] }]);
    assert.match(out, /\[1\] t/);
  });

  it('joins multiple candidates with blank lines', () => {
    const out = INTERNAL.formatBatch([
      { title: 'a', authors: [], abstract: 'x' },
      { title: 'b', authors: [], abstract: 'y' },
    ]);
    assert.match(out, /\[1\] a[\s\S]+\n\n\[2\] b/);
  });
});

// ── INTERNAL.validateScores ────────────────────────────────────

describe('INTERNAL.validateScores', () => {
  it('returns [] for null/missing scores', () => {
    assert.deepEqual(INTERNAL.validateScores(null), []);
    assert.deepEqual(INTERNAL.validateScores({}), []);
  });

  it('returns [] for non-array scores', () => {
    assert.deepEqual(INTERNAL.validateScores({ scores: 'not-array' }), []);
  });

  it('parses valid entries', () => {
    const out = INTERNAL.validateScores({
      scores: [
        { idx: 1, score: 8.5, reason: 'good match' },
        { idx: 2, score: 3, reason: 'weak' },
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].idx, 1);
    assert.equal(out[0].score, 8.5);
    assert.equal(out[0].reason, 'good match');
  });

  it('coerces idx + score from strings', () => {
    const out = INTERNAL.validateScores({
      scores: [{ idx: '3', score: '5' }],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].idx, 3);
    assert.equal(out[0].score, 5);
  });

  it('clamps score to [0, 10]', () => {
    const out = INTERNAL.validateScores({
      scores: [
        { idx: 1, score: 15 },
        { idx: 2, score: -3 },
        { idx: 3, score: 5 },
      ],
    });
    assert.equal(out[0].score, 10);
    assert.equal(out[1].score, 0);
    assert.equal(out[2].score, 5);
  });

  it('drops non-object entries', () => {
    const out = INTERNAL.validateScores({
      scores: [null, 'not-object', { idx: 1, score: 5 }],
    });
    assert.equal(out.length, 1);
  });

  it('drops entries with non-finite idx or score', () => {
    const out = INTERNAL.validateScores({
      scores: [
        { idx: 'not-number', score: 5 },
        { idx: 1, score: 'not-number' },
        { idx: NaN, score: 5 },
        { idx: 1, score: 5 },
      ],
    });
    assert.equal(out.length, 1);
  });

  it('truncates reason to 200 chars; non-string → undefined', () => {
    const out = INTERNAL.validateScores({
      scores: [
        { idx: 1, score: 5, reason: 'r'.repeat(500) },
        { idx: 2, score: 5, reason: 42 },
      ],
    });
    assert.equal(out[0].reason.length, 200);
    assert.equal(out[1].reason, undefined);
  });
});

// ── INTERNAL.combinedScore ─────────────────────────────────────

describe('INTERNAL.combinedScore', () => {
  const w = {
    rerank: 1.0, providerRank: 0.3, citations: 0.2, openAccessBoost: 0.1,
  };

  it('rerank-only contribution (score 10 → full weight)', () => {
    const s = INTERNAL.combinedScore({}, 10, w);
    // rerank=10/10=1, others=0 (providerRank undefined→1/1=1, weight 0.3)
    // Actually providerRank ?? 0 → 1/(1+0)=1, * 0.3 = 0.3.
    // Citation = 0, oa = 0.
    assert.ok(Math.abs(s - 1.3) < 1e-9);
  });

  it('rerank undefined → 0 contribution from rerank', () => {
    const s = INTERNAL.combinedScore({ providerRank: 0 }, undefined, w);
    // rerank=0, providerRank=1*0.3 = 0.3, citation/oa = 0
    assert.ok(Math.abs(s - 0.3) < 1e-9);
  });

  it('providerRank=0 yields max provider score (1)', () => {
    const s1 = INTERNAL.combinedScore({ providerRank: 0 }, 0, w);
    const s2 = INTERNAL.combinedScore({ providerRank: 10 }, 0, w);
    assert.ok(s1 > s2);
  });

  it('citationCount uses log1p / log1p(1000) ratio', () => {
    const noCite = INTERNAL.combinedScore({}, 0, w);
    const someCite = INTERNAL.combinedScore({ citationCount: 100 }, 0, w);
    assert.ok(someCite > noCite);
    // 1000 citations should hit the cap
    const maxCite = INTERNAL.combinedScore({ citationCount: 1000 }, 0, w);
    // Citation score capped at 1, so contribution is exactly w.citations.
    const beyondCap = INTERNAL.combinedScore({ citationCount: 10_000 }, 0, w);
    // 10k > 1000 → log1p(10001)/log1p(1001) > 1, but Math.min caps it.
    assert.ok(Math.abs(beyondCap - maxCite) < 1e-9 || beyondCap === maxCite);
  });

  it('openAccess=true adds openAccessBoost weight', () => {
    const closed = INTERNAL.combinedScore({}, 0, w);
    const open = INTERNAL.combinedScore({ openAccess: true }, 0, w);
    assert.ok(Math.abs(open - closed - 0.1) < 1e-9);
  });

  it('all-zero result returns sum of provider component only (default providerRank treated as 0)', () => {
    const s = INTERNAL.combinedScore({ providerRank: 0 }, 0, w);
    assert.ok(Math.abs(s - 0.3) < 1e-9);
  });

  it('weights are applied linearly', () => {
    const w2 = { rerank: 2, providerRank: 0, citations: 0, openAccessBoost: 0 };
    const s = INTERNAL.combinedScore({}, 10, w2);
    // rerank=1, w.rerank=2 → 2; other weights zero so no contribution.
    assert.equal(s, 2);
  });

  it('does not let an LLM score or citations rescue an off-topic paper', () => {
    const topical = INTERNAL.combinedScore({
      retrievalScore: 0.95,
      qualityScore: 0.82,
      providerRank: 1,
      citationCount: 5,
      openAccess: true,
    }, 4, w);
    const offTopic = INTERNAL.combinedScore({
      retrievalScore: 0.1,
      qualityScore: 0.2,
      providerRank: 0,
      citationCount: 10000,
      openAccess: true,
    }, 10, w);

    assert.ok(topical > offTopic, `topical=${topical} offTopic=${offTopic}`);
  });
});

// ── rerankResults ──────────────────────────────────────────────

describe('rerankResults · primitives', () => {
  it('empty results → empty output, reranked:false', async () => {
    const out = await rerankResults({ query: 'q', results: [] });
    assert.deepEqual(out, { results: [], reranked: false });
  });

  it('non-array results → empty output', async () => {
    const out = await rerankResults({ query: 'q', results: null });
    assert.deepEqual(out, { results: [], reranked: false });
  });

  it('no callLLM → heuristic sort with reranked=false', async () => {
    const results = [
      { title: 'A', citationCount: 10 },
      { title: 'B', citationCount: 1000 },
    ];
    const out = await rerankResults({ query: 'q', results });
    assert.equal(out.reranked, false);
    // Higher-citation B should rank above A.
    assert.equal(out.results[0].title, 'B');
  });
});

describe('rerankResults · LLM path', () => {
  it('applies LLM-returned scores and sorts results', async () => {
    const callLLM = async () => ({
      content: JSON.stringify({
        scores: [
          { idx: 1, score: 3 },
          { idx: 2, score: 9 },
        ],
      }),
    });
    const out = await rerankResults({
      query: 'q',
      results: [
        { title: 'low-rank', citationCount: 0 },
        { title: 'high-rank', citationCount: 0 },
      ],
      callLLM,
    });
    assert.equal(out.reranked, true);
    assert.equal(out.results[0].title, 'high-rank');
    assert.equal(out.results[0].rerankScore, 9);
    assert.equal(out.results[1].rerankScore, 3);
  });

  it('batches when results > batchSize', async () => {
    let calls = 0;
    const callLLM = async () => {
      calls += 1;
      return { content: JSON.stringify({ scores: [{ idx: 1, score: 5 }] }) };
    };
    const results = Array.from({ length: 25 }, (_, i) => ({ title: `r${i}` }));
    await rerankResults({ query: 'q', results, batchSize: 10, callLLM });
    // 25 → 3 batches (10, 10, 5).
    assert.equal(calls, 3);
  });

  it('LLM throw on one batch does not abort the whole rerank', async () => {
    let calls = 0;
    const callLLM = async () => {
      calls += 1;
      if (calls === 2) throw new Error('batch 2 down');
      return { content: JSON.stringify({ scores: [{ idx: 1, score: 5 }] }) };
    };
    const results = Array.from({ length: 15 }, (_, i) => ({ title: `r${i}` }));
    const out = await rerankResults({ query: 'q', results, batchSize: 10, callLLM });
    assert.equal(out.reranked, true);
    assert.equal(out.results.length, 15);
  });

  it('malformed JSON leaves items heuristically sorted and reports reranked:false', async () => {
    const callLLM = async () => ({ content: 'not json' });
    const results = [{ title: 'a' }, { title: 'b' }];
    const out = await rerankResults({ query: 'q', results, callLLM });
    assert.equal(out.reranked, false);
    // No rerankScore on either.
    for (const r of out.results) {
      assert.equal(r.rerankScore, undefined);
    }
  });

  it('falls back to no-LLM heuristic when callLLM not provided', async () => {
    const out = await rerankResults({
      query: 'q',
      results: [{ title: 'a' }],
    });
    assert.equal(out.reranked, false);
  });

  it('sends temperature=0 + maxTokens=700 + RERANKER_SYSTEM', async () => {
    let captured;
    const callLLM = async (args) => {
      captured = args;
      return { content: JSON.stringify({ scores: [{ idx: 1, score: 5 }] }) };
    };
    await rerankResults({
      query: 'q', results: [{ title: 't', abstract: 'a' }], callLLM,
    });
    assert.equal(captured.temperature, 0);
    assert.equal(captured.maxTokens, 700);
    assert.equal(captured.system, RERANKER_SYSTEM);
  });

  it('weights override default behavior', async () => {
    // Stub callLLM so every result gets score=5; with rerank weight zero
    // and providerRank weight large, sort order depends on providerRank.
    const callLLM = async () => ({
      content: JSON.stringify({ scores: [{ idx: 1, score: 5 }, { idx: 2, score: 5 }] }),
    });
    const out = await rerankResults({
      query: 'q',
      results: [
        { title: 'A', providerRank: 5 },
        { title: 'B', providerRank: 0 },
      ],
      weights: { rerank: 0, providerRank: 10, citations: 0, openAccessBoost: 0 },
      callLLM,
    });
    assert.equal(out.results[0].title, 'B');  // higher provider score (lower providerRank)
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/searchBrain/llmReranker');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['INTERNAL', 'RERANKER_SYSTEM', 'rerankResults']);
  });
});
