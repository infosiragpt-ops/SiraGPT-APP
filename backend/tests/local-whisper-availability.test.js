'use strict';

/**
 * Local Whisper availability diagnostics. Prod 2026-09-28: the ggml model was
 * `-rw------- root` while the backend runs as appuser (uid 100); the only log
 * line was «local whisper unavailable». The engine must name the cause
 * (binary / model / permissions / ffmpeg) and log it once per process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const engine = require('../src/services/local-whisper-engine');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-whisper-avail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, { model = true } = {}) {
  const dir = tmpDir(t);
  const bin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const modelPath = path.join(dir, 'ggml-base.bin');
  if (model) fs.writeFileSync(modelPath, Buffer.alloc(64, 1));
  return { dir, bin, modelPath };
}

/** Simulates EACCES on one path without depending on the test user's uid. */
function denyRead(target) {
  return (filePath, mode) => {
    if (filePath === target && (mode & fs.constants.R_OK)) {
      const err = new Error(`EACCES: permission denied, access '${filePath}'`);
      err.code = 'EACCES';
      throw err;
    }
    return fs.accessSync(filePath, mode);
  };
}

test('describeLocalWhisperAvailability names an unreadable model with the uid and path', (t) => {
  const { bin, modelPath } = fixture(t);
  const ok = engine.describeLocalWhisperAvailability({ whisperBin: bin, modelPath, ffmpegPath: 'ffmpeg' });
  assert.equal(ok.ok, true);
  assert.equal(ok.model, modelPath);

  const denied = engine.describeLocalWhisperAvailability({ whisperBin: bin, modelPath, ffmpegPath: 'ffmpeg', accessImpl: denyRead(modelPath) });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'model_not_readable');
  assert.match(denied.reason, /^model not readable by (uid \d+|this process) \(/);
  assert.ok(denied.reason.includes(modelPath));
});

test('describeLocalWhisperAvailability distinguishes missing binary, missing model and missing ffmpeg', (t) => {
  const { dir, bin, modelPath } = fixture(t, { model: false });
  const noModel = engine.describeLocalWhisperAvailability({ whisperBin: bin, modelPath, ffmpegPath: 'ffmpeg' });
  assert.equal(noModel.code, 'model_missing');
  assert.match(noModel.reason, /model missing/);

  const noBin = engine.describeLocalWhisperAvailability({ whisperBin: path.join(dir, 'nope'), modelPath, env: {} });
  assert.equal(noBin.code, 'binary_missing');
  assert.match(noBin.reason, /binary missing/);

  fs.writeFileSync(modelPath, Buffer.alloc(8, 1));
  const noFfmpeg = engine.describeLocalWhisperAvailability({ whisperBin: bin, modelPath, ffmpegPath: path.join(dir, 'no-ffmpeg') });
  assert.equal(noFfmpeg.code, 'ffmpeg_missing');
  assert.match(noFfmpeg.reason, /ffmpeg missing/);
});

test('transcribeWithWhisperCpp refuses an unreadable model with a LOCAL_WHISPER_UNAVAILABLE reason (no spawn)', async (t) => {
  const { bin, modelPath, dir } = fixture(t);
  const wav = path.join(dir, 'audio.wav');
  fs.writeFileSync(wav, Buffer.alloc(32000, 0));
  let spawned = 0;
  await assert.rejects(
    engine.transcribeWithWhisperCpp(wav, 'es', {
      whisperBin: bin, modelPath, accessImpl: denyRead(modelPath),
      spawnImpl: () => { spawned += 1; throw new Error('must not spawn'); },
    }),
    (err) => err.code === 'LOCAL_WHISPER_UNAVAILABLE' && /model not readable by/.test(err.message) && err.reason.includes(modelPath),
  );
  assert.equal(spawned, 0);
});

test('transcribeLocal surfaces the real reason and logs it once per process', async (t) => {
  const { bin, modelPath, dir } = fixture(t);
  const input = path.join(dir, 'nota.ogg');
  fs.writeFileSync(input, 'fake');
  // Fake ffmpeg: writes the wav, exits 0. Fake python: exits 0 with no output.
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (cmd === 'ffmpeg') fs.writeFileSync(args[args.length - 1], Buffer.alloc(32000, 0));
      child.emit('close', 0);
    });
    return child;
  };
  const logged = [];
  engine.resetAvailabilityLog();
  const options = { whisperBin: bin, modelPath, ffmpegPath: 'ffmpeg', accessImpl: denyRead(modelPath), spawnImpl, logImpl: (line) => logged.push(line) };
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      engine.transcribeLocal(input, options),
      (err) => err.code === 'LOCAL_WHISPER_UNAVAILABLE' && /local whisper unavailable: model not readable by/.test(err.message),
    );
  }
  assert.equal(logged.length, 1, 'the diagnosis is logged once per process');
  assert.match(logged[0], /^\[local-whisper\] unavailable: model not readable by/);
  engine.resetAvailabilityLog();
});
