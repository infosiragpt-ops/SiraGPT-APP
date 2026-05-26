'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bk = require('../src/services/attribution-bulk-analyzer');

describe('attribution-bulk-analyzer', () => {
  test('empty input returns zero', () => {
    const r = bk.analyzeBatch([]);
    assert.equal(r.total, 0);
  });

  test('analyzeOne returns expected fields', () => {
    const r = bk.analyzeOne('crea un PDF con los KPIs del trimestre');
    assert.ok(r.quality);
    assert.ok(typeof r.quality.score === 'number');
    assert.ok(Array.isArray(r.intents));
    assert.ok(Array.isArray(r.supernodes));
  });

  test('analyzeBatch aggregates intent counts', () => {
    const r = bk.analyzeBatch([
      'arregla el bug',
      'arregla otro bug del frontend',
      'genera un PDF',
    ]);
    assert.equal(r.total, 3);
    assert.ok(r.aggregate.intentDistribution.length >= 1);
    const fix = r.aggregate.intentDistribution.find((i) => i.intent === 'fix');
    if (fix) assert.ok(fix.count >= 2);
  });

  test('analyzeBatch respects MAX_BATCH cap', () => {
    const big = Array.from({ length: bk.MAX_BATCH + 50 }, (_, i) => `crea reporte ${i}`);
    const r = bk.analyzeBatch(big);
    assert.equal(r.total, bk.MAX_BATCH);
  });

  test('analyzeBatch tracks elapsedMs and avgQuality', () => {
    const r = bk.analyzeBatch(['hola', 'crea un PDF detallado con KPIs']);
    assert.ok(typeof r.elapsedMs === 'number');
    assert.ok(r.aggregate.avgQuality >= 0);
    assert.ok(r.aggregate.avgQuality <= 1);
  });

  test('includeSuite returns the suite bundle per prompt', () => {
    const r = bk.analyzeBatch(['crea un PDF'], { includeSuite: true });
    assert.ok(r.results[0].suite);
  });

  test('empty prompt entries are flagged but do not crash', () => {
    const r = bk.analyzeBatch(['', '   ', 'arregla el bug']);
    assert.equal(r.total, 3);
    assert.equal(r.results[0].empty, true);
  });

  test('buildBulkBlock returns content', () => {
    const r = bk.analyzeBatch(['crea un PDF']);
    const block = bk.buildBulkBlock(r);
    assert.match(block, /BULK ATTRIBUTION/);
  });
});
