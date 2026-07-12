const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
  countPptxStructure,
  validatePptxPackage,
  expectsSlides,
} = require('../src/services/agents/pptx-package-validator');

async function makePptxBuffer({ slideRefs = 1, slideFiles = 1 } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const refs = Array.from({ length: slideRefs }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  zip.file('ppt/presentation.xml',
    '<?xml version="1.0"?>'
    + '<p:presentation xmlns:p="x" xmlns:r="x">'
    + `<p:sldIdLst>${refs}</p:sldIdLst>`
    + '</p:presentation>');
  for (let i = 1; i <= slideFiles; i += 1) {
    zip.file(`ppt/slides/slide${i}.xml`, `<p:sld xmlns:p="x"><p:cSld/></p:sld>`);
  }
  return await zip.generateAsync({ type: 'nodebuffer' });
}

test('countPptxStructure counts manifest refs + actual slide bodies', async () => {
  const buf = await makePptxBuffer({ slideRefs: 5, slideFiles: 5 });
  const result = await countPptxStructure(buf);
  assert.equal(result.ok, true);
  assert.equal(result.slideRefs, 5);
  assert.equal(result.slideFiles, 5);
});

test('countPptxStructure detects manifest/file mismatch', async () => {
  const buf = await makePptxBuffer({ slideRefs: 5, slideFiles: 2 });
  const result = await countPptxStructure(buf);
  assert.equal(result.ok, true, 'structure parses');
  assert.equal(result.slideRefs, 5);
  assert.equal(result.slideFiles, 2);
});

test('countPptxStructure fails closed on empty / not-zip / missing-presentation', async () => {
  assert.equal((await countPptxStructure(Buffer.alloc(0))).ok, false);
  assert.match((await countPptxStructure(Buffer.from('not-a-zip-of-any-kind-' + 'x'.repeat(300)))).reason, /zip_open_failed/);
  const noPresentationZip = new JSZip();
  noPresentationZip.file('not_pptx/file.xml', '<x/>');
  const buf = await noPresentationZip.generateAsync({ type: 'nodebuffer' });
  const result = await countPptxStructure(buf);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_presentation_xml');
});

test('expectsSlides matches Spanish + English deck vocabulary', () => {
  assert.equal(expectsSlides('crea una presentación de defensa de tesis'), true);
  assert.equal(expectsSlides('PPT con 8 diapositivas para marketing'), true);
  assert.equal(expectsSlides('Build a deck for next week'), true);
  assert.equal(expectsSlides('Generate a quarterly report'), false);
});

test('validatePptxPackage passes when refs + files match and >= 1 slide', async () => {
  const buf = await makePptxBuffer({ slideRefs: 3, slideFiles: 3 });
  const result = await validatePptxPackage({
    buffer: buf,
    prompt: 'crea una presentación',
  });
  assert.equal(result.ok, true);
  assert.equal(result.slideFiles, 3);
});

test('validatePptxPackage blocks a deck that ignores the requested total', async () => {
  const buf = await makePptxBuffer({ slideRefs: 10, slideFiles: 10 });
  const result = await validatePptxPackage({
    buffer: buf,
    prompt: 'crea una presentación en 8 diapositivas',
    expectedSlides: 8,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'requested_slide_count_mismatch');
  assert.equal(result.expectedSlides, 8);
  assert.equal(result.slideFiles, 10);
});

test('validatePptxPackage BLOCKS a 0-slide deck', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="x"><p:sldIdLst/></p:presentation>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const result = await validatePptxPackage({ buffer: buf, prompt: 'PPT vacío' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_slides_rendered');
  assert.equal(result.slideFiles, 0);
});

test('validatePptxPackage BLOCKS when manifest references slides that are missing on disk', async () => {
  const buf = await makePptxBuffer({ slideRefs: 4, slideFiles: 1 });
  const result = await validatePptxPackage({ buffer: buf, prompt: 'PPT con 4 slides' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'slide_manifest_mismatch');
  assert.equal(result.slideRefs, 4);
  assert.equal(result.slideFiles, 1);
});
