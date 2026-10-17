'use strict';

/**
 * The transcriber's quality loop (contract C4, quality half), end to end with
 * fakes for every binary and provider:
 *   - «no speech» needs a second opinion that agrees (short clips always;
 *     segmented pieces when they carry speech energy);
 *   - flagged pieces get alternative hypotheses (next rung, opt-in escalation
 *     rung, or the same rung on an enhanced copy), chosen by agreement;
 *   - rungs revive after a pause; the last rung backs off instead of dying;
 *   - refine (range + forceRetranscribe) redoes only the overlapping pieces;
 *   - result.quality is the honest report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const audio = require('../src/services/audio-transcriber');
const format = require('../src/services/media-transcript-format');

const SENTENCES = [
  'La oferta agregada depende de los costos de producción y de la tecnología disponible.',
  'Cuando sube la tasa de interés, la inversión privada suele disminuir en el corto plazo.',
  'El banco central publicó su informe trimestral con nuevas proyecciones de inflación.',
  'Los estudiantes deben entregar el ensayo final antes del viernes por la tarde.',
  'En Ayacucho se celebró una feria agrícola con productores de quinua y papa nativa.',
  'La profesora pidió revisar el capítulo cuatro sobre externalidades y bienes públicos.',
  'Un aumento del salario mínimo puede afectar el empleo formal de los jóvenes.',
  'El tipo de cambio se mantuvo estable gracias a las intervenciones del regulador.',
  'Las exportaciones mineras crecieron por la mejora en los precios internacionales del cobre.',
  'Para el examen parcial entra todo lo visto desde la primera semana de clases.',
];
/** Varied prose for piece `i` (≈ 870 chars: dense enough for a 10-min piece). */
const prose = (i = 0) => SENTENCES.map((s, k) => `${s} [${i}.${k}]`).join(' ');

function tempDir(t, prefix = 'sira-qloop-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempFile(t, name) {
  const file = path.join(tempDir(t), name);
  fs.writeFileSync(file, 'fake-media');
  return file;
}

function segmenter(t, count, seconds = 600) {
  const fn = async () => {
    fn.calls++;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-qloop-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
      dir,
      segments: Array.from({ length: count }, (_, i) => {
        const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
        fs.writeFileSync(p, `segment-${i}`);
        return { path: p, index: i, offsetSeconds: i * seconds, durationSeconds: seconds };
      }),
    };
  };
  fn.calls = 0;
  return fn;
}

/** options.transcodeClip fake: a FLAC-looking master in its own dir. */
function fakeMaster(t, durationSeconds = 20) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-qloop-master-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'audio.flac');
    fs.writeFileSync(out, 'fLaC-master');
    return { ok: true, path: out, dir, size: 11, durationSeconds, tolerant: false, decodeCause: null, streamDropped: false };
  };
}

const pieceOf = (name) => {
  const m = /segment-(\d+)/.exec(String(name));
  return m ? Number(m[1]) - 1 : -1;
};
const createFile = (buffer, name, mime) => ({ name, mime, body: Buffer.from(buffer).toString('utf8') });

function sdk(handler) {
  const requests = [];
  return {
    requests,
    audio: { transcriptions: { async create(request) {
      const index = pieceOf(request.file.name);
      requests.push({ index, name: request.file.name, body: request.file.body, language: request.language, prompt: request.prompt });
      return handler(index, request, requests.length - 1);
    } } },
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const noLocal = async () => { throw new Error('local must not run'); };
const noSleep = () => {
  const fn = async (ms) => { fn.sleeps.push(ms); };
  fn.sleeps = [];
  return fn;
};
const clip = (t, extra = {}) => ({ durationSeconds: 20, transcodeClip: fakeMaster(t), createFile, ffmpegFilters: [], ...extra });
const long = (t, count, extra = {}) => ({ durationSeconds: count * 600, segmentAudio: segmenter(t, count), createFile, ffmpegFilters: [], parallel: 1, ...extra });

test.beforeEach(() => audio.clearTranscriptionCooldowns());

// ── no_speech needs a second opinion (short clips) ─────────────────────────

test('short clip: the first rung hears music, the next one hears the voice note — the voice wins (no first-answer no_speech)', async (t) => {
  const openai = sdk(() => ({ text: '[Música]', segments: [] }));
  const groq = sdk(() => ({ text: 'Hola mamá, ya llegué a la casa.', segments: [{ start: 0.5, end: 3, text: 'Hola mamá, ya llegué a la casa.' }] }));
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q1', GROQ_API_KEY: 'gsk_q1' }, openai, groqClient: groq, localTranscribe: noLocal, ...clip(t),
  });
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'Hola mamá, ya llegué a la casa.');
  assert.deepEqual(result.providers, { groq: 1 });
  assert.equal(openai.requests.length, 1);
  assert.equal(groq.requests.length, 1);
  assert.equal(groq.requests[0].name, 'audio.flac', 'the second opinion reads the same FLAC master');
  assert.equal(result.quality.escalations, 1);
  assert.ok(result.quality.notes.some((n) => /Revisé 1 tramo dudoso/.test(n)));
});

test('short clip: two engines agree there is no voice → no_speech, and nothing more is asked', async (t) => {
  const openai = sdk(() => ({ text: '[BLANK_AUDIO]', segments: [] }));
  const groq = sdk(() => ({ text: '', segments: [] }));
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q2', GROQ_API_KEY: 'gsk_q2' }, openai, groqClient: groq, localTranscribe: noLocal, ...clip(t),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'no_speech');
  assert.equal(openai.requests.length + groq.requests.length, 2, 'one second opinion, then stop');
});

test('short clip: an engine sign-off over silence («Gracias por ver el video») is not a transcript', async (t) => {
  const run = (second) => audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q3', GROQ_API_KEY: 'gsk_q3' },
    openai: sdk(() => ({ text: 'Gracias por ver el video.', segments: [] })),
    groqClient: sdk(() => second), localTranscribe: noLocal, ...clip(t),
  });
  const silent = await run({ text: '', segments: [] });
  assert.equal(silent.reasonCode, 'no_speech');
  const spoken = await run({ text: 'Profe, mañana no podré ir a la clase.', segments: [] });
  assert.equal(spoken.ok, true);
  assert.equal(spoken.transcript, 'Profe, mañana no podré ir a la clase.');
});

test('short clip with one engine: the second opinion is the same engine on a loudness-normalised copy', async (t) => {
  const calls = [];
  const result = await audio.transcribe(tempFile(t, 'nota.wav'), 'audio/wav', 'nota.wav', {
    env: {}, durationSeconds: 25, ffmpegFilters: ['highpass', 'dynaudnorm', 'loudnorm'],
    async localTranscribe(_p, options) {
      calls.push(options.audioFilter || null);
      return options.audioFilter ? { text: 'Te llamo cuando salga del trabajo.', model: 'ggml-base.bin' } : { text: '' };
    },
  });
  assert.deepEqual(calls.map((f) => (f ? /dynaudnorm/.test(f) : null)), [null, true], 'clean decode first, enhanced copy second');
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'Te llamo cuando salga del trabajo.');
  assert.equal(result.method, 'local-whisper');
  assert.equal(result.quality.escalations, 1);
});

test('short clip: a decoder loop is re-decoded without text context (-mc 0), a wide beam and no prompt', async (t) => {
  const loop = Array.from({ length: 40 }, () => 'y entonces el profesor dijo que').join(' ');
  const calls = [];
  const result = await audio.transcribe(tempFile(t, 'nota.wav'), 'audio/wav', 'nota.wav', {
    env: {}, durationSeconds: 60, keyterms: ['Microeconomía'], ffmpegFilters: [],
    async localTranscribe(_p, options) {
      calls.push({ maxContext: options.maxContext, beamSize: options.beamSize, prompt: options.prompt });
      return calls.length === 1 ? { text: loop } : { text: prose(1) };
    },
  });
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].prompt), /Microeconomía/);
  assert.deepEqual(calls[1], { maxContext: 0, beamSize: 5, prompt: undefined });
  assert.equal(result.transcript, prose(1));
  assert.ok(!result.quality.lowConfidence.some((s) => s.reason === 'loop'));
});

test('kill switch: TRANSCRIBE_QUALITY_LOOP=0 restores first-answer-wins', async (t) => {
  const groq = sdk(() => ({ text: 'Hola', segments: [] }));
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q4', GROQ_API_KEY: 'gsk_q4', TRANSCRIBE_QUALITY_LOOP: '0' },
    openai: sdk(() => ({ text: '[Música]', segments: [] })), groqClient: groq, localTranscribe: noLocal, ...clip(t),
  });
  assert.equal(result.reasonCode, 'no_speech');
  assert.equal(groq.requests.length, 0);
});

test('short clip: second opinions that all fail are not agreement — retried later, never first-answer no_speech', async (t) => {
  const openai = sdk(() => ({ text: '', segments: [] }));
  const groq = sdk(() => { throw httpError(503, 'Service Unavailable'); });
  const sleep = noSleep();
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q20', GROQ_API_KEY: 'gsk_q20' }, openai, groqClient: groq, sleep,
    async localTranscribe() { throw Object.assign(new Error('whisper timed out'), { code: 'LOCAL_WHISPER_TIMEOUT' }); },
    ...clip(t),
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.reasonCode, 'no_speech');
  assert.equal(result.reasonCode, 'local_unavailable', 'a transient code: the queue tries the clip again');
  assert.equal(openai.requests.length, 1);
  assert.equal(groq.requests.length, 2, 'a cloud blip on a second opinion gets ONE more try');
  assert.ok(sleep.sleeps.includes(2000));

  // The retried second opinion answers: it decides (here, agreement on silence).
  let calls = 0;
  const flaky = sdk(() => { calls++; if (calls === 1) throw httpError(502, 'Bad Gateway'); return { text: '', segments: [] }; });
  const agreed = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q21', GROQ_API_KEY: 'gsk_q21' }, openai: sdk(() => ({ text: '', segments: [] })),
    groqClient: flaky, sleep: noSleep(), localTranscribe: noLocal, ...clip(t),
  });
  assert.equal(agreed.reasonCode, 'no_speech');
  assert.equal(flaky.requests.length, 2);

  // No second opinion possible at all (one engine, no enhanced copy): today's behaviour.
  const single = await audio.transcribe(tempFile(t, 'nota.wav'), 'audio/wav', 'nota.wav', {
    env: {}, durationSeconds: 25, ffmpegFilters: [], localTranscribe: async () => ({ text: '' }),
  });
  assert.equal(single.reasonCode, 'no_speech');
});

test('short clip without the master: the enhanced copy a cloud rung reads is uploaded under the FLAC name it was built with', async (t) => {
  // The master failed host-side (a timeout under load): the original «nota.ogg» goes up.
  const groq = sdk((_i, request) => (request.file.body === 'enhanced'
    ? { text: 'Profe, mañana no podré ir a la clase.', segments: [] }
    : { text: '', segments: [] }));
  const spawnImpl = (_bin, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => { fs.writeFileSync(args.at(-1), 'enhanced'); child.emit('close', 0); });
    return child;
  };
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { GROQ_API_KEY: 'gsk_q30', TRANSCRIBE_PROVIDERS: 'groq' }, groqClient: groq, ...clip(t),
    transcodeClip: async () => ({ ok: false, code: 'timeout', dir: null }),
    ffmpegFilters: ['highpass', 'dynaudnorm'], spawnImpl,
  });
  assert.deepEqual(groq.requests.map((r) => r.name), ['nota.ogg', 'audio.flac'],
    'FLAC bytes never travel under the .ogg name (OpenAI / Groq read the format from it)');
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'Profe, mañana no podré ir a la clase.');
});

test('dictation ladder «local,voicestudio»: whisper.cpp reads first; Sira Voz only as its fallback or second opinion, within its own budget', async (t) => {
  const run = async ({ providers = ['local', 'voicestudio'], local, vs }) => {
    const order = [];
    const vsCalls = [];
    let masters = 0;
    const master = fakeMaster(t);
    const voiceStudio = {
      isConfigured: () => true,
      async transcribe(args, opts) {
        order.push('voicestudio');
        vsCalls.push({ filename: args.filename, timeoutMs: opts.timeoutMs });
        if (vs instanceof Error) throw vs;
        return vs;
      },
    };
    const result = await audio.transcribe(tempFile(t, 'dictation.webm'), 'audio/webm', 'dictation.webm', {
      env: {}, providers, voiceStudio, voiceStudioTimeoutMs: 15000, ...clip(t),
      transcodeClip: async (...args) => { masters++; return master(...args); },
      async localTranscribe(_p, options) {
        order.push('local');
        assert.equal(options.timeoutMs, undefined, 'Sira Voz\'s budget is not whisper.cpp\'s');
        if (local instanceof Error) throw local;
        return local;
      },
    });
    return { result, order, vsCalls, masters };
  };
  const spoken = { text: 'Hola, te escribo desde el celular.', model: 'ggml-base.bin' };
  const heard = { text: 'Necesito el informe para mañana temprano.', segments: [] };

  // whisper.cpp answers: Sira Voz is never asked, and no master is built for it.
  const fast = await run({ local: spoken, vs: heard });
  assert.deepEqual(fast.order, ['local']);
  assert.equal(fast.masters, 0);
  assert.equal(fast.result.transcript, 'Hola, te escribo desde el celular.');

  // whisper.cpp heard nothing: Sira Voz is the second opinion, within its own budget.
  const empty = await run({ local: { text: '', model: 'ggml-base.bin' }, vs: heard });
  assert.deepEqual(empty.order, ['local', 'voicestudio']);
  assert.deepEqual(empty.vsCalls, [{ filename: 'dictation.webm', timeoutMs: 15000 }]);
  assert.equal(empty.result.transcript, 'Necesito el informe para mañana temprano.');
  assert.deepEqual(empty.result.providers, { voicestudio: 1 });

  // whisper.cpp could not run: Sira Voz is the next rung.
  const crashed = await run({ local: Object.assign(new Error('crash'), { code: 'LOCAL_WHISPER_FAILED' }), vs: heard });
  assert.deepEqual(crashed.order, ['local', 'voicestudio']);
  assert.equal(crashed.result.ok, true);
  assert.equal(crashed.result.transcript, 'Necesito el informe para mañana temprano.');

  // Listed first, Sira Voz still goes first (on the FLAC master).
  const vsFirst = await run({ providers: ['voicestudio', 'local'], local: spoken, vs: heard });
  assert.deepEqual(vsFirst.order, ['voicestudio']);
  assert.equal(vsFirst.masters, 1);
  assert.equal(vsFirst.vsCalls[0].filename, 'audio.flac');
});

test('short clip: a multi-word music annotation («[Música de fondo]») is not a transcript — it gets a second opinion', async (t) => {
  for (const annotation of ['[Música de fondo]', '(música suave)', '[Music playing]', '(upbeat music)', '[♪]']) {
    const silent = sdk(() => ({ text: '', segments: [] }));
    const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
      env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q22', GROQ_API_KEY: 'gsk_q22' },
      openai: sdk(() => ({ text: annotation, segments: [{ start: 0, end: 20, text: annotation }] })),
      groqClient: silent, localTranscribe: noLocal, ...clip(t),
    });
    assert.equal(result.reasonCode, 'no_speech', annotation);
    assert.equal(silent.requests.length, 1, `${annotation}: one second opinion`);
  }
  const voice = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q23', GROQ_API_KEY: 'gsk_q23' },
    openai: sdk(() => ({ text: '[Música de fondo]', segments: [] })),
    groqClient: sdk(() => ({ text: 'Mamá, ya salí del colegio.', segments: [] })), localTranscribe: noLocal, ...clip(t),
  });
  assert.equal(voice.ok, true);
  assert.equal(voice.transcript, 'Mamá, ya salí del colegio.');
});

test('short clip: the «Revisé N tramos» note counts tramos that got another reading, not failed attempts', async (t) => {
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q24', GROQ_API_KEY: 'gsk_q24' },
    openai: sdk(() => ({ text: '', segments: [] })),
    groqClient: sdk(() => { throw httpError(503, 'Service Unavailable'); }), sleep: noSleep(),
    localTranscribe: async () => ({ text: 'Hola, te escribo para confirmar la reunión de mañana.', model: 'ggml-base.bin' }),
    ...clip(t),
  });
  assert.equal(result.ok, true);
  assert.equal(result.quality.escalations, 2, 'two attempts (the first one failed)');
  assert.ok(result.quality.notes.some((n) => /^Revisé 1 tramo dudoso /.test(n)), JSON.stringify(result.quality.notes));
  assert.ok(!result.quality.notes.some((n) => /Revisé 2/.test(n)));
});

// ── segmented pieces: energy, second opinions, gaps ─────────────────────────

test('a piece answered empty over speech energy is re-asked; the voice another engine hears is kept', async (t) => {
  const groq = sdk((i) => (i === 1 ? { text: '', segments: [] } : { text: prose(i), segments: [{ start: 1, end: 590, text: prose(i) }] }));
  const local = [];
  const measured = [];
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q5' }, groqClient: groq, ...long(t, 3),
    async measureVoiced(p, ctx) { measured.push(ctx.index); return { voicedSec: 310, silences: [] }; },
    async localTranscribe(p) {
      local.push(path.basename(p));
      return { text: 'La segunda parte de la clase habla de mercados.', segments: [{ start: 2, end: 9, text: 'La segunda parte de la clase habla de mercados.' }], model: 'ggml-base.bin' };
    },
  });
  assert.deepEqual(measured, [1], 'only the suspicious piece is measured (one decode of that piece)');
  assert.deepEqual(local, ['seg-0001.flac']);
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.providers, { groq: 2, local: 1 });
  assert.match(result.transcript, /La segunda parte de la clase habla de mercados\./);
  assert.equal(result.segments.find((s) => /segunda parte/.test(s.text)).start, 602);
  assert.equal(result.quality.escalations, 1);
  assert.deepEqual(format.normalizeQuality(result.quality), result.quality, 'the sidecar keeps the report as is');
});

test('a piece with speech energy that only ever comes back empty is a gap, never «covered»', async (t) => {
  const groq = sdk((i) => (i === 1 ? { text: '', segments: [] } : { text: prose(i), segments: [] }));
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q6', TRANSCRIBE_MIN_COVERAGE: '0.5' }, groqClient: groq, ...long(t, 3),
    measureVoiced: async () => ({ voicedSec: 200, silences: [] }),
    async localTranscribe() { throw Object.assign(new Error('Audio could not be decoded'), { code: 'AUDIO_DECODE_FAILED' }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.gaps, [{ start: 600, end: 1200, reason: 'audio_decode_failed' }]);
  assert.ok(result.coverage < 1);
});

test('a measured-silent piece is not re-asked; a recording that is silent everywhere needs ONE agreeing second opinion', async (t) => {
  const groq = sdk(() => ({ text: '', segments: [] }));
  const variants = [];
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q7', TRANSCRIBE_PROVIDERS: 'groq' }, groqClient: groq, ...long(t, 3),
    ffmpegFilters: ['highpass', 'dynaudnorm'],
    measureVoiced: async () => ({ voicedSec: 0.3, silences: [] }),
    async buildVariant(source, variant, ctx) {
      variants.push({ variant, name: ctx.name });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-qloop-variant-'));
      const out = path.join(dir, ctx.name);
      fs.writeFileSync(out, 'enhanced');
      return { ok: true, path: out, dir };
    },
  });
  assert.equal(result.reasonCode, 'no_speech');
  assert.equal(groq.requests.length, 4, 'three pieces + one second opinion on the enhanced copy');
  assert.deepEqual(variants, [{ variant: 'dynaudnorm', name: 'segment-1.flac' }]);
  assert.equal(groq.requests[3].body, 'enhanced');
});

test('a silent recording whose «no voice anywhere» second opinion fails is not no_speech; the retry asks again', async (t) => {
  const checkpoint = memoryCheckpoint();
  const file = tempFile(t, 'clase.wav');
  const enhanced = async (source, variant, ctx) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-qloop-variant-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, ctx.name);
    fs.writeFileSync(out, 'enhanced');
    return { ok: true, path: out, dir };
  };
  const base = {
    env: { GROQ_API_KEY: 'gsk_q25', TRANSCRIBE_PROVIDERS: 'groq' }, ...long(t, 2), checkpoint, language: 'es',
    ffmpegFilters: ['highpass', 'dynaudnorm'], measureVoiced: async () => ({ voicedSec: 0.3, silences: [] }),
    buildVariant: enhanced, sleep: noSleep(),
  };
  const down = sdk((_i, request) => {
    if (request.file.body === 'enhanced') throw httpError(503, 'Service Unavailable');
    return { text: '', segments: [] };
  });
  const first = await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, groqClient: down });
  assert.equal(first.ok, false);
  assert.notEqual(first.reasonCode, 'no_speech', 'the only second opinion failed: nothing agreed');
  assert.equal(first.reasonCode, 'low_coverage', 'transient: the partial retry reviews the piece again');
  assert.equal(down.requests.filter((r) => r.body === 'enhanced').length, 2, 'one more try for the cloud blip');

  const up = sdk(() => ({ text: '', segments: [] }));
  const second = await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, groqClient: up });
  assert.equal(second.reasonCode, 'no_speech', 'now a second opinion agrees');
  assert.deepEqual(up.requests.map((r) => r.body), ['enhanced'], 'only the check is redone; the pieces are not re-transcribed');
});

test('a silent recording: text one enhanced copy invents over measured silence is not adopted — no_speech stands', async (t) => {
  const calls = [];
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, ...long(t, 2), language: 'es',
    ffmpegFilters: ['highpass', 'dynaudnorm'],
    measureVoiced: async () => ({ voicedSec: 0, silences: [] }),
    async localTranscribe(_p, options) {
      calls.push(options.audioFilter ? 'enhanced' : 'plain');
      // The amplified room tone (up to +26 dB) is where Whisper invents a phrase.
      return options.audioFilter ? { text: 'Hola, ¿qué tal?', model: 'ggml-base.bin' } : { text: '', model: 'ggml-base.bin' };
    },
  });
  assert.deepEqual(calls, ['plain', 'plain', 'enhanced'], 'the «no voice anywhere» check is still asked once');
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'no_speech', 'the base heard nothing and the energy agrees: a video can still fall back to its subtitles');
});

test('past the second-opinion allowance, an empty piece with sound is never «covered» while second opinions keep finding speech', async (t) => {
  const checkpoint = memoryCheckpoint();
  const file = tempFile(t, 'clase.wav');
  const count = 10;
  const base = {
    env: { GROQ_API_KEY: 'gsk_q26', TRANSCRIBE_PROVIDERS: 'groq,local', TRANSCRIBE_MIN_COVERAGE: '0.5' }, ...long(t, count),
    checkpoint, language: 'es', measureVoiced: async () => ({ voicedSec: 400, silences: [] }),
  };
  const pieceOfPath = (p) => Number(/^seg-(\d+)/.exec(path.basename(String(p)))[1]);
  const groq = sdk((i) => (i < 8 ? { text: '', segments: [] } : { text: prose(i), segments: [] }));
  const heard = [];
  const first = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, groqClient: groq,
    async localTranscribe(p) { heard.push(pieceOfPath(p)); return { text: prose(pieceOfPath(p)), model: 'ggml-base.bin' }; },
  });
  assert.equal(first.ok, true);
  assert.equal(first.partial, true, 'pieces left unread are gaps, not silently «covered»');
  for (let i = 0; i < 8; i++) {
    const read = first.transcript.includes(`[${i}.0]`);
    const gap = first.gaps.some((g) => g.start === i * 600);
    assert.ok(read !== gap, `piece ${i}: either read by a second opinion or a gap (read=${read}, gap=${gap})`);
  }
  assert.ok(first.coverage < 1);
  assert.ok(!first.quality.notes.some((n) => /poco audibles/.test(n)), 'no voiced piece passed off as «poco audible»');

  // The partial retry reviews only those pieces (fresh allowance): nothing is re-transcribed.
  const retryGroq = sdk(() => { throw new Error('nothing to re-transcribe'); });
  const reread = [];
  const second = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, groqClient: retryGroq,
    async localTranscribe(p) { reread.push(pieceOfPath(p)); return { text: prose(pieceOfPath(p)), model: 'ggml-base.bin' }; },
  });
  assert.equal(retryGroq.requests.length, 0);
  assert.deepEqual(reread.sort((a, b) => a - b), first.gaps.map((g) => g.start / 600).sort((a, b) => a - b));
  assert.equal(second.ok, true);
  assert.equal(second.partial, false);
  assert.equal(second.coverage, 1);
  for (let i = 0; i < count; i++) assert.ok(second.transcript.includes(`[${i}.0]`), `piece ${i}`);
});

test('one engine and no enhanced copy: past the allowance, empty pieces with sound stay «poco audibles» (a retry could not change them)', async (t) => {
  const pieceOfPath = (p) => Number(/^seg-(\d+)/.exec(path.basename(String(p)))[1]);
  const result = await audio.transcribe(tempFile(t, 'concierto.wav'), 'audio/wav', 'concierto.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, ...long(t, 8), language: 'es',
    measureVoiced: async () => ({ voicedSec: 450, silences: [] }),
    async localTranscribe(p) { return pieceOfPath(p) === 0 ? { text: prose(0), model: 'ggml-base.bin' } : { text: '', model: 'ggml-base.bin' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.gaps, []);
  assert.ok(result.quality.notes.some((n) => /poco audibles/.test(n)));
});

test('a «no voice» piece confirmed by a second opinion keeps no invented sign-off in the transcript or its checkpoint', async (t) => {
  const checkpoint = memoryCheckpoint();
  const groq = sdk((i) => (i === 0
    ? { text: 'Gracias por ver el video.', segments: [{ start: 0, end: 4, text: 'Gracias por ver el video.' }] }
    : { text: prose(i), segments: [{ start: 1, end: 500, text: prose(i) }] }));
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q27', TRANSCRIBE_PROVIDERS: 'groq,local' }, groqClient: groq, ...long(t, 2), checkpoint, language: 'es',
    localTranscribe: async () => ({ text: '', model: 'ggml-base.bin' }),
    measureVoiced: async () => ({ voicedSec: 300, silences: [] }),
  });
  assert.equal(result.ok, true);
  assert.ok(!/Gracias por ver/.test(result.transcript), result.transcript.slice(0, 80));
  assert.ok(!result.segments.some((s) => /Gracias por ver/.test(s.text)));
  assert.equal(result.segments[0].start, 601);
  assert.equal(checkpoint.store.get(0).part.text, '');
  assert.equal(checkpoint.store.get(0).part.review.confirmedEmpty, true);
  assert.equal(checkpoint.store.get(0).part.review.alternatives, 1, 'the checkpoint says how many alternatives answered');
  assert.ok(result.quality.notes.some((n) => /lo confirmé con una segunda lectura/.test(n)));

  // Over measured silence, the sign-off is dropped too; an annotation stays.
  const quiet = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q28', TRANSCRIBE_PROVIDERS: 'groq' }, ...long(t, 2), language: 'es',
    groqClient: sdk((i) => (i === 0
      ? { text: '[Música] Gracias por ver el video.', segments: [{ start: 0, end: 3, text: '[Música]' }, { start: 3, end: 6, text: 'Gracias por ver el video.' }] }
      : { text: prose(i), segments: [{ start: 1, end: 500, text: prose(i) }] })),
    measureVoiced: async (_p, ctx) => ({ voicedSec: ctx.index === 0 ? 0.4 : 500, silences: [] }),
  });
  assert.equal(quiet.ok, true);
  assert.ok(!/Gracias por ver/.test(quiet.transcript));
  assert.deepEqual(quiet.segments.filter((s) => s.start < 600).map((s) => s.text), ['[Música]']);
});

test('the default energy probe decodes only that piece, with the -50 dB energy threshold', async (t) => {
  const execCalls = [];
  const groq = sdk((i) => (i === 0 ? { text: '', segments: [] } : { text: prose(i), segments: [] }));
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q8', TRANSCRIBE_PROVIDERS: 'groq', TRANSCRIBE_MIN_COVERAGE: '0.5' }, groqClient: groq, ...long(t, 2),
    async execFileImpl(bin, args) {
      execCalls.push(args);
      if (args.some((a) => /silencedetect/.test(String(a)))) {
        return { stdout: '', stderr: '[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 2 | silence_duration: 2\n' };
      }
      throw Object.assign(new Error('unexpected'), { code: 'ENOENT' });
    },
  });
  const probe = execCalls.find((args) => args.some((a) => /silencedetect/.test(String(a))));
  assert.ok(probe.includes('silencedetect=noise=-50dB:d=0.4'));
  assert.equal(path.basename(probe[probe.indexOf('-i') + 1]), 'seg-0000.flac');
  // 598 voiced seconds, an empty answer, no other engine and no enhanced copy:
  // the piece is kept but marked «poco audible», never claimed as clean.
  assert.ok(result.quality.lowConfidence.some((s) => s.reason === 'quiet' && s.start === 0 && s.end === 600));
});

// ── escalation rungs, budget, voicestudio ──────────────────────────────────

/** Scribe fake: the words spread over `spanSec` (a 10-min piece by default). */
function elevenLabsFake(text, spanSec = 580) {
  const calls = [];
  const tokens = text.split(' ');
  const step = spanSec / tokens.length;
  const words = tokens.flatMap((w, i) => [
    { text: w, start: i * step, end: i * step + step * 0.8, type: 'word', logprob: -0.05 },
    { text: ' ', start: i * step + step * 0.8, end: (i + 1) * step, type: 'spacing', logprob: 0 },
  ]);
  return {
    calls,
    speechToText: { async convert(request, requestOptions) {
      calls.push({ modelId: request.modelId, languageCode: request.languageCode, granularity: request.timestampsGranularity, timeout: requestOptions.timeoutInSeconds, retries: requestOptions.maxRetries });
      return { languageCode: 'spa', text, words: [...words, { text: '(risas)', start: 1, end: 2, type: 'audio_event', logprob: 0 }] };
    } },
  };
}

test('an opt-in escalation rung (ElevenLabs Scribe) reads ONLY the flagged piece; it never runs in the first pass', async (t) => {
  const groq = sdk((i) => (i === 1 ? { text: 'Hola a todos.', segments: [] } : { text: prose(i), segments: [] }));
  const eleven = elevenLabsFake(prose(9));
  const voiced = async (_p, ctx) => ({ voicedSec: ctx.index === 1 ? 300 : 500, silences: [] });
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q9', ELEVENLABS_API_KEY: 'el-test', TRANSCRIBE_PROVIDERS: 'groq', TRANSCRIBE_ESCALATION_PROVIDERS: 'elevenlabs' },
    groqClient: groq, elevenlabsClient: eleven, measureVoiced: voiced, ...long(t, 3), language: 'es',
  });
  assert.equal(eleven.calls.length, 1, 'only the under-transcribed piece');
  // A 10-min piece gets the scaled per-request timeout (60 s + 0.2 s per audio second).
  assert.deepEqual(eleven.calls[0], { modelId: 'scribe_v1', languageCode: 'es', granularity: 'word', timeout: 180, retries: 0 });
  assert.deepEqual(result.providers, { groq: 2, elevenlabs: 1 });
  assert.ok(!result.transcript.includes('(risas)'), 'audio events are not words');
  assert.ok(result.quality.enginesUsed.includes('elevenlabs:scribe_v1'));
  assert.equal(result.quality.escalations, 1);
  assert.ok(!result.quality.lowConfidence.some((s) => s.reason === 'under_transcribed'), 'repaired, not doubtful');

  // Same file, no opt-in: ElevenLabs is never asked; the piece is reported honestly.
  const quiet = elevenLabsFake(prose(9));
  const plain = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q9b', ELEVENLABS_API_KEY: 'el-test', TRANSCRIBE_PROVIDERS: 'groq' },
    groqClient: sdk((i) => (i === 1 ? { text: 'Hola a todos.', segments: [] } : { text: prose(i), segments: [] })),
    elevenlabsClient: quiet, measureVoiced: voiced, ...long(t, 3),
  });
  assert.equal(quiet.calls.length, 0);
  assert.ok(plain.quality.lowConfidence.some((s) => s.reason === 'under_transcribed' && s.start === 600 && s.end === 1200));
  assert.ok(plain.quality.score < 1);
});

test('the escalation budget bounds the extra work per job', async (t) => {
  const eleven = elevenLabsFake(prose(5));
  await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q10', ELEVENLABS_API_KEY: 'el-test', TRANSCRIBE_PROVIDERS: 'groq', TRANSCRIBE_ESCALATION_PROVIDERS: 'elevenlabs', TRANSCRIBE_ESCALATION_BUDGET_RATIO: '0' },
    groqClient: sdk(() => ({ text: 'Hola a todos.', segments: [] })), elevenlabsClient: eleven,
    measureVoiced: async () => ({ voicedSec: 400, silences: [] }), ...long(t, 4),
  });
  assert.equal(eleven.calls.length, 1, 'ratio 0 still allows one piece (600 s), not four');
});

test('VoiceStudio as an escalation rung: used for a flagged piece only', async (t) => {
  const vsCalls = [];
  const voiceStudio = {
    isConfigured: () => true,
    async transcribe({ filename }) { vsCalls.push(filename); return { text: prose(7), segments: [] }; },
  };
  const loop = Array.from({ length: 40 }, () => 'y entonces el profesor dijo que').join(' ');
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q11', TRANSCRIBE_PROVIDERS: 'groq', TRANSCRIBE_ESCALATION_PROVIDERS: 'voicestudio' },
    groqClient: sdk((i) => (i === 0 ? { text: loop, segments: [] } : { text: prose(i), segments: [] })), voiceStudio, ...long(t, 2),
  });
  assert.deepEqual(vsCalls, ['segment-1.flac']);
  assert.deepEqual(result.providers, { voicestudio: 1, groq: 1 });
});

// ── rung revival, last-rung backoff, deterministic local failures ──────────

test('a rung paused by a 3-in-a-row streak comes back after its pause (no latch for the rest of the job)', async (t) => {
  let now = 0;
  const openai = sdk((i) => { if (i <= 2) throw httpError(500, 'upstream error'); return { text: prose(i), segments: [] }; });
  const groq = sdk((i) => { now += 120_000; return { text: prose(i), segments: [] }; });
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_q12', GROQ_API_KEY: 'gsk_q12', TRANSCRIBE_SEGMENT_RETRIES: '0' },
    openai, groqClient: groq, localTranscribe: noLocal, now: () => now, sleep: noSleep(), ...long(t, 8),
  });
  assert.deepEqual(openai.requests.map((r) => r.index), [0, 1, 2, 5, 6, 7], 'paused 5 min after piece 2, probed again on piece 5');
  assert.deepEqual(result.providers, { groq: 5, openai: 3 });
  assert.equal(result.partial, false);
});

test('the last engine left backs off (30 s, 2 min, 10 min) instead of dying; a repeated OOM kill is deterministic', async (t) => {
  const sleep = noSleep();
  let attempts = 0;
  const healed = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, sleep, ...long(t, 3), language: 'es',
    async localTranscribe(p) {
      if (/seg-0001/.test(p) && ++attempts <= 2) throw Object.assign(new Error('local whisper timed out'), { code: 'LOCAL_WHISPER_TIMEOUT' });
      return { text: prose(Number(/seg-(\d+)/.exec(path.basename(p))[1])) };
    },
  });
  assert.deepEqual(sleep.sleeps, [30_000, 120_000]);
  assert.equal(healed.partial, false);

  const oomSleep = noSleep();
  const oom = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_MIN_COVERAGE: '0.5' }, sleep: oomSleep, ...long(t, 3), language: 'es',
    async localTranscribe(p) {
      if (/seg-0001/.test(p)) {
        throw Object.assign(new Error('local whisper unavailable'), {
          code: 'LOCAL_WHISPER_UNAVAILABLE', cppError: { code: 'LOCAL_WHISPER_FAILED', exitCode: null, signal: 'SIGKILL' },
        });
      }
      return { text: prose(Number(/seg-(\d+)/.exec(path.basename(p))[1])) };
    },
  });
  assert.deepEqual(oomSleep.sleeps, [30_000], 'one backoff, then the second kill ends it for this piece');
  assert.deepEqual(oom.gaps, [{ start: 600, end: 1200, reason: 'local_unavailable' }]);
  assert.match(oom.transcript, /\[2\.0\]/, 'the next piece still ran locally');

  const budgetSleep = noSleep();
  const capped = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_MIN_COVERAGE: '0.5', TRANSCRIBE_LAST_RUNG_WAIT_BUDGET_MS: '60000' },
    sleep: budgetSleep, ...long(t, 3), language: 'es',
    async localTranscribe(p) {
      if (/seg-0001/.test(p)) throw Object.assign(new Error('crash'), { code: 'LOCAL_WHISPER_FAILED', exitCode: 1 });
      return { text: prose(1) };
    },
  });
  assert.deepEqual(budgetSleep.sleeps, [30_000], 'the job wait budget (60 s) bounds the backoff');
  assert.equal(capped.gaps.length, 1);
});

test('whisper.cpp refusing the language code retries that piece with detection once', async (t) => {
  const languages = [];
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, ...long(t, 2), language: 'es', sleep: noSleep(),
    async localTranscribe(p, options) {
      languages.push(options.language);
      if (/seg-0000/.test(p) && options.language) {
        throw Object.assign(new Error('whisper.cpp returned no output'), { code: 'LOCAL_WHISPER_EMPTY', diagnostics: "error: unknown language 'es'" });
      }
      return { text: prose(0) };
    },
  });
  assert.deepEqual(languages, ['es', undefined, 'es']);
  assert.equal(result.partial, false);
});

// ── refine, resume mid-review ───────────────────────────────────────────────

function memoryCheckpoint() {
  const store = new Map();
  return {
    store,
    async load(index, meta) {
      const saved = store.get(index);
      return saved && saved.meta.total === meta.total && saved.meta.segmentSeconds === meta.segmentSeconds ? saved.part : null;
    },
    async save(index, meta, part) { store.set(index, { meta, part: JSON.parse(JSON.stringify(part)) }); },
  };
}

test('refine: range + forceRetranscribe redo only the overlapping piece (with a second hypothesis); the rest is reused', async (t) => {
  const checkpoint = memoryCheckpoint();
  const file = tempFile(t, 'clase.wav');
  const base = { env: { GROQ_API_KEY: 'gsk_q13' }, ...long(t, 3), checkpoint, language: 'es' };
  const first = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, groqClient: sdk((i) => ({ text: prose(i), segments: [] })), localTranscribe: noLocal,
  });
  assert.equal(first.ok, true);
  assert.equal(checkpoint.store.get(1).part.review.done, true, 'each part is saved with its review record');

  const groq = sdk((i) => ({ text: `${prose(i)} Corregido.`, segments: [] }));
  const local = [];
  const refined = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, groqClient: groq, range: { start: 700, end: 900 }, forceRetranscribe: true,
    async localTranscribe(p) { local.push(path.basename(p)); return { text: `${prose(1)} Corregido.`, model: 'ggml-base.bin' }; },
  });
  assert.deepEqual(groq.requests.map((r) => r.index), [1], 'only the piece overlapping 700–900 s');
  assert.deepEqual(local, ['seg-0001.flac'], 'and one more hypothesis for it');
  assert.equal(refined.segmentCount, 3, 'the full result comes back');
  assert.match(refined.transcript, /\[0\.0\]/);
  assert.match(refined.transcript, /Corregido\./);
  assert.match(checkpoint.store.get(1).part.text, /Corregido\./, 'the refined part replaces its checkpoint');

  const untouched = sdk(() => { throw new Error('nothing to redo'); });
  const plain = await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, groqClient: untouched, range: { start: 700, end: 900 }, localTranscribe: noLocal });
  assert.equal(untouched.requests.length, 0, 'a range without forceRetranscribe changes nothing');
  assert.equal(plain.ok, true);
});

test('refine without kept parts (none saved, or saved in another language) transcribes only the window; the rest is skipped, not re-read', async (t) => {
  const file = tempFile(t, 'clase.wav');
  const timed = (i, extra = '') => ({ text: `${prose(i)}${extra}`, segments: [{ start: 1, end: 500, text: `${prose(i)}${extra}` }] });
  // Nothing kept: a transcript finished before parts were kept, or swept after 14 days.
  const empty = memoryCheckpoint();
  const groq = sdk((i) => timed(i, ' Corregido.'));
  const refined = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q31', TRANSCRIBE_PROVIDERS: 'groq' }, ...long(t, 3), checkpoint: empty, language: 'es',
    groqClient: groq, range: { start: 700, end: 900 }, forceRetranscribe: true,
  });
  assert.deepEqual(groq.requests.map((r) => r.index), [1], 'only the piece overlapping 700–900 s');
  assert.equal(refined.ok, true);
  assert.equal(refined.refineSkipped, 2);
  assert.equal(refined.partial, false, 'a skipped piece is not a gap');
  assert.deepEqual(refined.gaps, []);
  assert.equal(refined.coverage, 1, 'nor a hole in the coverage');
  assert.match(refined.transcript, /\[1\.0\][^]*Corregido\./);
  assert.doesNotMatch(refined.transcript, /\[0\.0\]|\[2\.0\]/);
  assert.ok(refined.segments.length && refined.segments.every((s) => s.start >= 600 && s.start < 1200), 'only the window\'s times');
  assert.deepEqual(refined.refineSpans, [[600, 1200]], 'the stretch read again, on the file clock: the caller cuts by it');
  assert.deepEqual([...empty.store.keys()], [1], 'nothing saved for the pieces that were not read');

  // A window across a cut: one span per piece read again, in order.
  const across = sdk((i) => timed(i, ' Corregido.'));
  const twoPieces = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q34', TRANSCRIBE_PROVIDERS: 'groq' }, ...long(t, 3), checkpoint: memoryCheckpoint(), language: 'es',
    groqClient: across, range: { start: 500, end: 700 }, forceRetranscribe: true,
  });
  assert.deepEqual(across.requests.map((r) => r.index).sort(), [0, 1]);
  assert.equal(twoPieces.refineSkipped, 1);
  assert.deepEqual(twoPieces.refineSpans, [[0, 600], [600, 1200]]);

  // Parts kept in Spanish, refine in English: the other pieces are not re-read in English.
  const kept = memoryCheckpoint();
  const base = { env: { GROQ_API_KEY: 'gsk_q32', TRANSCRIBE_PROVIDERS: 'groq' }, ...long(t, 3), checkpoint: kept };
  await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, language: 'es', groqClient: sdk((i) => timed(i)) });
  const english = sdk((i) => timed(i, ' Corrected.'));
  const inEnglish = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, language: 'en', groqClient: english, range: { start: 1300, end: 1400 }, forceRetranscribe: true,
  });
  assert.deepEqual(english.requests.map((r) => r.index), [2]);
  assert.equal(inEnglish.refineSkipped, 2);
  assert.deepEqual(inEnglish.refineSpans, [[1200, 1800]]);
  assert.match(inEnglish.transcript, /Corrected\./);

  // Without a refine window nothing is skipped (and no refineSkipped field).
  const plain = await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, language: 'en', groqClient: sdk((i) => timed(i)) });
  assert.equal(plain.ok, true);
  assert.equal('refineSkipped' in plain, false);
  assert.equal('refineSpans' in plain, false, 'no refine, no spans');
  assert.equal(plain.coverage, 1);
});

test('refine with refineSkipUnusable: false (a transcript the caller cannot splice) transcribes every piece without a usable part; the window is still forced', async (t) => {
  const file = tempFile(t, 'clase.wav');
  const timed = (i, extra = '') => ({ text: `${prose(i)}${extra}`, segments: [{ start: 1, end: 500, text: `${prose(i)}${extra}` }] });
  const env = { GROQ_API_KEY: 'gsk_q33', TRANSCRIBE_PROVIDERS: 'groq' };
  // Nothing kept: the whole recording is read, nothing skipped.
  const empty = memoryCheckpoint();
  const groq = sdk((i) => timed(i, ' Corregido.'));
  const whole = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    env, ...long(t, 3), checkpoint: empty, language: 'es',
    groqClient: groq, range: { start: 700, end: 900 }, forceRetranscribe: true, refineSkipUnusable: false,
  });
  assert.deepEqual(groq.requests.map((r) => r.index).sort(), [0, 1, 2], 'every piece is read');
  assert.equal(whole.ok, true);
  assert.equal('refineSkipped' in whole, false);
  assert.equal(whole.segmentCount, 3);
  assert.match(whole.transcript, /\[0\.0\][^]*\[1\.0\][^]*\[2\.0\]/, 'the whole result comes back');

  // Parts kept: only the window is read again (forced), the rest is reused as before.
  const kept = memoryCheckpoint();
  const base = { env, ...long(t, 3), checkpoint: kept, language: 'es' };
  await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, groqClient: sdk((i) => timed(i)) });
  const again = sdk((i) => timed(i, ' Corregido.'));
  const refined = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, groqClient: again, range: { start: 700, end: 900 }, forceRetranscribe: true, refineSkipUnusable: false,
  });
  assert.deepEqual(again.requests.map((r) => r.index), [1]);
  assert.match(refined.transcript, /\[0\.0\][^]*\[1\.0\][^]*Corregido\.[^]*\[2\.0\]/);
  assert.deepEqual(refined.refineSpans, [[600, 1200]], 'the window piece is still the one read again');
  assert.deepEqual(whole.refineSpans, [[600, 1200]]);
});

/** options.segmentAudio fake with given piece offsets (a snapped cut plan when they are not multiples of 600 s). */
function offsetSegmenter(t, offsets, total) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-qloop-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
      dir,
      segments: offsets.map((offset, i) => {
        const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
        fs.writeFileSync(p, `segment-${i}`);
        return { path: p, index: i, offsetSeconds: offset, durationSeconds: (offsets[i + 1] ?? total) - offset };
      }),
    };
  };
}

test('refine over parts kept from another cut plan reads every piece: the stored segments do not line up with the new pieces', async (t) => {
  const file = tempFile(t, 'clase.wav');
  const timed = (i, extra = '') => ({ text: `${prose(i)}${extra}`, segments: [{ start: 1, end: 500, text: `${prose(i)}${extra}` }] });
  const env = { GROQ_API_KEY: 'gsk_q41', TRANSCRIBE_PROVIDERS: 'groq' };
  const base = { env, durationSeconds: 1800, createFile, ffmpegFilters: [], parallel: 1, language: 'es' };
  // The stored transcript was cut at 610 s and 1210 s (its parts say so).
  const kept = memoryCheckpoint();
  await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, checkpoint: kept, segmentAudio: offsetSegmenter(t, [0, 610, 1210], 1800), groqClient: sdk((i) => timed(i)) });
  assert.ok(kept.store.get(0).part.cutPlan, 'each part records its cut plan');
  // The refine cuts at 600 s and 1200 s: nothing is skipped, every piece is read.
  const groq = sdk((i) => timed(i, ' Corregido.'));
  const refined = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, checkpoint: kept, segmentAudio: segmenter(t, 3), groqClient: groq, range: { start: 700, end: 900 }, forceRetranscribe: true,
  });
  assert.deepEqual(groq.requests.map((r) => r.index).sort(), [0, 1, 2], 'a whole reading for the caller to cut into');
  assert.equal(refined.ok, true);
  assert.equal('refineSkipped' in refined, false);
  assert.deepEqual(refined.refineSpans, [[600, 1200]], 'the window piece is still the one read again');
  assert.match(refined.transcript, /\[0\.0\][^]*\[1\.0\][^]*\[2\.0\]/);

  // A part saved before parts recorded their plan cannot fill a snapped cut either.
  const legacy = memoryCheckpoint();
  await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, checkpoint: legacy, segmentAudio: segmenter(t, 3), groqClient: sdk((i) => timed(i)) });
  for (const saved of legacy.store.values()) delete saved.part.cutPlan;
  const again = sdk((i) => timed(i, ' Corregido.'));
  const overLegacy = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, checkpoint: legacy, segmentAudio: offsetSegmenter(t, [0, 610, 1210], 1800), groqClient: again, range: { start: 700, end: 900 }, forceRetranscribe: true,
  });
  assert.deepEqual(again.requests.map((r) => r.index).sort(), [0, 1, 2]);
  assert.equal('refineSkipped' in overLegacy, false);
});

test('refine over entries the checkpoint will not load (another number of pieces) still sees their cut plan and reads every piece', async (t) => {
  const file = tempFile(t, 'clase.wav');
  const timed = (i, extra = '') => ({ text: `${prose(i)}${extra}`, segments: [{ start: 1, end: 400, text: `${prose(i)}${extra}` }] });
  const env = { GROQ_API_KEY: 'gsk_q43', TRANSCRIBE_PROVIDERS: 'groq' };
  const base = { env, durationSeconds: 1800, createFile, ffmpegFilters: [], parallel: 1, language: 'es' };
  // A checkpoint like the queue's disk one: load ignores entries of another
  // piece count; savedCutPlan reads their plan anyway.
  const kept = memoryCheckpoint();
  kept.savedCutPlan = async (index) => kept.store.get(index)?.meta?.cutPlan || null;
  await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, checkpoint: kept, segmentAudio: offsetSegmenter(t, [0, 450, 900, 1350], 1800), groqClient: sdk((i) => timed(i)) });
  assert.equal(kept.store.get(0).meta.total, 4);
  const groq = sdk((i) => timed(i, ' Corregido.'));
  const refined = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, checkpoint: kept, segmentAudio: segmenter(t, 3), groqClient: groq, range: { start: 700, end: 900 }, forceRetranscribe: true,
  });
  assert.deepEqual(groq.requests.map((r) => r.index).sort(), [0, 1, 2]);
  assert.equal('refineSkipped' in refined, false);

  // The same plan saved before (a gap piece without a part): only the window is read.
  const same = memoryCheckpoint();
  same.savedCutPlan = async (index) => same.store.get(index)?.meta?.cutPlan || null;
  await audio.transcribe(file, 'audio/wav', 'clase.wav', { ...base, checkpoint: same, segmentAudio: segmenter(t, 3), groqClient: sdk((i) => timed(i)) });
  same.store.delete(2);
  const window = sdk((i) => timed(i, ' Corregido.'));
  const sameCut = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    ...base, checkpoint: same, segmentAudio: segmenter(t, 3), groqClient: window, range: { start: 700, end: 900 }, forceRetranscribe: true,
  });
  assert.deepEqual(window.requests.map((r) => r.index), [1]);
  assert.equal(sameCut.refineSkipped, 1);
});

test('a segment timed at its piece\'s very end starts inside that piece: a refine\'s caller attributes it to the piece it re-read', async (t) => {
  const file = tempFile(t, 'clase.wav');
  // Whisper times the last word at the piece's end (600 s of a 600 s piece).
  const atEnd = (i) => ({ text: `${prose(i)} fin`, segments: [{ start: 1, end: 590, text: prose(i) }, { start: 600, end: 600.4, text: 'fin' }] });
  const refined = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q42', TRANSCRIBE_PROVIDERS: 'groq' }, ...long(t, 3), checkpoint: memoryCheckpoint(), language: 'es',
    groqClient: sdk(atEnd), range: { start: 700, end: 900 }, forceRetranscribe: true,
  });
  assert.equal(refined.refineSkipped, 2);
  assert.deepEqual(refined.refineSpans, [[600, 1200]]);
  const fin = refined.segments.find((s) => s.text === 'fin');
  assert.ok(fin && fin.start >= 600 && fin.start < 1200, `«fin» starts inside the piece it was read in (${fin && fin.start})`);
  assert.equal(fin.end, 1200.4, 'its end is untouched');
});

test('a restart in the middle of a review reviews that piece again — it is not re-transcribed', async (t) => {
  const checkpoint = memoryCheckpoint();
  const file = tempFile(t, 'clase.wav');
  const opts = { ...long(t, 2), checkpoint, language: 'es' };
  // The previous attempt saved piece 1's first (empty) answer, then stopped mid-review.
  const groqSeed = sdk((i) => ({ text: i === 1 ? '' : prose(i), segments: [] }));
  const controller = new AbortController();
  await assert.rejects(audio.transcribe(file, 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q14' }, ...opts, groqClient: groqSeed, signal: controller.signal,
    measureVoiced: async () => ({ voicedSec: 300, silences: [] }),
    async localTranscribe() { controller.abort(); throw Object.assign(new Error('cancelled'), { code: 'LOCAL_WHISPER_ABORTED' }); },
  }), { name: 'AbortError' });
  assert.deepEqual(checkpoint.store.get(1).part.review, { v: 1, done: false });

  const groq = sdk(() => { throw new Error('nothing to re-transcribe'); });
  const local = [];
  const result = await audio.transcribe(file, 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q14' }, ...opts, groqClient: groq,
    measureVoiced: async () => ({ voicedSec: 300, silences: [] }),
    async localTranscribe(p) { local.push(path.basename(p)); return { text: 'Lo que se oyó en la segunda parte.' }; },
  });
  assert.equal(groq.requests.length, 0);
  assert.deepEqual(local, ['seg-0001.flac'], 'only the second opinion that was interrupted');
  assert.match(result.transcript, /Lo que se oyó en la segunda parte\./);
  assert.equal(checkpoint.store.get(1).part.review.done, true);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('ElevenLabs Scribe: words → timed segments (spacing and audio events dropped), ISO-639-3 language, bounded request', async (t) => {
  const file = tempFile(t, 'segment-1.flac');
  const eleven = elevenLabsFake('Hola a todos. Empezamos la clase de hoy.', 3.2);
  const controller = new AbortController();
  const out = await audio.transcribeWithElevenLabs({
    filePath: file, mimeType: 'audio/flac', language: 'es', signal: controller.signal, timeoutMs: 90_000, model: 'scribe_v1',
    options: { elevenlabsClient: eleven },
  });
  assert.equal(out.language, 'es');
  assert.equal(out.text, 'Hola a todos. Empezamos la clase de hoy.');
  assert.deepEqual(out.segments.map((s) => s.text), ['Hola a todos.', 'Empezamos la clase de hoy.']);
  assert.ok(out.segments.every((s) => s.confidence > 0.9));
  assert.deepEqual(eleven.calls[0], { modelId: 'scribe_v1', languageCode: 'es', granularity: 'word', timeout: 90, retries: 0 });
  assert.equal(audio.elevenLabsRung({ env: {} }), null, 'no key, no rung');
  assert.deepEqual(audio.escalationProviderNames({ env: { TRANSCRIBE_ESCALATION_PROVIDERS: 'ElevenLabs, voicestudio, openai, elevenlabs' } }), ['elevenlabs', 'voicestudio']);
});

test('ffmpeg filters are read once per binary and parsed; an unreadable list means no enhanced copies', async () => {
  const listing = [
    'Filters:',
    '  T.. = Timeline support',
    ' ... loudnorm          A->A       EBU R128 loudness normalization',
    ' TSC dynaudnorm        A->A       Dynamic Audio Normalizer.',
    ' TSC highpass          A->A       Apply a high-pass filter.',
  ].join('\n');
  assert.deepEqual([...audio.parseFfmpegFilters(listing)].sort(), ['dynaudnorm', 'highpass', 'loudnorm']);
  let calls = 0;
  const execFileImpl = async () => { calls++; return { stdout: listing, stderr: '' }; };
  const a = await audio.ffmpegFilterSet({ execFileImpl, ffmpegPath: '/opt/ffmpeg-a' });
  const b = await audio.ffmpegFilterSet({ execFileImpl, ffmpegPath: '/opt/ffmpeg-a' });
  assert.equal(calls, 1);
  assert.ok(a.has('dynaudnorm') && b.has('loudnorm'));
  const none = await audio.ffmpegFilterSet({ execFileImpl: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.equal(none.size, 0);
  assert.deepEqual([...(await audio.ffmpegFilterSet({ ffmpegFilters: ['x'] }))], ['x']);
});

test('a failed ffmpeg filter listing is probed again after a while; a missing binary is remembered', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  let calls = 0;
  let fail = true;
  const flaky = async () => {
    calls++;
    if (fail) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true });
    return { stdout: ' TSC dynaudnorm        A->A       Dynamic Audio Normalizer.\n TSC highpass          A->A       High-pass.', stderr: '' };
  };
  const opts = { execFileImpl: flaky, ffmpegPath: '/opt/ffmpeg-flaky', now };
  assert.equal((await audio.ffmpegFilterSet(opts)).size, 0);
  assert.equal((await audio.ffmpegFilterSet(opts)).size, 0);
  assert.equal(calls, 1, 'within the retry window the failure is reused');
  fail = false;
  clock += 5 * 60_000;
  const filters = await audio.ffmpegFilterSet(opts);
  assert.equal(calls, 2, 'probed again after the window');
  assert.ok(filters.has('dynaudnorm'));
  clock += 60 * 60_000;
  await audio.ffmpegFilterSet(opts);
  assert.equal(calls, 2, 'a successful listing is kept for the process');

  let missingCalls = 0;
  const missing = async () => { missingCalls++; throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); };
  const gone = { execFileImpl: missing, ffmpegPath: '/opt/ffmpeg-gone', now };
  await audio.ffmpegFilterSet(gone);
  clock += 60 * 60_000;
  await audio.ffmpegFilterSet(gone);
  assert.equal(missingCalls, 1, 'a missing binary does not come back by waiting');
});

test('buildVariantFile: an enhanced FLAC named like the piece, through the shared ffmpeg runner; failures clean up', async (t) => {
  const source = tempFile(t, 'seg-0001.flac');
  let seenArgs = null;
  const spawnImpl = (_bin, args) => {
    seenArgs = args;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => { fs.writeFileSync(args.at(-1), 'enhanced'); child.emit('close', 0); });
    return child;
  };
  const built = await audio.buildVariantFile(source, 'loudnorm', { name: 'segment-2.flac', durationSeconds: 600 }, { spawnImpl });
  t.after(() => fs.rmSync(built.dir, { recursive: true, force: true }));
  assert.equal(built.ok, true);
  assert.equal(path.basename(built.path), 'segment-2.flac');
  assert.equal(seenArgs[seenArgs.indexOf('-af') + 1], audio.VARIANT_FILTERS.loudnorm.filter);
  assert.ok(!seenArgs.includes('-map'), 'a FLAC piece has one stream');

  let failedDir = null;
  const failing = (_bin, args) => {
    failedDir = path.dirname(args.at(-1));
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('close', 1));
    return child;
  };
  const failed = await audio.buildVariantFile(source, 'dynaudnorm', { name: 'segment-2.flac' }, { spawnImpl: failing });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(failedDir), false);
  assert.deepEqual(await audio.buildVariantFile(source, 'unknown', {}, {}), { ok: false });
});

test('classifyRungError separates deterministic from transient local failures', () => {
  const local = { name: 'local', kind: 'local' };
  assert.equal(audio.classifyRungError(local, { code: 'AUDIO_DECODE_FAILED' }), 'segment');
  assert.equal(audio.classifyRungError(local, { code: 'LOCAL_WHISPER_UNAVAILABLE', reason: 'model missing' }), 'dead');
  assert.equal(audio.classifyRungError(local, { code: 'LOCAL_WHISPER_TIMEOUT' }), 'transient');
  assert.equal(audio.classifyRungError(local, { code: 'LOCAL_WHISPER_UNAVAILABLE', cppError: { code: 'LOCAL_WHISPER_FAILED', signal: 'SIGKILL' } }), 'oom');
  assert.equal(audio.classifyRungError(local, { code: 'LOCAL_WHISPER_EMPTY', diagnostics: "error: unknown language 'qu'" }), 'language');
  assert.equal(audio.classifyRungError(local, {
    code: 'LOCAL_WHISPER_UNAVAILABLE', cppError: { code: 'LOCAL_WHISPER_SPAWN', cause: { code: 'EAGAIN' } },
  }), 'transient', 'EAGAIN is load, not a missing engine');
  assert.deepEqual(audio.refineWindow({ range: { start: 10, end: 20 }, forceRetranscribe: true }), { start: 10, end: 20 });
  assert.equal(audio.refineWindow({ range: { start: 10, end: 20 } }), null);
  assert.equal(audio.refineWindow({ range: { start: 30, end: 20 }, forceRetranscribe: true }), null);
});

test('a sparse answer is measured against the speech threshold (the cut plan\'s), an empty one against any sound', async (t) => {
  const thresholds = [];
  await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q15', TRANSCRIBE_PROVIDERS: 'groq', TRANSCRIBE_MIN_COVERAGE: '0.3' },
    groqClient: sdk((i) => ({ text: i === 0 ? 'Hola a todos.' : '', segments: [] })), ...long(t, 2),
    async measureVoiced(_p, ctx) { thresholds.push([ctx.index, ctx.thresholdDb]); return { voicedSec: 1, silences: [] }; },
  });
  assert.deepEqual(thresholds, [[0, -35], [1, -50]]);
});

test('the language detection reads what the second opinion heard, not the first empty answer', async (t) => {
  const groq = sdk((i) => ({ text: i === 0 ? '' : prose(i), language: 'spanish', segments: [] }));
  const result = await audio.transcribe(tempFile(t, 'clase.wav'), 'audio/wav', 'clase.wav', {
    env: { GROQ_API_KEY: 'gsk_q16', WHISPER_LANGUAGE: 'es' }, groqClient: groq, ...long(t, 2),
    measureVoiced: async () => ({ voicedSec: 300, silences: [] }),
    async localTranscribe() { return { text: 'Good morning everyone, welcome back to the course.', language: 'en' }; },
  });
  assert.equal(result.ok, true);
  assert.match(result.transcript, /Good morning everyone/);
  assert.deepEqual(groq.requests.map((r) => r.language), [undefined, undefined, 'es'],
    'piece 0 (second opinion: English) and piece 1 (Spanish) disagree, so the hint decides and the English piece is re-read');
});

// ── real ffmpeg (skipped without it) ────────────────────────────────────────

const { spawnSync } = require('node:child_process');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

test('real ffmpeg: a far-field voice (-44 dBFS) counts as sound for an empty answer but not as speech for a sparse one; the enhanced copy keeps its length',
  { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
    const dir = tempDir(t, 'sira-qloop-real-');
    const piece = path.join(dir, 'seg-0000.flac');
    // lavfi's sine peaks at 1/8 (-18 dBFS); × 0.05 → about -44 dBFS: under the
    // -35 dB speech threshold, over the -50 dB «any sound» one.
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-filter_complex', '[0:a]volume=0.05[s];[1:a]atrim=0:6[z];[z][s]concat=n=2:v=0:a=1[o]',
      '-map', '[o]', '-ar', '16000', '-ac', '1', '-c:a', 'flac', piece]);
    assert.equal(made.status, 0);
    const jc = audio.createJobContext({ options: {}, signal: new AbortController().signal, rungs: [], segmentSeconds: 600 });
    const segment = { path: piece, index: 0, durationSeconds: 14 };
    const sound = await audio.measurePieceEnergy(segment, jc, { thresholdDb: -50 });
    const speech = await audio.measurePieceEnergy(segment, jc, { thresholdDb: -35 });
    assert.ok(sound.voicedSec > 7 && sound.voicedSec < 9, JSON.stringify(sound));
    assert.ok(speech.voicedSec < 1, JSON.stringify(speech));
    const variant = await audio.buildVariantFile(piece, 'dynaudnorm', { name: 'segment-1.flac', durationSeconds: 14 }, {});
    t.after(() => fs.rmSync(variant.dir, { recursive: true, force: true }));
    assert.equal(variant.ok, true);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', variant.path]);
    assert.equal(Math.round(Number(String(probe.stdout).trim())), 14, 'alternative hypotheses keep the piece clock');
  });
