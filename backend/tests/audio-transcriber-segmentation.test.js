'use strict';

/**
 * Cutting long media once per job: silence-snapped cut plan, no sub-2 s tail
 * request, duration probing when the container has no length header,
 * segmentation of unknown-length files on the local path, and the FLAC
 * pieces + manifest that a restart reuses. The ffmpeg cases run against the
 * real binary (CI installs it) and skip when it is absent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const audio = require('../src/services/audio-transcriber');
const { createDiskCheckpoint } = require('../src/services/media-transcription-queue');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const execFileAsync = promisify(execFile);

function tempDir(t, prefix = 'sira-seg-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Sine tone with true silences at the given [start, end] windows. */
function synthAudio(dir, name, seconds, silences = []) {
  const file = path.join(dir, name);
  const filter = silences.length
    ? ['-af', `volume=enable='${silences.map(([a, b]) => `between(t,${a},${b})`).join('+')}':volume=0`]
    : [];
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=16000`, ...filter, file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

function counting() {
  const counts = { spawn: 0, exec: 0 };
  return {
    counts,
    spawnImpl: (...args) => { counts.spawn++; return spawn(...args); },
    execFileImpl: (...args) => { counts.exec++; return execFileAsync(...args); },
  };
}

test('planCutTimes: fixed targets without silences, never longer than a segment, tail < 2 s folded', () => {
  assert.deepEqual(audio.planCutTimes(1800, 600), [600, 1200]);
  assert.deepEqual(audio.planCutTimes(1200, 600), [600]);
  assert.deepEqual(audio.planCutTimes(1200.5, 600), [600], 'a 0.5 s tail is folded into the previous segment');
  assert.deepEqual(audio.planCutTimes(1203, 600), [600, 1200]);
  assert.deepEqual(audio.planCutTimes(600, 600), []);
  assert.deepEqual(audio.planCutTimes(0, 600), []);
});

test('planCutTimes snaps each cut to the latest pause inside the window before the target', () => {
  const silences = [
    { start: 300, end: 301 }, // too early for the first target
    { start: 570, end: 571 }, // inside [555, 600] → 570.5
    { start: 590, end: 592 }, // later, still before 600 → 591 wins
    { start: 610, end: 612 }, // after the target: would make a 611 s segment
    { start: 1150, end: 1152 }, // second target 1191 → window [1146, 1191] → 1151
  ];
  const cuts = audio.planCutTimes(1800, 600, silences);
  assert.deepEqual(cuts, [591, 1151, 1751]);
  const lengths = [cuts[0], ...cuts.slice(1).map((c, i) => c - cuts[i]), 1800 - cuts.at(-1)];
  assert.ok(lengths.every((l) => l <= 600), `no segment exceeds 600 s: ${lengths}`);
});

test('mergeShortTail folds a sub-2 s final piece into the previous one (pure)', () => {
  const listing = [
    { path: '/a/seg-0000.flac', index: 0, durationSeconds: 600.012 },
    { path: '/a/seg-0001.flac', index: 1, durationSeconds: 599.976 },
    { path: '/a/seg-0002.flac', index: 2, durationSeconds: 0.108 },
  ];
  const { segments, merge } = audio.mergeShortTail(listing);
  assert.equal(segments.length, 2);
  assert.equal(segments[1].durationSeconds, 600.084);
  assert.equal(merge.into.path, '/a/seg-0001.flac');
  assert.equal(merge.from.path, '/a/seg-0002.flac');
  assert.equal(audio.mergeShortTail(listing.slice(0, 2)).merge, null);
  assert.equal(audio.mergeShortTail([{ path: '/x', durationSeconds: 0.5 }]).merge, null, 'a lone short clip stays');
  assert.equal(audio.mergeShortTail([{ path: '/x', durationSeconds: 600 }, { path: '/y', durationSeconds: null }]).merge, null, 'unknown length is never merged');
});

test('parsers: silencedetect output and ffmpeg -progress clock', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 27.0079',
    '[silencedetect @ 0x1] silence_end: 28.544 | silence_duration: 1.53606',
    'size=N/A time=00:00:30.00',
    '[silencedetect @ 0x1] silence_start: 55.552',
    '[silencedetect @ 0x1] silence_end: 57.024 | silence_duration: 1.472',
    '[silencedetect @ 0x1] silence_start: 69.5',
  ].join('\n');
  assert.deepEqual(audio.parseSilences(stderr), [{ start: 27.0079, end: 28.544 }, { start: 55.552, end: 57.024 }]);
  assert.equal(audio.parseProgressDuration('out_time_us=1000\nout_time_us=69888000\nout_time_ms=69888000\n'), 69.888);
  assert.equal(audio.parseProgressDuration('out_time=05:00:00.250000\n'), 18000.25);
  assert.equal(audio.parseProgressDuration(''), 0);
});

test('probeAudioDuration: container header → stream header → one decode pass', async () => {
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push([path.basename(bin), args.includes('format=duration') ? 'format' : args.includes('stream=duration') ? 'stream' : 'decode']);
    if (args.includes('-progress')) return { stdout: 'out_time_us=12000\nout_time_us=18000000000\nprogress=end\n', stderr: '' };
    return { stdout: 'N/A\n', stderr: '' };
  };
  assert.equal(await audio.probeAudioDuration('/media/clase.webm', { env: {}, execFileImpl }), 18000);
  assert.deepEqual(calls, [['ffprobe', 'format'], ['ffprobe', 'stream'], ['ffmpeg', 'decode']]);
  assert.equal(await audio.probeAudioDuration('/media/x', { env: {}, execFileImpl: async () => { throw new Error('missing'); } }), 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(audio.probeAudioDuration('/media/x', { env: {}, signal: aborted.signal }), { name: 'AbortError' });
});

test('unknown length on the local path is cut into segments instead of one whole-file whisper run', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'grabacion.webm');
  fs.writeFileSync(file, 'webm-without-duration');
  const pieces = [600, 600, 300].map((seconds, index) => {
    const p = path.join(dir, `seg-${index}.flac`);
    fs.writeFileSync(p, `piece-${index}`);
    return { path: p, index, offsetSeconds: index * 600, durationSeconds: seconds };
  });
  const calls = [];
  const result = await audio.transcribe(file, 'audio/webm', 'grabacion.webm', {
    env: { TRANSCRIBE_PROVIDERS: 'local', WHISPER_LANGUAGE: 'es' },
    probeAudioDuration: async () => 0,
    segmentAudio: async () => ({ dir: null, segments: pieces }),
    async localTranscribe(segPath, options) {
      calls.push({ file: path.basename(segPath), language: options.language });
      return { text: `tramo ${calls.length}`, segments: [{ start: 1, end: 2, text: 'x' }], model: 'ggml-base.bin' };
    },
  });
  assert.deepEqual(calls.map((c) => c.file), ['seg-0.flac', 'seg-1.flac', 'seg-2.flac']);
  assert.equal(calls[0].language, undefined, '25 measured minutes are detected, not forced to the short-clip hint');
  assert.equal(result.ok, true);
  assert.equal(result.durationSec, 1500, 'the measured length is reported');
  assert.equal(result.segmentCount, 3);
  assert.deepEqual(result.segments.map((s) => s.start), [1, 601, 1201]);
});

test('unknown length that ffmpeg cannot cut still reaches the local decoder whole', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'raro.bin');
  fs.writeFileSync(file, 'opaque');
  const seen = [];
  const result = await audio.transcribe(file, 'audio/ogg', 'raro.ogg', {
    env: { TRANSCRIBE_PROVIDERS: 'local' },
    probeAudioDuration: async () => 0,
    segmentAudio: async () => { throw Object.assign(new Error('ffmpeg exited 1'), { code: 'SEGMENT_FAILED' }); },
    async localTranscribe(p) { seen.push(p); return { text: 'hola entera' }; },
  });
  assert.deepEqual(seen, [file]);
  assert.equal(result.transcript, 'hola entera');
});

test('real ffmpeg: one silence-snapped FLAC cut with a manifest, reused after a restart', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-seg-real-');
  const source = synthAudio(dir, 'clase.wav', 70, [[27, 28.5], [55.5, 57]]);
  const checkpoint = { dir: path.join(dir, 'ckpt') };
  const io = counting();
  const fileSize = fs.statSync(source).size;
  const first = await audio.prepareSegments(source, { env: {}, checkpoint, ...io }, { segmentSeconds: 30, durationSeconds: 70, fileSize });
  assert.equal(first.persistent, true);
  assert.equal(first.dir, path.join(checkpoint.dir, 'audio'));
  assert.equal(first.segments.length, 3);
  const offsets = first.segments.map((s) => s.offsetSeconds);
  assert.equal(offsets[0], 0);
  assert.ok(Math.abs(offsets[1] - 27.77) < 0.35, `first cut lands in the first pause: ${offsets}`);
  assert.ok(Math.abs(offsets[2] - 56.29) < 0.35, `second cut lands in the second pause: ${offsets}`);
  const total = first.segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  assert.ok(Math.abs(total - 70) < 0.1, `durations add up to the source: ${total}`);
  for (const s of first.segments) {
    assert.match(path.basename(s.path), /^seg-\d{4}\.flac$/);
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', s.path]);
    assert.ok(Math.abs(Number(stdout) - s.durationSeconds) < 0.01, 'each FLAC header carries its own length');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.total, 3);
  assert.equal(manifest.segmentSeconds, 30);
  assert.equal(manifest.plan.hash, first.plan.hash);
  assert.equal(first.plan.kind, 'snapped');

  const before = { ...io.counts };
  const again = await audio.prepareSegments(source, { env: {}, checkpoint, ...io }, { segmentSeconds: 30, durationSeconds: 70, fileSize });
  assert.equal(again.reused, true);
  assert.deepEqual(io.counts, before, 'a restart re-uses the pieces: no ffmpeg / ffprobe at all');
  assert.equal(again.plan.hash, first.plan.hash);

  const changed = await audio.prepareSegments(source, { env: {}, checkpoint, ...io }, { segmentSeconds: 30, durationSeconds: 70, fileSize: fileSize + 1 });
  assert.notEqual(changed.reused, true, 'another source size re-cuts');
});

test('real ffmpeg: unknown length is cut on fixed times and a 1 s tail is merged', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-seg-tail-');
  const source = synthAudio(dir, 'nota.wav', 61);
  const prepared = await audio.prepareSegments(source, { env: {} }, { segmentSeconds: 30, durationSeconds: 0, fileSize: fs.statSync(source).size });
  t.after(() => fs.rmSync(prepared.dir, { recursive: true, force: true }));
  assert.equal(prepared.persistent, false);
  assert.equal(prepared.segments.length, 2, 'no request for a 1 s tail');
  assert.ok(Math.abs(prepared.segments[1].durationSeconds - 31) < 0.2, `tail merged: ${prepared.segments.map((s) => s.durationSeconds)}`);
  assert.equal(fs.readdirSync(prepared.dir).filter((n) => n.endsWith('.flac')).length, 2);
  assert.equal(prepared.plan.kind, 'fixed');
});

test('real ffmpeg end to end: header-less length probed, cut once, every part reused after a restart', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const dir = tempDir(t, 'sira-seg-e2e-');
  const source = synthAudio(dir, 'clase.wav', 70, [[27, 28.5], [55.5, 57]]);
  const checkpoint = createDiskCheckpoint(path.join(dir, 'media-ckpt'));
  const calls = [];
  const options = {
    env: { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_SEGMENT_SECONDS: '30' },
    checkpoint,
    async localTranscribe(p, opts) {
      calls.push({ name: path.basename(p), language: opts.language });
      return { text: `parte ${calls.length}`, language: 'es', segments: [{ start: 0.5, end: 1.5, text: `parte ${calls.length}` }], model: 'ggml-base.bin' };
    },
  };
  const first = await audio.transcribe(source, 'audio/wav', 'clase.wav', { ...options, signal: new AbortController().signal });
  assert.equal(first.ok, true);
  assert.equal(first.segmentCount, 3);
  assert.ok(Math.abs(first.durationSec - 70) < 0.1);
  assert.deepEqual(calls.map((c) => c.name), ['seg-0000.flac', 'seg-0001.flac', 'seg-0002.flac']);
  assert.deepEqual(calls.map((c) => c.language), [undefined, 'es', 'es'], 'detected on the first piece, then locked');
  assert.deepEqual(first.providers, { local: 3 });
  assert.equal(first.engine, 'local');
  assert.ok(fs.existsSync(path.join(checkpoint.dir, 'audio', 'manifest.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(checkpoint.dir, 'audio', 'manifest.json'), 'utf8')).language, 'es');

  calls.length = 0;
  const again = await audio.transcribe(source, 'audio/wav', 'clase.wav', { ...options, signal: new AbortController().signal });
  assert.equal(calls.length, 0, 'every part comes from the checkpoint');
  assert.equal(again.transcript, first.transcript);
  await checkpoint.clear();
  assert.equal(fs.existsSync(checkpoint.dir), false, 'the queue\'s clear() also removes the audio pieces');
});
