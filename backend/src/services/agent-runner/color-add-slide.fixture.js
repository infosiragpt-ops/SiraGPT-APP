#!/usr/bin/env node
'use strict';

/**
 * Local fixture: 6-slide pink deck + follow-up
 * "Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones."
 *
 * Asserts: 7 slides, 22C55E present, FF69B4 gone/overwritten,
 * validation.passed false unless both color and count match.
 */

const assert = require('assert');
const PizZip = require('pizzip');
const path = require('path');

const helpers = require('./office-helpers');
const { parsePptFollowupIntent, resolveTargetSlideCount, buildSlideBullets } = require('./slide-intent');
const { applyAllOutputGates, honestSlideShortfallMessage } = require('./verify');
const { persistOutputs } = require('./artifacts');
const { requestedOfficeFormat } = require('./format-intent');

const PINK = 'FF69B4';
const GREEN = '22C55E';
const PHRASE = 'Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones.';

function slideXml(n, hex, title) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld>` +
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:r><a:t>${title}</a:t></a:r></a:p>` +
    `<a:p><a:r><a:t>Cuerpo ${n}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function makePinkDeck(n = 6) {
  const zip = new PizZip();
  const overrides = [];
  const rels = [];
  const sldIds = [];
  for (let i = 1; i <= n; i += 1) {
    zip.file(`ppt/slides/slide${i}.xml`, slideXml(i, PINK, i === 1 ? 'Precipitación' : `Slide ${i}`));
    overrides.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`);
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
  }
  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    overrides.join('') +
    `</Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
    `</Relationships>`);
  zip.file('ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels.join('') +
    `</Relationships>`);
  zip.file('ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>` +
    `</p:presentation>`);
  return zip.generate({ type: 'nodebuffer' });
}

function countHex(buffer, hex) {
  const h = String(hex).replace('#', '').toUpperCase();
  const zip = new PizZip(buffer);
  let n = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/\.xml$/i.test(name)) continue;
    const xml = zip.file(name)?.asText() || '';
    const matches = xml.toUpperCase().split(h).length - 1;
    n += matches;
  }
  return n;
}

async function main() {
  const pink = makePinkDeck(6);
  assert.equal(helpers.countSlides(pink), 6, 'base is 6 slides');
  assert.ok(countHex(pink, PINK) >= 6, 'base has pink');
  assert.equal(countHex(pink, GREEN), 0, 'base has no green');

  const intent = parsePptFollowupIntent(PHRASE);
  assert.equal(intent.wantsAddSlide, true, 'wants add slide');
  assert.equal(intent.targetTotal, 7, 'target 7');
  const target = resolveTargetSlideCount(intent, 6);
  assert.equal(target, 7);

  const title = intent.title || 'Conclusiones';
  const bullets = buildSlideBullets({ existingTexts: helpers.listSlideTexts(pink), title });
  const applied = helpers.applyColorAndAddSlides(pink, {
    color: GREEN,
    title,
    bullets,
    targetCount: target,
  });

  assert.equal(applied.slideCount, 7, 'result has 7 slides');
  const green = countHex(applied.buffer, GREEN);
  const pinkLeft = countHex(applied.buffer, PINK);
  assert.ok(green >= 1, `22C55E present (got ${green})`);
  assert.equal(pinkLeft, 0, `FF69B4 gone (got ${pinkLeft})`);
  assert.equal(helpers.bufferContainsHex(applied.buffer, GREEN), true);
  assert.equal(applied.colorPresent, true);

  const goodOut = { name: 'ciclo-editado.pptx', buffer: applied.buffer, valid: true };
  const goodGate = applyAllOutputGates([goodOut], PHRASE, { currentCount: 6, color: GREEN });
  assert.equal(goodGate.ok, true, 'gate ok when color+count match');
  assert.notEqual(goodOut.verified, false);

  const saved = [];
  await persistOutputs({
    outputs: [goodOut],
    userId: 'u1',
    chatId: 'c1',
    saveArtifact: (args) => {
      saved.push(args);
      return { id: 'a1', filename: args.filename, mime: args.mime, format: 'pptx', sizeBytes: 10, path: '/tmp/x', downloadUrl: '/d/x' };
    },
  });
  assert.equal(saved[0].validation.passed, true, 'passed true when both match');
  assert.equal(saved[0].validation.ok, true);

  // Color missing → passed MUST be false (the live Validado bug)
  const stillPink = helpers.appendTextSlide({ buffer: pink, title: 'Conclusiones', bullets }).buffer;
  const badOut = { name: 'ciclo-editado.pptx', buffer: stillPink, valid: true, verified: false, validationPassed: false };
  const badGate = applyAllOutputGates([badOut], PHRASE, { currentCount: 6, color: GREEN });
  assert.equal(badGate.ok, false, 'gate fails when hex missing');
  assert.equal(badOut.verified, false);
  const savedBad = [];
  await persistOutputs({
    outputs: [badOut],
    userId: 'u1',
    chatId: 'c1',
    saveArtifact: (args) => {
      savedBad.push(args);
      return { id: 'a2', filename: args.filename, mime: args.mime, format: 'pptx', sizeBytes: 10, path: '/tmp/y', downloadUrl: '/d/y' };
    },
  });
  assert.equal(savedBad[0].validation.passed, false, 'validation.passed false when unverified');
  assert.equal(savedBad[0].validation.ok, false);

  const msg = honestSlideShortfallMessage(PHRASE, 6, 7, 'Conclusiones');
  assert.match(msg, /se pedían 7/);
  assert.doesNotMatch(msg, /8 «Conclusiones»/);

  assert.equal(requestedOfficeFormat('Escribe un documento Word… sin convertirlo a Excel ni PPT'), 'docx');
  assert.notEqual(requestedOfficeFormat('Escribe un documento Word… sin convertirlo a Excel ni PPT'), 'xlsx');
  assert.notEqual(requestedOfficeFormat('Escribe un documento Word… sin convertirlo a Excel ni PPT'), 'pptx');

  console.log(JSON.stringify({
    ok: true,
    slides: applied.slideCount,
    green,
    pinkLeft,
    gateOk: goodGate.ok,
    passedWhenMatch: saved[0].validation.passed,
    passedWhenUnverified: savedBad[0].validation.passed,
    wordFormat: requestedOfficeFormat('Escribe un documento Word… sin convertirlo a Excel ni PPT'),
    message: msg,
  }, null, 2));
}

main().catch((err) => {
  console.error('FIXTURE FAIL', err);
  process.exit(1);
});
