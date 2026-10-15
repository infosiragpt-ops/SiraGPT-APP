'use strict';

/**
 * Language, vocabulary and model capabilities of the transcription engine:
 * ISO-639-1 normalisation, auto-detection for long media (the forced «es»
 * used to Spanish-ise English lectures), detect-on-first-segment-then-lock,
 * prompt + key terms on every rung, and the OpenAI model capability map.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audio = require('../src/services/audio-transcriber');

function tempFile(t, name = 'clase.m4a', bytes = 'fake-media') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lang-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function fakeSegments(t, count, seconds = 600) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lang-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
      dir,
      segments: Array.from({ length: count }, (_, i) => {
        const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
        fs.writeFileSync(p, `segment-${i}`);
        return { path: p, index: i, offsetSeconds: i * seconds };
      }),
    };
  };
}

function client(handler) {
  const requests = [];
  return {
    requests,
    audio: { transcriptions: { async create(request, requestOptions) {
      requests.push({ ...request, file: request.file && request.file.name, requestOptions });
      return handler(request, requests.length - 1);
    } } },
  };
}

const createFile = (_buffer, name, mime) => ({ name, mime });

test.beforeEach(() => audio.clearTranscriptionCooldowns());

test('normalizeLanguage maps names, regional tags and ISO-639-2 to ISO-639-1; auto means detect', () => {
  const table = {
    es: 'es', 'es-PE': 'es', es_MX: 'es', ES: 'es', spanish: 'es', Spanish: 'es', español: 'es', castellano: 'es',
    english: 'en', 'en-US': 'en', inglés: 'en', portuguese: 'pt', 'pt-BR': 'pt', spa: 'es', eng: 'en', fre: 'fr',
    galician: 'gl', catalan: 'ca',
  };
  for (const [input, expected] of Object.entries(table)) assert.equal(audio.normalizeLanguage(input), expected, input);
  for (const input of ['auto', 'AUTO', 'detect', 'automático', '', '   ', null, undefined, 'klingon', 'xyz1']) {
    assert.equal(audio.normalizeLanguage(input), undefined, String(input));
  }
});

test('resolveLanguage: explicit wins, long media detects, short clips keep the WHISPER_LANGUAGE hint', () => {
  assert.equal(audio.resolveLanguage({ env: {}, durationSeconds: 30 }), 'es', 'voice notes keep the es default');
  assert.equal(audio.resolveLanguage({ env: {}, durationSeconds: 0 }), 'es', 'unknown length keeps the hint');
  assert.equal(audio.resolveLanguage({ env: {}, durationSeconds: 18000 }), undefined, 'a 5 h lecture is detected');
  assert.equal(audio.resolveLanguage({ env: { WHISPER_LANGUAGE: 'es' }, durationSeconds: 61 }), undefined);
  assert.equal(audio.resolveLanguage({ env: { WHISPER_LANGUAGE: 'spanish' }, durationSeconds: 10 }), 'es');
  assert.equal(audio.resolveLanguage({ env: { WHISPER_LANGUAGE: '' }, durationSeconds: 10 }), undefined);
  assert.equal(audio.resolveLanguage({ env: {}, language: 'es-PE', durationSeconds: 18000 }), 'es', 'explicit beats detection');
  assert.equal(audio.resolveLanguage({ env: { WHISPER_LANGUAGE: 'es' }, language: 'auto', durationSeconds: 5 }), undefined, 'explicit auto beats the hint');
  assert.equal(audio.resolveLanguage({ env: { TRANSCRIBE_AUTO_LANGUAGE_MIN_SECONDS: '7200' }, durationSeconds: 3600 }), 'es');
});

test('a 2-minute clip is no longer forced to Spanish; a 30 s note still is', async (t) => {
  const groq = client(() => ({ text: 'Good morning everyone, welcome back.', language: 'english', segments: [] }));
  const options = { env: { GROQ_API_KEY: 'gsk_lang', WHISPER_LANGUAGE: 'es' }, groqClient: groq, createFile, async localTranscribe() { throw new Error('no local'); } };
  const long = await audio.transcribe(tempFile(t, 'a.m4a'), 'audio/mp4', 'a.m4a', { ...options, durationSeconds: 120 });
  assert.equal(groq.requests[0].language, undefined);
  assert.equal(long.language, 'en', 'verbose_json «english» is reported as ISO-639-1');
  await audio.transcribe(tempFile(t, 'b.ogg'), 'audio/ogg', 'b.ogg', { ...options, durationSeconds: 30 });
  assert.equal(groq.requests[1].language, 'es');
});

test('long media: the first segment detects the language, the rest of the job is locked to it', async (t) => {
  const groq = client((request, n) => ({
    text: `Part ${n + 1} of the lecture.`,
    language: n === 0 ? 'english' : (request.language === 'en' ? 'english' : 'welsh'),
    segments: [{ start: 1, end: 3, text: `Part ${n + 1}` }],
  }));
  const result = await audio.transcribe(tempFile(t), 'audio/mp4', 'clase.m4a', {
    env: { GROQ_API_KEY: 'gsk_lock', WHISPER_LANGUAGE: 'es' }, durationSeconds: 2400,
    groqClient: groq, createFile, segmentAudio: fakeSegments(t, 4),
    async localTranscribe() { throw new Error('no local'); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(groq.requests.map((r) => r.language), [undefined, 'en', 'en', 'en']);
  assert.equal(result.language, 'en');
  assert.deepEqual(result.segments.map((s) => s.start), [1, 601, 1201, 1801]);
});

test('a silent opening does not lock the language; the first segment with speech does', async (t) => {
  const groq = client((request, n) => (n === 0
    ? { text: '[Música]', language: 'english', segments: [] }
    : { text: `Hola, parte ${n + 1}.`, language: request.language ? 'spanish' : 'spanish', segments: [] }));
  const result = await audio.transcribe(tempFile(t), 'audio/mp4', 'clase.m4a', {
    env: { GROQ_API_KEY: 'gsk_silent' }, durationSeconds: 2400,
    groqClient: groq, createFile, segmentAudio: fakeSegments(t, 4),
  });
  assert.deepEqual(groq.requests.map((r) => r.language), [undefined, undefined, 'es', 'es']);
  assert.equal(result.language, 'es');
});

test('a checkpointed part in another language is redone; a matching one is reused', async (t) => {
  const store = new Map([
    [1, { text: 'old english part', segments: [], model: 'whisper-large-v3-turbo', language: 'en' }],
    [2, { text: 'parte dos guardada', segments: [], model: 'whisper-large-v3-turbo', language: 'es' }],
  ]);
  const checkpoint = { async load(index) { return store.get(index) || null; }, async save(index, _meta, part) { store.set(index, part); } };
  const groq = client((_request, n) => ({ text: `nueva parte ${n}`, segments: [] }));
  const result = await audio.transcribe(tempFile(t), 'audio/mp4', 'clase.m4a', {
    env: { GROQ_API_KEY: 'gsk_ckpt' }, language: 'es', durationSeconds: 1800,
    groqClient: groq, createFile, segmentAudio: fakeSegments(t, 3), checkpoint,
  });
  assert.deepEqual(groq.requests.map((r) => r.file), ['segment-1.flac', 'segment-2.flac']);
  assert.match(result.transcript, /nueva parte 0[\s\S]*nueva parte 1[\s\S]*parte dos guardada/);
  assert.equal(store.get(1).language, 'es');
  assert.equal(store.get(1).provider, 'groq', 'every saved part carries its provenance');
  assert.ok(store.get(1).cutPlan, 'and the cut plan it belongs to');
});

test('prompt + key terms reach every cloud request and the local engine', async (t) => {
  assert.equal(audio.resolvePrompt({ env: {}, prompt: 'Clase de Microeconomía.', keyterms: ['Pareto', 'Nash', 'pareto', '  '] }), 'Clase de Microeconomía. Pareto, Nash.');
  assert.equal(audio.resolvePrompt({ env: { WHISPER_PROMPT: 'Acta' }, keyterms: 'UPN; Lima' }), 'Acta UPN, Lima.');
  assert.equal(audio.resolvePrompt({ env: {} }), undefined);
  const capped = audio.resolvePrompt({ env: {}, prompt: 'p'.repeat(2000), keyterms: ['Pareto'] });
  assert.equal(capped.length, 1000);
  assert.ok(capped.endsWith('Pareto.'), 'terms survive at the end (Whisper reads the end of a prompt)');

  const groq = client(() => ({ text: 'transcripción con vocabulario', segments: [] }));
  await audio.transcribe(tempFile(t, 'n.ogg'), 'audio/ogg', 'n.ogg', {
    env: { GROQ_API_KEY: 'gsk_prompt' }, durationSeconds: 20, prompt: 'Clase de Microeconomía.', keyterms: ['Pareto', 'Nash'],
    groqClient: groq, createFile,
  });
  assert.equal(groq.requests[0].prompt, 'Clase de Microeconomía. Pareto, Nash.');
  let localPrompt;
  await audio.transcribe(tempFile(t, 'm.ogg'), 'audio/ogg', 'm.ogg', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, durationSeconds: 20, keyterms: ['Pareto'],
    async localTranscribe(_file, options) { localPrompt = options.prompt; return { text: 'hola' }; },
  });
  assert.equal(localPrompt, 'Pareto.');
});

test('OpenAI capability map: gpt-4o transcribe gets json and 300 s segments; diarize gets diarized_json', async (t) => {
  assert.deepEqual(audio.transcriptionModelCaps('whisper-1').responseFormat, 'verbose_json');
  assert.equal(audio.transcriptionModelCaps('whisper-large-v3-turbo').maxSegmentSeconds, 600);
  const caps = audio.transcriptionModelCaps('gpt-4o-transcribe');
  assert.equal(caps.responseFormat, 'json');
  assert.equal(caps.maxSegmentSeconds, 300);
  assert.equal(audio.transcriptionModelCaps('gpt-4o-mini-transcribe').responseFormat, 'json');
  const diarize = audio.transcriptionModelCaps('gpt-4o-transcribe-diarize');
  assert.equal(diarize.responseFormat, 'diarized_json');
  assert.equal(diarize.chunkingStrategy, 'auto');

  const providers = audio.cloudProviders({ env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_caps', WHISPER_MODEL: 'gpt-4o-transcribe' } });
  assert.equal(audio.effectiveSegmentSeconds({ env: {} }, providers), 300);

  let segmentations = 0;
  const openai = client(() => ({ text: 'parte' }));
  const result = await audio.transcribe(tempFile(t), 'audio/mp4', 'clase.m4a', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_caps', WHISPER_MODEL: 'gpt-4o-transcribe' }, durationSeconds: 400, language: 'es',
    openai, createFile,
    async segmentAudio(...args) { segmentations++; return fakeSegments(t, 2, 300)(...args); },
  });
  assert.equal(segmentations, 1, 'a 400 s file exceeds the model\'s 300 s limit and is cut');
  assert.equal(openai.requests[0].response_format, 'json');
  assert.equal(openai.requests[0].timestamp_granularities, undefined);
  assert.equal(result.ok, true);

  const diarized = client(() => ({ text: 'A: hola. B: buenas.', segments: [{ speaker: 'A', start: 0, end: 1, text: 'hola' }, { speaker: 'B', start: 1, end: 2, text: 'buenas' }] }));
  const out = await audio.transcribe(tempFile(t, 'd.ogg'), 'audio/ogg', 'd.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_diar', WHISPER_MODEL: 'gpt-4o-transcribe-diarize' }, durationSeconds: 20, prompt: 'no admitido',
    openai: diarized, createFile,
  });
  assert.equal(diarized.requests[0].response_format, 'diarized_json');
  assert.equal(diarized.requests[0].chunking_strategy, 'auto');
  assert.equal(diarized.requests[0].prompt, undefined, 'the diarize model rejects prompts');
  assert.deepEqual(out.segments.map((s) => s.speaker), ['A', 'B']);
});
