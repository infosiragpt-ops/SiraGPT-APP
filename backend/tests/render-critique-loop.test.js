'use strict';

// Render→vision critique loop — offline tests. The loop is best-effort by
// contract: every unavailable dependency must produce { skipped: true },
// never a throw, and it must be OFF under NODE_ENV=test unless forced.

const test = require('node:test');
const assert = require('node:assert');

const {
  runRenderCritique,
  critiqueRenderedPages,
  critiqueEnabled,
} = require('../src/services/document-pipeline/render-critique-loop');

test('critiqueEnabled: off in test env unless SIRAGPT_DOC_CRITIQUE=1', () => {
  assert.equal(critiqueEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(critiqueEnabled({ NODE_ENV: 'test', SIRAGPT_DOC_CRITIQUE: '1' }), true);
  assert.equal(critiqueEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(critiqueEnabled({ NODE_ENV: 'production', SIRAGPT_DOC_CRITIQUE: '0' }), false);
});

test('runRenderCritique skips cleanly: disabled / bad format / no vision key', async () => {
  const disabled = await runRenderCritique({ filePath: '/nope', format: 'docx', env: { NODE_ENV: 'production', SIRAGPT_DOC_CRITIQUE: '0' } });
  assert.deepEqual(disabled, { skipped: true, reason: 'disabled' });

  const badFormat = await runRenderCritique({ filePath: '/nope', format: 'csv', env: { NODE_ENV: 'production' } });
  assert.equal(badFormat.skipped, true);
  assert.match(badFormat.reason, /not renderable/);

  const noKey = await runRenderCritique({ filePath: '/nope', format: 'docx', env: { NODE_ENV: 'production' } });
  assert.deepEqual(noKey, { skipped: true, reason: 'no vision provider' });
});

test('runRenderCritique never throws on renderer failure (missing file/binary)', async () => {
  const out = await runRenderCritique({
    filePath: '/definitely/not/a/file.docx',
    format: 'docx',
    env: { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k' },
  });
  assert.equal(out.skipped, true);
  assert.ok(out.reason, 'reason reported');
});

test('critiqueRenderedPages parses the model JSON and clamps defects', async (t) => {
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{
        type: 'text',
        text: 'Análisis:\n{"defects":[{"page":1,"defect":"mitad inferior en blanco","severity":"high","suggestion":"llenar el lienzo"},{"page":2,"defect":"x","severity":"weird","suggestion":""}],"overall":"needs_work","summary":"dos hallazgos"}',
      }],
    }),
  });
  const report = await critiqueRenderedPages(
    [{ page: 1, png: Buffer.from('png') }, { page: 2, png: Buffer.from('png') }],
    { env: { ANTHROPIC_API_KEY: 'k' } },
  );
  assert.equal(report.overall, 'needs_work');
  assert.equal(report.defects.length, 2);
  assert.equal(report.defects[0].severity, 'high');
  assert.equal(report.defects[1].severity, 'medium', 'unknown severity normalized');
  assert.equal(report.summary, 'dos hallazgos');
});

test('critiqueRenderedPages returns null without a key (caller skips)', async () => {
  assert.equal(await critiqueRenderedPages([{ page: 1, png: Buffer.alloc(1) }], { env: {} }), null);
});

const { applyPptxVisualReview } = require('../src/services/document-pipeline/pptx-visual-review');
const validDeck = () => ({ passed: true, checks: { designSafety: true }, details: { slides: 14 } });

test('PPTX visual QA distinguishes unavailable, partial and complete inspection', () => {
  const unavailable = applyPptxVisualReview(validDeck(), { skipped: true, reason: 'private provider error' });
  assert.equal(unavailable.details.visualCritique.status, 'not_checked');
  assert.equal(unavailable.passed, true, 'static checks remain independent');
  assert.equal(unavailable.details.visualCritique.pagesRendered, 0);
  assert.doesNotMatch(JSON.stringify(unavailable), /private provider/);
  const result = { skipped: false, pagesRendered: 10, totalPages: 14, report: { overall: 'pass', defects: [], model: 'internal-only' } };
  assert.equal(applyPptxVisualReview(validDeck(), result).details.visualCritique.status, 'partial');
  const full = applyPptxVisualReview(validDeck(), { ...result, pagesRendered: 14 });
  assert.equal(full.details.visualCritique.status, 'passed');
  assert.doesNotMatch(JSON.stringify(full), /internal-only/);
});

test('PPTX visual defects block approval even when static checks passed', () => {
  const blocked = applyPptxVisualReview(validDeck(), {
    skipped: false, pagesRendered: 10, totalPages: 14,
    report: { overall: 'pass', defects: [{ page: 4, severity: 'high', defect: 'Título cortado' }] },
  });
  assert.equal(blocked.passed, false);
  assert.equal(blocked.checks.visualReview, false);
  assert.equal(blocked.details.visualCritique.status, 'needs_work');
  assert.equal(blocked.details.visualCritique.defects[0].page, 4);
  const staticFailure = applyPptxVisualReview({ ...validDeck(), passed: false }, {
    skipped: false, pagesRendered: 14, totalPages: 14, report: { overall: 'pass', defects: [] },
  });
  assert.equal(staticFailure.passed, false, 'vision does not override the structural gate');
});

test('vision critique ignores defect page numbers absent from the inspected batch', async (t) => {
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({
    overall: 'needs_work', defects: [{ page: 99, defect: 'not inspected' }, { page: 1, defect: 'visible' }],
  }) }] }) });
  const report = await critiqueRenderedPages([{ page: 1, png: Buffer.alloc(1) }], { env: { ANTHROPIC_API_KEY: 'k' } });
  assert.deepEqual(report.defects.map((defect) => defect.page), [1]);
});


test('malformed vision JSON is unavailable, not an invented design rejection', async (t) => {
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  for (const response of [{}, { overall: 'unexpected', defects: [] }, { overall: 'needs_work', defects: [] }, { overall: 'pass' }, { overall: 'pass', defects: [null] }]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(response) }] }) });
    assert.equal(await critiqueRenderedPages([{ page: 1, png: Buffer.alloc(1) }], { env: { ANTHROPIC_API_KEY: 'k' } }), null);
  }
  assert.equal(applyPptxVisualReview(validDeck(), { skipped: false, pagesRendered: 14, report: {} }).details.visualCritique.status, 'not_checked');
  assert.equal(applyPptxVisualReview(validDeck(), { skipped: false, pagesRendered: 10, totalPages: 10, report: { overall: 'pass', defects: [] } }).details.visualCritique.status, 'partial');
});
