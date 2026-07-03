'use strict';

// CREATE_DOCUMENT directive tolerance — regression tests for the raw-JSON
// leak: Deepseek improvised an attribute form ([CREATE_DOCUMENT format="pptx"
// filename="X.pptx"] {json}) that the colon-form-only interceptor didn't
// match, so the entire directive rendered in the chat as text and no file
// was created. These tests pin the tolerant matcher contract. The matcher
// lives inline in routes/ai.js (route closure); this suite mirrors the exact
// implementation to lock the behavior — keep both in sync.

const test = require('node:test');
const assert = require('node:assert');

const { cleanAssistantContentForDocument } = require('../src/services/document-followup-context');

// Mirror of the in-route matcher (routes/ai.js) — same regexes, same order.
const matchCreateDocumentDirective = (text) => {
  const colon = text.match(/\[CREATE_DOCUMENT:(?<filename>[^\]]+)\](?<content>[\s\S]*?)\[\/CREATE_DOCUMENT\]/i);
  if (colon?.groups) {
    return { raw: colon[0], filename: colon.groups.filename.trim(), content: colon.groups.content };
  }
  const attr = text.match(/\[CREATE_DOCUMENT\s+(?<attrs>[^\]]*)\](?<content>[\s\S]*?)\[\/CREATE_DOCUMENT\]/i);
  if (!attr?.groups) return null;
  const fileAttr = attr.groups.attrs.match(/filename\s*=\s*["']([^"']+)["']/i);
  const formatAttr = attr.groups.attrs.match(/format\s*=\s*["']?([a-z0-9]+)["']?/i);
  const filename = (fileAttr?.[1] || `documento.${formatAttr?.[1] || 'docx'}`).trim();
  return { raw: attr[0], filename, content: attr.groups.content };
};

test('canonical colon form still matches', () => {
  const d = matchCreateDocumentDirective('intro [CREATE_DOCUMENT:informe.docx]# Hola[/CREATE_DOCUMENT] fin');
  assert.equal(d.filename, 'informe.docx');
  assert.equal(d.content, '# Hola');
});

test('Deepseek attribute form matches and extracts the filename', () => {
  const text = 'Entendido, procedo. [CREATE_DOCUMENT format="pptx" filename="Gestion_Embarazo_Profesional.pptx"] { "slides": [ { "title": "Gestión del Embarazo" } ] } [/CREATE_DOCUMENT]';
  const d = matchCreateDocumentDirective(text);
  assert.ok(d, 'attribute form must match');
  assert.equal(d.filename, 'Gestion_Embarazo_Profesional.pptx');
  assert.ok(d.content.includes('"slides"'));
  // stripping the matched raw block leaves only the human summary
  assert.equal(text.split(d.raw).join('').trim(), 'Entendido, procedo.');
});

test('format-only attribute falls back to documento.<ext>', () => {
  const d = matchCreateDocumentDirective('[CREATE_DOCUMENT format="xlsx"]|a|b|[/CREATE_DOCUMENT]');
  assert.equal(d.filename, 'documento.xlsx');
});

test('plain text mentioning CREATE_DOCUMENT does not match', () => {
  assert.equal(matchCreateDocumentDirective('el tag CREATE_DOCUMENT no está presente'), null);
});

test('followup-context strips BOTH directive variants from source content', () => {
  const colonForm = 'resumen [CREATE_DOCUMENT:x.docx]cuerpo completo[/CREATE_DOCUMENT] cola';
  const attrForm = 'resumen [CREATE_DOCUMENT format="pptx" filename="x.pptx"]{"slides":[]}[/CREATE_DOCUMENT] cola';
  for (const sample of [colonForm, attrForm]) {
    const out = cleanAssistantContentForDocument(sample);
    assert.ok(!out.includes('CREATE_DOCUMENT'), `directive stripped from: ${sample.slice(0, 40)}`);
    assert.ok(out.includes('resumen'));
  }
});
