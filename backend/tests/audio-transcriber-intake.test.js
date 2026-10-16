'use strict';

/**
 * Intake half of contract C4 («transcription never fails»):
 *   - every short clip reaches the cloud rungs as ONE mono 16 kHz FLAC master
 *     with a clean name (no .opus/.amr/.mov 400s, no video uploaded);
 *   - the audio track comes from media-probe.chooseAudioStream, or
 *     options.audioStreamOrdinal, and every decode maps it;
 *   - no audio stream → `no_audio_track` (from the probe, or only once a
 *     tolerant, wide-window decode agrees); a missing moov atom →
 *     `truncated_container`; DRM (protected MP4 sample entries) →
 *     `drm_protected`; anything else ffmpeg rejects goes down the ladder
 *     strict → tolerant with the track → tolerant without it;
 *   - every decode that maps a track uses media-probe's discovery window;
 *   - the track and tolerant-read notes appear on successful results only;
 *   - NEW cut plans snap to silences under an adaptive threshold sampled from
 *     a few short windows; existing manifests are reused untouched;
 *   - language: detected unless explicit; unsupported → detected with a note;
 *   - hints.terms join the prompt, device identifiers dropped, capped.
 * Every binary and provider is faked; the real-ffmpeg cases skip without it.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const audio = require('../src/services/audio-transcriber');
const local = require('../src/services/local-whisper-engine');
const { isAudioTranscriptionPlaceholder } = require('../src/services/rag-audio-placeholder-filter');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const execFileAsync = promisify(execFile);

function tempDir(t, prefix = 'sira-intake-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempFile(t, name, bytes = 'fake-media') {
  const file = path.join(tempDir(t), name);
  fs.writeFileSync(file, bytes);
  return file;
}

const createFile = (buffer, name, mime) => ({ name, mime, head: Buffer.from(buffer).subarray(0, 4).toString('latin1') });

function sdk(handler = () => ({ text: 'Hola, ¿cómo estás?', language: 'spanish', segments: [] })) {
  const requests = [];
  return {
    requests,
    audio: { transcriptions: { async create(request) {
      requests.push({ name: request.file.name, mime: request.file.mime, head: request.file.head, language: request.language, prompt: request.prompt });
      return handler(request, requests.length - 1);
    } } },
  };
}

/** A C1 probe result: streams default to plain, untagged tracks. */
function probe(audioStreams, { video = [], subtitles = [], durationSec = 20 } = {}) {
  return {
    ok: true,
    durationSec,
    formatName: 'matroska,webm',
    audio: audioStreams.map((a, i) => ({
      index: i + 1, streamOrdinal: i, codec: 'opus', channels: 2, sampleRate: 48000, language: null, title: null,
      isDefault: false, isComment: false, isVisualImpaired: false, isHearingImpaired: false, isMusic: false, durationSec, ...a,
    })),
    subtitles,
    video,
    hasAudio: audioStreams.length > 0,
    hasVideo: video.some((v) => !v.attachedPic),
    hasTextSubtitles: false,
  };
}

/** options.transcodeClip fake: writes a FLAC-looking master in its own dir. */
function fakeMaster(t, { durationSeconds = 20, tolerant = false, code = null, size = 9, decodeCause = null, streamDropped = false } = {}) {
  const fn = async (filePath, ctx) => {
    fn.calls.push({ filePath, ...ctx });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-intake-master-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fn.dirs.push(dir);
    if (code) return { ok: false, code, dir };
    const out = path.join(dir, 'audio.flac');
    fs.writeFileSync(out, 'fLaC-fake');
    return { ok: true, path: out, dir, size, durationSeconds, tolerant, decodeCause, streamDropped };
  };
  fn.calls = [];
  fn.dirs = [];
  return fn;
}

function child({ code = 0, stderr = '', write = null } = {}) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  queueMicrotask(() => {
    try { write?.(); } catch (error) { c.emit('error', error); return; }
    if (stderr) c.stderr.emit('data', Buffer.from(stderr));
    c.emit('close', code);
  });
  return c;
}

const noLocal = async () => { throw new Error('local must not run'); };
const TOLERANT_NOTE = 'Parte del archivo no se pudo leer con normalidad; usé una lectura tolerante a errores y transcribí lo que se pudo leer.';
const WINDOW = ['-probesize', '100M', '-analyzeduration', '100M'];

test.beforeEach(() => audio.clearTranscriptionCooldowns());

// ── Language ────────────────────────────────────────────────────────────────

test('supported-language whitelist: Whisper languages pass, quechua / aimara / guaraní do not', () => {
  for (const value of ['es', 'en-US', 'portugués', 'pt-BR', 'spanish', 'nb-NO', 'fr']) {
    assert.equal(audio.isSupportedLanguage(value), true, value);
  }
  for (const value of ['quechua', 'que', 'qu', 'quz', 'aimara', 'aymara', 'guaraní', 'gn', 'klingon', '', 'auto']) {
    assert.equal(audio.isSupportedLanguage(value), false, value);
  }
  assert.ok(audio.WHISPER_LANGUAGES.has('es') && audio.WHISPER_LANGUAGES.size >= 99);
});

test('an unsupported explicit language is detected automatically, with a Spanish note, never a 400 storm', async (t) => {
  const groq = sdk();
  const master = fakeMaster(t);
  const result = await audio.transcribe(tempFile(t, 'clase.ogg'), 'audio/ogg', 'clase.ogg', {
    env: { GROQ_API_KEY: 'gsk_intake_qu' }, groqClient: groq, createFile, transcodeClip: master,
    mediaProbe: probe([{ language: 'qu' }]), language: 'quechua', localTranscribe: noLocal,
  });
  assert.equal(result.ok, true);
  assert.equal(groq.requests.length, 1);
  assert.equal(groq.requests[0].language, undefined, 'no language=qu on the wire');
  assert.match(result.notes[0], /^El quechua no está disponible en los motores de transcripción; detecté el idioma automáticamente/);
  assert.equal(result.intake.requestedLanguage, 'qu');
  assert.equal(result.intake.languageSupported, false);
  assert.equal(result.audioStream.reason, 'only_stream');
});

test('short clips and unknown lengths are auto-detected; an explicit supported language is sent', async (t) => {
  const groq = sdk();
  const options = {
    env: { GROQ_API_KEY: 'gsk_intake_lang', WHISPER_LANGUAGE: 'es' }, groqClient: groq, createFile, localTranscribe: noLocal,
  };
  // Unknown length: the master's exact FLAC length settles it (20 s, short).
  await audio.transcribe(tempFile(t, 'a.webm'), 'audio/webm', 'a.webm', {
    ...options, transcodeClip: fakeMaster(t, { durationSeconds: 20 }), mediaProbe: probe([{}], { durationSec: null }), probeAudioDuration: async () => 0,
  });
  await audio.transcribe(tempFile(t, 'b.ogg'), 'audio/ogg', 'b.ogg', { ...options, transcodeClip: fakeMaster(t), durationSeconds: 25 });
  await audio.transcribe(tempFile(t, 'c.ogg'), 'audio/ogg', 'c.ogg', { ...options, transcodeClip: fakeMaster(t), durationSeconds: 25, language: 'en-GB' });
  assert.deepEqual(groq.requests.map((r) => r.language), [undefined, undefined, 'en']);
});

// ── Prompt vocabulary ───────────────────────────────────────────────────────

test('device identifiers are never prompt vocabulary', () => {
  for (const term of ['WA0012', 'PTT-20261003-WA0012', 'AUD-20261003-WA0007', 'GMT20261003', 'REC0042', 'DSC01234', 'MVI_0042',
    'IMG_1234', 'VID-20261003', 'ptt', 'wa0012', '1920x1080', '720p', '2026-10-03', '20261003', '03/10/2026', '15:00', '15h30', '150000', '  ']) {
    assert.equal(audio.isDeviceIdentifier(term), true, term);
  }
  for (const term of ['Huamán', 'Ayacucho', 'Bioquímica', 'Krebs', 'COVID-19', 'Recursos', 'Audio', 'Waldo', 'UPN', 'H2O', 'MP3']) {
    assert.equal(audio.isDeviceIdentifier(term), false, term);
  }
});

test('hints.terms join the file-name key terms: device ids dropped, the user spelling wins, user terms last, capped', () => {
  const options = { keyterms: ['Bioquímica', 'WA0012', 'huamán'], hints: { terms: ['Huamán, Ayacucho', 'GMT20261003', 'Krebs'] } };
  assert.deepEqual(audio.promptTerms(options), ['Bioquímica', 'Huamán', 'Ayacucho', 'Krebs']);
  assert.equal(audio.resolvePrompt({ env: {}, ...options }), 'Bioquímica, Huamán, Ayacucho, Krebs.');
  assert.equal(audio.resolvePrompt({ env: {}, keyterms: ['PTT', 'WA0012'], hints: { terms: '20261003' } }), undefined, 'nothing but device ids → no prompt');

  const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  assert.equal(audio.promptTerms({ hints: { terms: many('Usuario', 60) } }).length, 30, 'at most 30 user terms');
  const merged = audio.promptTerms({ keyterms: many('Archivo', 50), hints: { terms: many('Usuario', 30) } });
  assert.equal(merged.length, 40, 'at most 40 terms in all');
  assert.ok(merged.slice(-30).every((term) => term.startsWith('Usuario')), 'every user term kept, at the end');
});

test('the prompt that reaches the rung carries the user terms and none of the file name\'s device ids', async (t) => {
  const groq = sdk();
  await audio.transcribe(tempFile(t, 'PTT-20261003-WA0012.opus'), 'audio/ogg', 'PTT-20261003-WA0012.opus', {
    env: { GROQ_API_KEY: 'gsk_intake_prompt' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t),
    mediaProbe: probe([{}]), keyterms: ['WA0012'], hints: { terms: ['Huamán', 'Ayacucho'] }, localTranscribe: noLocal,
  });
  assert.equal(groq.requests[0].prompt, 'Huamán, Ayacucho.');
});

// ── Short-clip master ───────────────────────────────────────────────────────

test('a short clip reaches every cloud rung as the FLAC master with a clean name, never the uploaded container', async (t) => {
  const groq = sdk();
  const master = fakeMaster(t, { durationSeconds: 14 });
  const result = await audio.transcribe(tempFile(t, 'nota.opus'), 'audio/opus', 'nota.opus', {
    env: { GROQ_API_KEY: 'gsk_intake_master' }, groqClient: groq, createFile, transcodeClip: master,
    mediaProbe: probe([{ channels: 1 }], { durationSec: 14 }), localTranscribe: noLocal,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(groq.requests.map((r) => [r.name, r.mime, r.head]), [['audio.flac', 'audio/flac', 'fLaC']]);
  assert.equal(master.calls.length, 1);
  assert.equal(master.calls[0].audioStreamOrdinal, 0, 'the chosen track is mapped');
  assert.deepEqual(result.audioStream, { streamOrdinal: 0, reason: 'only_stream' });
  assert.equal(result.intake.master, 'flac');
  assert.equal(result.intake.decode, 'strict');
  assert.equal(result.durationSec, 14);
  assert.equal(fs.existsSync(master.dirs[0]), false, 'the master is removed after the job');
});

test('a master longer than a segment (the length was unknown or wrong) is cut and transcribed segment by segment', async (t) => {
  const groq = sdk((request) => ({ text: `parte ${request.file.name}`, segments: [] }));
  const master = fakeMaster(t, { durationSeconds: 1500 });
  const cutFrom = [];
  const result = await audio.transcribe(tempFile(t, 'larga.amr'), 'audio/amr', 'larga.amr', {
    env: { GROQ_API_KEY: 'gsk_intake_long' }, groqClient: groq, createFile, transcodeClip: master,
    mediaProbe: probe([{}], { durationSec: null }), probeAudioDuration: async () => 0, localTranscribe: noLocal,
    async segmentAudio(filePath) {
      cutFrom.push(filePath);
      const dir = tempDir(t, 'sira-intake-seg-');
      return {
        dir,
        segments: [0, 1, 2].map((i) => {
          const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
          fs.writeFileSync(p, `s${i}`);
          return { path: p, index: i, offsetSeconds: i * 600, durationSeconds: i < 2 ? 600 : 300 };
        }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.segmentCount, 3);
  assert.deepEqual(cutFrom, [path.join(master.dirs[0], 'audio.flac')], 'the cut reads the master, not the original');
  assert.equal(result.durationSec, 1500);
});

test('the master decoded tolerantly is used and the delivery is told so', async (t) => {
  const groq = sdk();
  const result = await audio.transcribe(tempFile(t, 'cortada.m4a'), 'audio/mp4', 'cortada.m4a', {
    env: { GROQ_API_KEY: 'gsk_intake_tolerant' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { tolerant: true }),
    mediaProbe: probe([{}]), localTranscribe: noLocal,
  });
  assert.equal(result.ok, true);
  assert.equal(result.intake.decode, 'tolerant');
  assert.equal(result.intake.decodeCause, 'damaged');
  assert.ok(result.notes.includes(TOLERANT_NOTE));
});

test('a missing moov atom, DRM or a stream-less file end the job at once with an honest code', async (t) => {
  for (const [code, text] of [
    ['truncated_container', /la grabación está incompleta/],
    ['drm_protected', /protegido \(DRM\)/],
    ['no_audio_track', /no tiene pista de audio/],
  ]) {
    const groq = sdk();
    let localCalls = 0;
    const result = await audio.transcribe(tempFile(t, 'video.mp4'), 'video/mp4', 'video.mp4', {
      env: { GROQ_API_KEY: `gsk_intake_${code}` }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code }),
      mediaProbe: { ok: false, error: 'probe_failed' }, durationSeconds: 30,
      async localTranscribe() { localCalls++; return { text: 'no' }; },
    });
    assert.equal(result.ok, false, code);
    assert.equal(result.reasonCode, code);
    assert.equal(result.status, 'failed');
    assert.match(result.text, text);
    assert.equal(isAudioTranscriptionPlaceholder(result.text), true, `${code}: never indexed into RAG as speech`);
    assert.equal(groq.requests.length + localCalls, 0, `${code}: no rung runs`);
  }
});

test('when ffmpeg cannot decode the clip: audio in an accepted container goes as uploaded; a video container never does', async (t) => {
  const groq = sdk();
  const ogg = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { GROQ_API_KEY: 'gsk_intake_raw' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code: 'decode' }),
    mediaProbe: probe([{}]), localTranscribe: noLocal,
  });
  assert.equal(ogg.ok, true);
  assert.deepEqual(groq.requests.map((r) => [r.name, r.mime]), [['nota.ogg', 'audio/ogg']]);
  assert.equal(ogg.intake.master, 'raw');

  const seen = [];
  const mov = await audio.transcribe(tempFile(t, 'clip.mov'), 'video/quicktime', 'clip.mov', {
    env: { GROQ_API_KEY: 'gsk_intake_raw' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code: 'decode' }),
    mediaProbe: probe([{ language: 'es', isDefault: true }, { language: 'en' }], { video: [{ codec: 'h264' }] }),
    async localTranscribe(file, options) { seen.push([path.basename(file), options.audioStreamOrdinal]); return { text: 'hola desde local' }; },
  });
  assert.equal(groq.requests.length, 1, 'no upload of the .mov');
  assert.deepEqual(seen, [['clip.mov', 0]], 'local decodes the original, mapping the chosen track');
  assert.equal(mov.ok, true);
});

test('without ffmpeg the clip goes as uploaded (today\'s behaviour) and the operator is warned once', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const groq = sdk();
  const run = (name, mime) => audio.transcribe(tempFile(t, name), mime, name, {
    env: { GROQ_API_KEY: 'gsk_intake_noffmpeg' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code: 'ffmpeg_missing' }),
    mediaProbe: { ok: false, error: 'probe_failed', reason: 'ffprobe_missing' }, durationSeconds: 20, localTranscribe: noLocal,
  });
  await run('clip.mov', 'video/quicktime');
  await run('otro.mov', 'video/quicktime');
  assert.deepEqual(groq.requests.map((r) => r.name), ['clip.mov', 'otro.mov']);
  const warnings = warn.mock.calls.filter((call) => /ffmpeg is not available/.test(String(call.arguments[0])));
  assert.ok(warnings.length <= 1, 'at most one WARN line for the whole process');
});

test('a local-only clip skips the master; a decode the local engine rejects is repaired once with a tolerant master', async (t) => {
  const master = fakeMaster(t, { tolerant: true });
  const seen = [];
  const original = tempFile(t, 'nota.m4a');
  const result = await audio.transcribe(original, 'audio/mp4', 'nota.m4a', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, transcodeClip: master, mediaProbe: probe([{}]), durationSeconds: 20,
    async localTranscribe(file, options) {
      seen.push([file, options.audioStreamOrdinal]);
      if (file === original) throw Object.assign(new Error('Audio could not be decoded'), { code: 'AUDIO_DECODE_FAILED', cause: { diagnostics: 'Invalid data found when processing input' } });
      return { text: 'transcripción reparada', language: 'es' };
    },
  });
  assert.equal(master.calls.length, 1);
  assert.equal(master.calls[0].tolerantOnly, true, 'the strict decode already failed: straight to tolerant');
  assert.deepEqual(seen, [[original, 0], [path.join(master.dirs[0], 'audio.flac'), undefined]]);
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'transcripción reparada');
  assert.equal(result.intake.master, 'flac');
  assert.equal(result.intake.decode, 'tolerant');

  const plain = fakeMaster(t);
  const ok = await audio.transcribe(tempFile(t, 'bien.wav'), 'audio/wav', 'bien.wav', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, transcodeClip: plain, durationSeconds: 20,
    async localTranscribe() { return { text: 'bien' }; },
  });
  assert.equal(ok.ok, true);
  assert.equal(plain.calls.length, 0, 'no master when nothing needs one');
  assert.equal(ok.intake.probe, 'skipped', 'a measured single-track WAV needs no stream probe');
});

test('local diagnostics name the cause: a missing moov atom is truncated_container, not a generic decode failure', async (t) => {
  const master = fakeMaster(t);
  const result = await audio.transcribe(tempFile(t, 'grabacion.mp4'), 'video/mp4', 'grabacion.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, transcodeClip: master, mediaProbe: { ok: false, error: 'probe_failed' }, durationSeconds: 20,
    async localTranscribe() {
      throw Object.assign(new Error('Audio could not be decoded'), {
        code: 'AUDIO_DECODE_FAILED', cause: { diagnostics: '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found' },
      });
    },
  });
  assert.equal(result.reasonCode, 'truncated_container');
  assert.equal(master.calls.length, 0, 'nothing to repair');
});

test('aborting while the master is built rejects without running any rung', async (t) => {
  const controller = new AbortController();
  const groq = sdk();
  const pending = audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { GROQ_API_KEY: 'gsk_intake_abort' }, groqClient: groq, createFile, mediaProbe: probe([{}]), signal: controller.signal,
    transcodeClip: (_file, _ctx, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted by user'), { name: 'AbortError' })), { once: true });
      controller.abort();
    }),
    localTranscribe: noLocal,
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(groq.requests.length, 0);
});

// ── buildClipMaster with fake processes ─────────────────────────────────────

function ffmpegScript(steps) {
  const calls = [];
  const spawnImpl = (bin, args) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push({ bin, args });
    if (step.enoent) return child({ write: () => { throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }); } });
    if (step.hang) {
      const c = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = (signal) => { c.killed = signal; };
      step.onSpawn?.(args);
      return c;
    }
    return child({ code: step.code || 0, stderr: step.stderr || '', write: step.code ? null : () => fs.writeFileSync(args.at(-1), 'fLaC-real-enough') });
  };
  return { calls, spawnImpl };
}

const ffprobeLength = (seconds) => async (bin) => {
  if (path.basename(bin) === 'ffprobe') return { stdout: `${seconds}\n`, stderr: '' };
  throw new Error(`unexpected ${bin}`);
};

test('buildClipMaster: a strict decode ffmpeg rejects gets ONE tolerant pass, mapping the chosen track', async (t) => {
  const { calls, spawnImpl } = ffmpegScript([{ code: 1, stderr: 'nota.amr: Invalid data found when processing input\n' }, {}]);
  const master = await audio.buildClipMaster(tempFile(t, 'nota.amr'), { audioStreamOrdinal: 1, fileName: 'nota.amr', durationSeconds: 12 }, {
    env: {}, spawnImpl, execFileImpl: ffprobeLength('12.480000'),
  });
  t.after(() => fs.rmSync(master.dir, { recursive: true, force: true }));
  assert.equal(master.ok, true);
  assert.equal(master.tolerant, true);
  assert.equal(master.durationSeconds, 12.48);
  assert.equal(path.basename(master.path), 'audio.flac');
  assert.equal(calls.length, 2);
  const [strict, tolerant] = calls.map((c) => c.args);
  assert.ok(!strict.includes('-err_detect'));
  for (const args of [strict, tolerant]) {
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:a:1']);
    assert.deepEqual(args.slice(args.indexOf('-ac'), args.indexOf('-ac') + 6), ['-ac', '1', '-ar', '16000', '-c:a', 'flac']);
    assert.ok(args.includes('-vn') && args.includes('-sn') && args.includes('-dn'));
  }
  const input = tolerant.indexOf('-i');
  assert.deepEqual(tolerant.slice(input - 8, input), ['-err_detect', 'ignore_err', '-fflags', '+discardcorrupt+genpts', '-probesize', '100M', '-analyzeduration', '100M']);
});

test('buildClipMaster: moov / DRM / resource / missing ffmpeg are answered without a tolerant pass', async (t) => {
  const cases = [
    [{ code: 183, stderr: '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\nError opening input files: Invalid data found when processing input\n' }, 'video.mp4', 'truncated_container'],
    [{ code: 1, stderr: 'Invalid data found when processing input\n' }, 'cancion.m4p', 'drm_protected'],
    [{ code: 1, stderr: 'Error: activation_bytes option is missing\n' }, 'libro.m4b', 'drm_protected'],
    [{ code: 1, stderr: 'av_interleaved_write_frame(): No space left on device\n' }, 'nota.ogg', 'resource'],
    [{ enoent: true }, 'nota.ogg', 'ffmpeg_missing'],
  ];
  for (const [step, name, code] of cases) {
    const { calls, spawnImpl } = ffmpegScript([step]);
    const master = await audio.buildClipMaster(tempFile(t, name), { fileName: name }, { env: {}, spawnImpl, execFileImpl: ffprobeLength(5) });
    if (master.dir) t.after(() => fs.rmSync(master.dir, { recursive: true, force: true }));
    assert.equal(master.ok, false, name);
    assert.equal(master.code, code, name);
    assert.equal(calls.length, 1, `${name}: no tolerant retry`);
  }
});

test('buildClipMaster: «no stream» from the strict, default-window pass is not conclusive until the tolerant pass agrees', async (t) => {
  const noStream = { code: 234, stderr: '[out#0/flac @ 0x1] Output file does not contain any stream\n' };
  const late = ffmpegScript([noStream, {}]);
  const found = await audio.buildClipMaster(tempFile(t, 'camara.mpg'), { fileName: 'camara.mpg' }, { env: {}, spawnImpl: late.spawnImpl, execFileImpl: ffprobeLength(10) });
  t.after(() => fs.rmSync(found.dir, { recursive: true, force: true }));
  assert.equal(found.ok, true, 'audio that starts after the default window is found by the wide one');
  assert.equal(found.tolerant, true);
  assert.equal(found.decodeCause, 'stream_window');
  assert.equal(found.streamDropped, false);
  assert.equal(late.calls.length, 2);
  assert.ok(late.calls[1].args.includes('-err_detect'));

  const none = ffmpegScript([noStream]);
  const empty = await audio.buildClipMaster(tempFile(t, 'pantalla.mp4'), { fileName: 'pantalla.mp4' }, { env: {}, spawnImpl: none.spawnImpl, execFileImpl: ffprobeLength(5) });
  t.after(() => fs.rmSync(empty.dir, { recursive: true, force: true }));
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'no_audio_track', 'conclusive once the tolerant pass agrees');
  assert.equal(none.calls.length, 2);
});

test('buildClipMaster: a track ffmpeg does not see is retried tolerantly WITH the map, and only then without it', async (t) => {
  const missing = { code: 234, stderr: "Stream map '0:a:3' matches no streams.\n" };
  const seen = ffmpegScript([missing, {}]);
  const kept = await audio.buildClipMaster(tempFile(t, 'v.mkv'), { audioStreamOrdinal: 3, fileName: 'v.mkv' }, {
    env: {}, spawnImpl: seen.spawnImpl, execFileImpl: ffprobeLength(30),
  });
  t.after(() => fs.rmSync(kept.dir, { recursive: true, force: true }));
  assert.equal(kept.ok, true);
  assert.equal(kept.streamDropped, false, 'the wide window saw the track: it is still the one transcribed');
  assert.equal(kept.decodeCause, 'stream_window');
  assert.equal(seen.calls.length, 2);
  for (const { args } of seen.calls) assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:a:3']);
  assert.deepEqual(seen.calls[0].args.slice(seen.calls[0].args.indexOf('-i') - 4, seen.calls[0].args.indexOf('-i')), WINDOW, 'the strict pass maps under media-probe\'s window');
  assert.ok(seen.calls[1].args.includes('-err_detect'));

  const never = ffmpegScript([missing, missing, {}]);
  const dropped = await audio.buildClipMaster(tempFile(t, 'w.mkv'), { audioStreamOrdinal: 3, fileName: 'w.mkv' }, {
    env: {}, spawnImpl: never.spawnImpl, execFileImpl: ffprobeLength(30),
  });
  t.after(() => fs.rmSync(dropped.dir, { recursive: true, force: true }));
  assert.equal(dropped.ok, true);
  assert.equal(dropped.streamDropped, true);
  assert.equal(never.calls.length, 3);
  assert.ok(never.calls[2].args.includes('-err_detect') && !never.calls[2].args.includes('-map'));

  const plain = ffmpegScript([{}]);
  const unmapped = await audio.buildClipMaster(tempFile(t, 'x.ogg'), { fileName: 'x.ogg' }, { env: {}, spawnImpl: plain.spawnImpl, execFileImpl: ffprobeLength(3) });
  t.after(() => fs.rmSync(unmapped.dir, { recursive: true, force: true }));
  assert.ok(!plain.calls[0].args.includes('-probesize') && !plain.calls[0].args.includes('-map'), 'no track: today\'s strict decode');
});

test('buildClipMaster: a host-side failure of the tolerant pass is not a verdict on the media; a decode rejection is', async (t) => {
  const host = ffmpegScript([{ code: 1, stderr: 'No space left on device\n' }]);
  const disk = await audio.buildClipMaster(tempFile(t, 'a.mp4'), { fileName: 'a.mp4' }, { env: {}, spawnImpl: host.spawnImpl, execFileImpl: ffprobeLength(3) });
  t.after(() => fs.rmSync(disk.dir, { recursive: true, force: true }));
  assert.equal(disk.code, 'resource');
  const bad = ffmpegScript([{ code: 1, stderr: 'Invalid data found when processing input\n' }, { code: 1, stderr: 'No space left on device\n' }]);
  const rejected = await audio.buildClipMaster(tempFile(t, 'b.mp4'), { fileName: 'b.mp4' }, { env: {}, spawnImpl: bad.spawnImpl, execFileImpl: ffprobeLength(3) });
  t.after(() => fs.rmSync(rejected.dir, { recursive: true, force: true }));
  assert.equal(rejected.code, 'decode', 'the strict pass already said ffmpeg cannot read this file');
});

test('buildClipMaster: tolerantOnly starts at the tolerant pass, told how the strict decode failed', async (t) => {
  const { calls, spawnImpl } = ffmpegScript([{}]);
  const master = await audio.buildClipMaster(tempFile(t, 'v.mpg'), { fileName: 'v.mpg', tolerantOnly: true, strictVerdict: 'no_audio_track' }, {
    env: {}, spawnImpl, execFileImpl: ffprobeLength(8),
  });
  t.after(() => fs.rmSync(master.dir, { recursive: true, force: true }));
  assert.equal(master.ok, true);
  assert.equal(master.decodeCause, 'stream_window');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('-err_detect'));
});

test('buildClipMaster: abort kills ffmpeg and removes its temp dir', async (t) => {
  const controller = new AbortController();
  let out;
  const { spawnImpl } = ffmpegScript([{ hang: true, onSpawn: (args) => { out = args.at(-1); queueMicrotask(() => controller.abort()); } }]);
  await assert.rejects(audio.buildClipMaster(tempFile(t, 'nota.ogg'), { fileName: 'nota.ogg' }, { env: {}, spawnImpl, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fs.existsSync(path.dirname(out)), false);
});

// ── Track choice ────────────────────────────────────────────────────────────

test('the track comes from chooseAudioStream (language, then disposition), or from options.audioStreamOrdinal', async (t) => {
  const streams = probe([
    { language: 'es', isDefault: true, title: 'Español' },
    { language: 'en', title: 'English' },
    { language: 'es', title: 'Comentarios del director', isComment: true },
  ], { video: [{ codec: 'h264' }] });
  const run = async (extra) => {
    const master = fakeMaster(t);
    const result = await audio.transcribe(tempFile(t, 'pelicula.mkv'), 'video/x-matroska', 'pelicula.mkv', {
      env: { GROQ_API_KEY: 'gsk_intake_track' }, groqClient: sdk(), createFile, transcodeClip: master, mediaProbe: streams,
      localTranscribe: noLocal, ...extra,
    });
    return { result, mapped: master.calls[0]?.audioStreamOrdinal };
  };
  const english = await run({ language: 'en' });
  assert.equal(english.mapped, 1);
  assert.deepEqual(english.result.audioStream, { streamOrdinal: 1, reason: 'language_match' });
  assert.equal(english.result.notes[0], 'El archivo tiene 3 pistas de audio; transcribí la pista 2 (inglés).');
  assert.equal(english.result.intake.audioStreams, 3);

  const byDefault = await run({});
  assert.deepEqual(byDefault.result.audioStream, { streamOrdinal: 0, reason: 'default_disposition' });

  const requested = await run({ audioStreamOrdinal: 2 });
  assert.equal(requested.mapped, 2);
  assert.deepEqual(requested.result.audioStream, { streamOrdinal: 2, reason: 'requested' });

  const missing = await run({ audioStreamOrdinal: 7 });
  assert.equal(missing.mapped, 0, 'a track that does not exist falls back to the automatic choice');
  assert.match(missing.result.notes[0], /La pista de audio pedida \(8\) no existe/);
});

test('a probe that shows no audio stream ends as no_audio_track before any decode; text-art «video» proves nothing', async (t) => {
  const master = fakeMaster(t);
  const groq = sdk();
  const silent = await audio.transcribe(tempFile(t, 'pantalla.mp4'), 'video/mp4', 'pantalla.mp4', {
    env: { GROQ_API_KEY: 'gsk_intake_noaudio' }, groqClient: groq, createFile, transcodeClip: master,
    mediaProbe: probe([], { video: [{ codec: 'h264', width: 1920, height: 1080 }], durationSec: 312.5 }), localTranscribe: noLocal,
  });
  assert.equal(silent.reasonCode, 'no_audio_track');
  assert.equal(silent.ok, false);
  assert.equal(silent.durationSec, 312.5);
  assert.equal(silent.audioStream, null);
  assert.equal(master.calls.length + groq.requests.length, 0);

  const textArt = await audio.transcribe(tempFile(t, 'raro.ogg'), 'audio/ogg', 'raro.ogg', {
    env: { GROQ_API_KEY: 'gsk_intake_noaudio' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t),
    mediaProbe: probe([], { video: [{ codec: 'ansi' }] }), localTranscribe: noLocal,
  });
  assert.equal(textArt.ok, true, 'an inconclusive probe never invents «no audio»');
});

test('segmented jobs: FLAC pieces are never mapped again; the local whole-file decode of the original is', async (t) => {
  const seen = [];
  await audio.transcribe(tempFile(t, 'clase.mkv'), 'video/x-matroska', 'clase.mkv', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, durationSeconds: 1800, audioStreamOrdinal: 1,
    mediaProbe: probe([{ language: 'es' }, { language: 'en' }], { video: [{ codec: 'h264' }] }),
    async segmentAudio() {
      const dir = tempDir(t, 'sira-intake-seg-');
      return { dir, segments: [0, 1, 2].map((i) => { const p = path.join(dir, `seg-${i}.flac`); fs.writeFileSync(p, 'x'); return { path: p, index: i, offsetSeconds: i * 600 }; }) };
    },
    async localTranscribe(file, options) { seen.push(options.audioStreamOrdinal); return { text: `parte ${seen.length}` }; },
  });
  assert.deepEqual(seen, [undefined, undefined, undefined]);
});

test('local whisper: convertToWav maps the requested track, and only when one is given', async (t) => {
  const dir = tempDir(t);
  const seen = [];
  const spawnImpl = (_bin, args) => { seen.push(args); return child({ write: () => fs.writeFileSync(args.at(-1), 'wav') }); };
  await local.convertToWav('/in/pelicula.mkv', path.join(dir, 'a.wav'), { spawnImpl, audioStreamOrdinal: 2 });
  await local.convertToWav('/in/pelicula.mkv', path.join(dir, 'b.wav'), { spawnImpl });
  await local.convertToWav('/in/pelicula.mkv', path.join(dir, 'c.wav'), { spawnImpl, audioStreamOrdinal: -1 });
  const [mapped, plain, invalid] = seen;
  const at = mapped.indexOf('-map');
  assert.deepEqual(mapped.slice(at, at + 2), ['-map', '0:a:2']);
  assert.ok(at > mapped.indexOf('-i') && at < mapped.indexOf('-vn'), 'an output option, before the stream filters');
  assert.deepEqual(mapped.slice(mapped.indexOf('-i') - 4, mapped.indexOf('-i')), WINDOW, 'the ordinal is read under media-probe\'s window');
  assert.ok(!plain.includes('-map') && !invalid.includes('-map'));
  assert.ok(!plain.includes('-probesize') && !invalid.includes('-probesize'), 'no track: today\'s decode');
  assert.deepEqual(local.audioStreamMapArgs('1'), ['-map', '0:a:1']);
  assert.deepEqual(local.audioStreamProbeArgs(1), WINDOW);
  assert.deepEqual(local.audioStreamProbeArgs(undefined), []);
});

// ── Segment cut: tolerant decode, intake verdicts, adaptive silences ────────

/**
 * Fake ffmpeg for cutAndMeasure: the segment call fails/succeeds per `cuts`,
 * a success writes `pieces` FLAC files; finalize calls write their output.
 */
function fakeCutter({ cuts, pieces = 3 }) {
  const segmentCalls = [];
  const spawnImpl = (_bin, args) => {
    if (args.includes('segment')) {
      const step = cuts[Math.min(segmentCalls.length, cuts.length - 1)];
      segmentCalls.push(args);
      const pattern = args.at(-1);
      return child({
        code: step.code || 0,
        stderr: step.stderr || '',
        write: () => {
          if (step.partial) fs.writeFileSync(pattern.replace('%04d', '0000'), 'partial');
          if (step.code) return;
          for (let i = 0; i < pieces; i++) fs.writeFileSync(pattern.replace('%04d', String(i).padStart(4, '0')), `piece-${i}`);
        },
      });
    }
    return child({ write: () => fs.writeFileSync(args.at(-1), 'fixed') });
  };
  return { segmentCalls, spawnImpl };
}

const cutOptions = (extra = {}) => ({
  env: {},
  execFileImpl: ffprobeLength('600.000000'),
  estimateSilenceThreshold: async () => ({ thresholdDb: -35, adaptive: false, windows: 0 }),
  detectSilences: async () => [],
  ...extra,
});

test('cutAndMeasure: a strict cut ffmpeg rejects is cleaned and retried tolerantly; the report says so', async (t) => {
  const dir = tempDir(t);
  const { segmentCalls, spawnImpl } = fakeCutter({ cuts: [{ code: 1, stderr: 'Invalid data found when processing input\n', partial: true }, {}] });
  const report = {};
  const segments = await audio.cutAndMeasure('/media/clase.ts', dir, { segmentSeconds: 600, durationSeconds: 1800, audioStreamOrdinal: 0, report }, cutOptions({ spawnImpl }));
  assert.equal(segments.length, 3);
  assert.equal(report.decode, 'tolerant');
  assert.equal(segmentCalls.length, 2);
  assert.ok(!segmentCalls[0].includes('-err_detect') && segmentCalls[1].includes('-err_detect'));
  for (const args of segmentCalls) assert.ok(args.includes('0:a:0'), 'both passes map the chosen track');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.flac')).sort(), ['seg-0000.flac', 'seg-0001.flac', 'seg-0002.flac']);
});

test('cutAndMeasure: moov/DRM/no-stream become intake errors; a full disk is not retried', async (t) => {
  for (const [stderr, code, passes] of [
    ['[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\n', 'truncated_container', 1],
    // «No stream» needs the tolerant, wide-window pass to agree.
    ['Output file does not contain any stream\n', 'no_audio_track', 2],
  ]) {
    const { segmentCalls, spawnImpl } = fakeCutter({ cuts: [{ code: 1, stderr }] });
    await assert.rejects(
      audio.cutAndMeasure('/media/x.mp4', tempDir(t), { segmentSeconds: 600, durationSeconds: 1800 }, cutOptions({ spawnImpl })),
      (err) => err.intakeCode === code,
    );
    assert.equal(segmentCalls.length, passes, code);
  }
  const disk = fakeCutter({ cuts: [{ code: 1, stderr: 'No space left on device\n' }] });
  await assert.rejects(
    audio.cutAndMeasure('/media/x.mp4', tempDir(t), { segmentSeconds: 600, durationSeconds: 1800 }, cutOptions({ spawnImpl: disk.spawnImpl })),
    (err) => err.code === 'SEGMENT_FAILED' && !err.intakeCode,
  );
  assert.equal(disk.segmentCalls.length, 1);
});

test('a long file whose cut finds a missing moov atom ends as truncated_container, not a transient local_unavailable', async (t) => {
  const { spawnImpl } = fakeCutter({ cuts: [{ code: 183, stderr: 'moov atom not found\n' }] });
  const result = await audio.transcribe(tempFile(t, 'clase.mp4'), 'video/mp4', 'clase.mp4', {
    ...cutOptions({ spawnImpl }), env: { TRANSCRIBE_PROVIDERS: 'local' }, durationSeconds: 5400, mediaProbe: { ok: false },
    localTranscribe: noLocal,
  });
  assert.equal(result.reasonCode, 'truncated_container');
});

test('a long file cut tolerantly is transcribed in full and the delivery is told so', async (t) => {
  const { spawnImpl } = fakeCutter({ cuts: [{ code: 1, stderr: 'Invalid data found when processing input\n' }, {}] });
  const result = await audio.transcribe(tempFile(t, 'clase.ts'), 'video/mp2t', 'clase.ts', {
    ...cutOptions({ spawnImpl }), env: { TRANSCRIBE_PROVIDERS: 'local' }, language: 'es', durationSeconds: 1800,
    mediaProbe: probe([{}], { video: [{ codec: 'h264' }], durationSec: 1800 }),
    async localTranscribe(file) { return { text: `bloque ${path.basename(file)}` }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.segmentCount, 3);
  assert.equal(result.intake.decode, 'tolerant');
  assert.ok(result.notes.includes(TOLERANT_NOTE));
});

test('cutAndMeasure hands the adaptive threshold and the track to silence detection', async (t) => {
  const { segmentCalls, spawnImpl } = fakeCutter({ cuts: [{}] });
  let silenceOptions;
  const report = {};
  await audio.cutAndMeasure('/media/clase.mkv', tempDir(t), { segmentSeconds: 600, durationSeconds: 1800, audioStreamOrdinal: 1, report }, cutOptions({
    spawnImpl,
    estimateSilenceThreshold: async (_file, ctx) => ({ thresholdDb: -24, adaptive: true, noiseFloorDb: -32, speechPeakDb: -6, windows: 5, ctx }),
    detectSilences: async (_file, options) => { silenceOptions = options; return [{ start: 590, end: 592 }, { start: 1150, end: 1152 }]; },
  }));
  assert.equal(silenceOptions.silenceThresholdDb, -24);
  assert.equal(silenceOptions.silenceStreamOrdinal, 1);
  assert.equal(report.silence.ctx.audioStreamOrdinal, 1);
  assert.equal(report.silence.thresholdDb, -24);
  const times = segmentCalls[0][segmentCalls[0].indexOf('-segment_times') + 1];
  assert.equal(times, '591,1151,1751', 'cuts snap to the pauses the adaptive threshold found');
});

test('silence detection: -35 dB keeps today\'s exact filter; a threshold and a track shape the decode', async () => {
  // detectSilences is internal: exercise it through cuts with a fake ffmpeg.
  const seen = [];
  const execFileImpl = async (_bin, args) => { seen.push(args); return { stdout: '', stderr: '[silencedetect @ 0x1] silence_start: 10\n[silencedetect @ 0x1] silence_end: 11 | silence_duration: 1\n' }; };
  const { spawnImpl } = fakeCutter({ cuts: [{}] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-intake-filter-'));
  try {
    await audio.cutAndMeasure('/media/a.mkv', dir, { segmentSeconds: 600, durationSeconds: 1800 }, {
      env: {}, spawnImpl, execFileImpl: async (bin, args, opts) => (path.basename(bin) === 'ffprobe' ? { stdout: '600\n', stderr: '' } : execFileImpl(bin, args, opts)),
      estimateSilenceThreshold: async () => ({ thresholdDb: -35, adaptive: false }),
    });
    await audio.cutAndMeasure('/media/a.mkv', dir, { segmentSeconds: 600, durationSeconds: 1800, audioStreamOrdinal: 2 }, {
      env: {}, spawnImpl, execFileImpl: async (bin, args, opts) => (path.basename(bin) === 'ffprobe' ? { stdout: '600\n', stderr: '' } : execFileImpl(bin, args, opts)),
      estimateSilenceThreshold: async () => ({ thresholdDb: -22, adaptive: true }),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const [legacy, adaptive] = seen.filter((args) => args.includes('-af'));
  assert.equal(legacy[legacy.indexOf('-af') + 1], 'silencedetect=noise=-35dB:d=0.4');
  assert.ok(!legacy.includes('-map'));
  assert.equal(adaptive[adaptive.indexOf('-af') + 1], 'silencedetect=noise=-22dB:d=0.4');
  assert.deepEqual(adaptive.slice(adaptive.indexOf('-map'), adaptive.indexOf('-map') + 2), ['-map', '0:a:2']);
  assert.deepEqual(adaptive.slice(adaptive.indexOf('-i') - 4, adaptive.indexOf('-i')), WINDOW);
  assert.ok(!legacy.includes('-probesize'));
});

/** s16le PCM: `quiet` frames at amplitude `low`, then `loud` frames at `high`. */
function pcm({ quiet, loud, low, high }) {
  const frames = quiet + loud;
  const buf = Buffer.alloc(frames * 800 * 2);
  for (let f = 0; f < frames; f++) {
    const amp = f < quiet ? low : high;
    for (let i = 0; i < 800; i++) buf.writeInt16LE(i % 2 ? amp : -amp, (f * 800 + i) * 2);
  }
  return buf;
}

test('silenceThresholdFromPeaks: only ever raises -35 dB, 8 dB over the room, never within 6 dB of the speech', () => {
  const peaks = (low, high, n = 100) => Array.from({ length: n }, (_, i) => (i < n * 0.2 ? low : high));
  const db = (v) => Math.round(32768 * 10 ** (v / 20));
  const clean = audio.silenceThresholdFromPeaks(peaks(db(-70), db(-8)));
  assert.equal(clean.thresholdDb, -35);
  assert.equal(clean.adaptive, false, 'a clean room keeps today\'s plan');
  const cafe = audio.silenceThresholdFromPeaks(peaks(db(-30), db(-6)));
  assert.equal(cafe.thresholdDb, -22);
  assert.equal(cafe.adaptive, true);
  assert.equal(cafe.noiseFloorDb, -30);
  assert.equal(audio.silenceThresholdFromPeaks(peaks(db(-12), db(-3))).thresholdDb, -20, 'capped at -20 dB');
  assert.equal(audio.silenceThresholdFromPeaks(peaks(db(-32), db(-25))).thresholdDb, -31, 'low SNR: the speech margin wins');
  assert.equal(audio.silenceThresholdFromPeaks(peaks(db(-30), db(-6), 10)).thresholdDb, -35, 'too few frames: default');
  assert.deepEqual(audio.framePeaks(pcm({ quiet: 2, loud: 1, low: 100, high: 9000 })), [100, 100, 9000]);
});

test('estimateSilenceThreshold samples a few short windows with input seeking — never a full decode', async () => {
  const calls = [];
  const execFileImpl = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout: pcm({ quiet: 48, loud: 192, low: 1036, high: 16384 }), stderr: Buffer.alloc(0) };
  };
  const estimate = await audio.estimateSilenceThreshold('/media/clase.mkv', { durationSeconds: 18000, audioStreamOrdinal: 2 }, { env: {}, execFileImpl });
  assert.equal(calls.length, 5, 'five windows for a 5-hour file');
  for (const { args, opts } of calls) {
    assert.ok(args.indexOf('-ss') < args.indexOf('-i') && args.indexOf('-t') < args.indexOf('-i'), 'input seeking');
    assert.equal(args[args.indexOf('-t') + 1], '12.000');
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:a:2']);
    assert.ok(args.indexOf('-probesize') > -1 && args.indexOf('-probesize') < args.indexOf('-i'), 'the mapped ordinal is read under media-probe\'s window');
    assert.deepEqual(args.slice(-5), ['-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']);
    assert.equal(opts.encoding, 'buffer');
    assert.ok(opts.maxBuffer <= 12 * 16000 * 2 + 64 * 1024);
  }
  const starts = calls.map(({ args }) => Number(args[args.indexOf('-ss') + 1]));
  assert.deepEqual(starts, [1794, 5394, 8994, 12594, 16194], 'spread over the whole recording');
  assert.equal(estimate.thresholdDb, -22);
  assert.equal(estimate.adaptive, true);
  assert.equal(estimate.windows, 5);
});

test('estimateSilenceThreshold degrades to -35 dB: failed windows, the kill switch, no length; abort still aborts', async () => {
  let n = 0;
  const flaky = await audio.estimateSilenceThreshold('/m', { durationSeconds: 3600 }, {
    env: {}, execFileImpl: async () => { n++; if (n % 2) throw new Error('ffmpeg exited 1'); return { stdout: pcm({ quiet: 30, loud: 120, low: 1036, high: 16384 }) }; },
  });
  assert.equal(flaky.windows, 2, 'a window that fails only costs precision');
  assert.equal(flaky.thresholdDb, -22);

  let calls = 0;
  const off = await audio.estimateSilenceThreshold('/m', { durationSeconds: 3600 }, { env: { TRANSCRIBE_ADAPTIVE_SILENCE: '0' }, execFileImpl: async () => { calls++; return {}; } });
  const unknown = await audio.estimateSilenceThreshold('/m', { durationSeconds: 0 }, { env: {}, execFileImpl: async () => { calls++; return {}; } });
  assert.equal(calls, 0);
  assert.equal(off.thresholdDb, -35);
  assert.equal(unknown.thresholdDb, -35);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(audio.estimateSilenceThreshold('/m', { durationSeconds: 3600 }, { env: {}, signal: controller.signal, execFileImpl: async () => ({}) }), { name: 'AbortError' });
});

// ── Manifest durability ─────────────────────────────────────────────────────

test('planOf keeps the original hash formula unless a multi-stream (or requested) track must be named', () => {
  const segments = [{ offsetSeconds: 0 }, { offsetSeconds: 591.25 }, { offsetSeconds: 1151 }];
  const legacy = crypto.createHash('sha1').update(JSON.stringify({ v: 1, s: 600, o: [0, 591250, 1151000] })).digest('hex').slice(0, 16);
  assert.equal(audio.planOf(segments, 600).hash, legacy);
  assert.equal(audio.planOf(segments, 600, null).hash, legacy);
  assert.equal(audio.planOf(segments, 600, { streamOrdinal: 0, streams: 1 }).hash, legacy, 'a single-stream file: same plan as before');
  const multi = audio.planOf(segments, 600, { streamOrdinal: 1, streams: 2 }).hash;
  assert.notEqual(multi, legacy);
  assert.notEqual(audio.planOf(segments, 600, { streamOrdinal: 0, streams: 2 }).hash, multi);
  assert.notEqual(audio.planOf(segments, 600, { streamOrdinal: 0, streams: 1, explicit: true }).hash, legacy);
});

function writeManifest(t, { audioStream } = {}) {
  const root = tempDir(t, 'sira-intake-ckpt-');
  const dir = path.join(root, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const files = ['seg-0000.flac', 'seg-0001.flac'];
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'piece');
  const segments = [{ offsetSeconds: 0 }, { offsetSeconds: 600 }];
  const manifest = {
    version: 1, format: 'flac', segmentSeconds: 600, sourceSize: 1234, durationSeconds: 1200, total: 2, files,
    offsets: [0, 600], durations: [600, 600], plan: audio.planOf(segments, 600, audioStream || null), language: null,
    ...(audioStream ? { audioStream } : {}),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}

const forbiddenIo = {
  spawnImpl: () => { throw Object.assign(new Error('re-cut attempted'), { code: 'RECUT' }); },
  execFileImpl: async () => { throw Object.assign(new Error('ffmpeg/ffprobe called'), { code: 'RECUT' }); },
};

test('a manifest written before tracks were recorded is reused untouched, whatever track the job now picks', async (t) => {
  const { root, manifest } = writeManifest(t);
  const prepared = await audio.prepareSegments('/media/clase.mkv', { env: {}, checkpoint: { dir: root }, ...forbiddenIo }, {
    segmentSeconds: 600, fileSize: 1234, durationSeconds: 1200, audioStream: { streamOrdinal: 1, reason: 'language_match', streams: 2 },
  });
  assert.equal(prepared.reused, true, 'a job in flight across the deploy resumes');
  assert.equal(prepared.plan.hash, manifest.plan.hash, 'its checkpointed parts still match');
  assert.deepEqual(prepared.cutInfo, { audioStream: null, decode: null, decodeCause: null, silence: null, streamDropped: false, reused: true });
});

test('a manifest is reused only for the track it records; an explicit track never reuses an unrecorded cut', async (t) => {
  const recorded = { streamOrdinal: 0, reason: 'default_disposition', streams: 2, explicit: false };
  const { root } = writeManifest(t, { audioStream: recorded });
  const same = await audio.prepareSegments('/media/clase.mkv', { env: {}, checkpoint: { dir: root }, ...forbiddenIo }, {
    segmentSeconds: 600, fileSize: 1234, audioStream: recorded,
  });
  assert.equal(same.reused, true);
  assert.equal(same.cutInfo.audioStream.streamOrdinal, 0);
  await assert.rejects(audio.prepareSegments('/media/clase.mkv', { env: {}, checkpoint: { dir: root }, ...forbiddenIo }, {
    segmentSeconds: 600, fileSize: 1234, audioStream: { streamOrdinal: 1, reason: 'language_match', streams: 2 },
  }), { message: /re-cut attempted|ffmpeg\/ffprobe called/ });

  const legacy = writeManifest(t);
  await assert.rejects(audio.prepareSegments('/media/clase.mkv', { env: {}, checkpoint: { dir: legacy.root }, ...forbiddenIo }, {
    segmentSeconds: 600, fileSize: 1234, audioStream: { streamOrdinal: 1, reason: 'requested', streams: 2, explicit: true },
  }), { message: /re-cut attempted|ffmpeg\/ffprobe called/ });
});

// ── Honest notes, raw uploads, the repair, DRM ──────────────────────────────

const twoTrackMovie = () => probe([{ language: 'es', isDefault: true }, { language: 'en' }], { video: [{ codec: 'h264' }] });

test('a failed result never claims a track or a tolerant read; the notes that stay true are kept', async (t) => {
  const quiet = await audio.transcribe(tempFile(t, 'cortada.m4a'), 'audio/mp4', 'cortada.m4a', {
    env: { GROQ_API_KEY: 'gsk_notes_quiet' }, groqClient: sdk(() => ({ text: '', segments: [] })), createFile,
    transcodeClip: fakeMaster(t, { tolerant: true }), mediaProbe: probe([{}]), localTranscribe: noLocal,
  });
  assert.equal(quiet.ok, false);
  assert.equal(quiet.intake.decode, 'tolerant', 'the machine-readable record still says how it was read');
  assert.ok(!quiet.notes.includes(TOLERANT_NOTE), 'nothing was transcribed: no «transcribí lo que se pudo leer»');

  const failing = sdk(() => { throw Object.assign(new Error('upstream exploded'), { status: 500 }); });
  const failed = await audio.transcribe(tempFile(t, 'pelicula.mkv'), 'video/x-matroska', 'pelicula.mkv', {
    env: { GROQ_API_KEY: 'gsk_notes_fail' }, groqClient: failing, createFile, transcodeClip: fakeMaster(t, { tolerant: true }),
    mediaProbe: twoTrackMovie(), language: 'quechua', audioStreamOrdinal: 5,
    async localTranscribe() { throw Object.assign(new Error('whisper.cpp exited 1'), { code: 'LOCAL_WHISPER_UNAVAILABLE' }); },
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.notes.some((n) => /quechua no está disponible/.test(n)), 'still true on a failure');
  assert.ok(failed.notes.some((n) => /La pista de audio pedida \(6\) no existe/.test(n)), 'still true on a failure');
  assert.ok(!failed.notes.some((n) => /transcribí la pista/.test(n)));
  assert.ok(!failed.notes.includes(TOLERANT_NOTE));
});

test('a tolerant read that only widened the stream window is not reported as damage', async (t) => {
  const result = await audio.transcribe(tempFile(t, 'camara.mpg'), 'video/mpeg', 'camara.mpg', {
    env: { GROQ_API_KEY: 'gsk_notes_window' }, groqClient: sdk(), createFile,
    transcodeClip: fakeMaster(t, { tolerant: true, decodeCause: 'stream_window' }),
    mediaProbe: { ok: false, error: 'probe_failed' }, durationSeconds: 20, localTranscribe: noLocal,
  });
  assert.equal(result.ok, true);
  assert.equal(result.intake.decode, 'tolerant');
  assert.equal(result.intake.decodeCause, 'stream_window');
  assert.deepEqual(result.notes, []);
});

test('a master that fell back to ffmpeg\'s default stream never reports the chosen track as transcribed', async (t) => {
  const result = await audio.transcribe(tempFile(t, 'pelicula.mkv'), 'video/x-matroska', 'pelicula.mkv', {
    env: { GROQ_API_KEY: 'gsk_notes_dropped' }, groqClient: sdk(), createFile, language: 'en',
    transcodeClip: fakeMaster(t, { tolerant: true, decodeCause: 'stream_window', streamDropped: true }),
    mediaProbe: twoTrackMovie(), localTranscribe: noLocal,
  });
  assert.equal(result.ok, true);
  assert.equal(result.audioStream, null);
  assert.equal(result.intake.track, 'default_stream');
  assert.ok(!result.notes.some((n) => /transcribí la pista/.test(n)));
});

test('a host-side master failure still uploads accepted containers (video/mp4 too); a decode rejection does not', async (t) => {
  for (const code of ['timeout', 'resource', 'spawn', 'empty']) {
    const groq = sdk();
    const result = await audio.transcribe(tempFile(t, 'clase.mp4'), 'video/mp4', 'clase.mp4', {
      env: { GROQ_API_KEY: `gsk_raw_${code}` }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code }),
      mediaProbe: probe([{ codec: 'aac' }], { video: [{ codec: 'h264' }] }), localTranscribe: noLocal,
    });
    assert.equal(result.ok, true, code);
    assert.deepEqual(groq.requests.map((r) => [r.name, r.mime]), [['clase.mp4', 'video/mp4']], code);
    assert.equal(result.intake.master, 'raw');
    assert.deepEqual(result.audioStream, { streamOrdinal: 0, reason: 'only_stream' }, `${code}: one track, the provider's default IS the chosen one`);
  }

  const seen = [];
  const groq = sdk();
  const localOnly = async (file, options) => { seen.push([path.basename(file), options.audioStreamOrdinal]); return { text: 'hola desde local' }; };
  const mov = await audio.transcribe(tempFile(t, 'clip.mov'), 'video/quicktime', 'clip.mov', {
    env: { GROQ_API_KEY: 'gsk_raw_mov' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code: 'timeout' }),
    mediaProbe: probe([{}], { video: [{ codec: 'h264' }] }), localTranscribe: localOnly,
  });
  const rejected = await audio.transcribe(tempFile(t, 'rota.mp4'), 'video/mp4', 'rota.mp4', {
    env: { GROQ_API_KEY: 'gsk_raw_decode' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t, { code: 'decode' }),
    mediaProbe: probe([{}], { video: [{ codec: 'h264' }] }), localTranscribe: localOnly,
  });
  assert.equal(groq.requests.length, 0, 'a .mov is not an accepted upload, and a video ffmpeg rejected never goes up');
  assert.equal(mov.ok, true);
  assert.equal(rejected.ok, true);
  assert.deepEqual(seen, [['clip.mov', 0], ['rota.mp4', 0]]);

  const multi = sdk();
  const twoTracks = await audio.transcribe(tempFile(t, 'pelicula.mp4'), 'video/mp4', 'pelicula.mp4', {
    env: { GROQ_API_KEY: 'gsk_raw_multi' }, groqClient: multi, createFile, transcodeClip: fakeMaster(t, { code: 'timeout' }),
    mediaProbe: twoTrackMovie(), language: 'en', localTranscribe: noLocal,
  });
  assert.equal(twoTracks.ok, true);
  assert.equal(multi.requests.length, 1);
  assert.equal(twoTracks.audioStream, null, 'the provider decoded the file\'s default track, not necessarily the English one');
  assert.equal(twoTracks.intake.track, 'default_stream');
  assert.ok(!twoTracks.notes.some((n) => /transcribí la pista/.test(n)));
});

test('a repaired master that turns out long is cut and checkpointed, never handed to one whisper process', async (t) => {
  const master = fakeMaster(t, { tolerant: true, durationSeconds: 1500 });
  const original = tempFile(t, 'dañada.m4a');
  const cutFrom = [];
  const seen = [];
  const result = await audio.transcribe(original, 'audio/mp4', 'dañada.m4a', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, transcodeClip: master, mediaProbe: probe([{}], { durationSec: 20 }), durationSeconds: 20,
    async segmentAudio(filePath) {
      cutFrom.push(filePath);
      const dir = tempDir(t, 'sira-intake-seg-');
      return {
        dir,
        segments: [0, 1, 2].map((i) => {
          const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
          fs.writeFileSync(p, `s${i}`);
          return { path: p, index: i, offsetSeconds: i * 600, durationSeconds: i < 2 ? 600 : 300 };
        }),
      };
    },
    async localTranscribe(file) {
      seen.push(path.basename(file));
      if (file === original) throw Object.assign(new Error('Audio could not be decoded'), { code: 'AUDIO_DECODE_FAILED', cause: { diagnostics: 'Invalid data found when processing input' } });
      return { text: `parte ${path.basename(file)}` };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.segmentCount, 3);
  assert.equal(master.calls[0].tolerantOnly, true);
  assert.deepEqual(cutFrom, [path.join(master.dirs[0], 'audio.flac')], 'the cut reads the repaired master');
  assert.ok(!seen.includes('audio.flac'), 'the whole master never went to one local run');
  assert.equal(result.durationSec, 1500);
  assert.ok(result.notes.includes(TOLERANT_NOTE));
});

test('«no stream» from the local, default-window decode is not conclusive: the tolerant repair decides', async (t) => {
  const original = tempFile(t, 'camara.mpg');
  const diag = () => Object.assign(new Error('Audio could not be decoded'), {
    code: 'AUDIO_DECODE_FAILED', cause: { diagnostics: '[out#0/wav @ 0x1] Output file does not contain any stream' },
  });
  const run = (master) => audio.transcribe(original, 'video/mpeg', 'camara.mpg', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, transcodeClip: master, mediaProbe: { ok: false, error: 'probe_failed' }, durationSeconds: 20,
    async localTranscribe(file) {
      if (file === original) throw diag();
      return { text: 'hola desde la cámara', language: 'es' };
    },
  });
  const found = fakeMaster(t, { tolerant: true, decodeCause: 'stream_window' });
  const late = await run(found);
  assert.equal(late.ok, true, 'audio that starts late is transcribed, not «sin pista de audio»');
  assert.equal(found.calls[0].tolerantOnly, true);
  assert.equal(found.calls[0].strictVerdict, 'no_audio_track');
  assert.equal(late.intake.decodeCause, 'stream_window');
  assert.ok(!late.notes.includes(TOLERANT_NOTE));

  const none = await run(fakeMaster(t, { code: 'no_audio_track' }));
  assert.equal(none.reasonCode, 'no_audio_track', 'the tolerant pass agreed: now it is conclusive');
});

/** A minimal ISO-BMFF box. */
function box(type, ...children) {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** ftyp + mdat (64-bit size) + moov with one trak per { handler, entries }. */
function mp4With(tracks) {
  const traks = tracks.map(({ handler, entries }) => {
    const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
    const stsdHead = Buffer.alloc(8);
    stsdHead.writeUInt32BE(entries.length, 4);
    const stsd = box('stsd', stsdHead, ...entries.map((type) => box(type, Buffer.alloc(28))));
    return box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('mdhd', Buffer.alloc(24)), hdlr, box('minf', box('stbl', stsd))));
  });
  const mdat = Buffer.alloc(16 + 64);
  mdat.writeUInt32BE(1, 0);
  mdat.write('mdat', 4, 'latin1');
  mdat.writeBigUInt64BE(BigInt(mdat.length), 8);
  return Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0isom', 'latin1')), mdat, box('moov', box('mvhd', Buffer.alloc(100)), ...traks)]);
}

test('mp4AudioProtection reads the sample descriptions: FairPlay / CENC / Audible audio is protected, clear audio is not', async (t) => {
  const check = (name, tracks) => audio.mp4AudioProtection(tempFile(t, name, mp4With(tracks)));
  assert.deepEqual(await check('a.m4a', [{ handler: 'soun', entries: ['enca'] }]), { checked: true, audioTracks: 1, protected: true });
  assert.equal((await check('b.m4p', [{ handler: 'soun', entries: ['drms'] }])).protected, true);
  assert.equal((await check('c.aax', [{ handler: 'vide', entries: ['avc1'] }, { handler: 'soun', entries: ['aavd'] }])).protected, true);
  assert.equal((await check('d.m4a', [{ handler: 'soun', entries: ['mp4a'] }])).protected, false);
  assert.equal((await check('e.mp4', [{ handler: 'soun', entries: ['enca'] }, { handler: 'soun', entries: ['mp4a'] }])).protected, false, 'one clear audio track is enough');
  assert.equal((await check('f.mp4', [{ handler: 'vide', entries: ['encv'] }, { handler: 'soun', entries: ['mp4a'] }])).protected, false, 'protected video, clear audio');
  assert.deepEqual(await audio.mp4AudioProtection(tempFile(t, 'g.mp4', 'not an mp4 at all')), { checked: true, audioTracks: 0, protected: false });
  assert.deepEqual(await audio.mp4AudioProtection(path.join(os.tmpdir(), 'sira-missing-file.m4a')), { checked: false, protected: false, audioTracks: 0 });
});

test('a protected MP4 ends as drm_protected before any decode; a probe tag says the same', async (t) => {
  const groq = sdk();
  const locked = await audio.transcribe(tempFile(t, 'cancion.m4a', mp4With([{ handler: 'soun', entries: ['enca'] }])), 'audio/mp4', 'cancion.m4a', {
    env: { GROQ_API_KEY: 'gsk_drm' }, groqClient: groq, createFile, mediaProbe: probe([{ codec: 'aac' }], { durationSec: 215 }),
    localTranscribe: noLocal, ...forbiddenIo,
  });
  assert.equal(locked.reasonCode, 'drm_protected');
  assert.equal(locked.durationSec, 215);
  assert.match(locked.text, /protegido \(DRM\)/);
  assert.equal(groq.requests.length, 0);

  const tagged = await audio.transcribe(tempFile(t, 'libro.mka'), 'audio/x-matroska', 'libro.mka', {
    env: { GROQ_API_KEY: 'gsk_drm' }, groqClient: groq, createFile, mediaProbe: probe([{ codec: 'aac', codecTag: 'drms' }]),
    localTranscribe: noLocal, ...forbiddenIo,
  });
  assert.equal(tagged.reasonCode, 'drm_protected');

  const clear = await audio.transcribe(tempFile(t, 'nota.m4a', mp4With([{ handler: 'soun', entries: ['mp4a'] }])), 'audio/mp4', 'nota.m4a', {
    env: { GROQ_API_KEY: 'gsk_drm' }, groqClient: groq, createFile, transcodeClip: fakeMaster(t), mediaProbe: probe([{ codec: 'aac', codecTag: 'mp4a' }]),
    localTranscribe: noLocal,
  });
  assert.equal(clear.ok, true);
});

test('cutAndMeasure: the track is kept through the tolerant pass; dropped only when even the wide window misses it, and the manifest says so', async (t) => {
  const missing = { code: 234, stderr: "Stream map '0:a:1' matches no streams.\n" };
  const kept = fakeCutter({ cuts: [missing, {}] });
  const report = {};
  await audio.cutAndMeasure('/media/x.vob', tempDir(t), { segmentSeconds: 600, durationSeconds: 1800, audioStreamOrdinal: 1, report }, cutOptions({ spawnImpl: kept.spawnImpl }));
  assert.equal(kept.segmentCalls.length, 2);
  for (const args of kept.segmentCalls) assert.ok(args.includes('0:a:1'), 'both passes map the chosen track');
  const strict = kept.segmentCalls[0];
  assert.deepEqual(strict.slice(strict.indexOf('-i') - 4, strict.indexOf('-i')), WINDOW, 'the strict cut reads the ordinal under media-probe\'s window');
  assert.equal(report.streamDropped, false);
  assert.equal(report.decodeCause, 'stream_window');

  const root = tempDir(t, 'sira-intake-ckpt-');
  const track = { streamOrdinal: 1, reason: 'requested', streams: 2, explicit: true };
  const lost = fakeCutter({ cuts: [missing, missing, {}] });
  const prepared = await audio.prepareSegments('/media/x.vob', cutOptions({ spawnImpl: lost.spawnImpl, checkpoint: { dir: root } }), {
    segmentSeconds: 600, durationSeconds: 1800, fileSize: 999, audioStream: track,
  });
  assert.equal(lost.segmentCalls.length, 3);
  assert.ok(!lost.segmentCalls[2].includes('-map'));
  assert.equal(prepared.cutInfo.streamDropped, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'audio', 'manifest.json'), 'utf8'));
  assert.equal(manifest.audioStream.dropped, true);
  assert.equal(manifest.decodeCause, 'stream_window');
  const again = await audio.prepareSegments('/media/x.vob', { env: {}, checkpoint: { dir: root }, ...forbiddenIo }, {
    segmentSeconds: 600, fileSize: 999, audioStream: track,
  });
  assert.equal(again.reused, true);
  assert.equal(again.cutInfo.streamDropped, true, 'a restart still knows the pieces hold the default stream');
});

test('pieces cut before tracks were recorded are reused, but never reported as the chosen track', async (t) => {
  const { root } = writeManifest(t);
  const result = await audio.transcribe(tempFile(t, 'clase.mkv', Buffer.alloc(1234)), 'video/x-matroska', 'clase.mkv', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, checkpoint: { dir: root }, durationSeconds: 1200,
    mediaProbe: probe([{ language: 'es', isDefault: true }, { language: 'en' }], { video: [{ codec: 'h264' }], durationSec: 1200 }),
    ...forbiddenIo,
    async localTranscribe(file) { return { text: `parte ${path.basename(file)}`, language: 'es' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.segmentCount, 2, 'the pre-deploy cut was reused');
  assert.equal(result.audioStream, null);
  assert.equal(result.intake.track, 'unrecorded');
  assert.ok(!result.notes.some((n) => /transcribí la pista/.test(n)));
});

// ── Real ffmpeg (CI installs it; skipped without) ───────────────────────────

function synth(dir, name, args) {
  const file = path.join(dir, name);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

test('real ffmpeg: an Opus voice note reaches the provider as real FLAC named audio.flac', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-intake-real-');
  const note = synth(dir, 'PTT-20261003-WA0012.opus', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'libopus']);
  const groq = sdk();
  const outputs = [];
  const result = await audio.transcribe(note, 'audio/ogg', 'PTT-20261003-WA0012.opus', {
    env: { GROQ_API_KEY: 'gsk_intake_real' }, groqClient: groq, createFile, keyterms: ['WA0012'], localTranscribe: noLocal,
    spawnImpl: (bin, args, opts) => { outputs.push(args.at(-1)); return spawn(bin, args, opts); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(groq.requests.map((r) => [r.name, r.mime, r.head, r.prompt]), [['audio.flac', 'audio/flac', 'fLaC', undefined]]);
  assert.ok(Math.abs(result.durationSec - 3) < 0.1);
  assert.equal(result.intake.probe, 'ok');
  assert.equal(outputs.length, 1, 'one decode: strict succeeded');
  assert.equal(path.basename(outputs[0]), 'audio.flac');
  assert.equal(fs.existsSync(path.dirname(outputs[0])), false, 'no master left behind');
});

test('real ffmpeg: no audio track, a truncated MP4 and a two-track MKV', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-intake-real-');
  const noAudio = synth(dir, 'pantalla.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=5', '-c:v', 'mpeg4']);
  const full = synth(dir, 'full.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:a', 'aac']);
  const truncated = path.join(dir, 'cortado.mp4');
  fs.writeFileSync(truncated, fs.readFileSync(full).subarray(0, 3000));
  const twoTracks = synth(dir, 'pelicula.mkv', [
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=3',
    '-map', '0', '-map', '1', '-c:a', 'flac', '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng',
  ]);
  const groq = sdk();
  const base = { env: { GROQ_API_KEY: 'gsk_intake_real2' }, groqClient: groq, createFile, localTranscribe: noLocal };
  const a = await audio.transcribe(noAudio, 'video/mp4', 'pantalla.mp4', base);
  assert.equal(a.reasonCode, 'no_audio_track');
  const b = await audio.transcribe(truncated, 'video/mp4', 'cortado.mp4', base);
  assert.equal(b.reasonCode, 'truncated_container');
  assert.equal(groq.requests.length, 0);

  const spawned = [];
  const c = await audio.transcribe(twoTracks, 'video/x-matroska', 'pelicula.mkv', {
    ...base, language: 'en', spawnImpl: (bin, args, opts) => { spawned.push(args); return spawn(bin, args, opts); },
  });
  assert.equal(c.ok, true);
  assert.deepEqual(c.audioStream, { streamOrdinal: 1, reason: 'language_match' });
  assert.ok(spawned.some((args) => args.includes('0:a:1')), 'the English track was decoded');
  assert.equal(groq.requests[0].language, 'en');
});

test('real ffmpeg: a noisy two-track recording — adaptive pauses, recorded track, reused after a restart', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-intake-noisy-');
  const source = synth(dir, 'clase.mkv', [
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.04:duration=80:sample_rate=16000',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=80:sample_rate=16000',
    '-f', 'lavfi', '-i', 'sine=frequency=900:duration=80:sample_rate=16000',
    '-filter_complex', "[1:a]volume=6,volume=enable='between(t,27,28.5)+between(t,55.5,57)':volume=0[s];[0:a][s]amix=inputs=2:normalize=0[a0];[2:a]volume=4[a1]",
    '-map', '[a0]', '-map', '[a1]', '-c:a', 'flac', '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Music',
  ]);
  const fixed = await execFileAsync('ffmpeg', ['-hide_banner', '-nostdin', '-i', source, '-map', '0:a:0', '-af', 'silencedetect=noise=-35dB:d=0.4', '-f', 'null', '-']).catch((e) => e);
  assert.equal((String(fixed.stderr).match(/silence_start/g) || []).length, 0, 'the fixed -35 dB threshold finds no pause in this room');

  const { createDiskCheckpoint } = require('../src/services/media-transcription-queue');
  const checkpoint = createDiskCheckpoint(path.join(dir, 'ckpt'));
  let io = 0;
  const calls = [];
  const options = {
    env: { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_SEGMENT_SECONDS: '30' }, checkpoint, language: 'es',
    spawnImpl: (bin, args, opts) => { io++; return spawn(bin, args, opts); },
    execFileImpl: (...args) => { io++; return execFileAsync(...args); },
    async localTranscribe(file, opts) { calls.push([path.basename(file), opts.audioStreamOrdinal]); return { text: `parte ${calls.length}`, language: 'es' }; },
  };
  const first = await audio.transcribe(source, 'video/x-matroska', 'clase.mkv', { ...options, signal: new AbortController().signal });
  assert.equal(first.ok, true);
  assert.equal(first.segmentCount, 3);
  assert.deepEqual(first.audioStream, { streamOrdinal: 0, reason: 'language_match' });
  assert.equal(first.intake.silence.adaptive, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(checkpoint.dir, 'audio', 'manifest.json'), 'utf8'));
  assert.ok(Math.abs(manifest.offsets[1] - 27.75) < 0.5 && Math.abs(manifest.offsets[2] - 56.25) < 0.5, `cuts in the pauses: ${manifest.offsets}`);
  assert.deepEqual(manifest.audioStream, { streamOrdinal: 0, reason: 'language_match', streams: 2, explicit: false });
  assert.equal(manifest.decode, 'strict');
  assert.ok(manifest.silence.thresholdDb > -35);

  const before = io;
  calls.length = 0;
  const again = await audio.transcribe(source, 'video/x-matroska', 'clase.mkv', { ...options, signal: new AbortController().signal });
  assert.equal(calls.length, 0, 'every piece comes from the checkpoint');
  assert.equal(io - before, 1, 'one stream probe; the cut is reused (no decode at all)');
  assert.equal(again.transcript, first.transcript);
  await checkpoint.clear();
});

/** Zero-crossing rate of a file decoded to 16 kHz mono (300 Hz ≈ 0.0375, 900 Hz ≈ 0.1125). */
function zeroCrossingRate(file, extra = []) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...extra, '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  const n = Math.floor(r.stdout.length / 2);
  let crossings = 0;
  let previous = 0;
  for (let i = 0; i < n; i++) {
    const v = r.stdout.readInt16LE(i * 2);
    if (i && (previous < 0) !== (v < 0)) crossings++;
    previous = v;
  }
  return { seconds: n / 16000, zcr: crossings / Math.max(1, n) };
}

test('real ffmpeg: a VOB whose audio starts late — the master and the pieces hold the track the probe window names', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-intake-vob-');
  // ~30 MB of MPEG-2 before the audio: ffmpeg's default 5 MB / 5 s window
  // never sees an audio packet (and here even lists the tracks in the other
  // order), while media-probe's 100M window does.
  const vob = synth(dir, 'camara.vob', [
    '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x240:rate=25',
    '-itsoffset', '25', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5:sample_rate=48000',
    '-itsoffset', '25', '-f', 'lavfi', '-i', 'sine=frequency=900:duration=5:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg2video', '-b:v', '8M', '-minrate', '8M', '-maxrate', '8M', '-bufsize', '2M',
    '-c:a', 'mp2', '-f', 'vob',
  ]);
  // Which ordinal is the 900 Hz track under the probe's window.
  const byOrdinal = [0, 1].map((n) => {
    const out = path.join(dir, `ref-${n}.flac`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...WINDOW, '-i', vob, '-map', `0:a:${n}`, '-ac', '1', '-ar', '16000', out]);
    assert.equal(r.status, 0, String(r.stderr));
    return zeroCrossingRate(out).zcr;
  });
  const high = byOrdinal[0] > byOrdinal[1] ? 0 : 1;
  assert.ok(byOrdinal[high] > 0.1 && byOrdinal[1 - high] < 0.05, `two distinct tracks: ${byOrdinal}`);

  const master = await audio.buildClipMaster(vob, { audioStreamOrdinal: high, fileName: 'camara.vob', durationSeconds: 30 }, { env: {} });
  t.after(() => fs.rmSync(master.dir, { recursive: true, force: true }));
  assert.equal(master.ok, true);
  assert.equal(master.streamDropped, false);
  const heard = zeroCrossingRate(master.path);
  assert.ok(heard.zcr > 0.1, `the master holds the chosen (900 Hz) track: zcr ${heard.zcr}`);
  assert.ok(Math.abs(heard.seconds - 5) < 0.5);

  const cutDir = tempDir(t, 'sira-intake-vob-cut-');
  const pieces = await audio.cutAndMeasure(vob, cutDir, { segmentSeconds: 600, durationSeconds: 30, audioStreamOrdinal: high, fileName: 'camara.vob' }, { env: {} });
  assert.equal(pieces.length, 1);
  assert.ok(zeroCrossingRate(pieces[0].path).zcr > 0.1, 'the piece holds the chosen track too');

  // Without a probe (no map), the strict default-window decode finds no
  // stream; the tolerant, wide-window pass finds the audio: never «sin pista».
  const groq = sdk();
  const unprobed = await audio.transcribe(vob, 'video/mpeg', 'camara.vob', {
    env: { GROQ_API_KEY: 'gsk_intake_vob' }, groqClient: groq, createFile, mediaProbe: { ok: false, error: 'probe_failed' }, localTranscribe: noLocal,
  });
  assert.equal(unprobed.ok, true);
  assert.equal(unprobed.intake.decode, 'tolerant');
  assert.equal(unprobed.intake.decodeCause, 'stream_window');
  assert.ok(!unprobed.notes.includes(TOLERANT_NOTE), 'nothing was damaged');
  // 30 MB is above the upload cap: the cut (same ladder) fed the provider.
  assert.deepEqual(groq.requests.map((r) => r.head), ['fLaC']);
});

test('real ffmpeg: CENC-encrypted AAC ends as drm_protected without a single decode', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-intake-cenc-');
  const file = path.join(dir, 'protegida.m4a');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=3', '-c:a', 'aac',
    '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', '76a6c65c5ea762046bd749a2e632ccbb', '-encryption_kid', 'a7e61c373e219033c21091fa607bf3b8', file]);
  if (made.status !== 0) return t.skip('this ffmpeg cannot write CENC');
  // ffmpeg itself decodes it to noise and exits 0: only the sample entry tells.
  assert.equal((await audio.mp4AudioProtection(file)).protected, true);
  const groq = sdk();
  let spawned = 0;
  const result = await audio.transcribe(file, 'audio/mp4', 'protegida.m4a', {
    env: { GROQ_API_KEY: 'gsk_intake_cenc' }, groqClient: groq, createFile, localTranscribe: noLocal,
    spawnImpl: (bin, args, opts) => { spawned++; return spawn(bin, args, opts); },
  });
  assert.equal(result.reasonCode, 'drm_protected');
  assert.equal(spawned, 0, 'no decode at all');
  assert.equal(groq.requests.length, 0);
});
