'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/services/attribution-anti-pattern-detector');

describe('attribution-anti-pattern-detector', () => {
  test('empty history → no antipattern', () => {
    const r = d.detect({ history: [] });
    assert.equal(r.hasAntipattern, false);
  });

  test('detects repetition_loop after 3 same-action turns', () => {
    const history = Array.from({ length: 4 }, (_, i) => ({
      role: 'user',
      content: `Arregla el bug del frontend del Login Component intento ${i}`,
    }));
    const r = d.detect({ history });
    assert.ok(r.patterns.find((p) => p.kind === 'repetition_loop'));
  });

  test('detects escalating_urgency when markers appear late', () => {
    const history = [
      { role: 'user', content: 'Cómo está el reporte mensual' },
      { role: 'user', content: 'Avanzando bien?' },
      { role: 'user', content: 'Por favor necesito ya el reporte' },
      { role: 'user', content: 'Es urgente, ahora mismo' },
    ];
    const r = d.detect({ history });
    assert.ok(r.patterns.find((p) => p.kind === 'escalating_urgency'));
  });

  test('detects context_drop_loop on repeated anaphora', () => {
    const history = [
      { role: 'user', content: 'arregla eso del frontend' },
      { role: 'user', content: 'eso sigue mal' },
      { role: 'user', content: 'eso no funciona, intenta otra cosa' },
      { role: 'user', content: 'eso tampoco' },
    ];
    const r = d.detect({ history });
    assert.ok(r.patterns.find((p) => p.kind === 'context_drop_loop'));
  });

  test('benign chat → no antipattern', () => {
    const history = [
      { role: 'user', content: 'Crea un PDF con los KPIs' },
      { role: 'user', content: 'Ahora añade una gráfica de ventas' },
    ];
    const r = d.detect({ history });
    assert.equal(r.hasAntipattern, false);
  });

  test('buildAntipatternBlock empty when no patterns', () => {
    assert.equal(d.buildAntipatternBlock({ hasAntipattern: false, patterns: [] }), '');
  });

  test('buildAntipatternBlock contains alert when patterns present', () => {
    const result = { hasAntipattern: true, patterns: [{ kind: 'repetition_loop', severity: 'medium', detail: 'x', recommendation: 'y' }] };
    const block = d.buildAntipatternBlock(result);
    assert.match(block, /ANTI-PATTERN ALERT/);
  });
});
