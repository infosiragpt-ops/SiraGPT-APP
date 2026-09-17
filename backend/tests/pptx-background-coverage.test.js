'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PptxGenJS = require('pptxgenjs');
const PizZip = require('pizzip');
const { setSlideBackgrounds } = require('../src/services/document-editing/pptx-adapter');

async function deck(background = {}) {
  const pptx = new PptxGenJS();
  for (let index = 0; index < 2; index++) {
    const slide = pptx.addSlide();
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 0, y: 0, w: '100%', h: '100%', fill: { color: '101010' }, ...background,
    });
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 1, y: 2, w: 2, h: 1, fill: { color: 'CC3300' },
    });
    slide.addText(`Control ${index + 1}`, { x: 1, y: 1, w: 4, h: 1, color: 'EEEEEE' });
  }
  return pptx.write('nodebuffer');
}

const shapes = (xml) => [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((match) => match[0]);

test('an opaque full-canvas backing rectangle takes the new background color without recoloring content', async () => {
  const original = await deck();
  const frozen = Buffer.from(original);
  const before = new PizZip(original);
  const result = setSlideBackgrounds({ buffer: original, color: 'FFFFFF', contrastText: false });
  const after = new PizZip(result.buffer);
  for (const part of ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) {
    const oldShapes = shapes(before.file(part).asText());
    const newShapes = shapes(after.file(part).asText());
    assert.match(newShapes[0], /<a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill>/);
    assert.equal(newShapes[0], oldShapes[0].replace('val="101010"', 'val="FFFFFF"'));
    assert.deepEqual(newShapes.slice(1), oldShapes.slice(1), 'content rectangles and text are unchanged');
  }
  assert.deepEqual(original, frozen, 'input bytes are immutable');
});

test('painting one slide preserves every other ZIP part including other slides, themes and layouts', async () => {
  const original = await deck();
  const before = new PizZip(original);
  const after = new PizZip(setSlideBackgrounds({
    buffer: original, color: 'FFFFFF', allSlides: false, slideNumber: 2, contrastText: false,
  }).buffer);
  const changed = Object.keys(before.files).filter((name) => !before.files[name].dir
    && !before.file(name).asNodeBuffer().equals(after.file(name).asNodeBuffer()));
  assert.deepEqual(changed, ['ppt/slides/slide2.xml']);
  assert.match(shapes(after.file('ppt/slides/slide2.xml').asText())[0], /val="FFFFFF"/);
});

test('partial, offset, rotated, translucent and effect-bearing rectangles are content, not replaceable backgrounds', async () => {
  for (const background of [
    { w: 3 }, { x: 0.5 }, { rotate: 1 }, { fill: { color: '101010', transparency: 30 } },
    { shadow: { type: 'outer', blur: 3, angle: 45, distance: 3, color: '000000', opacity: 0.3 } },
  ]) {
    const original = await deck(background);
    const before = new PizZip(original);
    const after = new PizZip(setSlideBackgrounds({ buffer: original, color: 'FFFFFF', contrastText: false }).buffer);
    assert.equal(shapes(after.file('ppt/slides/slide1.xml').asText())[0],
      shapes(before.file('ppt/slides/slide1.xml').asText())[0], JSON.stringify(background));
  }
});

test('an outline-only full-canvas shape and a later full-canvas overlay are never recolored as backing shapes', async () => {
  const original = await deck();
  for (const mutate of [
    (xml) => xml.replace('<a:solidFill><a:srgbClr val="101010"/></a:solidFill>', '<a:noFill/>')
      .replace('<a:ln></a:ln>', '<a:ln><a:solidFill><a:srgbClr val="101010"/></a:solidFill></a:ln>'),
    (xml) => {
      const [backing, swatch] = shapes(xml);
      return xml.replace(backing + swatch, swatch + backing);
    },
  ]) {
    const source = new PizZip(original);
    const before = mutate(source.file('ppt/slides/slide1.xml').asText());
    source.file('ppt/slides/slide1.xml', before);
    const after = new PizZip(setSlideBackgrounds({ buffer: source.generate({ type: 'nodebuffer' }),
      color: 'FFFFFF', contrastText: false }).buffer);
    assert.deepEqual(shapes(after.file('ppt/slides/slide1.xml').asText()), shapes(before));
  }
});
