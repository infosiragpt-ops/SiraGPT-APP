'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPptxDeckManifest,
  attachSourceCitations,
  reconcilePptxPlan,
  auditPptxPlan,
  claimIsGrounded,
  extractStrongNumericClaims,
  valueIsGrounded,
} = require('../src/services/document-pipeline/pptx-prompt-contract');

function sampleSlides() {
  return [
    { layout: 'bullets', title: 'El reto exige foco', summary: 'La operación necesita prioridades claras.', bullets: [{ label: 'Reto', text: 'coordinar áreas y decisiones' }], notes: 'Explicar el reto.' },
    { layout: 'two_column', title: 'Dos capacidades sostienen el cambio', columns: [{ heading: 'Gestión', items: ['roles claros', 'procesos simples'] }, { heading: 'Ejecución', items: ['seguimiento', 'aprendizaje'] }], notes: 'Contrastar capacidades.' },
    { layout: 'bullets', title: 'La estrategia ordena recursos', summary: 'La estrategia conecta prioridades y recursos.', bullets: [{ label: 'Dirección', text: 'traducir objetivos en decisiones' }], notes: 'Explicar la estrategia.' },
    { layout: 'bullets', title: 'Los procesos vuelven repetible el valor', summary: 'Los procesos reducen variación.', bullets: [{ label: 'Proceso', text: 'definir entradas, responsables y salidas' }], notes: 'Explicar procesos.' },
    { layout: 'bullets', title: 'El seguimiento acelera aprendizaje', summary: 'La revisión permite corregir antes.', bullets: [{ label: 'Cadencia', text: 'revisar señales y desbloquear acciones' }], notes: 'Explicar seguimiento.' },
    { layout: 'bullets', title: 'Próximos pasos convierten intención', summary: 'El cierre asigna responsables y decisiones.', bullets: [{ label: 'Acción', text: 'priorizar, asignar y revisar' }], notes: 'Cerrar con acción.' },
  ];
}

test('manifest treats the requested number as the TOTAL deck size', () => {
  const manifest = buildPptxDeckManifest({ slideTarget: 8 });
  assert.deepEqual(manifest, {
    explicit: true,
    totalSlides: 8,
    contentSlides: 6,
    includeCover: true,
    includeAgenda: true,
    includeReferences: false,
    shellSlides: 2,
  });
});

test('manifest uses eight total slides when no count was requested', () => {
  const manifest = buildPptxDeckManifest({ slideTarget: null });
  assert.equal(manifest.explicit, false);
  assert.equal(manifest.totalSlides, 8);
  assert.equal(manifest.contentSlides, 6);
});

test('manifest budgets a references slide without exceeding the requested total', () => {
  const manifest = buildPptxDeckManifest({ slideTarget: 8, references: [{ name: 'Fuente' }] });
  assert.equal(manifest.totalSlides, 8);
  assert.equal(manifest.shellSlides, 3);
  assert.equal(manifest.contentSlides, 5);
  assert.equal(manifest.includeReferences, true);
});

test('small decks omit agenda so two requested slides still means two', () => {
  const manifest = buildPptxDeckManifest({ slideTarget: 2 });
  assert.equal(manifest.totalSlides, 2);
  assert.equal(manifest.contentSlides, 1);
  assert.equal(manifest.includeAgenda, false);
});

test('reconcilePptxPlan produces the exact content budget and keeps an action close', () => {
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'La disciplina de gestión convierte estrategia en resultados.',
    slides: sampleSlides(),
    references: [],
  }, { slideTarget: 8 });
  assert.equal(plan.manifest.totalSlides, 8);
  assert.equal(plan.slides.length, 6);
  assert.match(plan.slides.at(-1).title, /pr[oó]ximos pasos/i);
  assert.equal(plan.agenda.length, 6);
});

test('reconcilePptxPlan is idempotent so PPTX and HTML preview keep the same slides', () => {
  const source = {
    topic: 'Gestión de empresas',
    thesis: 'La gestión conecta estrategia y ejecución.',
    slides: Array.from({ length: 8 }, (_, index) => ({
      layout: index === 2 ? 'two_column' : 'bullets',
      title: index === 7 ? 'Próximos pasos' : `Decisión ${index + 1}`,
      summary: `Contenido ${index + 1}`,
      bullets: [{ label: 'Acción', text: `Paso ${index + 1}` }],
      columns: index === 2 ? [
        { heading: 'A', items: ['Uno'] },
        { heading: 'B', items: ['Dos'] },
      ] : undefined,
      notes: `Notas ${index + 1}`,
    })),
  };
  const first = reconcilePptxPlan(source, { slideTarget: 8 });
  const second = reconcilePptxPlan(first, { slideTarget: 8, fallbackSlides: source.slides });

  assert.deepEqual(second.slides.map((slide) => slide.title), first.slides.map((slide) => slide.title));
});

test('reconcilePptxPlan condenses a two-slide deck into cover plus synthesis', () => {
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'Una tesis clara.',
    slides: sampleSlides(),
    references: [],
  }, { slideTarget: 2 });
  assert.equal(plan.slides.length, 1);
  assert.equal(plan.slides[0].title, 'Síntesis ejecutiva');
});

test('numeric evidence gate detects the unsupported 68% failure from production', () => {
  assert.deepEqual(extractStrongNumericClaims('68% de empresas mejora márgenes'), ['68%']);
  assert.deepEqual(extractStrongNumericClaims('Programa de liderazgo para 150 gerentes intermedios'), ['150 gerentes']);
  assert.deepEqual(extractStrongNumericClaims('Plan de 30 días, 60 días y 90 días'), []);
  assert.deepEqual(extractStrongNumericClaims('Próximos pasos con un plan 30-60-90 Implementación'), []);
  assert.equal(valueIsGrounded('68%', 'Solicitud general sobre gestión de empresas'), false);
  assert.equal(valueIsGrounded('68%', 'La fuente adjunta reporta 68% de empresas'), true);
  assert.equal(claimIsGrounded('420 participantes', 'Muestra: 420'), true);
});

test('reconcile injects visible fallback content for explicitly required topics', () => {
  const primary = sampleSlides().map((slide) => ({ ...slide }));
  const fallbackRisk = {
    layout: 'bullets',
    title: 'Los controles reducen riesgos',
    bullets: [{ label: 'Riesgos', text: 'identificar responsables y alertas tempranas' }],
    notes: 'Explicar los controles.',
  };
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'Tesis',
    slides: primary,
  }, {
    slideTarget: 8,
    fallbackSlides: [...primary, fallbackRisk],
    requiredItems: ['riesgos'],
  });
  assert.equal(plan.slides.some((slide) => /riesgos/i.test(JSON.stringify({ ...slide, notes: '' }))), true);
});

test('speaker notes alone do not satisfy visible prompt requirements', () => {
  const slides = sampleSlides().map((slide) => ({ ...slide, notes: 'Explicar riesgos.' }));
  const plan = reconcilePptxPlan({ topic: 'Gestión empresarial', thesis: 'Tesis', slides }, { slideTarget: 8 });
  const report = auditPptxPlan(plan, {
    prompt: 'Presentación general.',
    requiredItems: ['riesgos'],
  });
  assert.equal(report.checks.requiredItems, false);
  assert.deepEqual(report.missingRequiredItems, ['riesgos']);
});

test('audit rejects an unsupported headcount even when it is not a percentage', () => {
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'Tesis',
    references: [],
    slides: [
      ...sampleSlides().slice(0, 5),
      { layout: 'bullets', title: 'El talento sostiene la ejecución', bullets: [{ text: 'Programa de liderazgo para 150 gerentes intermedios' }], notes: 'Explicar.' },
    ],
  }, { slideTarget: 8 });
  const report = auditPptxPlan(plan, { prompt: 'Presentación general sin estadísticas.' });
  assert.equal(report.checks.groundedNumbers, false);
  assert.equal(report.unsupportedNumericClaims[0].claim, '150 gerentes');
});

test('audit rejects unsupported metrics and accepts the same metric when sourced', () => {
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'Tesis',
    references: [],
    slides: [
      ...sampleSlides().slice(0, 5),
      { layout: 'stat', title: 'La escala mejora resultados', stat: { value: '68%', caption: '68% de empresas mejora márgenes', source: 'Estudio' }, notes: 'Explicar el dato.' },
    ],
  }, { slideTarget: 8 });
  const unsupported = auditPptxPlan(plan, { prompt: 'Presentación general sobre gestión.' });
  assert.equal(unsupported.checks.groundedNumbers, false);
  assert.equal(unsupported.unsupportedNumericClaims[0].claim, '68%');

  const grounded = auditPptxPlan(plan, { prompt: 'El estudio aportado indica que 68% de empresas mejora márgenes.' });
  assert.equal(grounded.checks.groundedNumbers, true);
});

test('audit enforces unique titles, notes and layout variety', () => {
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'Tesis',
    slides: sampleSlides(),
    references: [],
  }, { slideTarget: 8 });
  const report = auditPptxPlan(plan, { prompt: 'Presentación general sobre gestión.' });
  assert.equal(report.passed, true, JSON.stringify(report));
});

test('audit tracks required and forbidden prompt content', () => {
  const plan = reconcilePptxPlan({
    topic: 'Gestión empresarial',
    thesis: 'Tesis',
    slides: sampleSlides(),
    references: [],
  }, { slideTarget: 8 });
  const report = auditPptxPlan(plan, {
    prompt: 'Presentación general sobre gestión.',
    requiredItems: ['cronograma de implementación'],
    forbiddenItems: ['procesos simples'],
  });
  assert.equal(report.checks.requiredItems, false);
  assert.deepEqual(report.missingRequiredItems, ['cronograma de implementación']);
  assert.equal(report.checks.forbiddenItems, false);
  assert.deepEqual(report.presentForbiddenItems, ['procesos simples']);
});

test('scientific slides receive deterministic source citations and figure provenance is audited', () => {
  const referenceBriefs = [
    { name: '[S1] Telemedicine trial.txt', excerpt: 'Randomized trial with improved follow-up and n=420.' },
    { name: '[S2] Systematic review.txt', excerpt: 'Systematic review of remote care outcomes.' },
  ];
  const raw = reconcilePptxPlan({
    topic: 'Telemedicina',
    thesis: 'La evidencia orienta decisiones clínicas.',
    references: referenceBriefs,
    slides: sampleSlides().map((slide, index) => index === 0 ? {
      ...slide,
      layout: 'stat',
      stat: { value: '420', caption: '420 participantes en el ensayo', source: '[S1]' },
      summary: 'El ensayo aleatorizado evaluó seguimiento remoto.',
    } : slide),
  }, { slideTarget: 8 });
  const plan = attachSourceCitations(raw, { referenceBriefs });
  assert.equal(plan.slides.filter((slide) => slide.layout !== 'section').every((slide) => slide.sourceCitations.length > 0), true);
  const report = auditPptxPlan(plan, {
    prompt: 'El ensayo incluyó 420 participantes.',
    referenceBriefs,
  });
  assert.equal(report.checks.sourceCitations, true);
  assert.equal(report.checks.figureProvenance, true);
});
