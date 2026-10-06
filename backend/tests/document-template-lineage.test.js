'use strict';

// A deliverable built «con este formato» must DESCEND from the template:
// same theme (colour + font scheme), same masters, same layouts, no sample
// slides left. Offline: decks via pptxgenjs, packages via pizzip.

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const lineage = require('../src/services/document-template-lineage');

async function makeDeck({ slides = 2, text = 'Texto de ejemplo de la plantilla corporativa' } = {}) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  for (let i = 1; i <= slides; i += 1) {
    const slide = pptx.addSlide();
    slide.addText(`${text} ${i}`, { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 24 });
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

/** Give a pptxgenjs deck a distinctive theme + layout name so it reads as a corporate template. */
function brandTemplate(buffer) {
  const zip = new PizZip(buffer);
  const theme = zip.file('ppt/theme/theme1.xml').asText()
    .replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="7A1F1F"/></a:accent1>')
    .replace(/<a:majorFont>\s*<a:latin typeface="[^"]*"/, '<a:majorFont><a:latin typeface="Georgia"');
  zip.file('ppt/theme/theme1.xml', theme);
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)) {
      zip.file(name, zip.file(name).asText().replace(/<p:cSld\b([^>]*)\bname="[^"]*"/, '<p:cSld$1name="Portada UPN"'));
    }
  }
  return zip.generate({ type: 'nodebuffer' });
}

/** Emulate a template fill: drop the sample slides, add one slide on the template's own layout. */
function fillTemplate(templateBuffer, title) {
  const zip = new PizZip(templateBuffer);
  const sample = zip.file('ppt/slides/slide1.xml').asText();
  const sampleRels = zip.file('ppt/slides/_rels/slide1.xml.rels').asText();
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?$/.test(n));
  for (const n of names) zip.remove(n);
  const fresh = sample.replace(/<a:t>[^<]*<\/a:t>/g, `<a:t>${title}</a:t>`);
  zip.file('ppt/slides/slide1.xml', fresh);
  zip.file('ppt/slides/_rels/slide1.xml.rels', sampleRels);
  const pres = zip.file('ppt/presentation.xml').asText().replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, '<p:sldIdLst><p:sldId id="256" r:id="rIdS1"/></p:sldIdLst>');
  zip.file('ppt/presentation.xml', pres);
  const rels = zip.file('ppt/_rels/presentation.xml.rels').asText()
    .replace(/<Relationship\b[^>]*Type="[^"]*\/slide"[^>]*\/>/g, '')
    .replace('</Relationships>', '<Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
  zip.file('ppt/_rels/presentation.xml.rels', rels);
  const ct = zip.file('[Content_Types].xml').asText().replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, '')
    .replace('</Types>', '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  zip.file('[Content_Types].xml', ct);
  return zip.generate({ type: 'nodebuffer' });
}

test('summarizeTemplate inventories layouts, placeholders, sample slides and theme fonts', async () => {
  const template = brandTemplate(await makeDeck({ slides: 2 }));
  const summary = lineage.summarizeTemplate(template);
  assert.equal(summary.format, 'pptx');
  assert.ok(summary.layouts.length >= 1);
  assert.equal(summary.layouts[0].name, 'Portada UPN');
  assert.equal(summary.slides.length, 2);
  assert.match(summary.slides[0].text, /Texto de ejemplo/);
  assert.equal(summary.theme.fonts.major, 'Georgia');
  assert.equal(summary.theme.colors.accent1, '7A1F1F');
  const block = lineage.describeTemplateForPrompt(summary, 'Plantilla.pptx');
  assert.match(block, /PLANTILLA OBLIGATORIA: uploads\/Plantilla\.pptx/);
  assert.match(block, /«Portada UPN»/);
  assert.match(block, /Láminas de muestra en la plantilla \(2\)/);
  assert.match(block, /Georgia/);
});

test('a deck built ON the template passes; its sample slides are gone', async () => {
  const template = brandTemplate(await makeDeck({ slides: 2 }));
  const output = fillTemplate(template, 'Marketing digital 2026');
  const verdict = lineage.verifyTemplateLineage({ templateBuffer: template, outputBuffer: output });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
  assert.equal(verdict.format, 'pptx');
  for (const name of ['theme_scheme', 'slide_masters', 'slide_layouts', 'slides_use_layouts', 'no_sample_leftovers', 'slide_size']) {
    assert.equal(verdict.checks.find((c) => c.check === name).ok, true, name);
  }
});

test('a fresh SiraGPT-themed deck fails: different theme and layouts', async () => {
  const template = brandTemplate(await makeDeck({ slides: 2 }));
  const fresh = await makeDeck({ slides: 3, text: 'Contenido nuevo' });
  const verdict = lineage.verifyTemplateLineage({ templateBuffer: template, outputBuffer: fresh });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checks.find((c) => c.check === 'theme_scheme').ok, false);
  assert.equal(verdict.checks.find((c) => c.check === 'slide_layouts').ok, false);
  assert.match(lineage.describeLineageFailure(verdict), /no sigue la plantilla adjunta/);
});

test('delivering the template itself (sample slides untouched) is rejected unless allowed', async () => {
  const template = brandTemplate(await makeDeck({ slides: 2 }));
  const same = lineage.verifyTemplateLineage({ templateBuffer: template, outputBuffer: template });
  assert.equal(same.ok, false);
  assert.equal(same.checks.find((c) => c.check === 'no_sample_leftovers').ok, false);
  const allowed = lineage.verifyTemplateLineage({ templateBuffer: template, outputBuffer: template, allowSampleSlides: true });
  assert.equal(allowed.ok, true);
});

test('unreadable or mismatched packages never throw', async () => {
  const template = brandTemplate(await makeDeck({ slides: 1 }));
  assert.equal(lineage.verifyTemplateLineage({ templateBuffer: Buffer.from('nope'), outputBuffer: template }).ok, false);
  assert.equal(lineage.verifyTemplateLineage({}).ok, false);
  assert.equal(lineage.summarizeTemplate(null), null);
  const verdict = lineage.verifyTemplateLineage({ templateBuffer: template, outputBuffer: Buffer.from('') });
  assert.match(verdict.reasons[0], /unreadable/);
});
