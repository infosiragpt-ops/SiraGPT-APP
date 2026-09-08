'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const localCopy = path.join(__dirname, 'document-turn-context.js');
const serviceCopy = path.join(__dirname, '../src/services/document-turn-context.js');
const ctx = require(fs.existsSync(serviceCopy) ? serviceCopy : localCopy);

const SAMPLE_PDF_EXTRACT = [
  'INFORME DE SUFICIENCIA PROFESIONAL',
  'Título: Gestión administrativa en organizaciones modernas',
  'El presente documento analiza la planificación, organización, dirección y control',
  'como procesos integrados de la gestión administrativa. En el capítulo II se',
  'describe el marco teórico y las teorías clásicas de Fayol y Taylor.',
  'Los resultados muestran que el 78% de las empresas encuestadas formalizó',
  'sus procedimientos internos durante 2025.',
].join(' ');

test('extract text is present in the generate payload (mocked LLM)', () => {
  const payload = ctx.buildGeneratePayload({
    prompt: 'analiza este documento',
    processedFiles: [{
      id: 'file-pdf-1',
      name: 'informe.pdf',
      mimeType: 'application/pdf',
      extractedText: SAMPLE_PDF_EXTRACT,
    }],
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.failClosed, false);
  assert.ok(ctx.payloadContainsExtract(payload.messages, 'Gestión administrativa en organizaciones modernas'));
  assert.ok(ctx.payloadContainsExtract(payload.messages, '78% de las empresas'));
  assert.match(payload.messages[1].content, /Attached files:/);
  assert.match(payload.messages[1].content, /informe\.pdf/);
});

test('TXT extract also appears in the generate payload', () => {
  const payload = ctx.buildGeneratePayload({
    prompt: 'analiza este documento',
    processedFiles: [{
      id: 'file-txt-1',
      name: 'notas.txt',
      mimeType: 'text/plain',
      extractedText: 'MARCADOR-TXT-OK: el contrato vence el 30 de septiembre de 2026 y el total es 14500 PEN.',
    }],
  });
  assert.equal(payload.ok, true);
  assert.ok(ctx.payloadContainsExtract(payload.messages, 'MARCADOR-TXT-OK'));
  assert.ok(ctx.payloadContainsExtract(payload.messages, '14500 PEN'));
});

test('empty extract fail-closes with a Spanish actionable error', () => {
  const payload = ctx.buildGeneratePayload({
    prompt: 'analiza este documento',
    processedFiles: [{
      id: 'file-pdf-empty',
      name: 'escaneado.pdf',
      mimeType: 'application/pdf',
      extractedText: '',
    }],
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.failClosed, true);
  assert.equal(payload.code, 'document_extract_empty');
  assert.match(payload.error, /No pude leer el PDF/);
  assert.match(payload.error, /vuelve a adjuntarlo/);
  assert.equal(payload.messages.length, 0);
});

test('placeholder extract also fail-closes', () => {
  const verdict = ctx.assessEmptyDocumentExtract([{
    id: 'f2',
    name: 'binario.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extractedText: 'File "binario.docx" uploaded successfully. Content type: application/octet-stream.',
  }]);
  assert.equal(verdict.failClosed, true);
  assert.match(verdict.error, /No pude leer el documento/);
});

test('image-only turns do not fail-closed', () => {
  const verdict = ctx.assessEmptyDocumentExtract([{
    id: 'img',
    name: 'foto.png',
    mimeType: 'image/png',
    extractedText: '',
  }]);
  assert.equal(verdict.failClosed, false);
  assert.equal(verdict.reason, 'no_document_attachment');
});

test('attached document is preferred over generic/stale RAG hits', () => {
  const hits = [
    { source: 'file:old-other-chat', title: 'otro.pdf', text: 'Texto viejo de otro documento sobre marketing.' },
    { source: 'file:current-doc', title: 'informe.pdf', text: SAMPLE_PDF_EXTRACT },
    { source: 'project-document:p1', title: 'proyecto.md', text: 'Notas de un proyecto distinto.' },
  ];
  const preferred = ctx.preferAttachedRagHits(hits, [{
    id: 'current-doc',
    name: 'informe.pdf',
    mimeType: 'application/pdf',
    extractedText: SAMPLE_PDF_EXTRACT,
  }]);
  assert.equal(preferred.length, 1);
  assert.equal(preferred[0].source, 'file:current-doc');
  assert.match(preferred[0].text, /Gestión administrativa/);
});

test('stale RAG is dropped when the attached file has no hits', () => {
  const hits = [
    { source: 'file:old-other-chat', title: 'otro.pdf', text: 'Texto viejo.' },
  ];
  const preferred = ctx.preferAttachedRagHits(hits, [{
    id: 'brand-new',
    name: 'nuevo.pdf',
    mimeType: 'application/pdf',
    extractedText: SAMPLE_PDF_EXTRACT,
  }]);
  assert.equal(preferred.length, 0);
});

test('filename-only RAG scaffolding cannot hide the attached extract', () => {
  const prompt = ctx.buildAttachedFilePrompt({
    prompt: 'analiza este documento',
    uploadedFileContext: [
      'The attached document text was indexed by SIRA EVIDENCE RUNTIME for this turn.',
      'File manifest:',
      '- informe.pdf: application/pdf; 180 extracted characters',
    ].join('\n'),
    processedFiles: [{
      id: 'current-doc',
      name: 'informe.pdf',
      mimeType: 'application/pdf',
      extractedText: SAMPLE_PDF_EXTRACT,
    }],
  });
  assert.match(prompt, /Gestión administrativa en organizaciones modernas/);
  assert.match(prompt, /78% de las empresas/);
});

test('shouldKeepAttachedBody is true when extract is useful', () => {
  assert.equal(ctx.shouldKeepAttachedBody([{
    id: 'd1',
    name: 'a.pdf',
    mimeType: 'application/pdf',
    extractedText: SAMPLE_PDF_EXTRACT,
  }]), true);
  assert.equal(ctx.shouldKeepAttachedBody([{
    id: 'd2',
    name: 'a.pdf',
    mimeType: 'application/pdf',
    extractedText: '',
  }]), false);
});

test('token budget keeps head and tail instead of dropping the document', () => {
  const long = `INICIO_UNICO ${'bloque '.repeat(4000)} FINAL_UNICO y conclusiones del estudio.`;
  const out = ctx.applyTokenBudget(long, { maxChars: 400 });
  assert.equal(out.truncated, true);
  assert.match(out.text, /INICIO_UNICO/);
  assert.match(out.text, /FINAL_UNICO/);
  assert.match(out.text, /el documento es largo y se truncó/);
});
