'use strict';

// Decode completeness is separate from speech coverage: every produced piece
// can transcribe successfully even when the decoder omitted most of the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audio = require('../src/services/audio-transcriber');

function fixture(t, { duration = 36000, trackDuration = duration, lengths = [600], video = true, startTimeSec = 0, formatStartTimeSec = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-complete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, video ? 'clase.webm' : 'clase.flac');
  fs.writeFileSync(file, 'source');
  let offset = 0;
  const pieces = lengths.map((length, index) => {
    const piece = path.join(dir, `seg-${index}.flac`);
    fs.writeFileSync(piece, `piece-${index}`);
    const entry = { path: piece, index, offsetSeconds: offset, durationSeconds: length };
    offset += length;
    return entry;
  });
  const calls = [];
  const options = {
    env: { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_QUALITY_LOOP: '0' },
    language: 'es', durationSeconds: duration,
    mediaProbe: { ok: true, durationSec: duration, formatStartTimeSec, hasAudio: true, hasVideo: video,
      audio: [{ streamOrdinal: 0, index: 0, durationSec: trackDuration, startTimeSec, isDefault: true }],
      video: video ? [{ streamOrdinal: 0, index: 1, durationSec: duration }] : [], subtitles: [] },
    segmentAudio: async () => ({ dir: null, segments: pieces }),
    localTranscribe: async (piece) => {
      calls.push(piece);
      const i = pieces.findIndex(entry => entry.path === piece);
      const text = `Contenido de la clase, tramo ${i + 1}.`;
      return { text, language: 'es', model: 'ggml-base.bin',
        segments: [{ start: 0, end: lengths[i], text }] };
    },
  };
  const transcribe = () => audio.transcribe(file, video ? 'video/webm' : 'audio/flac', path.basename(file), options);
  return { transcribe, calls, options };
}

test('a ten-hour track decoded as ten minutes fails before any STT request', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.transcribe(), err => {
    assert.equal(err.code, 'audio_decode_incomplete');
    assert.equal(err.retryable, true);
    assert.equal(err.expectedDurationSeconds, 36000);
    assert.equal(err.decodedDurationSeconds, 600);
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('all sixty pieces of a ten-hour track are transcribed and kept in order', async (t) => {
  const f = fixture(t, { lengths: Array(60).fill(600) });
  const result = await f.transcribe();
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.coverage, 1);
  assert.equal(result.durationSec, 36000);
  assert.equal(result.segmentCount, 60);
  assert.equal(f.calls.length, 60);
  assert.deepEqual(result.segments.map(segment => segment.start), Array.from({ length: 60 }, (_, i) => i * 600));
  assert.equal(result.segments.at(-1).end, 36000);
});

test('a known audio track may legitimately end before the ten-hour video', async (t) => {
  const f = fixture(t, { trackDuration: 1200, lengths: [600, 600] });
  const result = await f.transcribe();
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(f.calls.length, 2);
});

test('a late audio track keeps its initial silence relative to the video clock', async (t) => {
  const complete = fixture(t, { trackDuration: 600, startTimeSec: 600, lengths: [600, 600] });
  assert.equal((await complete.transcribe()).ok, true);
  const shortened = fixture(t, { trackDuration: 600, startTimeSec: 600, lengths: [600] });
  await assert.rejects(shortened.transcribe(), { code: 'audio_decode_incomplete', expectedDurationSeconds: 1200 });
});

test('matching nonzero audio and container starts do not add phantom silence', async (t) => {
  const complete = fixture(t, { video: false, trackDuration: 1200, startTimeSec: 600, formatStartTimeSec: 600, lengths: [600, 600] });
  assert.equal((await complete.transcribe()).ok, true);
});

test('a video with unknown track duration is not rejected using its container length', async (t) => {
  const f = fixture(t, { trackDuration: null, lengths: [600, 600] });
  const result = await f.transcribe();
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 2);
});

test('audio-only source duration also detects a missing final piece', async (t) => {
  const f = fixture(t, { video: false, trackDuration: null, lengths: Array(59).fill(600) });
  await assert.rejects(f.transcribe(), { code: 'audio_decode_incomplete' });
  assert.equal(f.calls.length, 0);
});

test('small timestamp rounding is tolerated but a missing minute is not', async (t) => {
  const complete = fixture(t, { lengths: [...Array(59).fill(600), 599.9] });
  assert.equal((await complete.transcribe()).ok, true);
  const truncated = fixture(t, { lengths: [...Array(59).fill(600), 540] });
  await assert.rejects(truncated.transcribe(), { code: 'audio_decode_incomplete' });
  assert.equal(truncated.calls.length, 0);
});

let hasFfmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  hasFfmpeg = true;
} catch { /* optional local media binaries */ }

test('real ffmpeg: timestamp gaps keep silence and pass the audio completeness gate', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-pts-gap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'paused-recording.m4a');
  execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-af', "asetpts='if(gte(T,1),PTS+8/TB,PTS)'", '-c:a', 'aac', source], { stdio: 'pipe' });
  const expected = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source], { encoding: 'utf8' }));
  assert.ok(Math.abs(expected - 10) < 0.1);
  const checkpoint = { dir: path.join(dir, 'checkpoint') };
  const context = { durationSeconds: expected, segmentSeconds: 30, expectedAudioDurationSeconds: expected, fileSize: fs.statSync(source).size };
  const result = await audio.prepareSegments(source, { env: { TRANSCRIBE_SILENCE_SNAP: '0' }, checkpoint }, context);
  const measured = result.segments.reduce((sum, part) => sum + part.durationSeconds, 0);
  assert.ok(Math.abs(measured - expected) < 0.1, `the eight-second pause must remain in the audio clock: ${measured}`);
  const originalClock = audio.planOf(result.segments, 30);
  assert.notEqual(result.plan.hash, originalClock.hash, 're-timed pieces cannot reuse old PCM-only checkpoints');
  const resumed = await audio.prepareSegments(source, { env: {}, checkpoint,
    spawnImpl() { throw new Error('complete cut must be reused'); },
  }, context);
  assert.equal(resumed.reused, true);
  assert.equal(resumed.plan.hash, result.plan.hash);
});
