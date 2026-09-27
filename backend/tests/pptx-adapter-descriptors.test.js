'use strict';

// Prod 2026-09-27: «cambia el año de la portada» reached the pptx editor as
// needle "año de la portada" and failed with «no encontré el texto "año de la
// portada" dentro de la diapositiva 1» although the cover showed «2024». A
// descriptor (año / fecha / correo / título / …) resolves against the
// slide's own text, and only when exactly one candidate exists.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { replaceSlideText, resolveDescriptiveNeedle, listPptxSlides } = require('../src/services/document-editing/pptx-adapter');

const SLIDE_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function shape(name, runs) {
  const paragraphs = runs.map((text) => `<a:p><a:r><a:rPr lang="es-PE"/><a:t>${text}</a:t></a:r></a:p>`).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function buildDeck(slidesShapes) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + slidesShapes.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${SLIDE_NS}><p:sldIdLst>${slidesShapes.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + slidesShapes.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('') + '</Relationships>');
  slidesShapes.forEach((shapes, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:sld ${SLIDE_NS}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`);
  });
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function slideText(buffer, partName = 'ppt/slides/slide1.xml') {
  return new PizZip(buffer).file(partName).asText();
}

const COVER = [shape('Título', ['Plan de trabajo anual']), shape('Datos', ['Elaborado en 2024', 'Contacto: contacto@empresa.com · Tel. +51 987 654 321'])];

test('descriptor «año de la portada» resolves to the only year on the slide and replaces it', () => {
  const deck = buildDeck([COVER]);
  const out = replaceSlideText({ buffer: deck, slideNumber: 1, needle: 'año de la portada', replacement: '2026' });
  assert.equal(out.resolvedNeedle, '2024');
  assert.equal(out.resolvedKind, 'year');
  const xml = slideText(out.buffer);
  assert.match(xml, /Elaborado en 2026/);
  assert.doesNotMatch(xml, /2024/);
  assert.match(xml, /contacto@empresa\.com/, 'other runs untouched');
});

test('descriptors for correo, teléfono and título resolve against the slide', () => {
  const deck = buildDeck([COVER]);
  const mail = replaceSlideText({ buffer: deck, slideNumber: 1, needle: 'el correo', replacement: 'ventas@empresa.com' });
  assert.equal(mail.resolvedNeedle, 'contacto@empresa.com');
  assert.match(slideText(mail.buffer), /ventas@empresa\.com/);

  const phone = replaceSlideText({ buffer: deck, slideNumber: 1, needle: 'cambia el teléfono', replacement: '+51 900 000 000' });
  assert.equal(phone.resolvedKind, 'phone');
  assert.match(slideText(phone.buffer), /\+51 900 000 000/);

  const title = replaceSlideText({ buffer: deck, slideNumber: 1, needle: 'el título', replacement: 'Plan estratégico 2026' });
  assert.equal(title.resolvedKind, 'title');
  assert.match(slideText(title.buffer), /Plan estratégico 2026/);
  assert.equal(listPptxSlides(title.buffer)[0].title, 'Plan estratégico 2026');
});

test('an ambiguous descriptor (two years on the slide) is never guessed', () => {
  const deck = buildDeck([[shape('Título', ['Comparativa']), shape('Cuerpo', ['Ventas 2023 frente a 2024'])]]);
  assert.throws(
    () => replaceSlideText({ buffer: deck, slideNumber: 1, needle: 'el año', replacement: '2026' }),
    /no encontré el texto "el año" dentro de la diapositiva 1/,
  );
  assert.equal(resolveDescriptiveNeedle('el año', { texts: ['Ventas 2023 frente a 2024'] }), null);
});

test('a literal needle still wins and a descriptor never overrides a literal match', () => {
  const deck = buildDeck([COVER]);
  const out = replaceSlideText({ buffer: deck, slideNumber: 1, needle: 'Elaborado en 2024', replacement: 'Elaborado en 2025' });
  assert.equal(out.resolvedNeedle, undefined);
  assert.match(slideText(out.buffer), /Elaborado en 2025/);
});

test('resolveDescriptiveNeedle: kinds, uniqueness and non-descriptors', () => {
  assert.deepEqual(resolveDescriptiveNeedle('la fecha de entrega', { texts: ['Entrega: 12/05/2024'] }), { kind: 'date', needle: '12/05/2024' });
  assert.deepEqual(resolveDescriptiveNeedle('el porcentaje', { texts: ['Avance 45 %'] }), { kind: 'percent', needle: '45 %' });
  assert.deepEqual(resolveDescriptiveNeedle('el enlace', { texts: ['Más en https://siragpt.com/agentes'] }), { kind: 'url', needle: 'https://siragpt.com/agentes' });
  assert.equal(resolveDescriptiveNeedle('el año', { texts: ['sin números'] }), null, 'no candidate');
  assert.equal(resolveDescriptiveNeedle('texto cualquiera', { texts: ['2024'] }), null, 'not a descriptor');
  assert.equal(resolveDescriptiveNeedle('el título', { texts: ['x'], title: '' }), null, 'no title');
});
