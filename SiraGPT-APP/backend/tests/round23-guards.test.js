'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Round-23 regression guards.
 *
 * Two behavioural tests (streamToBuffer + attribution visualizer) plus
 * source-level guards for the reader-leak / falsy-0 fixes whose code paths
 * sit behind heavy SSRF/route mocking and are cheaper to pin at the source.
 */

// ── Behavioural: audio streamToBuffer cancels the reader on every exit ──────
const { _internal } = require('../src/services/agents/audio-media-tools');

test('streamToBuffer cancels the ReadableStream reader on normal completion', async () => {
  let cancelled = false;
  const stream = {
    getReader() {
      let i = 0;
      const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])];
      return {
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => { cancelled = true; },
      };
    },
  };
  const buf = await _internal.streamToBuffer(stream);
  assert.deepEqual([...buf], [1, 2, 3, 4], 'all chunks collected');
  assert.equal(cancelled, true, 'reader must be cancelled even when the stream ends with done=true');
});

test('streamToBuffer cancels the reader even when read() throws mid-stream', async () => {
  let cancelled = false;
  const stream = {
    getReader() {
      return {
        read: async () => { throw new Error('boom'); },
        cancel: async () => { cancelled = true; },
      };
    },
  };
  await assert.rejects(() => _internal.streamToBuffer(stream), /boom/);
  assert.equal(cancelled, true, 'a mid-read throw must still release the stream');
});

// ── Behavioural: attribution visualizer honours minEdgeWeight=0 ─────────────
const viz = require('../src/services/attribution-graph-visualizer');
const GRAPH = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b', weight: 0.02 }] };

test('visualizer minEdgeWeight: explicit 0 includes sub-threshold edges (falsy-0 fix)', () => {
  assert.equal(viz.toCytoscape(GRAPH).edges.length, 0, 'default 0.05 threshold excludes the 0.02 edge');
  assert.equal(viz.toCytoscape(GRAPH, { minEdgeWeight: 0 }).edges.length, 1, '0 must be respected, not coerced to 0.05');
  assert.equal(viz.toCompactJSON(GRAPH, { minEdgeWeight: 0 }).edges.length, 1, 'same for toCompactJSON');
});

test('visualizer minEdgeWeight: NaN still falls back to the 0.05 default', () => {
  assert.equal(viz.toCytoscape(GRAPH, { minEdgeWeight: 'abc' }).edges.length, 0, 'NaN must guard to 0.05, not drop all edges via >= NaN');
});

// ── Source guards: reader-leak try/finally + reader.cancel() ────────────────
for (const rel of [
  'services/connectors/web-fetch.js',
  'services/gpts/gpt-actions.js',
  'services/agent-harness/tools/web-fetch-tool.js',
]) {
  test(`${rel} releases its capped-read reader in a finally block`, () => {
    const src = read(rel);
    assert.match(
      src,
      /getReader\(\)[\s\S]{0,1400}?\}\s*finally\s*\{[\s\S]{0,460}?reader\.cancel\(\)/,
      'the reader loop must be wrapped in try/finally that cancels the reader on every path',
    );
  });
}

// ── Source guards: NaN-only fallback for falsy-0 caps in ai.js ──────────────
test('ai.js enrichment + agentic-doc caps use NaN-only fallback (respect explicit 0)', () => {
  const src = read('routes/ai.js');
  assert.match(src, /_rawEnrichmentCap[\s\S]{0,160}Number\.isFinite\(_rawEnrichmentCap\)/, 'enrichmentSoftCap must not use `|| 80_000`');
  assert.match(src, /_rawDocInject[\s\S]{0,160}Number\.isFinite\(_rawDocInject\)/, 'AGENTIC_DOC_INJECT_CHARS must not use `|| 120000`');
  assert.doesNotMatch(src, /SIRAGPT_ENRICHMENT_MAX_CHARS, 10\)\s*\|\|\s*80_000/, 'old falsy-0 form gone');
});

// ── Source guard: admin create-user coerces BigInt monthlyLimit ─────────────
test('admin POST /users assigns monthlyLimit as BigInt, not Number', () => {
  const src = read('routes/admin.js');
  assert.match(src, /monthlyLimit:\s*BigInt\(/, 'BigInt column must get a BigInt value');
  assert.doesNotMatch(src, /monthlyLimit:\s*Number\(monthlyLimit\)/, 'old Number() form gone');
});
