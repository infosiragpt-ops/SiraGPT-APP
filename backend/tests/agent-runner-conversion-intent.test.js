'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fileConversionTarget } = require('../src/services/agent-runner/conversion-intent');
const { shouldRunAgentRunner, isRunnerOnlyDocumentTurn } = require('../src/services/agent-runner');
const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
const { requestedOfficeFormat } = require('../src/services/agent-runner/format-intent');

const conversions = [
  ['convierte este audio MP3 a MP4', 'audio.mp3', 'mp4'],
  ['extrae el audio de este video como MP3', 'video.mp4', 'mp3'],
  ['convierte el Word a PDF', 'informe.docx', 'pdf'],
  ['pasa el PDF a Word', 'informe.pdf', 'docx'],
  ['cambia el formato del Word a PDF', 'informe.docx', 'pdf'],
  ['convierte esto a PDF', 'informe.docx', 'pdf'],
  ['convert this to MP4', 'audio.mp3', 'mp4'],
];
test('chat conversion requests enter the file runner with original attachments or prior artifacts', () => {
  for (const [text, name, target] of conversions) {
    const files = [{ name }];
    assert.equal(fileConversionTarget(text), target, text);
    assert.equal(shouldRunAgentRunner({ text, files }), true, text);
    assert.equal(shouldRunAgentRunner({ text, fileIds: ['upload'] }), true, text);
    assert.equal(shouldRunAgentRunner({ text, hasPriorArtifacts: true }), true, text);
    assert.equal(shouldUseAgenticChat({ prompt: text, files }), true, text);
    assert.equal(isRunnerOnlyDocumentTurn(text), true, text);
    assert.equal(requestedOfficeFormat(text), target === 'docx' ? 'docx' : null, text);
  }
});
test('conversion routing does not hijack analysis, quoted text, refusals or new media generation', () => {
  for (const text of ['cómo convierto un MP3 a MP4', 'Explica cómo convertir Word a PDF',
    'No conviertas el Word a PDF', 'El documento dice "convierte el PDF a Word"',
    'transcribe el audio', 'crea un video a partir de esta imagen', 'genera una voz que diga hola',
    'crea un MP4 desde una foto']) assert.equal(fileConversionTarget(text), null, text);
  for (const text of ['crea una web para convertir Word a PDF', 'crea una presentación sobre cómo convertir Word a PDF',
    'cambia el título en Word', 'cambia el párrafo en PDF']) assert.equal(fileConversionTarget(text), null, text);
  assert.equal(requestedOfficeFormat('crea una presentación sobre cómo convertir Word a PDF'), 'pptx');
  const codeTask = 'crea una web para convertir Word a PDF';
  assert.equal(shouldRunAgentRunner({ text: codeTask, files: [{ name: 'source.zip' }], hasPriorArtifacts: true }), false);
  assert.equal(isRunnerOnlyDocumentTurn(codeTask), false);
});
