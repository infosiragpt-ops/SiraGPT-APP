'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');
const { fitText, addMeasuredText, assertFrame } = require('../src/services/document-pipeline/pptx-layout');
const { THEMES } = require('../src/services/document-pipeline/pptx-design-system');
const { buildPlan, INTERNAL } = require('../src/services/document-pipeline/advanced-document-pipeline');

test('text layout uses glyph widths, retains every character and bounds font reduction', () => {
  const frame = { x: 1, y: 1, w: 2.8, h: 0.8, fontFace: 'Arial', fontSize: 20, minFontSize: 16 };
  const short = fitText('Objetivo claro', frame);
  assert.equal(short.fontSize, 20);
  const calls = [];
  const value = 'Decisiones sostenibles con evidencia verificable';
  const measured = addMeasuredText({ addText: (...args) => calls.push(args) }, value, frame);
  assert.ok(measured.fontSize >= 16 && measured.fontSize <= 20);
  assert.equal(calls[0][0], value);
  assert.equal(calls[0][1].fit, 'none');
  assert.equal(calls[0][1].isTextBox, true);
  assert.equal(calls[0][1].margin, 0);
  assert.equal(calls[0][1].minFontSize, undefined);
});

test('too much text fails before writing rather than clipping or reducing below the minimum', () => {
  const calls = [];
  assert.throws(() => addMeasuredText({ addText: (...args) => calls.push(args) },
    'Una explicación que no puede caber. '.repeat(100),
    { x: 1, y: 1, w: 2, h: 0.3, fontFace: 'Arial', fontSize: 18, minFontSize: 16 },
    { slideNumber: 4 }), (error) => error.code === 'PPTX_TEXT_OVERFLOW' && error.details.slideNumber === 4 && error.details.minFontSize === 16);
  assert.equal(calls.length, 0);
});

test('wide unbroken identifiers and off-slide frames are rejected explicitly', () => {
  assert.throws(() => fitText('W'.repeat(120), { x: 1, y: 1, w: 2, h: 5, fontFace: 'Arial', fontSize: 18, minFontSize: 16 }), { code: 'PPTX_TEXT_OVERFLOW' });
  assert.throws(() => assertFrame({ x: 12, y: 1, w: 2, h: 1 }), { code: 'PPTX_LAYOUT_OUT_OF_BOUNDS' });
  assert.throws(() => assertFrame({ x: 1, y: -1, w: 2, h: 1 }), { code: 'PPTX_LAYOUT_OUT_OF_BOUNDS' });
});

test('every built-in theme uses portable fonts with available measurements', () => {
  for (const theme of Object.values(THEMES)) {
    for (const fontFace of [theme.fonts.body, theme.fonts.display]) {
      assert.ok(['Arial', 'Times New Roman'].includes(fontFace));
      for (const bold of [false, true]) for (const italic of [false, true]) {
        assert.equal(fitText('Información útil, ágil y verificable', { x: 1, y: 1, w: 10, h: 1, fontFace, fontSize: 20, bold, italic }).fontSize, 20);
      }
    }
  }
});

test('native PPTX text has explicit readable sizing, editable boxes and no unlimited autofit', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pptx-layout-proof-'));
  try {
    const plan = buildPlan({ prompt: 'Crea una PPT en 8 diapositivas sobre administración de empresas.', format: 'pptx', template: 'business' });
    const { buffer } = await INTERNAL.buildDocumentFile({ plan, outputDir });
    const zip = new PizZip(buffer);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(slides.length, 8);
    const xml = slides.map((name) => zip.file(name).asText()).join('\n');
    assert.doesNotMatch(xml, /normAutofit|spAutoFit/);
    assert.match(xml, /txBox="1"/);
    assert.doesNotMatch(xml, /TESIS DE LA PRESENTACIÓN|PRESENTACIÓN PROFESIONAL|Ruta de la presentación|IDEA CLAVE/);
    assert.doesNotMatch(xml, /Aptos|Georgia/);
    const fontSizes = [...xml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1]) / 100);
    assert.ok(fontSizes.length > 15);
    assert.ok(fontSizes.every((size) => size >= 10.5));
    assert.ok(fontSizes.some((size) => size >= 36));
    assert.equal(plan.pptxLayout.textBoxes, fontSizes.length);
    assert.equal(plan.pptxLayout.fontMetrics, 'pdfkit-compatible');
    assert.ok(Object.keys(zip.files).some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)));
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

function variedPlan(theme) {
  const plan = buildPlan({ prompt: 'Crea una PPT de 8 diapositivas para revisar resultados.', format: 'pptx', template: 'business' });
  plan.presentationTheme = theme;
  plan.slidePlan = {
    topic: 'Resultados del piloto', thesis: 'Decidir con evidencia y conservar una trazabilidad clara.', references: [],
    slides: [
      { layout: 'bullets', title: 'Prioridades del equipo', bullets: [{ label: 'Coordinación', text: 'Asignar un responsable por actividad.' }, { label: 'Control', text: 'Revisar los resultados al finalizar cada semana.' }], takeaway: 'Una responsabilidad explícita facilita el seguimiento.', notes: 'Explicar la relación entre responsabilidad y seguimiento.' },
      { layout: 'two_column', title: 'Comparación del proceso', columns: [{ heading: 'Antes del piloto', items: ['Registro disperso de tareas.', 'Revisión ocasional de resultados.'] }, { heading: 'Durante el piloto', items: ['Un registro común para el equipo.', 'Una reunión semanal de seguimiento.'] }], notes: 'Comparar las prácticas, sin atribuir causalidad.' },
      { layout: 'stat', title: 'Alcance de la muestra', stat: { value: '24', caption: 'Participantes en el piloto', source: 'Datos sintéticos de prueba.' }, support: ['La muestra permite comprobar el funcionamiento del flujo.', 'Estos datos no representan una investigación real.'], notes: 'Aclarar que la muestra es sintética.' },
      { layout: 'quote', title: 'Criterio de evaluación', quote: 'Cada decisión debe poder vincularse a una evidencia.', attribution: 'Criterio del ejercicio', notes: 'Presentar el criterio de evaluación.' },
      { layout: 'chart', title: 'Actividades por semana', chart: { type: 'column', labels: ['Semana 1', 'Semana 2', 'Semana 3'], values: [4, 8, 12], title: 'Actividades completadas', source: 'Datos sintéticos de prueba.' }, insight: 'Usar el gráfico para contrastar el avance registrado.', notes: 'Comprobar los valores antes de comparar.' },
      { layout: 'section', title: 'Cierre operativo', summary: 'Acordar responsables y mantener un registro verificable.', notes: 'Cerrar con los compromisos del equipo.' },
    ],
  };
  return plan;
}

test('all six layouts preserve their content and editable chart on light and dark themes', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pptx-varied-proof-'));
  try {
    for (const theme of ['minimal', 'boardroom', 'editorial']) {
      const plan = variedPlan(theme);
      const { buffer } = await INTERNAL.buildDocumentFile({ plan, outputDir: path.join(outputDir, theme) });
      const zip = new PizZip(buffer);
      const xml = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => zip.file(name).asText()).join('\n');
      for (const expected of ['Asignar un responsable por actividad.', 'Un registro común para el equipo.', 'Participantes en el piloto', 'Cada decisión debe poder vincularse a una evidencia.', 'Usar el gráfico para contrastar el avance registrado.', 'Acordar responsables y mantener un registro verificable.']) assert.ok(xml.includes(expected), `${theme}: ${expected}`);
      assert.ok(Object.keys(zip.files).some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)));
      assert.ok(Object.keys(zip.files).some((name) => /^ppt\/embeddings\/.*\.xlsx$/.test(name)));
      assert.doesNotMatch(xml, /normAutofit|spAutoFit/);
    }
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});

test('PPTX generation rejects an overfull box without creating an incomplete file', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pptx-overflow-proof-'));
  try {
    const plan = variedPlan('minimal');
    plan.slidePlan.slides[0].bullets[0].text = 'Este contenido debe mantenerse completo. '.repeat(120);
    await assert.rejects(INTERNAL.buildDocumentFile({ plan, outputDir }), { code: 'PPTX_TEXT_OVERFLOW' });
    assert.equal((await fs.readdir(outputDir)).filter((file) => file.endsWith('.pptx')).length, 0);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});
