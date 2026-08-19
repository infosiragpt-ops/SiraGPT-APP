'use strict';

/**
 * Surgical list preservation — inserted bullet items must join the source
 * document's OWN list style (captured numPr → real Word marker) and only
 * fall back to a hanging-indent "• " paragraph when the document has no
 * lists at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { INTERNAL } = require('../src/services/source-preserving-document-edit');

const {
  paragraphXml,
  pickRepresentativeListParagraph,
  buildFormattingTemplate,
  sanitizeCapturedParagraphProperties,
} = INTERNAL;

const LIST_PARAGRAPH_XML = [
  '<w:p>',
  '<w:pPr>',
  '<w:pStyle w:val="ListParagraph"/>',
  '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>',
  '<w:ind w:left="720" w:hanging="360"/>',
  '</w:pPr>',
  '<w:r><w:rPr><w:rFonts w:ascii="Garamond"/><w:sz w:val="22"/></w:rPr><w:t>Elemento existente de la lista</w:t></w:r>',
  '</w:p>',
].join('');

const BODY_PARAGRAPH_XML = [
  '<w:p>',
  '<w:pPr><w:jc w:val="both"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>',
  '<w:r><w:rPr><w:rFonts w:ascii="Garamond"/><w:sz w:val="24"/></w:rPr>',
  '<w:t>Un párrafo de cuerpo suficientemente largo para ser representativo del documento fuente.</w:t>',
  '</w:r></w:p>',
].join('');

test('sanitizeCapturedParagraphProperties keeps numPr only in list mode', () => {
  const pPr = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr><w:ind w:left="720"/></w:pPr>';
  assert.doesNotMatch(sanitizeCapturedParagraphProperties(pPr), /<w:numPr/);
  assert.match(sanitizeCapturedParagraphProperties(pPr, { keepNumbering: true }), /<w:numPr/);
  // sectPr is always dropped, even in list mode.
  const withSect = '<w:pPr><w:sectPr><w:pgSz w:w="12240"/></w:sectPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr>';
  const kept = sanitizeCapturedParagraphProperties(withSect, { keepNumbering: true });
  assert.doesNotMatch(kept, /<w:sectPr/);
  assert.match(kept, /<w:numPr/);
});

test('pickRepresentativeListParagraph finds the first real list item', () => {
  const paragraphs = [
    { xml: BODY_PARAGRAPH_XML, text: 'Un párrafo de cuerpo suficientemente largo…' },
    { xml: LIST_PARAGRAPH_XML, text: 'Elemento existente de la lista' },
  ];
  assert.equal(pickRepresentativeListParagraph(paragraphs), LIST_PARAGRAPH_XML);
  assert.equal(pickRepresentativeListParagraph([{ xml: BODY_PARAGRAPH_XML, text: 'cuerpo' }]), '');
});

test('bullet items clone the document list style (real numPr, clean text)', () => {
  const template = buildFormattingTemplate({
    bodyXml: BODY_PARAGRAPH_XML,
    headingXml: '',
    listXml: LIST_PARAGRAPH_XML,
  });
  assert.match(template.listPPr, /<w:numPr>[\s\S]*<w:numId w:val="3"\/>/, 'captured list keeps numId');

  const xml = paragraphXml({ kind: 'bullet', text: 'Nuevo punto insertado' }, template);
  assert.match(xml, /<w:numPr>/, 'inserted bullet joins the real list');
  assert.match(xml, /Nuevo punto insertado/);
  assert.doesNotMatch(xml, /•/, 'no literal marker when Word renders the list glyph');
  // Inherits the list run formatting (Garamond 22) — not a default size.
  assert.match(xml, /Garamond/);
});

test('bullet items fall back to hanging-indent "• " when the document has no lists', () => {
  const template = buildFormattingTemplate({
    bodyXml: BODY_PARAGRAPH_XML,
    headingXml: '',
    listXml: '',
  });
  assert.equal(template.listPPr, '', 'no list captured');

  const xml = paragraphXml({ kind: 'bullet', text: 'Punto sin lista fuente' }, template);
  assert.match(xml, /• Punto sin lista fuente/, 'visible fallback marker');
  assert.match(xml, /<w:ind w:left="720" w:hanging="360"\/>/, 'hanging indent so wraps align');
  assert.doesNotMatch(xml, /<w:numPr>/);
});

test('bullet text is deduped: a pre-prefixed "• " never doubles the marker', () => {
  const noListTemplate = buildFormattingTemplate({ bodyXml: BODY_PARAGRAPH_XML, listXml: '' });
  const xml = paragraphXml({ kind: 'bullet', text: '• Ya venía con viñeta' }, noListTemplate);
  const occurrences = (xml.match(/•/g) || []).length;
  assert.equal(occurrences, 1, 'single marker');
  assert.match(xml, /• Ya venía con viñeta/);

  const listTemplate = buildFormattingTemplate({ bodyXml: BODY_PARAGRAPH_XML, listXml: LIST_PARAGRAPH_XML });
  const listXml = paragraphXml({ kind: 'bullet', text: '- Ya venía con guion' }, listTemplate);
  assert.doesNotMatch(listXml, /- Ya venía/, 'markdown dash stripped when the list renders the glyph');
  assert.match(listXml, /Ya venía con guion/);
});

test('normal paragraphs are untouched by the list machinery', () => {
  const template = buildFormattingTemplate({
    bodyXml: BODY_PARAGRAPH_XML,
    listXml: LIST_PARAGRAPH_XML,
  });
  const xml = paragraphXml({ kind: 'normal', text: 'Texto de cuerpo normal.' }, template);
  assert.doesNotMatch(xml, /<w:numPr>/, 'body text never inherits numbering');
  assert.match(xml, /Texto de cuerpo normal\./);
});
