const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transcriber = require('../src/services/audio-transcriber');
const runtime = require('../src/services/rag/operational-runtime');
const documentCollections = require('../src/services/document-collections');

function makePlaceholderText(fileName) {
  // Produce a real placeholder via the public seam: without an OpenAI key,
  // transcribe() short-circuits to generatePlaceholder().
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return transcriber.transcribe(`/tmp/${fileName}`, 'audio/mpeg', fileName)
    .then((result) => {
      process.env.OPENAI_API_KEY = prevKey;
      return result;
    }, (err) => {
      process.env.OPENAI_API_KEY = prevKey;
      throw err;
    });
}

function fakeRag() {
  const calls = { ingest: [] };
  return {
    calls,
    async listSources() {
      return [];
    },
    async ingest(userId, collection, docs, opts) {
      calls.ingest.push({ userId, collection, docs, opts });
      return { chunksAdded: docs.length, totalChunks: docs.length };
    },
    async stats() {
      return { chunks: 0, sources: 0, dim: 1536 };
    },
    getOpenAI() {
      return null;
    },
  };
}

test('transcribe failure blocks are recognized by isPlaceholderText', async () => {
  const result = await makePlaceholderText('grabacion.mp3');
  assert.equal(result.method, 'placeholder');
  assert.equal(result.reasonCode, 'provider_not_configured');
  assert.equal(transcriber.isPlaceholderText(result.text), true);
});

test('no_speech whisper result carries placeholder text and IS detected', async () => {
  const tmpFile = path.join(os.tmpdir(), `siragpt-nospeech-${Date.now()}.mp3`);
  fs.writeFileSync(tmpFile, Buffer.alloc(64));
  try {
    const result = await transcriber.transcribe(tmpFile, 'audio/mpeg', 'silencio.mp3', {
      openai: {
        audio: {
          transcriptions: {
            create: async () => ({ text: '', segments: [] }),
          },
        },
      },
    });
    // The legacy code labels this method:'whisper', so flag-based filtering
    // would miss it — text detection must catch it anyway.
    assert.equal(transcriber.isPlaceholderText(result.text), true);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('real transcripts are NOT flagged as placeholders', () => {
  const realTranscript = 'MP3 Audio transcription — 240 characters, model: whisper-1\n---\n'
    + 'Bienvenidos a la reunión semanal del equipo de producto. '.repeat(5);
  assert.equal(transcriber.isPlaceholderText(realTranscript), false);
});

test('normaliseDocs drops audio placeholder documents', () => {
  const placeholder = [
    'MP3 Audio — grabacion.mp3',
    'Type: audio/mpeg',
    'Status: Transcription not available (provider_error)',
    '',
    'This media file has been uploaded for reference. To enable transcription:',
    '1. Set OPENAI_API_KEY in your environment',
    '2. Ensure the file is under 25 MB',
    '3. Supported formats: mp3, mp4, mpeg, wav, webm, ogg, m4a, mov',
  ].join('\n');

  const docs = runtime.normaliseDocs([
    { id: 'ph', originalName: 'grabacion.mp3', mimeType: 'audio/mpeg', extractedText: placeholder },
    { id: 'ok', originalName: 'notas.txt', mimeType: 'text/plain', extractedText: 'Contenido útil del documento. '.repeat(20) },
  ]);

  assert.equal(docs.length, 1);
  assert.equal(docs[0].source, 'file:ok');
});

test('ensureIndexed refuses to ingest placeholder text passed directly (defense in depth)', async () => {
  const placeholder = [
    'WAV Audio — nota.wav',
    'Type: audio/wav',
    'Status: Transcription not available (file_too_large)',
    '',
    'This media file has been uploaded for reference. To enable transcription:',
    '1. Set OPENAI_API_KEY in your environment',
    '2. Ensure the file is under 25 MB',
    '3. Supported formats: mp3, mp4, mpeg, wav, webm, ogg, m4a, mov',
  ].join('\n');

  const rag = fakeRag();
  const result = await runtime.ensureIndexed({
    rag,
    userId: 'user-1',
    collection: 'default',
    docs: [{
      text: placeholder,
      source: 'file:ph',
      title: 'nota.wav',
      chars: placeholder.length,
      truncated: false,
    }],
  });

  assert.equal(result.indexed, false);
  assert.equal(rag.calls.ingest.length, 0);
});

test('makeChunkRecords returns no chunks for placeholder extractedText', () => {
  const placeholder = [
    'MP4 Video — reunion.mp4',
    'Type: video/mp4',
    'Status: Transcription not available (provider_not_configured)',
    '',
    'This media file has been uploaded for reference. To enable transcription:',
    '1. Set OPENAI_API_KEY in your environment',
    '2. Ensure the file is under 25 MB',
    '3. Supported formats: mp3, mp4, mpeg, wav, webm, ogg, m4a, mov',
  ].join('\n');

  const chunks = documentCollections.makeChunkRecords({
    originalName: 'reunion.mp4',
    mimeType: 'video/mp4',
    extractedText: placeholder,
  });

  assert.deepEqual(chunks, []);
});

test('makeChunkRecords still chunks real extracted text', () => {
  const chunks = documentCollections.makeChunkRecords({
    originalName: 'notas.txt',
    mimeType: 'text/plain',
    extractedText: 'Texto real del documento con contenido sustantivo para indexar. '.repeat(50),
  });
  assert.ok(chunks.length > 0);
});
