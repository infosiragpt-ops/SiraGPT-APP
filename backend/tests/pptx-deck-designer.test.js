'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeDeck, planPptxDeckWithLLM, _internals } = require('../src/services/document-pipeline/pptx-deck-designer');

function validDeck() {
  return {
    deckTitle: 'Gestión administrativa',
    thesis: 'Administrar es convertir recursos en resultados.',
    slides: [
      { layout: 'section', title: 'Fundamentos', kicker: 'Parte 1', notes: 'Abrir el bloque.' },
      { layout: 'bullets', title: 'Funciones clave', kicker: 'Ciclo', summary: 'El ciclo ordena el trabajo.', bullets: [{ label: 'Planificar', text: 'definir metas y presupuesto' }, { text: 'organizar recursos y roles' }], takeaway: 'El ciclo reduce incertidumbre', notes: 'Explicar el ciclo.' },
      { layout: 'two_column', title: 'Antes vs después', kicker: 'Cambio', columns: [{ heading: 'Hoy', items: ['procesos manuales'] }, { heading: 'Meta', items: ['flujos digitales'] }], notes: 'Contrastar.' },
      { layout: 'stat', title: 'Dato central', kicker: 'Evidencia', stat: { value: '70%', caption: 'de organizaciones reporta mejoras con gestión formal' }, support: ['dato del material adjunto'], notes: 'Aterrizar el dato.' },
      { layout: 'chart', title: 'Énfasis del plan', kicker: 'Estructura', chart: { title: 'Peso por eje', labels: ['Diagnóstico', 'Diseño', 'Ejecución'], values: [30, 30, 40], source: 'estructura de la presentación' }, insight: 'La ejecución concentra el esfuerzo', notes: 'Explicar pesos.' },
      { layout: 'bullets', title: 'Próximos pasos', kicker: 'Cierre', bullets: [{ label: '30 días', text: 'diagnóstico de procesos' }], notes: 'Cerrar con acción.' },
    ],
  };
}

test('sanitizeDeck acepta un deck válido y normaliza la forma legada', () => {
  const deck = sanitizeDeck(validDeck(), { title: 'Gestión administrativa' });
  assert.ok(deck);
  assert.equal(deck.source, 'llm:deck-designer');
  assert.equal(deck.slides.length, 6);
  assert.ok(deck.agenda.length >= 3);
  // toda slide expone summary/bullets para la vista previa HTML
  for (const slide of deck.slides) {
    assert.equal(typeof slide.summary, 'string');
    assert.ok(Array.isArray(slide.bullets));
    assert.ok(slide.notes.length > 0 || slide.layout === 'section');
  }
  const statSlide = deck.slides.find((slide) => slide.layout === 'stat');
  assert.match(statSlide.summary, /70%/);
});

test('sanitizeDeck filtra slides inválidas y exige mínimo 5', () => {
  const raw = validDeck();
  raw.slides = raw.slides.slice(0, 3); // < 5 tras sanitizar
  assert.equal(sanitizeDeck(raw, { title: 'x' }), null);

  const broken = validDeck();
  broken.slides.push({ layout: 'stat', title: 'Sin stat', notes: 'x' }); // stat sin value → fuera
  broken.slides.push({ layout: 'two_column', title: 'Una columna', columns: [{ heading: 'a', items: ['1'] }], notes: 'x' }); // 1 col → fuera
  const deck = sanitizeDeck(broken, { title: 'x' });
  assert.ok(deck);
  assert.equal(deck.slides.length, 6); // las rotas no entran
});

test('sanitizeChart rechaza datos incompletos', () => {
  assert.equal(_internals.sanitizeChart({ labels: ['a'], values: [1] }), null);
  assert.equal(_internals.sanitizeChart({ labels: ['a', 'b'], values: [1] }), null);
  const ok = _internals.sanitizeChart({ title: 'T', labels: ['a', 'b'], values: [1, 2], source: 's' });
  assert.equal(ok.labels.length, 2);
});

test('planPptxDeckWithLLM no toca la red en NODE_ENV=test', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const out = await planPptxDeckWithLLM({ title: 'x', prompt: 'crea una ppt de x' });
    assert.equal(out, null);
  } finally {
    process.env.NODE_ENV = prev;
  }
});
