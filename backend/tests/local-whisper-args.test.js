'use strict';

/**
 * whisper.cpp invocation for long media: real timestamps (no -nt), language
 * auto-detection instead of whisper-cli's English default, the vocabulary
 * prompt, and a beam width picked by the length of the whole recording.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../src/services/local-whisper-engine');

function child(write, exitCode = 0) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  queueMicrotask(() => {
    try { write?.(); } catch (error) { c.emit('error', error); return; }
    c.emit('close', exitCode);
  });
  return c;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-whisper-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wavPath = path.join(dir, 'audio.wav');
  const modelPath = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(wavPath, 'wav');
  fs.writeFileSync(modelPath, 'model');
  return { dir, wavPath, modelPath };
}

const base = { modelPath: '/m/ggml-base.bin', wavPath: '/tmp/a.wav', outBase: '/tmp/transcript' };

test('timestamps are decoded: -nt is never passed, JSON + txt output stay', () => {
  const args = engine.buildWhisperCppArgs({ ...base, language: 'es', threads: 2 });
  assert.ok(!args.includes('-nt'), 'no -nt: whisper.cpp seeks on real segment ends');
  assert.ok(args.includes('-oj') && args.includes('-otxt'));
  assert.equal(args[args.indexOf('-of') + 1], '/tmp/transcript');
});

test('an unknown language is -l auto (whisper-cli otherwise assumes English); tags are reduced to ISO', () => {
  for (const language of [undefined, null, '', 'auto', 'detect', 'spanish']) {
    const args = engine.buildWhisperCppArgs({ ...base, language });
    assert.equal(args[args.indexOf('-l') + 1], 'auto', String(language));
  }
  assert.equal(engine.whisperLanguageArg('es-PE'), 'es');
  assert.equal(engine.whisperLanguageArg('EN'), 'en');
  const args = engine.buildWhisperCppArgs({ ...base, language: 'pt' });
  assert.equal(args[args.indexOf('-l') + 1], 'pt');
});

test('the vocabulary prompt travels as one clean argv entry', () => {
  const args = engine.buildWhisperCppArgs({ ...base, language: 'es', prompt: 'Clase de Microeconomía.\nElasticidad, Pareto,\u0007 Nash.' });
  assert.equal(args[args.indexOf('--prompt') + 1], 'Clase de Microeconomía. Elasticidad, Pareto, Nash.');
  assert.ok(!engine.buildWhisperCppArgs({ ...base, prompt: '   ' }).includes('--prompt'));
  const long = engine.buildWhisperCppArgs({ ...base, prompt: 'x'.repeat(5000) });
  assert.equal(long[long.indexOf('--prompt') + 1].length, 1000);
});

test('beam width: 5 for clips up to 10 min, 2 for long media, WHISPER_CPP_BEAM_SIZE wins', () => {
  assert.equal(engine.resolveBeamSize({ env: {}, durationSeconds: 45 }), 5);
  assert.equal(engine.resolveBeamSize({ env: {}, durationSeconds: 600 }), 5);
  assert.equal(engine.resolveBeamSize({ env: {}, durationSeconds: 120, mediaDurationSeconds: 18000 }), 2, 'a 10-min piece of a 5 h lecture uses the long-media beam');
  assert.equal(engine.resolveBeamSize({ env: { WHISPER_CPP_BEAM_SIZE: '1' }, durationSeconds: 45 }), 1);
  assert.equal(engine.resolveBeamSize({ env: { WHISPER_CPP_BEAM_SIZE: '99' } }), 10);
  assert.equal(engine.resolveBeamSize({ env: { WHISPER_CPP_BEAM_SIZE: 'nope' }, durationSeconds: 7200 }), 2);
  const args = engine.buildWhisperCppArgs({ ...base, beamSize: 2 });
  assert.equal(args[args.indexOf('-bs') + 1], '2');
});

test('transcribeWithWhisperCpp sends auto + prompt + beam and reports the detected language', async (t) => {
  const { dir, wavPath, modelPath } = fixture(t);
  let seen;
  const result = await engine.transcribeWithWhisperCpp(wavPath, undefined, {
    env: {}, whisperBin: 'fixture-whisper', modelPath, prompt: 'Pareto, Nash.', mediaDurationSeconds: 18000,
    spawnImpl(command, args) {
      seen = args;
      return child(() => {
        const outBase = args[args.indexOf('-of') + 1];
        fs.writeFileSync(`${outBase}.json`, JSON.stringify({
          result: { language: 'en' },
          transcription: [
            { offsets: { from: 0, to: 4200 }, text: 'Hello class.' },
            { offsets: { from: 4200, to: 9100 }, text: 'Today: Pareto.' },
          ],
        }));
      });
    },
  });
  assert.equal(seen[seen.indexOf('-l') + 1], 'auto');
  assert.equal(seen[seen.indexOf('--prompt') + 1], 'Pareto, Nash.');
  assert.equal(seen[seen.indexOf('-bs') + 1], '2');
  assert.ok(!seen.includes('-nt'));
  assert.equal(result.language, 'en', 'auto mode reports what whisper.cpp detected');
  assert.deepEqual(result.segments.map((s) => [s.start, s.end]), [[0, 4.2], [4.2, 9.1]]);
  assert.ok(fs.existsSync(dir));
});

test('a forced language is reported as forced; the python fallback gets no bogus --language', async (t) => {
  const { wavPath, modelPath } = fixture(t);
  const cpp = await engine.transcribeWithWhisperCpp(wavPath, 'es', {
    env: {}, whisperBin: 'fixture-whisper', modelPath,
    spawnImpl(_command, args) {
      return child(() => fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ text: 'Hola' }] })));
    },
  });
  assert.equal(cpp.language, 'es');
  let pyArgs;
  await engine.transcribeWithPython(wavPath, 'auto', {
    env: {},
    spawnImpl(_command, args) {
      pyArgs = args;
      return child(() => fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ text: 'hola', segments: [], language: 'es' })));
    },
  });
  assert.ok(!pyArgs.includes('--language'), 'auto is the python default; never pass the literal «auto»');
});

test('decoding a long whole file to WAV gets a budget scaled to its length', () => {
  assert.equal(engine.conversionTimeoutMs({ env: {} }), 180_000);
  assert.equal(engine.conversionTimeoutMs({ env: {}, durationSeconds: 18000 }), 1_800_000);
  assert.equal(engine.conversionTimeoutMs({ env: {}, mediaDurationSeconds: 36000, durationSeconds: 600 }), 3_600_000);
});
