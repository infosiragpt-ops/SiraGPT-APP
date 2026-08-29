'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAudioTranscriptionPlaceholder,
  filterAudioPlaceholders,
} = require('../src/services/rag-audio-placeholder-filter');
const runtime = require('../src/services/rag/operational-runtime');
const { generatePlaceholder } = require('../src/services/audio-transcriber');

test('placeholder filter recognizes current Spanish failure blocks', () => {
  const text = generatePlaceholder('nota.ogg', 'Audio OGG', 'audio/ogg', 'local_unavailable');
  assert.equal(isAudioTranscriptionPlaceholder(text), true);
});

test('placeholder filter recognizes legacy English failure blocks', () => {
  const legacy = [
    'OGG Audio — nota.ogg',
    'Type: audio/ogg',
    'Status: Transcription not available (Transcription failed: 401 Incorrect API key provided: sk-proj-TESTKEY)',
    '',
    'This media file has been uploaded for reference. To enable transcription:',
    '1. Set OPENAI_API_KEY in your environment',
    '2. Ensure the file is under 25 MB',
    '3. Supported formats: mp3, mp4, mpeg, wav, webm, ogg, m4a, mov',
  ].join('\n');
  assert.equal(isAudioTranscriptionPlaceholder(legacy), true);
});

test('real transcripts are not treated as placeholders', () => {
  const transcript = 'Hola, te confirmo la reunión de mañana a las diez.\n---\nMensaje de voz.';
  assert.equal(isAudioTranscriptionPlaceholder(transcript), false);
});

test('filterAudioPlaceholders drops failure docs and keeps speech', () => {
  const kept = filterAudioPlaceholders([
    { text: generatePlaceholder('a.ogg', 'Audio OGG', 'audio/ogg', 'provider_error') },
    { text: 'Hola Luis, te dejo el recado sobre el pedido de esta tarde.' },
  ]);
  assert.equal(kept.length, 1);
  assert.match(kept[0].text, /Hola Luis/);
});

test('operational-runtime normaliseDocs excludes audio failure blocks from RAG', () => {
  const docs = runtime.normaliseDocs([
    {
      id: 'voice-fail',
      originalName: 'nota.ogg',
      mimeType: 'audio/ogg',
      extractedText: generatePlaceholder('nota.ogg', 'Audio OGG', 'audio/ogg', 'local_unavailable') + '\n'.repeat(20),
    },
    {
      id: 'voice-ok',
      originalName: 'ok.ogg',
      mimeType: 'audio/ogg',
      extractedText: 'Transcripción local — 80 caracteres, modelo: base, idioma: es\n---\n' + 'Hola, recado útil. '.repeat(12),
    },
  ]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].source, 'file:voice-ok');
  assert.doesNotMatch(JSON.stringify(docs), /sk-proj|OPENAI_API_KEY|Transcription not available/);
});
