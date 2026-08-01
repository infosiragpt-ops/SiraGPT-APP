'use strict';

/**
 * Surgical DOCX run-level edits — the same document, byte-stable structure.
 *
 * Guarantees:
 *  1. Mixed bold/italic runs survive a mid-paragraph replace.
 *  2. Needles split across multiple <w:t> runs still match and rewrite.
 *  3. Proofreading does not rebuild the paragraph (rPr stays).
 *  4. Partial delete blanks only the needle, not the whole <w:p>.
 *  5. Untouched sibling paragraphs remain byte-identical.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const PizZip = require('pizzip');

const {
  INTERNAL: {
    deleteTextFromDocxBuffer,
    extractWtNodes,
    proofreadMinimalDocxBuffer,
    replaceTextInDocxBuffer,
    replaceTextInParagraphXmlSurgical,
  },
} = require('../src/services/source-preserving-document-edit');

function paragraphText(xml = '') {
  const pieces = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let match;
  while ((match = re.exec(xml))) {
    pieces.push(match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'));
  }
  return pieces.join('');
}

function documentXmlFromBuffer(buffer) {
  return new PizZip(buffer).file('word/document.xml').asText();
}

function extractParagraphs(documentXml) {
  const paragraphs = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = re.exec(documentXml))) {
    paragraphs.push({ start: match.index, end: match.index + match[0].length, xml: match[0] });
  }
  return paragraphs;
}

async function makeMixedFormattingDocx() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: 'El informe de ', bold: false }),
            new TextRun({ text: 'Introducción original', bold: true }),
            new TextRun({ text: ' queda pendiente.', italics: true }),
          ],
        }),
        new Paragraph('Párrafo hermano intacto UPN-42.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeSplitRunDocx() {
  // Force the target phrase to live across three runs with different rPr.
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: 'Estado: ' }),
            new TextRun({ text: 'BOR', bold: true }),
            new TextRun({ text: 'RAD', bold: true, italics: true }),
            new TextRun({ text: 'OR', bold: true }),
            new TextRun({ text: ' del comité.' }),
          ],
        }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeProofreadDocx() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: 'Lista de ', bold: false }),
            new TextRun({ text: 'palabras claves', bold: true }),
            new TextRun({ text: ' del estudio; porfavor revisar.' }),
          ],
        }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('docx surgical run-level edit', () => {
  it('replaces text mid-paragraph without destroying bold/italic runs', async () => {
    const source = await makeMixedFormattingDocx();
    const beforeXml = documentXmlFromBuffer(source);
    const siblingBefore = extractParagraphs(beforeXml).find((p) => /UPN-42/.test(p.xml))?.xml;

    const result = replaceTextInDocxBuffer(source, 'Introducción original', 'Introducción mejorada');
    assert.ok(result.changedCount >= 1);

    const afterXml = documentXmlFromBuffer(result.buffer);
    assert.match(afterXml, /Introducción mejorada/);
    assert.doesNotMatch(afterXml, /Introducción original/);

    // Bold run property must still be present near the new text.
    const targetPara = extractParagraphs(afterXml).find((p) => /Introducción mejorada/.test(p.xml));
    assert.ok(targetPara, 'edited paragraph present');
    assert.match(targetPara.xml, /<w:b\b|w:b\s*\/>|<w:bCs\b/);
    assert.match(targetPara.xml, /<w:i\b|w:i\s*\/>|<w:iCs\b/);

    // Sibling paragraph must be byte-identical (surgical = same document).
    const siblingAfter = extractParagraphs(afterXml).find((p) => /UPN-42/.test(p.xml))?.xml;
    assert.equal(siblingAfter, siblingBefore);
  });

  it('matches a needle split across multiple w:t runs', async () => {
    const source = await makeSplitRunDocx();
    const beforeXml = documentXmlFromBuffer(source);
    assert.match(paragraphText(beforeXml), /BORRADOR/);

    const result = replaceTextInDocxBuffer(source, 'BORRADOR', 'APROBADO');
    const afterXml = documentXmlFromBuffer(result.buffer);
    const text = paragraphText(afterXml);
    assert.match(text, /APROBADO/);
    assert.doesNotMatch(text, /BORRADOR/);
    assert.match(text, /Estado:/);
    assert.match(text, /del comité/);

    // At least one bold marker must survive (the runs that held BORRADOR).
    assert.match(afterXml, /<w:b\b|w:b\s*\/>|<w:bCs\b/);
  });

  it('surgical helper rewrites only the overlapped w:t nodes', () => {
    const paragraphXml = [
      '<w:p>',
      '<w:r><w:rPr><w:b/></w:rPr><w:t>Foo </w:t></w:r>',
      '<w:r><w:rPr><w:i/></w:rPr><w:t>bar</w:t></w:r>',
      '<w:r><w:t> baz</w:t></w:r>',
      '</w:p>',
    ].join('');

    const surgical = replaceTextInParagraphXmlSurgical(paragraphXml, 'bar', 'qux');
    assert.equal(surgical.changed, true);
    assert.equal(surgical.count, 1);
    assert.match(surgical.xml, /<w:b\s*\/>/);
    assert.match(surgical.xml, /<w:i\s*\/>/);
    assert.match(surgical.xml, /<w:t[^>]*>qux<\/w:t>/);
    assert.match(surgical.xml, /<w:t[^>]*>Foo <\/w:t>/);
    assert.match(surgical.xml, /<w:t[^>]*> baz<\/w:t>/);

    const nodes = extractWtNodes(surgical.xml);
    assert.equal(nodes.map((n) => n.text).join(''), 'Foo qux baz');
  });

  it('proofreads mechanical typos without rebuilding the paragraph', async () => {
    const source = await makeProofreadDocx();
    const beforeXml = documentXmlFromBuffer(source);
    const beforePara = extractParagraphs(beforeXml)[0].xml;
    assert.match(beforePara, /<w:b\b|w:b\s*\/>|<w:bCs\b/);

    const result = proofreadMinimalDocxBuffer(source);
    assert.ok(result.changedCount >= 1);
    assert.ok(result.changedParagraphs >= 1);

    const afterXml = documentXmlFromBuffer(result.buffer);
    const afterPara = extractParagraphs(afterXml)[0].xml;
    const text = paragraphText(afterXml);
    assert.match(text, /palabras clave/);
    assert.doesNotMatch(text, /palabras claves/i);
    assert.match(text, /por favor/i);
    assert.doesNotMatch(text, /porfavor/i);

    // Bold run property must still exist (we did not rebuild via paragraphXml).
    assert.match(afterPara, /<w:b\b|w:b\s*\/>|<w:bCs\b/);
  });

  it('partial delete removes only the needle, not the whole paragraph', async () => {
    const source = await makeMixedFormattingDocx();
    const result = deleteTextFromDocxBuffer(source, 'Introducción original');
    assert.ok(result.removedCount >= 1);

    const afterXml = documentXmlFromBuffer(result.buffer);
    const text = paragraphText(afterXml);
    assert.doesNotMatch(text, /Introducción original/);
    assert.match(text, /El informe de/);
    assert.match(text, /queda pendiente/);
    assert.match(text, /UPN-42/);
  });

  it('whole-paragraph delete drops the <w:p> when needle equals the paragraph', async () => {
    const source = await makeMixedFormattingDocx();
    const result = deleteTextFromDocxBuffer(source, 'Párrafo hermano intacto UPN-42.');
    assert.ok(result.removedCount >= 1);
    const afterXml = documentXmlFromBuffer(result.buffer);
    assert.doesNotMatch(afterXml, /UPN-42/);
    assert.match(paragraphText(afterXml), /Introducción original|informe de/);
  });
});
