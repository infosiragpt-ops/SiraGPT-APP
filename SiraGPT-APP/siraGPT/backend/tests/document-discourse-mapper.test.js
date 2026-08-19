'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-discourse-mapper');
const {
  mapDiscourse,
  buildDiscourseForFiles,
  renderDiscourseBlock,
  _internal,
} = engine;

test('mapDiscourse: empty / non-string input returns empty', () => {
  const r1 = mapDiscourse('');
  assert.equal(r1.markerCount, 0);
  assert.deepEqual(r1.markers, []);
  assert.equal(mapDiscourse(null).markerCount, 0);
  assert.equal(mapDiscourse(undefined).markerCount, 0);
  assert.equal(mapDiscourse(42).markerCount, 0);
});

test('mapDiscourse: Spanish contrast markers', () => {
  const text = `El proyecto avanza según lo previsto. Sin embargo, el presupuesto está bajo presión. No obstante, el equipo confía en cumplir el plazo.`;
  const r = mapDiscourse(text);
  assert.ok(r.totals.contrast >= 2, `expected ≥2 contrast markers, got ${r.totals.contrast}`);
  assert.ok(r.markers.some((m) => m.marker === 'sin embargo'));
  assert.ok(r.markers.some((m) => m.marker === 'no obstante'));
});

test('mapDiscourse: English causation markers', () => {
  const text = `The deal fell through. Therefore, we will renegotiate next week. Consequently, the deadline slips by two months. As a result, the team needs more headcount.`;
  const r = mapDiscourse(text);
  assert.ok(r.totals.causation >= 3, `expected ≥3 causation markers, got ${r.totals.causation}`);
  assert.ok(r.markers.some((m) => m.marker === 'therefore'));
  assert.ok(r.markers.some((m) => m.marker === 'consequently'));
  assert.ok(r.markers.some((m) => m.marker === 'as a result'));
});

test('mapDiscourse: sequence markers (bilingual)', () => {
  const text = `Plan de implementación. Primero, definir el alcance. Segundo, asignar recursos. Finalmente, ejecutar el rollout. First, we agree on goals. Then, we execute. Finally, we measure.`;
  const r = mapDiscourse(text);
  assert.ok(r.totals.sequence >= 5, `expected ≥5 sequence markers, got ${r.totals.sequence}: ${JSON.stringify(r.markers.map((m) => m.marker))}`);
});

test('mapDiscourse: conclusion markers', () => {
  const text = `Análisis del trimestre. En conclusión, los resultados superan las expectativas. In summary, every KPI moved in the right direction.`;
  const r = mapDiscourse(text);
  assert.ok(r.totals.conclusion >= 2);
  assert.ok(r.markers.some((m) => m.marker === 'en conclusión'));
  assert.ok(r.markers.some((m) => m.marker === 'in summary'));
});

test('mapDiscourse: exemplification markers', () => {
  const text = `Varios módulos están en buen estado. Por ejemplo, el módulo de auth está al 95%. For instance, the billing service has been refactored.`;
  const r = mapDiscourse(text);
  assert.ok(r.totals.exemplification >= 2);
});

test('mapDiscourse: emphasis markers', () => {
  const text = `Cabe destacar el desempeño del equipo de QA. Notably, the bug count dropped 40%. Particularly impressive is the response time.`;
  const r = mapDiscourse(text);
  assert.ok(r.totals.emphasis >= 2);
});

test('mapDiscourse: longest-match wins (e.g. "on the other hand" over "on")', () => {
  const text = 'The plan looks solid. On the other hand, the budget is tight.';
  const r = mapDiscourse(text);
  assert.ok(r.markers.some((m) => m.marker === 'on the other hand'));
});

test('mapDiscourse: markers come in reading order', () => {
  const text = `Sin embargo, hay un riesgo. Por lo tanto, hay que mitigarlo. Finalmente, ejecutamos el plan.`;
  const r = mapDiscourse(text);
  // Expect sequence: contrast, causation, sequence — by position.
  const cats = r.markers.map((m) => m.category);
  assert.equal(cats[0], 'contrast');
  assert.equal(cats[1], 'causation');
  assert.equal(cats[2], 'sequence');
});

test('mapDiscourse: snippet contains surrounding context', () => {
  const text = 'El equipo lleva meses preparando esto. Sin embargo, ayer todo cambió radicalmente.';
  const r = mapDiscourse(text);
  const m = r.markers.find((x) => x.marker === 'sin embargo');
  assert.ok(m);
  assert.ok(m.snippet.length > 'sin embargo'.length);
});

test('mapDiscourse: caps marker list at MAX_MARKERS_PER_FILE', () => {
  const sentences = [];
  for (let i = 0; i < 60; i += 1) {
    sentences.push('Sin embargo, esto cambia.');
  }
  const r = mapDiscourse(sentences.join(' '));
  assert.ok(r.markers.length <= _internal.MAX_MARKERS_PER_FILE);
  // Total should reflect uncapped count.
  assert.ok(r.markerCount >= 50);
});

test('buildDiscourseForFiles: aggregates and skips empty files', () => {
  const files = [
    { originalName: 'a.txt', extractedText: 'Sin embargo, el proyecto avanza.' },
    { originalName: 'empty.txt', extractedText: '' },
    { originalName: 'plain.txt', extractedText: 'just plain text with no markers' },
    { originalName: 'b.txt', extractedText: 'Therefore, we proceed. In conclusion, success.' },
  ];
  const { perFile, aggregate } = buildDiscourseForFiles(files);
  assert.equal(perFile.length, 2);
  assert.ok(aggregate.totals.contrast >= 1);
  assert.ok(aggregate.totals.causation >= 1);
});

test('renderDiscourseBlock: empty → empty string', () => {
  assert.equal(renderDiscourseBlock(null), '');
  assert.equal(renderDiscourseBlock({ perFile: [], aggregate: {} }), '');
});

test('renderDiscourseBlock: single-file rendering has heading + counts + markers', () => {
  const r = buildDiscourseForFiles([{
    originalName: 'plan.txt',
    extractedText: 'Sin embargo, el riesgo persiste. Por lo tanto, hay que mitigarlo. En conclusión, requiere atención.',
  }]);
  const md = renderDiscourseBlock(r);
  assert.ok(md.includes('## DISCOURSE MAP'));
  assert.ok(md.includes('### File: plan.txt'));
  assert.ok(md.includes('Marker counts'));
  assert.ok(md.includes('sin embargo'));
  assert.ok(md.includes('por lo tanto'));
});

test('renderDiscourseBlock: multi-file has aggregate + per-file', () => {
  const r = buildDiscourseForFiles([
    { originalName: 'a.txt', extractedText: 'Sin embargo, hay un cambio.' },
    { originalName: 'b.txt', extractedText: 'Therefore, the team adjusts. In conclusion, all is well.' },
  ]);
  const md = renderDiscourseBlock(r);
  assert.ok(md.includes('Aggregate across all files'));
  assert.ok(md.includes('### File: a.txt'));
  assert.ok(md.includes('### File: b.txt'));
});

test('renderDiscourseBlock: respects MAX_BLOCK_CHARS budget', () => {
  // Build a doc with many markers to force truncation.
  const sentences = [];
  for (let i = 0; i < 100; i += 1) {
    sentences.push(`Sin embargo, el punto ${i} requiere atención detallada y prolongada del equipo técnico.`);
    sentences.push(`Por lo tanto, hay que abrir el ticket ${i} y asignar un responsable de seguimiento.`);
  }
  const md = renderDiscourseBlock(buildDiscourseForFiles([
    { originalName: 'huge.txt', extractedText: sentences.join('\n') },
  ]));
  assert.ok(md.length <= _internal.MAX_BLOCK_CHARS,
    `block exceeded budget: ${md.length} > ${_internal.MAX_BLOCK_CHARS}`);
});

test('integration: professional-analyzer exposes discourseBlock', async () => {
  const pa = require('../src/services/document-professional-analyzer');
  const result = await pa.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'd1',
      originalName: 'argument.txt',
      extractedText: 'Primero, definimos el objetivo. Sin embargo, surgieron obstáculos. Por lo tanto, ajustamos el plan. En conclusión, el resultado fue positivo.',
    }],
  });
  assert.ok(typeof result.discourseBlock === 'string',
    'enrichment should expose discourseBlock field');
  assert.ok(result.discourseBlock.includes('DISCOURSE MAP'));
});
