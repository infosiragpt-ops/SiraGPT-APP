'use strict';

/**
 * Tests for the cycle-50 additions to thesis citation verification:
 * verifyDoisBatch (CrossRef-backed batch verification with bounded
 * concurrency) and the hallucination-rate guard in runThesisPipeline.
 *
 * Both paths are exercised with stubbed network + scientific-search so
 * the test stays offline and deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cv = require('../src/services/thesis/citation-verifier');
const thesisEngine = require('../src/services/thesis/thesis-engine');

// ── verifyDoisBatch ─────────────────────────────────────────────────────

test('verifyDoisBatch: empty input returns empty Map', async () => {
  const result = await cv.verifyDoisBatch([]);
  assert.ok(result instanceof Map);
  assert.equal(result.size, 0);
});

test('verifyDoisBatch: dedupes DOIs and calls fetcher once per unique DOI', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const doi = decodeURIComponent(url.split('/works/')[1]);
    return {
      ok: true,
      status: 200,
      async json() {
        return { message: { DOI: doi, title: ['Stub'], issued: { 'date-parts': [[2024]] } } };
      },
    };
  };
  const dois = ['10.1038/nature12373', '10.1038/nature12373', '10.1126/science.abc'];
  const result = await cv.verifyDoisBatch(dois, { fetcher });
  assert.equal(result.size, 2);
  assert.equal(calls.length, 2);
  assert.equal(result.get('10.1038/nature12373').ok, true);
  assert.equal(result.get('10.1126/science.abc').ok, true);
});

test('verifyDoisBatch: HTTP 404 marks the DOI as not ok', async () => {
  const fetcher = async () => ({ ok: false, status: 404, async json() { return {}; } });
  const result = await cv.verifyDoisBatch(['10.9999/missing'], { fetcher });
  assert.equal(result.get('10.9999/missing').ok, false);
  assert.match(result.get('10.9999/missing').error, /http_404/);
});

test('verifyDoisBatch: per-DOI failure does not abort the batch', async () => {
  // URLs are encoded with `encodeURIComponent` so `/` becomes `%2F`;
  // match on the DOI suffix to stay encoding-agnostic.
  const fetcher = async (url) => {
    if (url.includes('nature12373')) throw new Error('boom');
    return {
      ok: true,
      status: 200,
      async json() { return { message: { DOI: '10.1126/science.abc' } }; },
    };
  };
  const result = await cv.verifyDoisBatch(
    ['10.1038/nature12373', '10.1126/science.abc'],
    { fetcher },
  );
  assert.equal(result.size, 2);
  assert.equal(result.get('10.1038/nature12373').ok, false);
  assert.equal(result.get('10.1126/science.abc').ok, true);
});

// ── env flag readers ────────────────────────────────────────────────────

test('onlineFallbackEnabled: defaults to false', () => {
  const prev = process.env.THESIS_VERIFY_ONLINE_FALLBACK;
  delete process.env.THESIS_VERIFY_ONLINE_FALLBACK;
  try {
    assert.equal(cv.onlineFallbackEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.THESIS_VERIFY_ONLINE_FALLBACK = prev;
  }
});

test('onlineFallbackEnabled: respects truthy values', () => {
  const prev = process.env.THESIS_VERIFY_ONLINE_FALLBACK;
  try {
    process.env.THESIS_VERIFY_ONLINE_FALLBACK = 'true';
    assert.equal(cv.onlineFallbackEnabled(), true);
    process.env.THESIS_VERIFY_ONLINE_FALLBACK = '1';
    assert.equal(cv.onlineFallbackEnabled(), true);
    process.env.THESIS_VERIFY_ONLINE_FALLBACK = 'no';
    assert.equal(cv.onlineFallbackEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.THESIS_VERIFY_ONLINE_FALLBACK;
    else process.env.THESIS_VERIFY_ONLINE_FALLBACK = prev;
  }
});

test('hallucinationThreshold: defaults to 0.3 and clamps bad input', () => {
  const prev = process.env.THESIS_HALLUCINATION_THRESHOLD;
  try {
    delete process.env.THESIS_HALLUCINATION_THRESHOLD;
    assert.equal(cv.hallucinationThreshold(), 0.3);
    process.env.THESIS_HALLUCINATION_THRESHOLD = '0.5';
    assert.equal(cv.hallucinationThreshold(), 0.5);
    process.env.THESIS_HALLUCINATION_THRESHOLD = '2';
    assert.equal(cv.hallucinationThreshold(), 0.3, 'out-of-range clamps to default');
    process.env.THESIS_HALLUCINATION_THRESHOLD = 'foo';
    assert.equal(cv.hallucinationThreshold(), 0.3, 'NaN clamps to default');
  } finally {
    if (prev === undefined) delete process.env.THESIS_HALLUCINATION_THRESHOLD;
    else process.env.THESIS_HALLUCINATION_THRESHOLD = prev;
  }
});

// ── runThesisPipeline integration ──────────────────────────────────────

test('runThesisPipeline: emits hallucination warning when unverified rate exceeds threshold', async () => {
  const events = [];
  const result = await thesisEngine.runThesisPipeline(
    {
      topic: 'Test thesis',
      chapterIds: ['introduction'],
      strictCitations: true,
      verifyOnlineFallback: false,
      onEvent: (e) => events.push(e),
    },
    {
      researchPhase: async () => ({
        query: 'x',
        providers: [],
        papers: [
          { doi: '10.1038/known', title: 'Known', year: 2024, authors: [{ family: 'Smith' }] },
        ],
        rejected: 0,
      }),
      generateChapter: async () => (
        // 1 known + 4 fabricated → 80% unverified, well over the 30% default.
        '(Smith, 2024) reviewed the literature. Compare also 10.9999/fake1, 10.9999/fake2, ' +
        '10.9999/fake3, and 10.9999/fake4 for divergent views.'
      ),
    },
  );
  const warning = result.citationVerification.hallucinationWarning;
  assert.ok(warning, 'expected hallucination warning');
  assert.equal(warning.level, 'critical');
  assert.ok(warning.unverifiedRate > 0.3);
  assert.ok(warning.totalUnverified >= 4);
  assert.ok(events.some((e) => e.type === 'citations' && e.hallucinationWarning));
});

test('runThesisPipeline: no hallucination warning when citations align with references', async () => {
  const result = await thesisEngine.runThesisPipeline(
    {
      topic: 'Test thesis',
      chapterIds: ['introduction'],
      strictCitations: true,
      verifyOnlineFallback: false,
    },
    {
      researchPhase: async () => ({
        query: 'x',
        providers: [],
        papers: [
          { doi: '10.1038/known1', title: 'Known1', year: 2024, authors: [{ family: 'Smith' }] },
          { doi: '10.1038/known2', title: 'Known2', year: 2023, authors: [{ family: 'Doe' }] },
        ],
        rejected: 0,
      }),
      generateChapter: async () => '(Smith, 2024) and (Doe, 2023) found similar results. See 10.1038/known1 and 10.1038/known2.',
    },
  );
  assert.equal(result.citationVerification.hallucinationWarning, null);
  assert.equal(result.citationVerification.totalUnverified, 0);
});

test('runThesisPipeline: CrossRef fallback reclassifies a previously unverified DOI', async () => {
  // CROSSREF URL encodes the `/` in the DOI, so we match on the
  // distinctive suffix instead of the raw DOI string.
  const fetcher = async (url) => {
    if (url.includes('sci.real')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { message: { DOI: '10.1126/sci.real', title: ['Real paper'], issued: { 'date-parts': [[2024]] } } };
        },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const result = await thesisEngine.runThesisPipeline(
    {
      topic: 'Test thesis',
      chapterIds: ['introduction'],
      strictCitations: true,
      verifyOnlineFallback: true,
    },
    {
      researchPhase: async () => ({ query: 'x', providers: [], papers: [], rejected: 0 }),
      generateChapter: async () => 'See 10.1126/sci.real and 10.9999/fake for details.',
      fetcher,
    },
  );
  assert.equal(result.citationVerification.externallyVerified, 1);
  assert.equal(result.citationVerification.totalVerified, 1);
  assert.equal(result.citationVerification.totalUnverified, 1);
  // The reclassified DOI's marker should have been dropped from the chapter text.
  assert.ok(!result.chapters[0].content.includes('10.1126/sci.real [no verificado]'));
  assert.ok(result.chapters[0].content.includes('10.9999/fake [no verificado]'));
});
