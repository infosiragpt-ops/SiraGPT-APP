const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessAttachmentContext,
  countUsefulWords,
  referencesAttachment,
  stripScaffolding,
} = require('../src/services/agents/attachment-context-guard');

test('countUsefulWords ignores scaffolding lines from buildUploadedFileContext', () => {
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    'Usa este contenido para responder sobre el documento pegado/subido.',
    '',
    '### Archivo adjunto 1: nav.html',
    'id: f-123',
    'tipo: text/html',
    '',
    'Skip to main content / SKIP',
  ].join('\n');
  // Only the actual content "Skip to main content / SKIP" should count → 5 words
  assert.equal(countUsefulWords(ctx), 5);
});

test('referencesAttachment matches typical chat questions about a file', () => {
  assert.equal(referencesAttachment('de que pais es este?'), true);
  assert.equal(referencesAttachment('qué dice el documento?'), true);
  assert.equal(referencesAttachment('cuántos puntos hay aquí?'), true);
  assert.equal(referencesAttachment('Hola, cómo estás'), true);
  assert.equal(referencesAttachment('quiero un pitch deck'), false);
});

test('assessAttachmentContext flags thin context when files are attached', () => {
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    '',
    '### Archivo adjunto 1: page.html',
    'id: f-1',
    'tipo: text/html',
    '',
    'Skip to main content / SKIP',
  ].join('\n');
  const result = assessAttachmentContext({
    uploadedFileContext: ctx,
    files: ['f-1'],
    userText: 'de que pais es este?',
  });
  assert.equal(result.isThin, true);
  assert.equal(result.hasFiles, true);
  assert.equal(result.references, true);
  assert.ok(result.usefulWords < 30);
});

test('assessAttachmentContext does NOT flag when context is rich', () => {
  // 60+ useful words from real-looking content
  const richBody = Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(' ');
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    '',
    '### Archivo adjunto 1: report.pdf',
    'id: f-1',
    'tipo: application/pdf',
    '',
    richBody,
  ].join('\n');
  const result = assessAttachmentContext({
    uploadedFileContext: ctx,
    files: ['f-1'],
    userText: 'de qué trata este documento?',
  });
  assert.equal(result.isThin, false);
  assert.ok(result.usefulWords >= 30);
});

test('assessAttachmentContext does NOT flag when no files are attached', () => {
  const result = assessAttachmentContext({
    uploadedFileContext: '',
    files: [],
    userText: 'qué dice el archivo?',
  });
  assert.equal(result.isThin, false);
  assert.equal(result.hasFiles, false);
});

test('assessAttachmentContext does NOT flag when user is not asking about the attachment', () => {
  const ctx = [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    '',
    '### Archivo adjunto 1: x.txt',
    'id: f-1',
    'tipo: text/plain',
    '',
    'Skip',
  ].join('\n');
  const result = assessAttachmentContext({
    uploadedFileContext: ctx,
    files: ['f-1'],
    userText: 'genérame una idea de negocio para una startup de comida',
  });
  // User is not referencing the attachment → don't intervene
  assert.equal(result.references, false);
  assert.equal(result.isThin, false);
});

test('stripScaffolding removes ids and headers but keeps content', () => {
  const ctx = [
    '### Archivo adjunto 1: a.pdf',
    'id: abc',
    'tipo: application/pdf',
    'analysisId: def',
    'resumen tecnico: short summary',
    '',
    'Hello world this is real content.',
  ].join('\n');
  const stripped = stripScaffolding(ctx);
  assert.equal(stripped.includes('id: abc'), false);
  assert.equal(stripped.includes('### Archivo'), false);
  assert.equal(stripped.includes('Hello world this is real content.'), true);
});
