'use strict';

// Transcripción profesional (VoiceStudio-inspired) sobre el contrato de
// production-main: ladder openai → meta → local-stt (opt-in) → local-whisper
// → placeholder redactado + salidas SRT/VTT + hablantes. Todo offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const transcriber = require('../src/services/audio-transcriber');
const localStt = require('../src/services/voice-studio-local-stt');
const skill = require('../src/skills/audio_transcribe/handler');

function makeAudioFile(t, bytes = 'fake-audio-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-pro-transcribe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'sample.mp3');
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
}

function cloudMock(captured, text = 'Esta es una transcripcion profesional suficientemente larga.') {
  return {
    audio: {
      transcriptions: {
        async create(request, options) {
          captured.request = request;
          captured.options = options;
          return {
            text,
            segments: [
              { start: 0, end: 2.5, text: 'Esta es una transcripcion' },
              { start: 2.5, end: 5, text: 'profesional suficientemente larga.' },
            ],
          };
        },
      },
    },
  };
}

// ── Formato de timestamps y subtítulos ───────────────────────────────────────

test('formatTimestampSrt usa coma y zero-padding', () => {
  assert.equal(transcriber.formatTimestampSrt(0), '00:00:00,000');
  assert.equal(transcriber.formatTimestampSrt(61.5), '00:01:01,500');
  assert.equal(transcriber.formatTimestampSrt(3661.007), '01:01:01,007');
});

test('formatTimestampVtt usa punto', () => {
  assert.equal(transcriber.formatTimestampVtt(61.5), '00:01:01.500');
});

test('segmentsToSrt numera, temporiza y prefija hablante', () => {
  const srt = transcriber.segmentsToSrt([
    { start: 0, end: 1.5, text: 'Hola', speaker: 'SPEAKER_00' },
    { start: 2, end: 3, text: 'Adiós', speaker: null },
  ]);
  assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:01,500\n[SPEAKER_00] Hola'));
  assert.ok(srt.includes('2\n00:00:02,000 --> 00:00:03,000\nAdiós'));
});

test('segmentsToVtt incluye cabecera WEBVTT y etiquetas <v>', () => {
  const vtt = transcriber.segmentsToVtt([{ start: 0, end: 1, text: 'Hola', speaker: 'SPEAKER_01' }]);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:00.000 --> 00:00:01.000 <v SPEAKER_01>'));
});

test('segments vacíos → SRT/VTT vacíos', () => {
  assert.equal(transcriber.segmentsToSrt([]), '');
  assert.equal(transcriber.segmentsToVtt(null), '');
});

// ── Idiomas ──────────────────────────────────────────────────────────────────

test('normalizeLanguage: alias ES/EN, región e ISO passthrough', () => {
  assert.equal(transcriber.normalizeLanguage('es'), 'es');
  assert.equal(transcriber.normalizeLanguage('es-ES'), 'es');
  assert.equal(transcriber.normalizeLanguage('Español'), 'es');
  assert.equal(transcriber.normalizeLanguage('EN_us'), 'en');
  assert.equal(transcriber.normalizeLanguage('qu'), 'qu');
  assert.equal(transcriber.normalizeLanguage(''), null);
  assert.equal(transcriber.normalizeLanguage(null), null);
  assert.equal(transcriber.normalizeLanguage('español!!!'), null);
});

test('resolveLanguage conserva el default es de prod y normaliza', () => {
  assert.equal(transcriber.resolveLanguage({ env: {} }), 'es');
  assert.equal(transcriber.resolveLanguage({ env: { WHISPER_LANGUAGE: '' } }), undefined);
  assert.equal(transcriber.resolveLanguage({ language: 'es-ES', env: {} }), 'es');
});

// ── Normalización de segmentos ───────────────────────────────────────────────

test('normalizeSegments tolera begin/finish, speaker y words', () => {
  const { segments, words } = transcriber.normalizeSegments(
    [{ begin: 0, finish: 1, text: '  Hola  ', speaker: 'A' }, { text: '   ' }, null],
    [{ begin: 0, finish: 0.5, word: 'Hola' }],
  );
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], { id: 0, start: 0, end: 1, text: 'Hola', speaker: 'A' });
  assert.equal(words.length, 1);
  assert.equal(words[0].text, 'Hola');
});

// ── Catálogo de formatos ─────────────────────────────────────────────────────

test('AUDIO_MIME_MAP cubre formatos modernos + fallback por extensión', () => {
  for (const mime of ['audio/flac', 'audio/aac', 'audio/aiff', 'audio/amr', 'video/x-matroska', 'video/x-msvideo', 'video/ogg', 'audio/opus', 'audio/m4a']) {
    assert.ok(transcriber.AUDIO_MIME_MAP[mime], `falta ${mime}`);
  }
  assert.equal(transcriber.normalizeAudioMime('application/octet-stream', 'nota.aac'), 'audio/aac');
  assert.equal(transcriber.normalizeAudioMime('application/octet-stream', 'clip.mkv'), 'video/x-matroska');
});

// ── Ladder prod intacto por defecto (hermético, sin rung HTTP) ───────────────

test('fetch inyectado es opt-in: se intenta una vez y cae al motor local', async (t) => {
  const filePath = makeAudioFile(t);
  let fetches = 0;
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'sample.wav', {
    env: {},
    language: 'es',
    localFetch: async () => { fetches += 1; throw Object.assign(new Error('endpoint caído'), { code: 'LOCAL_STT_UNREACHABLE' }); },
    localTranscribe: async () => ({
      text: 'Texto del motor local embebido suficientemente largo.',
      model: 'base',
      language: 'es',
      segments: [],
    }),
  });
  assert.equal(fetches, 1);
  assert.equal(result.method, 'local-whisper');
  assert.equal(result.provider, 'local-whisper');
  assert.ok(result.transcript.includes('motor local embebido'));
});

test('sin opt-in y sin fetch inyectado no hay intento HTTP', async (t) => {
  const filePath = makeAudioFile(t);
  const captured = {};
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'sample.wav', {
    env: {},
    createFile: (buffer, name, mime) => ({ size: buffer.length, name, type: mime }),
    openai: cloudMock(captured),
  });
  assert.equal(result.method, 'whisper');
  assert.equal(transcriber.localSttEnabled({ env: {} }), false);
});

// ── Rung local-stt opt-in ────────────────────────────────────────────────────

test('local-stt opt-in por env: sin claves cloud usa el endpoint y devuelve SRT/VTT', async (t) => {
  const filePath = makeAudioFile(t);
  const result = await transcriber.transcribe(filePath, 'audio/mpeg', 'charla.mp3', {
    env: { SIRAGPT_LOCAL_STT_ENABLED: '1' },
    localStt: async () => ({
      text: 'Charla profesional sobre ingeniería de audio en local.',
      language: 'es',
      segments: [{ start: 0, end: 3.2, text: 'Charla profesional sobre ingeniería de audio en local.' }],
    }),
  });
  assert.equal(result.method, 'local-stt');
  assert.equal(result.provider, 'local-stt');
  assert.ok(transcriber.SUCCESS_METHODS.has('local-stt'));
  assert.ok(result.text.startsWith('Transcripción local'));
  assert.ok(result.transcript.includes('ingeniería'));
  assert.ok(result.srt.includes('-->'));
  assert.ok(result.vtt.startsWith('WEBVTT'));
  assert.equal(result.segments.length, 1);
});

test('orden prod intacto: cloud sano gana aunque el rung local esté habilitado', async (t) => {
  const filePath = makeAudioFile(t);
  const captured = {};
  let sttCalls = 0;
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'sample.wav', {
    env: { SIRAGPT_LOCAL_STT_ENABLED: '1' },
    createFile: (buffer, name, mime) => ({ size: buffer.length, name, type: mime }),
    openai: cloudMock(captured),
    localStt: async () => { sttCalls += 1; throw new Error('no debe llamarse con cloud sano'); },
  });
  assert.equal(sttCalls, 0);
  assert.equal(result.method, 'whisper');
  assert.equal(result.segments.length, 2);
  assert.ok(result.srt.includes('-->'));
  assert.ok(result.vtt.startsWith('WEBVTT'));
});
test('TRANSCRIBE_PROVIDERS=local-stt,local: cae al motor binario si el endpoint falla', async (t) => {
  const filePath = makeAudioFile(t);
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'nota.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local-stt,local' },
    localStt: async () => { throw Object.assign(new Error('conn refused'), { code: 'LOCAL_STT_UNREACHABLE' }); },
    localTranscribe: async () => ({
      text: 'Nota transcrita por el motor local embebido sin problema.',
      model: 'base',
      language: 'es',
      segments: [{ start: 0, end: 2, text: 'Nota transcrita' }],
    }),
  });
  assert.equal(result.method, 'local-whisper');
  assert.equal(result.provider, 'local-whisper');
});

test('solo local-stt con endpoint caído → placeholder local_unavailable', async (t) => {
  const filePath = makeAudioFile(t);
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'nota.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local-stt' },
    localStt: async () => { throw Object.assign(new Error('down'), { code: 'LOCAL_STT_UNREACHABLE' }); },
  });
  assert.equal(result.method, 'placeholder');
  assert.equal(result.reasonCode, 'local_unavailable');
});

// ── Diarización ──────────────────────────────────────────────────────────────

test('hablantes agregados, flag diarized y duración', async (t) => {
  const filePath = makeAudioFile(t);
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'reunion.wav', {
    env: { SIRAGPT_LOCAL_STT_ENABLED: '1' },
    diarize: true,
    localStt: async () => ({
      text: 'Acta de reunión con dos voces participando activamente.',
      segments: [
        { start: 0, end: 2, text: 'Acta de reunión', speaker: 'SPEAKER_00' },
        { start: 2, end: 4, text: 'con dos voces', speaker: 'SPEAKER_01' },
      ],
    }),
  });
  assert.deepEqual(result.speakers, ['SPEAKER_00', 'SPEAKER_01']);
  assert.equal(result.speakerCount, 2);
  assert.equal(result.diarized, true);
  assert.equal(result.durationMs, 4000);
  assert.ok(result.srt.includes('[SPEAKER_00]'));
});

// ── Placeholder redactado (contrato prod) ────────────────────────────────────

test('error de clave inválida nunca fuga la key al placeholder', async (t) => {
  const filePath = makeAudioFile(t);
  const badClient = {
    audio: {
      transcriptions: {
        async create() {
          const err = new Error('Incorrect API key provided: sk-secreta12345. OPENAI_API_KEY bad');
          err.status = 401;
          throw err;
        },
      },
    },
  };
  const result = await transcriber.transcribe(filePath, 'audio/wav', 'x.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'openai' },
    openai: badClient,
    createFile: (buffer, name, mime) => ({ size: buffer.length, name, type: mime }),
  });
  assert.equal(result.method, 'placeholder');
  assert.ok(!result.text.includes('sk-secreta12345'), 'la key no debe fugarse');
  assert.ok(!result.text.includes('Incorrect API key'), 'sin texto crudo del proveedor');
});

// ── localSttEnabled ──────────────────────────────────────────────────────────

test('localSttEnabled: solo opt-in explícito', () => {
  assert.equal(transcriber.localSttEnabled({ env: {} }), false);
  assert.equal(transcriber.localSttEnabled({ env: { SIRAGPT_LOCAL_STT_ENABLED: '1' } }), true);
  assert.equal(transcriber.localSttEnabled({ env: { SIRAGPT_LOCAL_STT_ENABLED: '0' } }), false);
  assert.equal(transcriber.localSttEnabled({ env: { TRANSCRIBE_PROVIDERS: 'openai,local-stt,local' } }), true);
  assert.equal(transcriber.localSttEnabled({ env: {}, localFetch: async () => ({}) }), true);
});

// ── Cliente local OpenAI-compatible ──────────────────────────────────────────

test('voice-studio-local-stt: config y mapeo de respuestas', async () => {
  const cfg = localStt.getConfig({});
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.url.includes('3900/v1/audio/transcriptions'));
  assert.equal(localStt.getConfig({ SIRAGPT_LOCAL_STT_ENABLED: '0' }).enabled, false);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ text: 'Audio local transcrito correctamente ya.', segments: [] }),
    };
  };
  const payload = await localStt.transcribeViaLocalStt(Buffer.from('wav'), 'a.wav', 'audio/wav', {
    language: 'es',
    fetchImpl,
    url: 'http://127.0.0.1:9/v1/audio/transcriptions',
  });
  assert.ok(payload.text.includes('transcrito'));
  assert.ok(String(calls[0].url).includes('127.0.0.1'));

  const failing = async () => ({ ok: false, status: 404, headers: { get: () => '' } });
  await assert.rejects(
    localStt.transcribeViaLocalStt(Buffer.from('x'), 'a.wav', 'audio/wav', { fetchImpl: failing, url: 'http://x/' }),
    (err) => err.code === 'LOCAL_STT_NOT_FOUND',
  );

  const srtFetch = async () => ({
    ok: true,
    headers: { get: () => 'application/x-subrip' },
    text: async () => '1\n00:00:00,000 --> 00:00:01,000\nHola\n',
  });
  const srtPayload = await localStt.transcribeViaLocalStt(Buffer.from('x'), 'a.wav', 'audio/wav', { fetchImpl: srtFetch, url: 'http://x/' });
  assert.equal(srtPayload._rawFormat, 'srt');
});

// ── Skill audio_transcribe: formatos ─────────────────────────────────────────

test('skill normalizeFormat/buildFormatPayload cubren txt/srt/vtt/json', () => {
  assert.equal(skill.normalizeFormat('VTT'), 'vtt');
  assert.equal(skill.normalizeFormat('subrip'), 'srt');
  assert.equal(skill.normalizeFormat('verbose_json'), 'json');
  assert.equal(skill.normalizeFormat('raro'), 'txt');
  const fake = {
    transcript: 'Hola mundo profesional',
    srt: 'SRT-DATA',
    vtt: 'VTT-DATA',
    segments: [{ start: 0, end: 1, text: 'Hola' }],
    words: [],
    speakers: ['SPEAKER_00'],
    speakerCount: 1,
    durationMs: 1000,
    model: 'whisper-1',
    provider: 'local-stt',
    language: 'es',
  };
  assert.equal(skill.buildFormatPayload(fake, 'srt'), 'SRT-DATA');
  assert.equal(skill.buildFormatPayload(fake, 'vtt'), 'VTT-DATA');
  assert.equal(skill.buildFormatPayload(fake, 'txt'), 'Hola mundo profesional');
  const parsed = JSON.parse(skill.buildFormatPayload(fake, 'json'));
  assert.equal(parsed.provider, 'local-stt');
  assert.equal(parsed.segments.length, 1);
});

test('skill acepta local-stt como éxito y guarda SRT', async () => {
  let saved = null;
  const result = await skill.execute({ format: 'srt', saveTranscript: true, language: 'es' }, {
    userId: 'user-a',
    mediaRuntime: {
      async resolveOwnedMediaSource() {
        return {
          localPath: '/private/reunion.mp3',
          source: { fileId: 'f-1', filename: 'reunion.mp3', mimeType: 'audio/mpeg' },
          cleanup: async () => {},
        };
      },
    },
    audioTranscriber: {
      AUDIO_MAX_FILE_BYTES: 100,
      async transcribe() {
        return {
          method: 'local-stt',
          provider: 'local-stt',
          transcript: 'Transcripcion de reunion suficientemente larga.',
          segments: [{ start: 0, end: 2, text: 'Transcripcion de reunion' }],
          words: [],
          srt: '1\n00:00:00,000 --> 00:00:02,000\nTranscripcion\n',
          vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nTranscripcion\n',
          speakers: [],
          speakerCount: 0,
          durationMs: 2000,
          model: 'local-stt',
          language: 'es',
        };
      },
    },
    saveArtifact(input) {
      saved = input;
      return { id: 'a-1', filename: input.filename, mime: input.mime };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'local-stt');
  assert.equal(result.format, 'srt');
  assert.ok(saved.filename.endsWith('.srt'));
});

test('skill degrada a texto si el SRT saldría vacío', async () => {
  let saved = null;
  const result = await skill.execute({ format: 'srt', saveTranscript: true }, {
    userId: 'user-a',
    mediaRuntime: {
      async resolveOwnedMediaSource() {
        return {
          localPath: '/private/a.wav',
          source: { fileId: 'f-1', filename: 'a.wav', mimeType: 'audio/wav' },
          cleanup: async () => {},
        };
      },
    },
    audioTranscriber: {
      AUDIO_MAX_FILE_BYTES: 100,
      async transcribe() {
        return {
          method: 'whisper',
          transcript: 'Texto sin segmentos pero suficientemente largo.',
          segments: [],
          model: 'whisper-1',
          language: 'es',
        };
      },
    },
    saveArtifact(input) { saved = input; return { id: 'a-1' }; },
    onEvent() {},
  });
  assert.equal(result.ok, true);
  assert.ok(saved.filename.endsWith('.srt'));
});
