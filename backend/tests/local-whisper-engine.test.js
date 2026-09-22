'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../src/services/local-whisper-engine');
const audio = require('../src/services/audio-transcriber');

function fakeChild(onSpawn) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    try { onSpawn?.(child); } catch { /* ignore */ }
    child.emit('close', 0);
  });
  return child;
}

test('buildWhisperCppArgs always passes -ng and defaults -t 1', () => {
  const args = engine.buildWhisperCppArgs({
    modelPath: '/usr/local/share/whisper/ggml-base.bin',
    wavPath: '/tmp/note.wav',
    outBase: '/tmp/transcript',
    language: 'es',
  });
  assert.equal(args[args.indexOf('-ng') + 0], '-ng');
  assert.ok(args.includes('-ng'));
  assert.equal(args[args.indexOf('-t') + 1], '1');
  assert.equal(args[args.indexOf('-l') + 1], 'es');
  assert.doesNotMatch(args.join(' '), /sk-|OPENAI_API_KEY|OPENROUTER/i);
});

test('resolveThreadCount defaults to 1 and honors WHISPER_CPP_THREADS', () => {
  assert.equal(engine.resolveThreadCount({ env: {} }), engine.defaultThreadCount());
  assert.ok(engine.defaultThreadCount() >= 1 && engine.defaultThreadCount() <= 8);
  assert.equal(engine.resolveThreadCount({ env: { WHISPER_CPP_THREADS: '4' } }), 4);
  assert.equal(engine.resolveThreadCount({ threads: 2, env: { WHISPER_CPP_THREADS: '8' } }), 2);
  assert.equal(engine.resolveThreadCount({ env: { WHISPER_CPP_THREADS: 'nope' } }), engine.defaultThreadCount());
  // 1 hour of 16 kHz mono PCM = 115.2 MB → 2.5 s budget per audio second + 1 min headroom.
  assert.equal(engine.whisperTimeoutForWav(3600 * 32000, { env: {} }), 3600 * 2500 + 60_000);
  assert.equal(engine.whisperTimeoutForWav(10 * 32000, { env: {} }), 180_000, 'short clips keep the 3-minute floor');
  assert.equal(engine.whisperTimeoutForWav(0, { env: { LOCAL_WHISPER_TIMEOUT_MS: '600000' } }), 600_000);
});

test('transcribeWithWhisperCpp mocks the bin and always sends -ng with the default threads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-whisper-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wavPath = path.join(dir, 'audio.wav');
  const bin = path.join(dir, 'whisper-cli');
  const modelPath = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(wavPath, 'fake-wav');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(modelPath, 'model');

  let seen;
  const result = await engine.transcribeWithWhisperCpp(wavPath, 'es', {
    whisperBin: bin,
    modelPath,
    env: {
      WHISPER_LANGUAGE: 'es',
      OPENAI_API_KEY: 'sk-proj-TESTKEY_NOT_A_REAL_SECRET_engine',
    },
    spawnImpl(command, args, opts) {
      seen = { command, args, env: opts?.env || {} };
      return fakeChild(() => {
        fs.writeFileSync(path.join(dir, 'transcript.txt'), 'hola desde local');
      });
    },
  });

  assert.equal(result.engine, 'whisper.cpp');
  assert.match(result.text, /hola desde local/);
  assert.equal(seen.command, bin);
  assert.ok(seen.args.includes('-ng'));
  assert.equal(seen.args[seen.args.indexOf('-t') + 1], String(engine.defaultThreadCount()));
  assert.doesNotMatch(JSON.stringify(seen.args), /sk-proj|OPENAI_API_KEY|OPENROUTER/);
  assert.equal(seen.env.OPENAI_API_KEY, undefined);
});

function decoderFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-whisper-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wavPath = path.join(dir, 'audio.wav');
  const modelPath = path.join(dir, 'model.bin');
  fs.writeFileSync(wavPath, 'fixture audio');
  fs.writeFileSync(modelPath, 'fixture model');
  return { dir, wavPath, options: { env: {}, durationSeconds: 1, whisperBin: 'fixture-whisper', modelPath } };
}

function decoderChild(writeOutput, exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    try { writeOutput?.(child); } catch (error) { child.emit('error', error); return; }
    child.emit('close', exitCode);
  });
  return child;
}

test('successful empty whisper.cpp JSON is no_speech without Python fallback and cleans temporary output', async (t) => {
  const { wavPath, options } = decoderFixture(t);
  const commands = [];
  let tempDir;
  const result = await audio.transcribe(wavPath, 'audio/wav', 'silent.wav', {
    ...options,
    spawnImpl(command, args) {
      commands.push(command);
      return decoderChild((child) => {
        if (command === 'ffmpeg') {
          tempDir = path.dirname(args.at(-1));
          fs.copyFileSync(wavPath, args.at(-1));
        } else if (command === 'fixture-whisper') {
          const base = args[args.indexOf('-of') + 1];
          fs.writeFileSync(`${base}.txt`, '');
          fs.writeFileSync(`${base}.json`, JSON.stringify({ transcription: [], result: { language: 'es' } }));
          child.stdout.emit('data', Buffer.from('decoder diagnostics, not speech'));
        } else {
          throw new Error('A valid silent decode must not start Python');
        }
      });
    },
  });
  assert.equal(result.reasonCode, 'no_speech');
  assert.equal(result.ok, false);
  assert.deepEqual(commands, ['ffmpeg', 'fixture-whisper']);
  assert.equal(fs.existsSync(tempDir), false);
});

test('successful empty Python fallback output is no_speech and cleans temporary output', async (t) => {
  const { wavPath, options } = decoderFixture(t);
  const commands = [];
  let tempDir;
  const result = await audio.transcribe(wavPath, 'audio/wav', 'silent.wav', {
    ...options,
    spawnImpl(command, args) {
      commands.push(command);
      return decoderChild(() => {
        if (command === 'ffmpeg') {
          tempDir = path.dirname(args.at(-1));
          fs.copyFileSync(wavPath, args.at(-1));
        } else if (command === 'python3') {
          fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ text: '', segments: [], engine: 'faster-whisper' }));
        }
      }, command === 'fixture-whisper' ? 1 : 0);
    },
  });
  assert.equal(result.reasonCode, 'no_speech');
  assert.deepEqual(commands, ['ffmpeg', 'fixture-whisper', 'python3']);
  assert.equal(fs.existsSync(tempDir), false);
});

test('missing, malformed, and structurally invalid decoder output remain failures', async (t) => {
  for (const decoder of ['cpp', 'python']) {
    for (const [name, raw, code] of [
      ['missing', undefined, 'LOCAL_WHISPER_EMPTY'],
      ['malformed JSON', '{', 'LOCAL_WHISPER_INVALID_OUTPUT'],
      ['invalid schema', '{}', 'LOCAL_WHISPER_INVALID_OUTPUT'],
      ['invalid segment', decoder === 'cpp' ? '{"transcription":[{}]}' : '{"text":"","segments":[{}]}', 'LOCAL_WHISPER_INVALID_OUTPUT'],
    ]) {
      await t.test(`${decoder}: ${name}`, async (subtest) => {
        const { wavPath, options } = decoderFixture(subtest);
        const invoke = decoder === 'cpp' ? engine.transcribeWithWhisperCpp : engine.transcribeWithPython;
        await assert.rejects(invoke(wavPath, 'es', {
          ...options,
          spawnImpl(_command, args) {
            return decoderChild((child) => {
              if (raw !== undefined) {
                const outPath = decoder === 'cpp' ? `${args[args.indexOf('-of') + 1]}.json` : args[args.indexOf('--output') + 1];
                fs.writeFileSync(outPath, raw);
              }
              child.stdout.emit('data', Buffer.from('decoder diagnostics, not a transcript'));
            });
          },
        }), { code });
      });
    }
  }
});

test('a failed decoder exit cannot turn written empty output into no_speech', async (t) => {
  for (const decoder of ['cpp', 'python']) {
    const { wavPath, options } = decoderFixture(t);
    const invoke = decoder === 'cpp' ? engine.transcribeWithWhisperCpp : engine.transcribeWithPython;
    await assert.rejects(invoke(wavPath, 'es', {
      ...options,
      spawnImpl(_command, args) {
        return decoderChild(() => {
          const outPath = decoder === 'cpp' ? `${args[args.indexOf('-of') + 1]}.json` : args[args.indexOf('--output') + 1];
          fs.writeFileSync(outPath, JSON.stringify(decoder === 'cpp' ? { transcription: [] } : { text: '', segments: [] }));
        }, 1);
      },
    }), { code: 'LOCAL_WHISPER_FAILED' });
  }
});

test('audio decode errors remain failures instead of no_speech', async (t) => {
  const { wavPath, options } = decoderFixture(t);
  const result = await audio.transcribe(wavPath, 'audio/wav', 'broken.wav', {
    ...options, spawnImpl: () => decoderChild(null, 1),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'audio_decode_failed');
});

test('a successful silent local segment preserves neighboring speech and timestamp offsets', async (t) => {
  const { dir, wavPath, options } = decoderFixture(t);
  const segmentDir = path.join(dir, 'segments');
  fs.mkdirSync(segmentDir);
  const segments = ['Inicio', '', 'Final'].map((text, index) => {
    const segmentPath = path.join(segmentDir, `${index}.wav`);
    fs.writeFileSync(segmentPath, text || 'silent');
    return { path: segmentPath, index, offsetSeconds: index * 600 };
  });
  const decoderDirs = [];
  const result = await audio.transcribe(wavPath, 'audio/wav', 'long.wav', {
    ...options, durationSeconds: 1800,
    segmentAudio: async () => ({ dir: segmentDir, segments }),
    spawnImpl(command, args) {
      return decoderChild(() => {
        if (command === 'ffmpeg') {
          decoderDirs.push(path.dirname(args.at(-1)));
          fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));
        } else if (command === 'fixture-whisper') {
          const text = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
          const rows = text === 'silent' ? [] : [{ text, offsets: { from: 1000, to: 2000 } }];
          fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: rows }));
        } else {
          throw new Error('Valid segments must not start Python');
        }
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'Inicio\n\nFinal');
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), [{ start: 1, end: 2 }, { start: 1201, end: 1202 }]);
  assert.equal(decoderDirs.length, 3);
  assert.ok(decoderDirs.every((tempDir) => !fs.existsSync(tempDir)));
  assert.equal(fs.existsSync(segmentDir), false);
});
