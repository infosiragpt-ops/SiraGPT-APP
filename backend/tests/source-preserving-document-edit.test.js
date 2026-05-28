const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Document, Packer, Paragraph } = require('docx');
const PizZip = require('pizzip');

const {
  appendToDocxBuffer,
  buildAppendixBlocks,
  inferDocumentTitle,
  isSourcePreservingEditRequest,
} = require('../src/services/source-preserving-document-edit');
const {
  buildDocumentDeliveryPolicy,
} = require('../src/services/agents/document-delivery-policy');

async function makeDocxBuffer() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('Capítulo 1. Introducción original'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('source-preserving document edit', () => {
  it('detects requests to edit the uploaded document instead of creating a new file', () => {
    const prompt = 'quiero que agregues al final el intuemtno de tesis que vamos a aplicar en esta tesis';

    assert.equal(isSourcePreservingEditRequest(prompt, ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('dame un resumen en un solo párrafo', ['file-docx']), false);
  });

  it('promotes source-preserving edits to doc_required so an artifact is returned', () => {
    const policy = buildDocumentDeliveryPolicy({
      goal: 'agrega al final un anexo con el instrumento de tesis',
      files: ['file-docx'],
    });

    assert.equal(policy.mode, 'doc_required');
    assert.equal(policy.autoGenerate, true);
  });

  it('appends instrument content into word/document.xml without replacing original body text', async () => {
    const original = await makeDocxBuffer();
    const sourceText = [
      '“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana durante el periodo 2020-2025”',
      'Capítulo 1. Introducción',
      'La informalidad de las MYPES afecta la recaudación fiscal.',
    ].join('\n');
    const blocks = buildAppendixBlocks({
      prompt: 'agrega al final el instrumento de tesis',
      sourceText,
      originalName: 'tesis.docx',
    });

    const edited = appendToDocxBuffer(original, blocks);
    const xml = new PizZip(edited).file('word/document.xml').asText();

    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /Capítulo 1\. Introducción original/);
    assert.match(xml, /ANEXOS/);
    assert.match(xml, /Instrumento de recolección de datos/);
    assert.match(xml, /informalidad de las MYPES/i);
    assert.match(xml, /recaudación fiscal/i);
    assert.doesNotMatch(xml, /Solicitud del usuario:/);
    assert.doesNotMatch(xml, /siraGPT Document Pipeline/);
  });

  it('infers the thesis title from quoted source text instead of using the prompt as title', () => {
    const title = inferDocumentTitle(
      'FACULTAD DE XXXXX\n“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana durante el periodo 2020-2025”',
      'tesis.docx',
    );

    assert.equal(title, 'Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana durante el periodo 2020-2025');
  });
});
