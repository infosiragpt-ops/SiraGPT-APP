'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/services/attribution-prompt-quality-scorer');

describe('attribution-prompt-quality-scorer', () => {
  test('empty prompt → grade F, score 0', () => {
    const r = q.score({ prompt: '' });
    assert.equal(r.grade, 'F');
    assert.equal(r.score, 0);
    assert.ok(r.suggestions.length >= 1);
  });

  test('high-quality prompt → grade A or B', () => {
    const r = q.score({ prompt: 'Arregla el bug del componente Login en backend/src/routes/auth.js antes de la versión 2.5 que ya está en producción.' });
    assert.ok(['A', 'B'].includes(r.grade), `grade=${r.grade}`);
  });

  test('vague short prompt → low grade', () => {
    const r = q.score({ prompt: 'hazlo' });
    assert.ok(['D', 'F'].includes(r.grade));
    assert.ok(r.suggestions.length >= 1);
  });

  test('overloaded multi-action prompt loses points', () => {
    const r = q.score({ prompt: 'arregla el bug y luego crea un PDF y después analiza el reporte y modifica la UI y borra el archivo viejo' });
    assert.ok(r.dimensions.overload < 1);
  });

  test('anaphora without context flagged', () => {
    const r = q.score({ prompt: 'arregla eso y hazlo bien' });
    assert.ok(r.dimensions.anaphora < 1);
    assert.ok(r.suggestions.find((s) => /Anaphoric/.test(s)));
  });

  test('numeric specificity adds points', () => {
    const r1 = q.score({ prompt: 'genera un reporte' });
    const r2 = q.score({ prompt: 'genera un reporte de 250 clientes con ventas superiores a 10000 USD' });
    assert.ok(r2.dimensions.specificity > r1.dimensions.specificity);
  });

  test('buildQualityBlock returns content', () => {
    const r = q.score({ prompt: 'hola' });
    const block = q.buildQualityBlock(r);
    assert.match(block, /PROMPT QUALITY/);
  });

  test('gradeFromScore maps correctly', () => {
    assert.equal(q.gradeFromScore(0.95), 'A');
    assert.equal(q.gradeFromScore(0.75), 'B');
    assert.equal(q.gradeFromScore(0.6), 'C');
    assert.equal(q.gradeFromScore(0.4), 'D');
    assert.equal(q.gradeFromScore(0.1), 'F');
  });
});
