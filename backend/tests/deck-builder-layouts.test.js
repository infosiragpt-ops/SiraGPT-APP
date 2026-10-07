'use strict';

/**
 * Professional deck design on the runner's default path (create_presentation
 * → deck-builder) and the designed add_slide follow-up (deck-append):
 *   - layout vocabulary (agenda, columns, timeline, table, quote, section,
 *     closing) chosen from the outline fields, speaker notes, shrink-to-fit;
 *   - the design audit the model acts on (designWarnings);
 *   - theme picked from the user's words when the model passes none;
 *   - a slide added to an existing SiraGPT deck keeps its theme, lands before
 *     the closing slide and renumbers every «NN / TT» footer;
 *   - the plain clone fallback never repeats bullets nor shares a notes part.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const deckBuilder = require('../src/services/agent-runner/deck-builder');
const { makeToolExecutors, normalizeOutline, auditDeckPlan, SLIDE_SCHEMA } = require('../src/services/agent-runner/tools');
const deckAppend = require('../src/services/agent-runner/deck-append');

function fakeSandbox() {
  const files = new Map();
  return {
    files,
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile(p) { return files.get(p); },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return []; },
  };
}

function executorsFor(sandbox, deck = null) {
  return makeToolExecutors(sandbox, { office: { enabled: false }, ...(deck ? { deck } : {}) });
}

async function createDeck(args, deck = null) {
  const sandbox = fakeSandbox();
  const executors = executorsFor(sandbox, deck);
  const raw = await executors.create_presentation(args);
  assert.ok(!String(raw).startsWith('ERROR:'), raw);
  const result = JSON.parse(raw);
  const out = [...sandbox.files.keys()].find((k) => k.startsWith('outputs/'));
  return { result, sandbox, executors, out, zip: new PizZip(sandbox.files.get(out)) };
}

function orderedSlideXml(zip) {
  return deckAppend.orderedSlides(zip).map((s) => zip.file(s.partName).asText());
}

function notesXml(zip) {
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .map((n) => zip.file(n).asText())
    .join('\n');
}

// ── Pure layout resolution ───────────────────────────────────────────────

test('resolveLayout: the outline fields pick the slide kind; aliases and unknown names normalise', () => {
  const plan = [
    { title: 'Agenda' },
    { title: 'Contexto', bullets: ['a', 'b', 'c'] },
    { title: 'Opciones', columns: [{ title: 'A', bullets: ['x'] }, { title: 'B', bullets: ['y'] }] },
    { title: 'Ruta', steps: ['Diagnóstico: entrevistas', 'Diseño — prototipo', 'Piloto'] },
    { title: 'Datos', table: { headers: ['Área', 'Valor'], rows: [['Norte', '120'], ['Sur', '90']] } },
    { title: 'Voz del cliente', quote: { text: 'Excelente servicio', author: 'CEO' } },
    { title: 'Capítulo 2' },
    { title: 'Próximos pasos', bullets: ['Aprobar presupuesto', 'Iniciar piloto'] },
  ];
  assert.deepEqual(deckBuilder.planLayouts(plan), ['agenda', 'bullets', 'columns', 'timeline', 'table', 'quote', 'section', 'closing']);
  // Last item without bullets closes a new deck but not a slide appended to an existing one.
  assert.equal(deckBuilder.resolveLayout({ title: 'Anexos' }, 0, [{ title: 'Anexos' }]), 'closing');
  assert.equal(deckBuilder.resolveLayout({ title: 'Anexos' }, 0, [{ title: 'Anexos' }], { appendMode: true }), 'section');
  // Seven or more steps do not fit a rail: they render as a list.
  assert.equal(deckBuilder.resolveLayout({ title: 'Plan', steps: ['1', '2', '3', '4', '5', '6', '7'] }, 0, []), 'bullets');
  assert.equal(deckBuilder.normalizeLayoutName('comparison'), 'columns');
  assert.equal(deckBuilder.normalizeLayoutName('process'), 'timeline');
  assert.equal(deckBuilder.normalizeLayoutName('kpi'), 'bullets');
  assert.equal(deckBuilder.normalizeLayoutName('whatever'), 'auto');
  assert.deepEqual(deckBuilder.stepParts('Diseño — prototipo'), { title: 'Diseño', description: 'prototipo' });
  assert.deepEqual(deckBuilder.stepParts({ title: 'Piloto', description: '3 meses' }), { title: 'Piloto', description: '3 meses' });
  assert.equal(deckBuilder.tableParts({ rows: [] }), null);
  assert.equal(deckBuilder.tableParts({ headers: ['a', 'b'], rows: [['1']] }).rows[0].length, 2, 'short rows are padded');
});

test('normalizeOutline keeps the design fields and refuses tables that cannot fit one slide', () => {
  const [slide] = normalizeOutline([{
    title: 'Comparativa', layout: 'comparison', subtitle: 'Tres escenarios', notes: 'Explicar la tabla.',
    columns: [{ title: 'A', bullets: ['x'] }, { title: 'B', bullets: ['y'] }],
    steps: ['Uno: a', 'Dos: b'], table: { headers: ['h'], rows: [['v']] }, quote: { text: 'q', author: 'a' },
  }]);
  assert.equal(slide.layout, 'columns');
  assert.equal(slide.subtitle, 'Tres escenarios');
  assert.equal(slide.notes, 'Explicar la tabla.');
  assert.equal(slide.columns.length, 2);
  assert.deepEqual(slide.steps, [{ title: 'Uno', description: 'a' }, { title: 'Dos', description: 'b' }]);
  assert.deepEqual(slide.table, { headers: ['h'], rows: [['v']] });
  assert.deepEqual(slide.quote, { text: 'q', author: 'a' });
  assert.throws(
    () => normalizeOutline([{ title: 'Grande', table: { headers: ['a'], rows: Array.from({ length: 15 }, (_, i) => [String(i)]) } }]),
    /E_PARAMS: la tabla/,
  );
  assert.throws(() => normalizeOutline([{ title: 'Cuatro', columns: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] }]), /máximo 3/);
  assert.equal(SLIDE_SCHEMA.properties.notes.type, 'string');
  assert.ok(SLIDE_SCHEMA.properties.columns && SLIDE_SCHEMA.properties.steps && SLIDE_SCHEMA.properties.table && SLIDE_SCHEMA.properties.quote);
});

test('auditDeckPlan: the professional-deck rules the model must act on', () => {
  const dense = Array.from({ length: 9 }, (_, i) => `Viñeta número ${i + 1} con texto`);
  const warnings = auditDeckPlan([
    { title: 'Un título demasiado largo que no cabe en ocho palabras ni en setenta caracteres de ancho', bullets: dense },
    { title: 'Tema — sección 2', bullets: ['Puntos clave sobre el tema'] },
    { title: 'Repetido', bullets: ['a', 'b'] },
    { title: 'Repetido', bullets: ['c', 'd'] },
    { title: 'Más viñetas', bullets: ['e', 'f'] },
  ]);
  const text = warnings.join('\n');
  assert.match(text, /título de \d+ caracteres/);
  assert.match(text, /9 viñetas; máximo 6/);
  assert.match(text, /título genérico/);
  assert.match(text, /viñetas de relleno/);
  assert.match(text, /repiten el título «Repetido»/);
  assert.match(text, /seguidas solo de viñetas/);
  assert.match(text, /Falta una diapositiva de cierre/);
  assert.match(text, /Ninguna diapositiva tiene notas/);
  // A clean deck has no warnings.
  assert.deepEqual(auditDeckPlan([
    { title: 'Las ventas crecieron 12 % en Q3', bullets: ['35% más pedidos', '12% ticket medio'], notes: 'Contexto.' },
    { title: 'Tres escenarios para 2027', columns: [{ title: 'Base', bullets: ['x'] }, { title: 'Agresivo', bullets: ['y'] }], notes: 'Comparar.' },
    { title: 'Próximos pasos', bullets: ['Aprobar presupuesto'], notes: 'Cierre.' },
  ]), []);
});

// ── Rendered decks ───────────────────────────────────────────────────────

const RICH_OUTLINE = [
  { title: 'Agenda', notes: 'Recorrido de la sesión.' },
  { title: 'Las ventas crecieron 12 % en Q3', bullets: ['35% más pedidos online', '12% de ticket medio', '98% cumplimiento de entregas'], notes: 'Datos del CRM.' },
  { title: 'Tres escenarios para 2027', subtitle: 'Supuestos del comité', columns: [{ title: 'Conservador', bullets: ['Crecer 5 %', 'Sin nuevas tiendas'] }, { title: 'Base', bullets: ['Crecer 9 %', 'Dos tiendas'] }, { title: 'Agresivo', bullets: ['Crecer 15 %', 'Cinco tiendas'] }], notes: 'Comparar riesgos.' },
  { title: 'Ruta de implementación', steps: ['Diagnóstico: entrevistas a 20 clientes', 'Diseño: prototipo en 4 semanas', 'Piloto: dos tiendas', 'Despliegue: toda la red'], notes: 'Fechas tentativas.' },
  { title: 'Presupuesto por área', table: { headers: ['Área', '2026', '2027'], rows: [['Marketing', '$120k', '$150k'], ['Operaciones', '$300k', '$320k'], ['Tecnología', '$80k', '$140k']] }, notes: 'Cifras aprobadas.' },
  { title: 'Lo que dicen los clientes', quote: { text: 'La entrega en 24 horas cambió nuestra operación', author: 'Gerente de compras, cliente mayorista' }, notes: 'Encuesta NPS.' },
  { title: 'Segunda parte' },
  { title: 'Próximos pasos', layout: 'closing', bullets: ['Aprobar el presupuesto 2027', 'Iniciar el piloto en marzo'], notes: 'Pedir decisión.' },
];

test('create_presentation renders agenda, columns, timeline, table, quote, section and closing slides with notes', async () => {
  const { result, zip } = await createDeck({ topic: 'ventas', title: 'Plan comercial 2027', outline: RICH_OUTLINE, filename: 'plan.pptx' });
  assert.deepEqual(result.layouts, ['cover', 'agenda', 'bullets', 'columns', 'timeline', 'table', 'quote', 'section', 'closing']);
  assert.equal(result.slides, 9);
  assert.equal(result.notesSlides, 7);
  const slides = orderedSlideXml(zip);
  assert.equal(slides.length, 9);
  const [, agenda, kpi, columns, timeline, table, quote, section, closing] = slides;
  // Agenda lists the other section titles when it has no bullets of its own.
  assert.ok(agenda.includes('SiraAgenda 1'), 'agenda rows');
  assert.ok(agenda.includes('Tres escenarios para 2027') && agenda.includes('Ruta de implementaci'), 'agenda derived from the outline');
  assert.equal(agenda.includes('Próximos pasos'), false, 'the closing slide is not an agenda item');
  assert.ok(kpi.includes('>35%<'), 'figure-first bullets become KPI tiles');
  assert.ok(columns.includes('SiraChip band 1') && columns.includes('SiraChip band 3') && columns.includes('Agresivo') && columns.includes('Cinco tiendas'), 'three comparison columns');
  assert.ok(columns.includes('Supuestos del comité'), 'subtitle rendered');
  assert.ok(timeline.includes('SiraRail timeline') && timeline.includes('SiraStep 4 title') && timeline.includes('entrevistas a 20 clientes'), 'process rail with four steps');
  assert.ok(table.includes('<a:tbl>') && table.includes('Operaciones') && table.includes('$320k'), 'native table with every cell');
  assert.ok(quote.includes('SiraQuote text') && quote.includes('SiraKpi quote value') && quote.includes('Gerente de compras'), 'quote with attribution');
  assert.ok(section.includes('Section number') && section.includes('>01<'), 'numbered section divider');
  assert.ok(closing.includes('Próximos pasos') && closing.includes('Iniciar el piloto en marzo'), 'closing slide keeps its call-to-action lines');
  assert.ok(closing.includes('09 / 09'), 'footer numbering');
  const notes = notesXml(zip);
  for (const text of ['Recorrido de la sesión.', 'Datos del CRM.', 'Encuesta NPS.', 'Pedir decisión.']) {
    assert.ok(notes.includes(text), `speaker notes kept: ${text}`);
  }
  assert.deepEqual(result.designWarnings, [], `clean outline has no warnings: ${result.designWarnings}`);
  const all = slides.join('\n');
  assert.equal(all.includes('Puntos clave'), false);
  assert.equal(all.includes('FFC0CB'), false, 'never pink without a request');
});

test('create_presentation reports designWarnings for dense slides and missing notes; text boxes shrink to fit', async () => {
  const dense = Array.from({ length: 9 }, (_, i) => `Viñeta ${i + 1}: un texto bastante largo que explica un punto con todo detalle para la audiencia`);
  const { result, zip } = await createDeck({
    topic: 'densidad', title: 'Un título de portada realmente largo que ocupa más de dos líneas en la diapositiva de apertura', filename: 'denso.pptx',
    outline: [{ title: 'Demasiado contenido en una sola diapositiva para que entre bien', bullets: dense }, { title: 'Gracias', bullets: [] }],
  });
  assert.ok(result.designWarnings.some((w) => /9 viñetas/.test(w)), result.designWarnings.join(' | '));
  assert.ok(result.designWarnings.some((w) => /notas del orador/.test(w)));
  const [cover, list] = orderedSlideXml(zip);
  assert.ok(/normAutofit/.test(list), 'the long list shrinks to its frame');
  assert.ok(/normAutofit/.test(cover), 'the cover title shrinks to its frame');
  for (let i = 1; i <= 9; i += 1) assert.ok(list.includes(`Viñeta ${i}:`), 'every bullet kept verbatim');
});

test('create_presentation picks the theme from the user\'s words when the model passes none', async () => {
  const outline = [{ title: 'Resumen', bullets: ['a', 'b'] }, { title: 'Gracias' }];
  const exec = await createDeck({ topic: 'directorio', title: 'Informe', outline, filename: 'a.pptx' }, { prompt: 'hazme una presentación ejecutiva para el directorio' });
  assert.equal(exec.result.theme, 'boardroom');
  const minimal = await createDeck({ topic: 'directorio', title: 'Informe', outline, filename: 'b.pptx', theme: 'minimal' }, { prompt: 'hazme una presentación ejecutiva para el directorio' });
  assert.equal(minimal.result.theme, 'minimal', 'an explicit theme from the model wins');
  const colored = await createDeck({ topic: 'directorio', title: 'Informe', outline, filename: 'c.pptx', color: 'verde' }, { prompt: 'presentación ejecutiva' });
  assert.equal(colored.result.theme.startsWith('user-color:'), true, 'a requested color always wins');
  const plain = await createDeck({ topic: 'directorio', title: 'Informe', outline, filename: 'd.pptx' });
  assert.equal(plain.result.theme, 'aurora', 'no words, no theme → aurora');
});

// ── add_slide on an existing SiraGPT deck ────────────────────────────────

test('add_slide keeps the theme, lands before the closing slide and renumbers every footer', async () => {
  const { sandbox, executors, out } = await createDeck({
    topic: 'gestión', title: 'Gestión administrativa', filename: 'gestion.pptx',
    outline: [
      { title: 'Contexto', bullets: ['Planificación con metas medibles', 'Procesos y responsables'], notes: 'Intro.' },
      { title: 'Indicadores', bullets: ['35% reducción de consumo', '98% cumplimiento'], notes: 'KPIs.' },
      { title: 'Gracias', bullets: [] },
    ],
  });
  assert.equal(out, 'outputs/gestion.pptx');
  const raw = await executors.add_slide({
    path: '/workspace/outputs/gestion.pptx', title: 'Conclusiones', bullets: ['Consolidar el control por indicadores', 'Auditar proveedores en 2027'], notes: 'Pedir aprobación.',
  });
  assert.ok(!String(raw).startsWith('ERROR:'), raw);
  const added = JSON.parse(raw);
  assert.equal(added.path, '/workspace/outputs/gestion-v2.pptx');
  assert.equal(added.slides, 5);
  assert.equal(added.slideNumber, 4, 'inserted before the closing «Gracias»');
  assert.equal(added.theme, 'aurora');
  assert.equal(added.layout, 'bullets');
  const zip = new PizZip(sandbox.files.get('outputs/gestion-v2.pptx'));
  const slides = orderedSlideXml(zip);
  assert.equal(slides.length, 5);
  assert.ok(slides[3].includes('Conclusiones') && slides[3].includes('Auditar proveedores'), 'new slide in position 4');
  assert.ok(slides[3].includes('SiraDeco[aurora]'), 'same theme decorations');
  assert.ok(slides[3].includes('2563EB'), 'aurora accent on the new slide');
  assert.ok(slides[4].includes('Gracias'), 'closing stays last');
  assert.ok(slides[1].includes('02 / 05') && slides[3].includes('04 / 05') && slides[4].includes('05 / 05'), 'footers renumbered in order');
  const notes = notesXml(zip);
  assert.ok(notes.includes('Pedir aprobación.'), 'notes carried into the package');
  const ct = zip.file('[Content_Types].xml').asText();
  assert.ok(/slide5\.xml/.test(ct), 'content type registered');
  const rels = zip.file('ppt/slides/_rels/slide5.xml.rels').asText();
  assert.match(rels, /slideLayout/);
  assert.match(rels, /notesSlide/);
  // The chain continues from the last version: -v2 → -v3, explicit position honoured.
  const again = JSON.parse(await executors.add_slide({ path: 'outputs/gestion-v2.pptx', title: 'Riesgos', layout: 'section', position: 2 }));
  assert.equal(again.path, '/workspace/outputs/gestion-v3.pptx');
  assert.equal(again.slideNumber, 2);
  const v3 = orderedSlideXml(new PizZip(sandbox.files.get('outputs/gestion-v3.pptx')));
  assert.equal(v3.length, 6);
  assert.ok(v3[1].includes('Riesgos') && v3[1].includes('Section number'), 'section divider right after the cover');
  assert.ok(v3[5].includes('06 / 06'));
});

test('add_slide: a new closing slide goes last even when the deck already ends with «Gracias»', async () => {
  const PptxGenJS = require('pptxgenjs');
  const { sandbox } = await createDeck({
    topic: 'gestión', title: 'Gestión administrativa', filename: 'gestion.pptx',
    outline: [
      { title: 'Contexto', bullets: ['Planificación con metas medibles'] },
      { title: 'Indicadores', bullets: ['35% reducción de consumo'] },
      { title: 'Gracias', bullets: [] },
    ],
  });
  // «agrega una lámina de gracias al final»: the runner's fast path asks for a closing slide.
  const added = await deckAppend.appendDesignedSlide({
    PptxGenJS, buffer: sandbox.files.get('outputs/gestion.pptx'), item: { title: 'Gracias', bullets: [], layout: 'closing' },
  });
  assert.equal(added.slideNumber, 5, 'after the existing closing, not before it');
  assert.equal(added.total, 5);
  const slides = orderedSlideXml(new PizZip(added.buffer));
  assert.equal(slides.length, 5);
  assert.ok(slides[4].includes('Gracias') && slides[4].includes('05 / 05'), 'new closing slide is the last one, footer renumbered');
  assert.ok(slides[3].includes('Gracias') && slides[3].includes('04 / 05'), 'the previous closing is now 4 / 5');
  // Content (not a closing) still lands before the deck's closing slide.
  const content = await deckAppend.appendDesignedSlide({
    PptxGenJS, buffer: sandbox.files.get('outputs/gestion.pptx'), item: { title: 'Riesgos', bullets: ['Dependencia de un proveedor'] },
  });
  assert.equal(content.slideNumber, 4, 'before «Gracias»');
});

test('add_slide refuses charts and decks SiraGPT did not design; the color-locked theme is kept', async () => {
  const { sandbox, executors } = await createDeck({
    topic: 'embarazo', title: 'Embarazo saludable', color: 'rosado', filename: 'rosa.pptx',
    outline: [{ title: 'Trimestres', bullets: ['Primero', 'Segundo', 'Tercero'] }, { title: 'Gracias' }],
  });
  const added = JSON.parse(await executors.add_slide({ path: 'outputs/rosa.pptx', title: 'Controles prenatales', bullets: ['Mensual hasta la semana 28'] }));
  assert.equal(added.theme, 'user-color:FFC0CB');
  const slides = orderedSlideXml(new PizZip(sandbox.files.get('outputs/rosa-v2.pptx')));
  for (const xml of slides) assert.ok(xml.includes('FFC0CB'), 'every slide, the new one included, keeps the requested color');
  const chart = await executors.add_slide({ path: 'outputs/rosa.pptx', title: 'Gráfica' , bullets: ['x'], layout: 'bullets', table: undefined, quote: undefined, steps: undefined, columns: undefined });
  assert.ok(!String(chart).startsWith('ERROR:'), 'a plain slide is fine');
  // A deck made elsewhere (no SiraDeco shapes) is refused: the agent copies a slide with python-pptx instead.
  const PptxGenJS = require('pptxgenjs');
  const foreign = new PptxGenJS();
  foreign.addSlide().addText('Uno', { x: 0.5, y: 0.4, w: 8, h: 1 });
  foreign.addSlide().addText('Dos', { x: 0.5, y: 0.4, w: 8, h: 1 });
  sandbox.files.set('uploads/foreign.pptx', await foreign.write('nodebuffer'));
  const refused = await executors.add_slide({ path: 'uploads/foreign.pptx', title: 'Tres' });
  assert.match(String(refused), /^ERROR: E_NOT_SIRA_DECK/);
  assert.equal(deckAppend.isSiraDeckBuffer(sandbox.files.get('uploads/foreign.pptx')), false);
  assert.equal(deckAppend.isSiraDeckBuffer(sandbox.files.get('outputs/rosa.pptx')), true);
  await assert.rejects(
    () => deckAppend.appendDesignedSlide({ PptxGenJS, buffer: sandbox.files.get('outputs/rosa.pptx'), item: { title: 'Ventas', chart: { type: 'bar', labels: ['a'], series: [{ name: 's', values: [1] }] } } }),
    /E_UNSUPPORTED/,
  );
});

test('nextVersionName versions the output next to the source deck', () => {
  assert.equal(deckAppend.nextVersionName('gestion.pptx'), 'gestion-v2.pptx');
  assert.equal(deckAppend.nextVersionName('outputs/gestion-v2.pptx'), 'gestion-v3.pptx');
  assert.equal(deckAppend.nextVersionName('uploads/informe-v9.pptx'), 'informe-v10.pptx');
});

test('appendTextSlide (plain decks): the cloned «Gracias» slide drops the source bullets and its notes link', async () => {
  const { appendTextSlide } = require('../src/services/agent-runner/office-helpers');
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  pres.addSlide().addText('Portada', { x: 0.5, y: 0.4, w: 8, h: 1 });
  const last = pres.addSlide();
  last.addText('Indicadores', { x: 0.5, y: 0.4, w: 8, h: 1 });
  last.addText([{ text: 'Viñeta uno', options: { bullet: true, breakLine: true } }, { text: 'Viñeta dos', options: { bullet: true } }], { x: 0.5, y: 1.5, w: 8, h: 3 });
  last.addNotes('Notas del original');
  const out = appendTextSlide({ buffer: await pres.write('nodebuffer'), title: 'Gracias' });
  const zip = new PizZip(out.buffer);
  const xml = zip.file('ppt/slides/slide3.xml').asText();
  assert.ok(xml.includes('Gracias'));
  assert.equal(xml.includes('Viñeta uno'), false, 'no repeated bullets');
  assert.equal(xml.includes('Viñeta dos'), false);
  const rels = zip.file('ppt/slides/_rels/slide3.xml.rels').asText();
  assert.equal(/notesSlide/.test(rels), false, 'the clone does not share the source notes part');
  assert.match(rels, /slideLayout/);
});
