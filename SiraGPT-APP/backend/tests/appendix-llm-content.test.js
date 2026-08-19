'use strict';

// Rich appendix content: "analiza y agrégale los instrumentos" must append
// the REAL analysed content to the docx, not a template stub or the echoed
// prompt. Before this fix the surgical editor added a placeholder, so the
// chat agent generated the content itself and dumped it into the chat.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../src/services/source-preserving-document-edit');
const { markdownToAppendixBlocks, generateAppendixBlocksLLM } = editor.INTERNAL;

describe('markdownToAppendixBlocks', () => {
  test('parses headings, bullets, paragraphs and flattens tables to readable blocks', () => {
    const md = [
      '## Anexo. Instrumentos de recolección de datos',
      '### Instrumento 1. Cuestionario de accesibilidad',
      'Variable: Barreras del entorno. Escala Likert de 5 niveles.',
      '',
      '| N.º | Dimensión | Ítem |',
      '| --- | --- | --- |',
      '| 1 | Barreras del entorno | El ingreso principal permitió el acceso autónomo. |',
      '| 2 | Barreras del entorno | Las rampas facilitaron el desplazamiento. |',
      '',
      '- Marque con una X la alternativa que corresponda.',
    ].join('\n');
    const blocks = markdownToAppendixBlocks(md);
    // Opens with a page break + ANEXOS anchor
    assert.equal(blocks[0].kind, 'pageBreak');
    assert.equal(blocks[1].kind, 'heading1');
    const text = blocks.map((b) => `${b.kind}:${b.text || ''}`).join('\n');
    assert.match(text, /heading[12]:Anexo\. Instrumentos/);
    assert.match(text, /heading3:Instrumento 1/);
    // Table header row → heading3 with the columns; body rows → bullets with cell text
    assert.match(text, /heading3:N\.º.+Dimensión.+Ítem/);
    assert.match(text, /bullet:1.+Barreras del entorno.+El ingreso principal/);
    assert.match(text, /bullet:Marque con una X/);
    // The |---| separator row must NOT appear as content
    // No block is a pure Markdown separator row (|---|---|).
    for (const b of blocks) assert.ok(!/^[-\s|]+$/.test(b.text || 'x'), `separator leaked: ${b.text}`);
  });

  test('short/empty markdown yields just the anchor (caller falls back)', () => {
    const blocks = markdownToAppendixBlocks('');
    assert.equal(blocks.length, 2); // pageBreak + ANEXOS
  });
});

describe('generateAppendixBlocksLLM', () => {
  test('returns null in test env (no network) → deterministic fallback', async () => {
    const out = await generateAppendixBlocksLLM({ requestText: 'agrega los instrumentos', sourceText: 'tesis', title: 'Accesibilidad hotelera' });
    assert.equal(out, null);
  });
});
