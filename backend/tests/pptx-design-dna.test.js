'use strict';

/**
 * pptx-design-dna — appended slides inherit the deck's own visual DNA.
 *
 * A slide added to a designed deck must carry its background, title/body
 * colors and sizes and geometry. Sampling is best-effort: anything missing
 * falls back to the previous neutral defaults, so unsamplable decks behave
 * exactly as before.
 *
 * Offline: decks via the `pptxgenjs` npm dep, ZIP reads via `pizzip`. No
 * network, no API keys.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PizZip = require('pizzip');
const {
  validateEditedFile,
} = require('../src/services/doc-agent/validate');
const mod = require('../src/services/source-preserving-document-edit');

const { appendToPptxBuffer, buildPptxSlideXml, extractPptxSlideDesign } = mod.INTERNAL;

async function makeThemedDeck() {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const slide = pptx.addSlide();
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: 'F5F3FF' }, line: { color: 'F5F3FF' } });
  slide.addText('Título del deck', { x: 0.7, y: 0.4, w: 11.9, h: 0.8, fontSize: 28, bold: true, color: '1E1B4B' });
  slide.addText('Cuerpo del deck', { x: 0.9, y: 1.8, w: 11.5, h: 4.5, fontSize: 14, color: '333333' });
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

test('design DNA: background, colors, sizes and geometry sampled from the deck', async () => {
  const orig = await makeThemedDeck();
  const design = extractPptxSlideDesign(new PizZip(orig));
  assert.equal(design.bg, 'F5F3FF');
  assert.equal(design.title.color, '1E1B4B');
  assert.equal(design.title.sz, 2800);
  assert.equal(design.title.b, true);
  assert.equal(design.body.color, '333333');
  assert.equal(design.body.sz, 1400);
  for (const key of ['x', 'y', 'cx', 'cy']) {
    assert.ok(Number.isFinite(design.title.box[key]), `title box ${key}`);
    assert.ok(Number.isFinite(design.body.box[key]), `body box ${key}`);
  }

  const out = appendToPptxBuffer(orig, [
    { kind: 'heading1', text: 'Ejemplo agregado' },
    { kind: 'normal', text: 'Punto de ejemplo' },
  ]);
  const slideXml = new PizZip(out).file('ppt/slides/slide2.xml').asText();
  assert.ok(slideXml.includes('<p:bg>'), 'appended slide carries the deck background');
  assert.ok(slideXml.includes('F5F3FF'), 'background color matches the deck');
  assert.ok(slideXml.includes('1E1B4B'), 'title color matches the deck');
  assert.ok(slideXml.includes('sz="2800"'), 'title size matches the deck');
  assert.ok(slideXml.includes('333333'), 'body color matches the deck');
  assert.ok(slideXml.includes('sz="1400"'), 'body size matches the deck');
  const verdict = validateEditedFile({ originalBuffer: orig, editedBuffer: out, instruction: 'agrega una diapositiva' });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.diff.removed, []);
});

test('design DNA: unsamplable decks keep the neutral defaults', async () => {
  const xml = buildPptxSlideXml(
    [{ kind: 'heading1', text: 'T' }, { kind: 'normal', text: 'B' }],
    { bg: null, title: {}, body: {} },
  );
  assert.ok(xml.includes('sz="3000"'), 'default title size');
  assert.ok(xml.includes('b="1"'), 'default title bold');
  assert.ok(xml.includes('sz="1800"'), 'default body size');
  assert.ok(!xml.includes('<p:bg>'), 'no background without DNA');

  const design = extractPptxSlideDesign({ file: () => null });
  assert.equal(design.bg, null);
  assert.equal(design.title.sz, null);
});
