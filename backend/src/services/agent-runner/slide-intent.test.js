'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePptFollowupIntent, resolveTargetSlideCount, buildSlideBullets } = require('./slide-intent');
const { appendTextSlide, countSlides, listSlideTexts, bufferHasHex } = require('./office-helpers');
const { applyRequestedSlideGate, applyRequestedColorGate, applyVerificationGates, needsVerification } = require('./verify');
const { parseExplicitOfficeFormat, shouldBlockGenericPipeline } = require('./format-intent');

test('bug phrase: color + séptima conclusiones is an add-slide follow-up', () => {
  const intent = parsePptFollowupIntent(
    'Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones.',
  );
  assert.equal(intent.wantsAddSlide, true);
  assert.equal(intent.targetTotal, 7);
  assert.equal(intent.title, 'Conclusiones');
  assert.equal(resolveTargetSlideCount(intent, 6), 7);
});

test('color-only follow-up is NOT treated as add-slide', () => {
  const a = parsePptFollowupIntent('Cambia el fondo a verde #22C55E');
  assert.equal(a.wantsAddSlide, false);
  const b = parsePptFollowupIntent('ponlas todas rosadas');
  assert.equal(b.wantsAddSlide, false);
  const c = parsePptFollowupIntent('cámbialas al hex #1E3A8A');
  assert.equal(c.wantsAddSlide, false);
});

test('agrega una diapositiva / lámina de gracias still parses', () => {
  const a = parsePptFollowupIntent('agrega una lámina de gracias al final');
  assert.equal(a.wantsAddSlide, true);
  assert.equal(a.title, 'Gracias');
  const b = parsePptFollowupIntent('agrega una diapositiva');
  assert.equal(b.wantsAddSlide, true);
  assert.equal(b.addCount, 1);
});

test('séptimo / 7 diapositivas request a 7-slide total', () => {
  for (const phrase of ['añade el séptimo slide', 'quiero 7 diapositivas', '7 diapositivas color naranja']) {
    const intent = parsePptFollowupIntent(phrase);
    assert.equal(intent.wantsAddSlide, true, phrase);
    assert.equal(intent.targetTotal, 7, phrase);
    assert.equal(resolveTargetSlideCount(intent, 6), 7, phrase);
  }
});

test('appendTextSlide adds Conclusiones with real bullets on a 6-slide fixture', async () => {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  const titles = ['Ciclo del agua', 'Evaporación', 'Condensación', 'Precipitación', 'Escorrentía', 'Infiltración'];
  for (const title of titles) {
    pres.addSlide().addText(title, { x: 0.5, y: 0.4, w: 8, h: 1 });
  }
  const buf = await pres.write('nodebuffer');
  assert.equal(countSlides(buf), 6);
  const added = appendTextSlide({
    buffer: buf,
    title: 'Conclusiones',
    bullets: buildSlideBullets({ existingTexts: listSlideTexts(buf), title: 'Conclusiones' }),
  });
  assert.equal(countSlides(added.buffer), 7);
  const texts = listSlideTexts(added.buffer);
  assert.ok(texts[6].includes('Conclusiones'), texts[6]);
  assert.ok(/Evaporaci[oó]n|Condensaci[oó]n|Precipitaci[oó]n/.test(texts[6]), texts[6]);
});

test('6 vs 6 create-count is SUCCESS, not a shortfall', async () => {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  for (let i = 0; i < 6; i += 1) pres.addSlide().addText(`S${i + 1}`, { x: 0.5, y: 0.4, w: 8, h: 1 });
  const buf = await pres.write('nodebuffer');
  const outputs = [{ name: 'ciclo_del_agua.pptx', buffer: buf, valid: true }];
  const gate = applyRequestedSlideGate(
    outputs,
    'Crea una ppt de 6 diapositivas del ciclo del agua color #FF69B4',
    { currentCount: null },
  );
  assert.equal(gate.ok, true, 'actual==requested must pass');
  assert.notEqual(outputs[0].verified, false);
  const follow = applyRequestedSlideGate(
    outputs,
    'Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones.',
    { currentCount: 6 },
  );
  assert.equal(follow.ok, false, '6 vs 7 still fails');
});

test('slide-count gate refuses Validado when a 7th slide is missing', async () => {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  for (let i = 0; i < 6; i += 1) pres.addSlide().addText(`S${i + 1}`, { x: 0.5, y: 0.4, w: 8, h: 1 });
  const buf = await pres.write('nodebuffer');
  const outputs = [{ name: 'ciclo.pptx', buffer: buf, valid: true }];
  const gate = applyRequestedSlideGate(
    outputs,
    'Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones.',
    { currentCount: 6 },
  );
  assert.equal(gate.ok, false);
  assert.equal(outputs[0].verified, false);
  assert.equal(outputs[0].validationPassed, false);
  assert.match(outputs[0].validationReason, /requested_slide_count_mismatch:6[!<]=?7/);
});

test('hex gate refuses Validado when requested color is missing from slide XML', async () => {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  pres.addSlide().addText('Hola', { x: 0.5, y: 0.4, w: 8, h: 1 });
  const buf = await pres.write('nodebuffer');
  assert.equal(bufferHasHex(buf, '22C55E'), false);
  const outputs = [{ name: 'ciclo.pptx', buffer: buf, valid: true }];
  const gate = applyRequestedColorGate(outputs, 'Cambia el fondo a verde #22C55E');
  assert.equal(gate.ok, false);
  assert.equal(outputs[0].verified, false);
  assert.match(outputs[0].validationReason, /requested_hex_missing:22C55E/);
});

test('combined gates fail Validado on slide mismatch even if OOXML is valid', async () => {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  for (let i = 0; i < 6; i += 1) pres.addSlide().addText(`S${i + 1}`, { x: 0.5, y: 0.4, w: 8, h: 1 });
  const buf = await pres.write('nodebuffer');
  const outputs = [{ name: 'ciclo.pptx', buffer: buf, valid: true }];
  const gate = applyVerificationGates(
    outputs,
    'Cambia el fondo a #22C55E y agrega una séptima de conclusiones.',
    { currentCount: 6 },
  );
  assert.equal(gate.ok, false);
  assert.equal(outputs[0].verified, false);
});

test('explicit Word / sin Excel / presentación / pptx / docx are claimed', () => {
  const cases = [
    ['hazme un documento Word', 'docx'],
    ['documento Word sin Excel', 'docx'],
    ['sin Excel, un informe', 'docx'],
    ['crea una presentación', 'pptx'],
    ['archivo pptx del tema', 'pptx'],
    ['exporta a docx', 'docx'],
  ];
  for (const [phrase, format] of cases) {
    const spec = parseExplicitOfficeFormat(phrase);
    assert.equal(spec.claimed, true, phrase);
    assert.equal(spec.format, format, phrase);
    assert.equal(shouldBlockGenericPipeline(phrase), true, phrase);
  }
});

test('plain chat is not an explicit office claim', () => {
  assert.equal(parseExplicitOfficeFormat('hola, resume el párrafo').claimed, false);
});

test('needsVerification still requires preview after set_slide_background', () => {
  assert.equal(needsVerification([{ tool: 'set_slide_background', ok: true }]).needed, true);
  assert.equal(needsVerification([
    { tool: 'add_slide', ok: true },
    { tool: 'render_preview', ok: true },
  ]).needed, false);
});
