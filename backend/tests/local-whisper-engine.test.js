'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../src/services/local-whisper-engine');

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
