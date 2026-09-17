
'use strict';

/**
 * Fixture: 6-slide #FF69B4 → combined append + setSlideBackgrounds(#22C55E)
 * Assert 7 slides, 22C55E count in slide XML > 0, validation.passed only if both.
 */
const PizZip = require('pizzip');
const {
  appendTextSlide,
  countSlides,
  countHexInSlideXml,
  listSlideTexts,
} = require('./office-helpers');
const { persistOutputs } = require('./artifacts');
const { parsePptFollowupIntent, resolveTargetSlideCount } = require('./slide-intent');
const { applyAllOutputGates, honestSlideShortfallMessage } = require('./verify');
const { setSlideBackgrounds } = require('../document-editing/pptx-adapter');

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
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:r><a:rPr lang="es-ES" sz="2800"/><a:t>${title}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function buildPinkDeck(n = 6, hex = 'FF69B4') {
  const zip = new PizZip();
  const overrides = [];
  const rels = [];
  const sldIds = [];
  for (let i = 1; i <= n; i += 1) {
    zip.file(`ppt/slides/slide${i}.xml`, slideXml(i, hex, `Tema ${i}`));
    overrides.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`);
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
  }
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `${overrides.join('')}</Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
    `</Relationships>`);
  zip.file('ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  zip.file('ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  return zip.generate({ type: 'nodebuffer' });
}

function fail(msg) {
  console.error('FIXTURE FAIL:', msg);
  process.exit(1);
}

(async () => {
  const pink = buildPinkDeck(6, 'FF69B4');
  const beforeSlides = countSlides(pink);
  const beforeGreen = countHexInSlideXml(pink, '22C55E');
  const beforePink = countHexInSlideXml(pink, 'FF69B4');
  console.log(`BEFORE slides=${beforeSlides} 22C55E=${beforeGreen} FF69B4=${beforePink}`);
  if (beforeSlides !== 6) fail(`expected 6 slides, got ${beforeSlides}`);
  if (beforeGreen !== 0) fail(`expected 0x 22C55E before, got ${beforeGreen}`);
  if (beforePink < 6) fail(`expected >=6x FF69B4 before, got ${beforePink}`);

  const followUp = 'Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones.';
  const intent = parsePptFollowupIntent(followUp);
  const target = Number.isInteger(intent.targetTotal)
    ? intent.targetTotal
    : resolveTargetSlideCount(intent, beforeSlides);
  console.log('intent', JSON.stringify(intent), 'target', target);
  if (!intent.wantsAddSlide) fail('follow-up must want add slide');
  if (target !== 7) fail(`target must be 7, got ${target}`);

  let buf = pink;
  while (countSlides(buf) < target) {
    buf = appendTextSlide({ buffer: buf, title: intent.title || 'Conclusiones', bullets: ['Cierre'] }).buffer;
  }
  // same paint as color-only
  buf = setSlideBackgrounds({ buffer: buf, color: '#22C55E', allSlides: true, contrastText: true }).buffer;

  const afterSlides = countSlides(buf);
  const afterGreen = countHexInSlideXml(buf, '22C55E');
  const afterPink = countHexInSlideXml(buf, 'FF69B4');
  const texts = listSlideTexts(buf);
  console.log(`AFTER slides=${afterSlides} 22C55E=${afterGreen} FF69B4=${afterPink}`);
  console.log('texts', texts);

  if (afterSlides !== 7) fail(`expected 7 slides, got ${afterSlides}`);
  if (afterGreen <= 0) fail(`expected 22C55E count > 0 in slide XML, got ${afterGreen}`);
  if (!texts.some((t) => /conclus/i.test(t))) fail('Conclusiones missing');

  const outputs = [{ name: 'deck-editado.pptx', buffer: buf, valid: true }];
  const gateOk = applyAllOutputGates(outputs, followUp, { currentCount: 6, color: '22C55E' });
  const bothMatch = afterSlides === 7 && afterGreen > 0;
  console.log('gate.ok', gateOk.ok, 'validation', outputs[0].validation, 'verified', outputs[0].verified, 'bothMatch', bothMatch);
  if (bothMatch && gateOk.ok !== true) fail('combined path should pass when color AND count match');
  if (bothMatch && outputs[0].validation.passed !== true) fail('validation.passed should be true when both match');
  if (!bothMatch && outputs[0].validation.passed !== false) fail('validation.passed must be false unless both match');

  const artifacts = await persistOutputs({
    outputs,
    userId: 'fixture',
    chatId: 'fixture',
    saveArtifact: ({ filename, validation }) => ({
      id: 'fix-1', filename, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      format: 'pptx', sizeBytes: buf.length, path: null, downloadUrl: '/x', validation,
    }),
  });
  if (artifacts[0].validation.passed !== bothMatch) {
    fail(`persistOutputs.validation.passed=${artifacts[0].validation.passed} expected ${bothMatch}`);
  }

  const bad = [{ name: 'deck.pptx', buffer: pink, valid: true }];
  applyAllOutputGates(bad, followUp, { currentCount: 6, color: '22C55E' });
  const badArts = await persistOutputs({
    outputs: bad,
    userId: 'fixture',
    chatId: 'fixture',
    saveArtifact: ({ filename, validation }) => ({
      id: 'fix-2', filename, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      format: 'pptx', sizeBytes: pink.length, path: null, downloadUrl: '/x', validation,
    }),
  });
  if (badArts[0].validation.passed !== false) fail('pink 6-slide must persist passed=false');

  const msg = honestSlideShortfallMessage(followUp, 6, 7, 'Conclusiones');
  if (/Conclusiones/.test(msg)) fail(`gate message must be slide count, not title: ${msg}`);
  if (!/\b6\b/.test(msg) || !/\b7\b/.test(msg)) fail(`gate message missing numeric counts: ${msg}`);

  console.log('FIXTURE PASS');
  console.log(JSON.stringify({
    before: { slides: beforeSlides, '22C55E': beforeGreen, FF69B4: beforePink },
    after: { slides: afterSlides, '22C55E': afterGreen, FF69B4: afterPink },
    gateOk: gateOk.ok,
    persistPassed: artifacts[0].validation.passed,
    persistBadPassed: badArts[0].validation.passed,
    gateMessage: msg,
  }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
