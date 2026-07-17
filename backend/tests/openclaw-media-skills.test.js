'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const frameSkill = require('../src/skills/video_frames/handler');
const spectrogramSkill = require('../src/skills/audio_spectrogram/handler');
const transcribeSkill = require('../src/skills/audio_transcribe/handler');
const audioTranscriber = require('../src/services/audio-transcriber');

function artifactContext(events) {
  let serial = 0;
  return {
    userId: 'user-a',
    chatId: 'chat-a',
    onEvent(event) { events.push(event); },
    saveArtifact(input) {
      serial += 1;
      const buffer = Buffer.from(input.base64, 'base64');
      return {
        id: `artifact-${serial}`,
        filename: input.filename,
        format: path.extname(input.filename).slice(1),
        mime: input.mime,
        sizeBytes: buffer.length,
        category: input.category || null,
        downloadUrl: `/api/agent/artifact/artifact-${serial}`,
      };
    },
  };
}

test('video frame skill saves every frame and emits downloadable artifacts', async () => {
  const events = [];
  const ctx = {
    ...artifactContext(events),
    mediaRuntime: {
      async extractVideoFrames() {
        return {
          source: { fileId: 'video-1', filename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 100 },
          media: { durationSeconds: 4, video: { codec: 'h264', width: 640, height: 360 }, audio: null },
          frames: [
            { filename: 'clip-frame-1.jpg', mime: 'image/jpeg', timestampSeconds: 1, buffer: Buffer.from('frame-one') },
            { filename: 'clip-frame-2.jpg', mime: 'image/jpeg', timestampSeconds: 3, buffer: Buffer.from('frame-two') },
          ],
        };
      },
    },
  };
  const result = await frameSkill.execute({ count: 2 }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.frames.map((item) => item.timestampSeconds), [1, 3]);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.type === 'file_artifact'));
  assert.ok(events.every((event) => event.artifact.kind === 'video_frame'));
});

test('spectrogram skill emits one image tied to its source file', async () => {
  const events = [];
  const ctx = {
    ...artifactContext(events),
    mediaRuntime: {
      async createAudioSpectrogram() {
        return {
          source: { fileId: 'audio-1', filename: 'voice.wav', mimeType: 'audio/wav', sizeBytes: 50 },
          media: { durationSeconds: 8, video: null, audio: { codec: 'pcm_s16le' } },
          spectrogram: {
            filename: 'voice-spectrogram.png',
            mime: 'image/png',
            startSeconds: 0,
            durationSeconds: 8,
            style: 'magma',
            buffer: Buffer.from('png-image'),
          },
        };
      },
    },
  };
  const result = await spectrogramSkill.execute({}, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.spectrogram.kind, 'audio_spectrogram');
  assert.equal(result.spectrogram.sourceFileId, 'audio-1');
  assert.equal(events[0].artifact.mime, 'image/png');
});

test('transcription skill uses owner-resolved media, cleans it, and can save TXT', async () => {
  const events = [];
  let cleanupCalls = 0;
  let request;
  let providerOptions;
  const ctx = {
    ...artifactContext(events),
    mediaRuntime: {
      async resolveOwnedMediaSource(options) {
        request = options;
        return {
          localPath: '/private/materialized.wav',
          source: { fileId: 'audio-1', filename: 'voice.wav', mimeType: 'audio/wav', sizeBytes: 100 },
          cleanup: async () => { cleanupCalls += 1; },
        };
      },
    },
    audioTranscriber: {
      AUDIO_MAX_FILE_BYTES: 1234,
      async transcribe(filePath, mimeType, filename, options) {
        providerOptions = options;
        assert.equal(filePath, '/private/materialized.wav');
        assert.equal(mimeType, 'audio/wav');
        assert.equal(filename, 'voice.wav');
        assert.equal(options.language, 'es');
        return {
          method: 'whisper',
          transcript: 'Hola, esta es una transcripcion profesional.',
          segments: [{ start: 0, end: 2, text: 'Hola' }],
          model: 'whisper-1',
          language: 'es',
        };
      },
    },
  };
  const result = await transcribeSkill.execute({ language: 'es', saveTranscript: true }, ctx);
  assert.deepEqual(request, { fileId: undefined, allowedKinds: ['audio', 'video'], maxSourceBytes: 1234 });
  assert.equal(cleanupCalls, 1);
  assert.equal(providerOptions.openai, undefined);
  assert.equal(result.transcript, 'Hola, esta es una transcripcion profesional.');
  assert.equal(result.artifact.kind, 'transcript');
  assert.equal(events[0].artifact.filename, 'voice-transcript.txt');
});

test('transcription skill forwards an audio-capable provider client', async () => {
  const audioClient = { audio: { transcriptions: { create: async () => ({}) } } };
  let forwarded;
  const result = await transcribeSkill.execute({}, {
    userId: 'user-a',
    openai: audioClient,
    mediaRuntime: {
      async resolveOwnedMediaSource() {
        return {
          localPath: '/private/audio.wav',
          source: { fileId: 'audio-1', filename: 'audio.wav', mimeType: 'audio/wav' },
          cleanup: async () => {},
        };
      },
    },
    audioTranscriber: {
      AUDIO_MAX_FILE_BYTES: 100,
      async transcribe(_filePath, _mimeType, _filename, options) {
        forwarded = options.openai;
        return { method: 'whisper', transcript: 'Audio provider routing works.' };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(forwarded, audioClient);
});

test('transcription skill never reports placeholder output as success and still cleans up', async () => {
  let cleanupCalls = 0;
  await assert.rejects(
    transcribeSkill.execute({}, {
      userId: 'user-a',
      mediaRuntime: {
        async resolveOwnedMediaSource() {
          return {
            localPath: '/private/audio.wav',
            source: { fileId: 'audio-1', filename: 'audio.wav', mimeType: 'audio/wav' },
            cleanup: async () => { cleanupCalls += 1; },
          };
        },
      },
      audioTranscriber: {
        AUDIO_MAX_FILE_BYTES: 100,
        async transcribe() { return { method: 'placeholder', reasonCode: 'provider_error' }; },
      },
    }),
    (error) => error.code === 'AUDIO_TRANSCRIPTION_UNAVAILABLE',
  );
  assert.equal(cleanupCalls, 1);
});

test('audio transcriber provider seam preserves language, prompt, segments, and raw transcript', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-transcriber-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'sample.wav');
  fs.writeFileSync(filePath, Buffer.from('fake-wave'));
  let providerRequest;
  let providerOptions;
  const signal = new AbortController().signal;
  const result = await audioTranscriber.transcribe(filePath, 'audio/wav', 'sample.wav', {
    language: 'es',
    prompt: 'SiraGPT vocabulary',
    signal,
    createFile(buffer, name, mime) {
      return { size: buffer.length, name, type: mime };
    },
    openai: {
      audio: {
        transcriptions: {
          async create(request, options) {
            providerRequest = request;
            providerOptions = options;
            return {
              text: 'Esta transcripcion contiene suficiente texto.',
              segments: [{ start: 0, end: 1.5, text: 'Esta transcripcion' }],
            };
          },
        },
      },
    },
  });
  assert.equal(providerRequest.language, 'es');
  assert.equal(providerRequest.prompt, 'SiraGPT vocabulary');
  assert.equal(providerRequest.file.name, 'sample.wav');
  assert.equal(providerOptions.signal, signal);
  assert.equal(result.method, 'whisper');
  assert.equal(result.transcript, 'Esta transcripcion contiene suficiente texto.');
  assert.equal(result.segments.length, 1);
});
