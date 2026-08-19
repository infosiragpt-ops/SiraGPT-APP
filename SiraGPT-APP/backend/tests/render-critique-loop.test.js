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
    [{ page: 1, png: Buffer.from('png') }],
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
