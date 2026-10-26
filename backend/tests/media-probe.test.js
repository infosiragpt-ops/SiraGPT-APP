'use strict';

// media-probe (contract C1): one bounded ffprobe call → streams; the audio
// track choice (language, disposition, commentary/music titles — never
// loudness); text subtitle tracks → timed segments. Offline: ffprobe/ffmpeg
// are faked, except one fixture test that runs the real binaries when they
// are installed (skipped honestly otherwise).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mediaProbe = require('../src/services/media-probe');

const {
  probeMediaStreams, chooseAudioStream, extractSubtitleSegments, parseProbeJson, parseSrt,
  cleanSubtitleText, normalizeLanguage, runMediaCommand, detectFfmpegFilters, resetMediaProbeMemo,
} = mediaProbe;

function disposition(over = {}) {
  return { default: 0, comment: 0, forced: 0, hearing_impaired: 0, visual_impaired: 0, attached_pic: 0, karaoke: 0, ...over };
}

// ffprobe -show_streams -show_format -of json of an OBS-style MKV: video,
// a mono Spanish mic track, a stereo English commentary, a subrip track and
// a PGS track. No default flags (the case ffmpeg resolves by channel count).
const MKV_FIXTURE = {
  streams: [
    { index: 0, codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001', disposition: disposition(), tags: { DURATION: '01:02:03.500000000' } },
    { index: 1, codec_name: 'aac', codec_type: 'audio', channels: 1, channel_layout: 'mono', sample_rate: '48000', disposition: disposition(), tags: { language: 'spa', DURATION: '01:02:03.480000000' } },
    { index: 2, codec_name: 'aac', codec_type: 'audio', channels: 2, channel_layout: 'stereo', sample_rate: '48000', disposition: disposition(), tags: { language: 'eng', title: 'Commentary' } },
    { index: 3, codec_name: 'subrip', codec_type: 'subtitle', disposition: disposition({ forced: 1 }), tags: { language: 'spa' } },
    { index: 4, codec_name: 'hdmv_pgs_subtitle', codec_type: 'subtitle', disposition: disposition(), tags: { language: 'eng' } },
  ],
  format: { format_name: 'matroska,webm', duration: '3723.500000' },
};

const MP4_NO_AUDIO_FIXTURE = {
  streams: [{ index: 0, codec_name: 'h264', codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '25/1', disposition: disposition() }],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.000000' },
};

const MP3_COVER_FIXTURE = {
  streams: [
    { index: 0, codec_name: 'mp3', codec_type: 'audio', channels: 2, sample_rate: '44100', duration: '182.4', disposition: disposition() },
    { index: 1, codec_name: 'mjpeg', codec_type: 'video', width: 600, height: 600, avg_frame_rate: '0/0', disposition: disposition({ attached_pic: 1 }) },
  ],
  format: { format_name: 'mp3', duration: '182.400000' },
};

function silentLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(['warn', m]), info: (m) => lines.push(['info', m]), log: (m) => lines.push(['log', m]) };
}

describe('parseProbeJson · the C1 shape', () => {
  test('lists audio, subtitle and video streams with ordinals, languages and dispositions', () => {
    const probe = parseProbeJson(JSON.stringify(MKV_FIXTURE));
    assert.equal(probe.ok, true);
    assert.equal(probe.durationSec, 3723.5);
    assert.equal(probe.formatName, 'matroska,webm');
    assert.equal(probe.hasAudio, true);
    assert.equal(probe.hasVideo, true);
    assert.equal(probe.hasTextSubtitles, true);
    assert.deepEqual(probe.audio.map((a) => [a.index, a.streamOrdinal, a.language, a.channels]), [[1, 0, 'es', 1], [2, 1, 'en', 2]]);
    assert.equal(probe.audio[0].durationSec, 3723.48, 'Matroska DURATION tag');
    assert.equal(probe.audio[0].sampleRate, 48000);
    assert.equal(probe.audio[1].isComment, true, 'commentary by title');
    assert.equal(probe.audio[0].isDefault, false);
    assert.deepEqual(probe.subtitles.map((s) => [s.index, s.streamOrdinal, s.codec, s.textBased, s.isForced]),
      [[3, 0, 'subrip', true, true], [4, 1, 'hdmv_pgs_subtitle', false, false]]);
    assert.equal(probe.video[0].fps, 29.97);
    assert.equal(probe.video[0].attachedPic, false);
    for (const key of ['index', 'streamOrdinal', 'codec', 'channels', 'sampleRate', 'language', 'title', 'isDefault', 'isComment', 'isVisualImpaired', 'isHearingImpaired', 'durationSec']) {
      assert.ok(key in probe.audio[0], `audio.${key}`);
    }
    for (const key of ['index', 'streamOrdinal', 'codec', 'language', 'title', 'isDefault', 'isForced', 'textBased']) {
      assert.ok(key in probe.subtitles[0], `subtitles.${key}`);
    }
    for (const key of ['index', 'codec', 'width', 'height', 'attachedPic', 'fps']) assert.ok(key in probe.video[0], `video.${key}`);
  });

  test('a video without audio and an mp3 with cover art are told apart', () => {
    const silent = parseProbeJson(MP4_NO_AUDIO_FIXTURE);
    assert.equal(silent.hasAudio, false);
    assert.equal(silent.hasVideo, true);
    assert.equal(silent.durationSec, 5);
    const song = parseProbeJson(MP3_COVER_FIXTURE);
    assert.equal(song.hasAudio, true);
    assert.equal(song.hasVideo, false, 'cover art is not a picture to read');
    assert.equal(song.video[0].attachedPic, true);
    assert.equal(song.audio[0].durationSec, 182.4);
  });

  test('normalizes Matroska end-clock tags without subtracting starts from direct durations', () => {
    const probe = parseProbeJson({
      format: { format_name: 'matroska,webm', start_time: '8.000000', duration: '10.000000' },
      streams: [
        { index: 0, codec_type: 'audio', start_time: '8.000000', tags: { DURATION: '00:00:10.000000000' } },
        { index: 1, codec_type: 'audio', start_time: '8.000000', duration: '2.000000', tags: { DURATION: '00:00:10.000000000' } },
        { index: 2, codec_type: 'video', start_time: '8.000000', tags: { duration: '00:00:10.000000000' } },
      ],
    });
    assert.equal(probe.formatStartTimeSec, 8);
    assert.equal(probe.durationSec, 10, 'preserve the container duration reported by ffprobe');
    assert.deepEqual(probe.audio.map((a) => [a.durationSec, a.startTimeSec]), [[2, 8], [2, 8]]);
    assert.deepEqual([probe.video[0].durationSec, probe.video[0].startTimeSec], [2, 8]);
    const otherContainer = parseProbeJson({
      format: { format_name: 'mp3' },
      streams: [{ index: 0, codec_type: 'audio', start_time: '8', tags: { DURATION: '00:00:10' } }],
    });
    assert.equal(otherContainer.audio[0].durationSec, 10, 'other formats keep their tag semantics');
  });

  test('keeps signed clock starts, treats missing clocks as unknown and rejects impossible tag spans', () => {
    const probe = parseProbeJson({
      format: { format_name: 'matroska', start_time: '-0.021333' },
      streams: [
        { index: 0, codec_type: 'audio', start_time: '-0.021333', tags: { DURATION: '00:00:02.000000000' } },
        { index: 1, codec_type: 'audio', start_time: '0', duration: '2' },
        { index: 2, codec_type: 'audio', start_time: 'N/A', tags: { DURATION: '00:00:02' } },
        { index: 3, codec_type: 'audio', tags: { DURATION: '00:00:02' } },
        { index: 4, codec_type: 'audio', start_time: '8', tags: { DURATION: '00:00:02' } },
        { index: 5, codec_type: 'audio', start_time: null, duration: '2' },
        { index: 6, codec_type: 'audio', start_time: '', duration: '2' },
        { index: 7, codec_type: 'audio', start_time: false, duration: '2' },
      ],
    });
    assert.equal(probe.formatStartTimeSec, -0.021);
    assert.deepEqual(probe.audio.map((a) => a.startTimeSec), [-0.021, 0, null, null, 8, null, null, null]);
    assert.deepEqual(probe.audio.map((a) => a.durationSec), [2.021, 2, 2, 2, null, 2, 2, 2]);
    assert.equal(parseProbeJson({ format: { start_time: 'Infinity' } }).formatStartTimeSec, null);
    assert.equal(parseProbeJson(null).formatStartTimeSec, null);
  });

  test('retains delayed track end time when no container duration is available', () => {
    const probe = parseProbeJson({
      format: { format_name: 'matroska', start_time: '0' },
      streams: [
        { index: 0, codec_type: 'video', start_time: '0', tags: { DURATION: '00:00:05' } },
        { index: 1, codec_type: 'audio', start_time: '8', tags: { DURATION: '00:00:10' } },
      ],
    });
    assert.equal(probe.audio[0].durationSec, 2);
    assert.equal(probe.durationSec, 10, 'late audio still extends the recording to ten seconds');
  });

  test('garbage never throws', () => {
    assert.deepEqual(parseProbeJson('{not json').reason, 'invalid_json');
    assert.equal(parseProbeJson(null).ok, false);
    const odd = parseProbeJson({ streams: [null, { codec_type: 'audio' }, { index: 'x', codec_type: 'video' }], format: null });
    assert.equal(odd.ok, true);
    assert.equal(odd.audio.length, 0);
    assert.equal(odd.durationSec, null);
  });
});

describe('probeMediaStreams · one bounded ffprobe call', () => {
  test('runs ONE ffprobe with -show_streams -show_format, JSON, 4 MB cap and an absolute input', async () => {
    const calls = [];
    const exec = async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { stdout: Buffer.from(JSON.stringify(MKV_FIXTURE)), code: 0 };
    };
    const probe = await probeMediaStreams('relative/clip.mkv', { exec, timeoutMs: 1234 });
    assert.equal(probe.ok, true);
    assert.equal(calls.length, 1);
    const { bin, args, opts } = calls[0];
    assert.equal(bin, 'ffprobe');
    for (const flag of ['-show_streams', '-show_format']) assert.ok(args.includes(flag), flag);
    assert.deepEqual(args.slice(args.indexOf('-of'), args.indexOf('-of') + 2), ['-of', 'json']);
    assert.ok(args.includes('-probesize'), 'larger probe window for late audio PIDs');
    assert.equal(path.isAbsolute(args[args.length - 1]), true, 'never parsed as an option or a protocol');
    assert.equal(opts.maxBuffer, 4 * 1024 * 1024);
    assert.equal(opts.timeoutMs, 1234);
  });

  test('failures come back typed, never thrown; a missing binary warns once', async () => {
    resetMediaProbeMemo();
    const logger = silentLogger();
    const enoent = Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
    const missing1 = await probeMediaStreams('/x.mp4', { exec: async () => { throw enoent; }, logger });
    const missing2 = await probeMediaStreams('/x.mp4', { exec: async () => ({ missing: true }), logger });
    for (const r of [missing1, missing2]) {
      assert.equal(r.ok, false);
      assert.equal(r.error, 'probe_failed');
      assert.equal(r.reason, 'ffprobe_missing');
      assert.deepEqual([r.audio, r.subtitles, r.video], [[], [], []]);
    }
    assert.equal(logger.lines.filter(([level]) => level === 'warn').length, 1, 'WARN once');

    assert.equal((await probeMediaStreams('/x.mp4', { exec: async () => ({ timedOut: true }) })).reason, 'timeout');
    assert.equal((await probeMediaStreams('/x.mp4', { exec: async () => { throw Object.assign(new Error('t'), { killed: true }); } })).reason, 'timeout');
    assert.equal((await probeMediaStreams('/x.mp4', { exec: async () => ({ stdoutTruncated: true, stdout: '{' }) })).reason, 'output_too_large');
    assert.equal((await probeMediaStreams('/x.mp4', { exec: async () => ({ stdout: '', code: 1 }) })).reason, 'unreadable');
    assert.equal((await probeMediaStreams('/x.mp4', { exec: async () => null })).reason, 'unreadable');
    assert.equal((await probeMediaStreams('/x.mp4', { exec: async () => ({ stdout: 'nope', code: 0 }) })).reason, 'invalid_json');
    assert.equal((await probeMediaStreams('', {})).reason, 'missing_path');
  });

  test('an aborted signal never starts ffprobe', async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const r = await probeMediaStreams('/x.mp4', { signal: controller.signal, exec: async () => { called = true; return {}; } });
    assert.equal(r.reason, 'aborted');
    assert.equal(called, false);
  });
});

describe('chooseAudioStream · language, disposition, not secondary, channels, index', () => {
  const track = (over) => ({ index: 1, streamOrdinal: 0, channels: 2, language: null, isDefault: false, isComment: false, isVisualImpaired: false, isMusic: false, ...over });

  test('null only without audio streams', () => {
    assert.equal(chooseAudioStream({ audio: [] }), null);
    assert.equal(chooseAudioStream(parseProbeJson(MP4_NO_AUDIO_FIXTURE)), null);
    assert.equal(chooseAudioStream(null), null);
    assert.deepEqual(chooseAudioStream({ audio: [track({ index: 3, streamOrdinal: 0 })] }), { streamOrdinal: 0, index: 3, reason: 'only_stream', language: null });
  });

  test('the requested language wins over the default disposition', () => {
    const probe = { audio: [track({ index: 1, streamOrdinal: 0, language: 'en', isDefault: true }), track({ index: 2, streamOrdinal: 1, language: 'es' })] };
    assert.deepEqual(chooseAudioStream(probe, { language: 'Español' }), { streamOrdinal: 1, index: 2, reason: 'language_match', language: 'es' });
    assert.deepEqual(chooseAudioStream(probe, { language: 'eng' }), { streamOrdinal: 0, index: 1, reason: 'language_match', language: 'en' });
    assert.equal(chooseAudioStream(probe, {}).reason, 'default_disposition');
  });

  test('commentary, audio description and music beds lose to the dialogue track', () => {
    const fixture = parseProbeJson(MKV_FIXTURE);
    // ffmpeg would pick the stereo commentary (more channels); we do not.
    assert.deepEqual(chooseAudioStream(fixture), { streamOrdinal: 0, index: 1, reason: 'not_secondary', language: 'es' });
    const obs = { audio: [track({ index: 1, streamOrdinal: 0, channels: 2, title: 'Desktop Audio', isMusic: true }), track({ index: 2, streamOrdinal: 1, channels: 1, title: 'Mic/Aux' })] };
    assert.equal(chooseAudioStream(obs).streamOrdinal, 1);
    const ad = { audio: [track({ index: 1, streamOrdinal: 0, isVisualImpaired: true, channels: 6 }), track({ index: 2, streamOrdinal: 1 })] };
    assert.equal(chooseAudioStream(ad).streamOrdinal, 1);
  });

  test('then more channels, then the lowest index', () => {
    const channels = { audio: [track({ index: 1, streamOrdinal: 0, channels: 1 }), track({ index: 2, streamOrdinal: 1, channels: 6 })] };
    assert.deepEqual(chooseAudioStream(channels), { streamOrdinal: 1, index: 2, reason: 'more_channels', language: null });
    const tie = { audio: [track({ index: 4, streamOrdinal: 1 }), track({ index: 2, streamOrdinal: 0 })] };
    assert.deepEqual(chooseAudioStream(tie), { streamOrdinal: 0, index: 2, reason: 'lowest_index', language: null });
  });

  test('titles and dispositions are read by the probe', () => {
    const probe = parseProbeJson({
      streams: [
        { index: 0, codec_type: 'audio', channels: 2, tags: { title: 'Música y efectos' }, disposition: disposition() },
        { index: 1, codec_type: 'audio', channels: 2, tags: { title: 'Audiodescripción' }, disposition: disposition() },
        { index: 2, codec_type: 'audio', channels: 2, disposition: disposition({ visual_impaired: 1 }) },
        { index: 3, codec_type: 'audio', channels: 1, tags: { title: 'Diálogo' }, disposition: disposition() },
      ],
      format: {},
    });
    assert.deepEqual(probe.audio.map((a) => [a.isMusic, a.isVisualImpaired]), [[true, false], [false, true], [false, true], [false, false]]);
    assert.equal(chooseAudioStream(probe).index, 3);
  });
});

test('normalizeLanguage maps ISO 639-2 tags, BCP-47 and names', () => {
  assert.equal(normalizeLanguage('spa'), 'es');
  assert.equal(normalizeLanguage('ger'), 'de');
  assert.equal(normalizeLanguage('es-419'), 'es');
  assert.equal(normalizeLanguage('pt_BR'), 'pt');
  assert.equal(normalizeLanguage('Inglés'), 'en');
  assert.equal(normalizeLanguage('und'), null);
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage('xyz'), 'xyz', 'unknown 3-letter codes still compare equal');
  assert.equal(normalizeLanguage('12'), null);
});

describe('subtitle text', () => {
  test('cleanSubtitleText strips ASS overrides, HTML tags, escapes and entities', () => {
    assert.equal(cleanSubtitleText('{\\an8}<i>Hola</i> {\\i1}mundo{\\i0}\\Nsegunda\\hlínea &amp; <font color="#fff">más</font>'),
      'Hola mundo segunda línea & más');
  });

  test('parseSrt handles CRLF, BOM, hours > 99 min, empty cues and roll-up duplicates', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<b>Uno</b>\r\n\r\n'
      + '2\n00:00:02,600 --> 00:00:03,000\nUno\n\n'
      + '3\n00:00:04.000 --> 00:00:05.000\n{\\an8}\n\n'
      + '4\n105:00:00,000 --> 105:00:02,000\nDos\nlíneas\n';
    assert.deepEqual(parseSrt(srt), [
      { start: 1, end: 3, text: 'Uno' },
      { start: 378000, end: 378002, text: 'Dos líneas' },
    ]);
  });

  test('dropLast discards an incomplete trailing cue', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nCompleto\n\n2\n00:00:03,000 --> 00:00:04,000\nInc';
    assert.equal(parseSrt(srt, { dropLast: true }).length, 1);
  });
});

describe('extractSubtitleSegments · -map 0:s:N -f srt pipe:1', () => {
  const SRT = '1\n00:00:00,500 --> 00:00:01,500\n<i>Hola</i> mundo\n\n2\n00:00:02,000 --> 00:00:03,000\n{\\an8}Segunda\n\n';

  test('maps the Nth subtitle stream, parses it and reads the codec from the mapping line', async () => {
    const calls = [];
    const run = async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      opts.onStderrLine('Stream mapping:');
      opts.onStderrLine('  Stream #0:3 -> #0:0 (mov_text (tx3g / 0x67337874) -> subrip (srt))');
      return { code: 0, stdout: Buffer.from(SRT) };
    };
    const r = await extractSubtitleSegments('/v/clip.mp4', 2, { run, maxBytes: 4096, timeoutMs: 5000 });
    assert.deepEqual(r, { ok: true, codec: 'mov_text', segments: [{ start: 0.5, end: 1.5, text: 'Hola mundo' }, { start: 2, end: 3, text: 'Segunda' }] });
    const { bin, args, opts } = calls[0];
    assert.equal(bin, 'ffmpeg');
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:s:2']);
    assert.deepEqual(args.slice(-3), ['-f', 'srt', 'pipe:1']);
    assert.equal(opts.maxStdoutBytes, 4096);
    assert.equal(opts.timeoutMs, 5000);
  });

  test('bitmap tracks are refused without running ffmpeg', async () => {
    let ran = false;
    const r = await extractSubtitleSegments('/v/film.mkv', 1, { codec: 'hdmv_pgs_subtitle', run: async () => { ran = true; return {}; } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bitmap_subtitles');
    assert.equal(ran, false);
    const mapped = await extractSubtitleSegments('/v/film.mkv', 1, {
      run: async (_b, _a, opts) => { opts.onStderrLine('Stream #0:5 -> #0:0 (dvd_subtitle (dvdsub) -> subrip (srt))'); return { code: 1, stdout: Buffer.alloc(0) }; },
    });
    assert.equal(mapped.error, 'bitmap_subtitles');
  });

  test('the byte cap keeps complete cues and says so; errors are typed', async () => {
    const big = await extractSubtitleSegments('/v/a.mkv', 0, { run: async () => ({ code: null, stdoutTruncated: true, stdout: Buffer.from(`${SRT}3\n00:00:04,000 --> 00:00:05,000\nCor`) }) });
    assert.equal(big.ok, true);
    assert.equal(big.truncated, true);
    assert.equal(big.reason, 'max_bytes');
    assert.equal(big.segments.length, 2);

    resetMediaProbeMemo();
    const logger = silentLogger();
    assert.equal((await extractSubtitleSegments('/v/a.mkv', 0, { run: async () => ({ missing: true }), logger })).error, 'ffmpeg_missing');
    assert.equal(logger.lines.length, 1);
    assert.equal((await extractSubtitleSegments('/v/a.mkv', 9, { run: async () => ({ code: 234, stdout: Buffer.alloc(0), stderrTail: "Stream map '0:s:9' matches no streams." }) })).error, 'stream_not_found');
    assert.equal((await extractSubtitleSegments('/v/a.mkv', 0, { run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderrTail: '' }) })).error, 'subtitle_extract_failed');
    assert.equal((await extractSubtitleSegments('/v/a.mkv', 0, { run: async () => ({ timedOut: true, stdout: Buffer.alloc(0) }) })).error, 'timeout');
    assert.equal((await extractSubtitleSegments('/v/a.mkv', -1, {})).error, 'invalid_stream');
    const empty = await extractSubtitleSegments('/v/a.mkv', 0, { run: async () => ({ code: 0, stdout: Buffer.alloc(0) }) });
    assert.deepEqual([empty.ok, empty.segments.length], [true, 0]);
    const controller = new AbortController();
    controller.abort();
    assert.equal((await extractSubtitleSegments('/v/a.mkv', 0, { signal: controller.signal, run: async () => { throw new Error('must not run'); } })).error, 'aborted');
  });
});

describe('runMediaCommand · bounded child processes (real spawn of node)', () => {
  const node = process.execPath;

  test('stdout past the cap kills the child and marks it truncated', async () => {
    const res = await runMediaCommand(node, ['-e', 'process.stdout.write("x".repeat(200000)); setTimeout(()=>{}, 5000)'], { maxStdoutBytes: 1000, timeoutMs: 10_000 });
    assert.equal(res.stdoutTruncated, true);
    assert.equal(res.stdout.length, 1000);
  });

  test('timeout, abort, stderr lines and a missing binary', async () => {
    const slow = await runMediaCommand(node, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200 });
    assert.equal(slow.timedOut, true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await runMediaCommand(node, ['-e', 'setTimeout(()=>{}, 10000)'], { signal: controller.signal, timeoutMs: 10_000 });
    assert.equal(aborted.aborted, true);
    const lines = [];
    const res = await runMediaCommand(node, ['-e', 'process.stderr.write("uno\\ndos\\ntres")'], { onStderrLine: (l) => lines.push(l) });
    assert.equal(res.code, 0);
    assert.deepEqual(lines, ['uno', 'dos', 'tres']);
    const missing = await runMediaCommand('definitely-not-a-binary-sira', [], {});
    assert.equal(missing.missing, true);
  });
});

test('detectFfmpegFilters parses `ffmpeg -filters` and degrades without the binary', async () => {
  const listing = [
    'Filters:', '  T.. = Timeline support', ' ---',
    ' ... select            V->N       Select video frames to pass in output.',
    ' ... showinfo          V->V       Show textual information for each video frame.',
    ' ..C scale             V->V       Scale the input video size.',
    ' ... abuffer           |->A       Buffer audio frames.',
  ].join('\n');
  const found = await detectFfmpegFilters({ run: async () => ({ code: 0, stdout: Buffer.from(listing) }) });
  assert.equal(found.available, true);
  assert.deepEqual(Array.from(found.filters).sort(), ['abuffer', 'scale', 'select', 'showinfo']);
  const logger = silentLogger();
  const missing = await detectFfmpegFilters({ ffmpeg: 'no-ffmpeg-here', run: async () => ({ missing: true }), logger });
  assert.equal(missing.available, false);
});

const FILTER_LISTING = [
  'Filters:', ' ---',
  ' ... select            V->N       Select video frames to pass in output.',
  ' ... showinfo          V->V       Show textual information for each video frame.',
  ' ..C scale             V->V       Scale the input video size.',
].join('\n');

test('detectFfmpegFilters memoizes only definitive answers: a timeout is asked again', async () => {
  resetMediaProbeMemo();
  try {
    let clock = 1_000_000;
    const now = () => clock;
    const logger = silentLogger();
    const answers = [
      // Under load: killed at the 10 s timeout after writing half a listing.
      { code: null, signal: 'SIGKILL', timedOut: true, stdout: Buffer.from(FILTER_LISTING.split('\n').slice(0, 3).join('\n')) },
      { code: 0, stdout: Buffer.from(FILTER_LISTING) },
    ];
    let runs = 0;
    const run = async () => { runs += 1; return answers.shift() || { code: 0, stdout: Buffer.from(FILTER_LISTING) }; };
    const opts = { ffmpeg: 'ffmpeg-memo-test', run, memoize: true, logger, now };

    const first = await detectFfmpegFilters(opts);
    assert.equal(first.available, true, 'a timeout never says «ffmpeg is missing»');
    assert.equal(first.definitive, false);
    assert.equal(first.reason, 'timeout');
    assert.equal(first.filters, null, 'a truncated listing is not trusted as the filter set');
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0][1], /-filters did not answer \(timeout\)/);
    assert.doesNotMatch(logger.lines[0][1], /not available/);

    // Within the short memo: same answer, no new run.
    clock += 30_000;
    assert.equal((await detectFfmpegFilters(opts)).reason, 'timeout');
    assert.equal(runs, 1);

    // After it: asked again, and the clean answer is kept for good.
    clock += 31_000;
    const second = await detectFfmpegFilters(opts);
    assert.equal(runs, 2);
    assert.deepEqual([second.available, second.definitive], [true, true]);
    assert.deepEqual(Array.from(second.filters).sort(), ['scale', 'select', 'showinfo']);
    clock += 24 * 3600 * 1000;
    await detectFfmpegFilters(opts);
    assert.equal(runs, 2, 'a definitive answer is never asked again');

    // Other non-definitive runs: spawn errors, aborts, a non-zero exit, an
    // empty listing. A missing binary IS definitive and warned once.
    const { classifyFiltersRun } = mediaProbe;
    assert.equal(classifyFiltersRun({ error: 'EAGAIN', code: null }).reason, 'spawn_error');
    assert.equal(classifyFiltersRun({ error: 'EMFILE' }).definitive, false);
    assert.equal(classifyFiltersRun({ aborted: true }).reason, 'aborted');
    assert.equal(classifyFiltersRun({ code: 0, stdoutTruncated: true, stdout: Buffer.from(FILTER_LISTING) }).reason, 'truncated');
    assert.equal(classifyFiltersRun({ code: 1, stdout: Buffer.alloc(0) }).reason, 'exit_1');
    assert.equal(classifyFiltersRun({ code: 0, stdout: Buffer.from('nothing here') }).reason, 'unparsed');
    assert.deepEqual(
      { ...classifyFiltersRun({ missing: true, error: 'ENOENT' }), filters: null },
      { available: false, filters: null, definitive: true, reason: 'missing' },
    );

    resetMediaProbeMemo();
    let missingRuns = 0;
    const missingLogger = silentLogger();
    const missingOpts = { ffmpeg: 'ffmpeg-missing-memo', memoize: true, logger: missingLogger, now, run: async () => { missingRuns += 1; return { missing: true, error: 'ENOENT' }; } };
    assert.equal((await detectFfmpegFilters(missingOpts)).available, false);
    clock += 10 * 60 * 1000;
    assert.equal((await detectFfmpegFilters(missingOpts)).available, false);
    assert.equal(missingRuns, 1, 'ENOENT is definitive');
    assert.equal(missingLogger.lines.length, 1);
    assert.match(missingLogger.lines[0][1], /not available/);

    // A runner that throws is a non-definitive answer, never a crash.
    const thrown = await detectFfmpegFilters({ ffmpeg: 'ffmpeg-throws', run: async () => { throw new Error('boom'); }, logger: silentLogger() });
    assert.deepEqual([thrown.available, thrown.definitive], [true, false]);
  } finally {
    resetMediaProbeMemo();
  }
});

function hasBinary(bin) {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
}

const HAS_FFMPEG = hasBinary('ffmpeg') && hasBinary('ffprobe');

test('real ffmpeg fixtures: two audio tracks, a subrip and a mov_text track', { skip: HAS_FFMPEG ? false : 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-media-probe-'));
  try {
    const srt = path.join(dir, 'subs.srt');
    fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:01,500\n<i>Hola</i> mundo\n\n2\n00:00:02,000 --> 00:00:03,000\n{\\an8}Segunda línea\n\n');
    const mkv = path.join(dir, 'multi.mkv');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=s=160x120:d=4:r=5',
      '-f', 'lavfi', '-i', 'sine=f=440:d=4',
      '-f', 'lavfi', '-i', 'sine=f=880:d=4',
      '-i', srt,
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-ac:a:0', '1', '-ac:a:1', '2', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Commentary',
      '-metadata:s:s:0', 'language=spa', '-disposition:a:0', '0', '-disposition:a:1', '0',
      mkv], { stdio: 'ignore' });
    assert.equal(made.status, 0, 'fixture built');
    const probe = await probeMediaStreams(mkv);
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.audio.map((a) => [a.language, a.channels, a.isComment]), [['es', 1, false], ['en', 2, true]]);
    assert.equal(probe.hasTextSubtitles, true);
    assert.deepEqual(chooseAudioStream(probe), { streamOrdinal: 0, index: 1, reason: 'not_secondary', language: 'es' });
    const subs = await extractSubtitleSegments(mkv, probe.subtitles[0].streamOrdinal, { codec: probe.subtitles[0].codec });
    assert.equal(subs.ok, true);
    assert.deepEqual(subs.segments.map((s) => s.text), ['Hola mundo', 'Segunda línea']);
    assert.ok(Math.abs(subs.segments[0].start - 0.5) < 0.1);

    const mp4 = path.join(dir, 'movtext.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x120:d=4:r=5', '-i', srt,
      '-map', '0:v', '-map', '1:s', '-c:v', 'mpeg4', '-c:s', 'mov_text', mp4], { stdio: 'ignore' }).status, 0);
    const silent = await probeMediaStreams(mp4);
    assert.equal(silent.hasAudio, false);
    assert.equal(chooseAudioStream(silent), null);
    const movText = await extractSubtitleSegments(mp4, 0);
    assert.equal(movText.codec, 'mov_text');
    assert.deepEqual(movText.segments.map((s) => [s.start, s.text]), [[0.5, 'Hola mundo'], [2, 'Segunda línea']]);
    assert.equal((await extractSubtitleSegments(mp4, 3)).error, 'stream_not_found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('real Matroska delayed audio and PTS gaps retain the correct track clock', { skip: HAS_FFMPEG ? false : 'ffmpeg/ffprobe not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-media-probe-clock-'));
  try {
    const cases = [
      { name: 'audio-delayed', inputs: ['-f', 'lavfi', '-i', 'sine=f=440:d=2'], filter: 'asetpts=PTS+8/TB', formatStart: 8, trackStart: 8, duration: 2 },
      { name: 'av-delayed', inputs: ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1:d=10', '-f', 'lavfi', '-i', 'sine=f=440:d=2'], filter: 'asetpts=PTS+8/TB', formatStart: 0, trackStart: 8, duration: 2 },
      { name: 'audio-gap', inputs: ['-f', 'lavfi', '-i', 'sine=f=440:d=2'], filter: "asetpts=if(gte(T\\,1)\\,PTS+8/TB\\,PTS)", formatStart: 0, trackStart: 0, duration: 10 },
    ];
    for (const fixture of cases) {
      const file = path.join(dir, `${fixture.name}.mkv`);
      const made = spawnSync('ffmpeg', ['-v', 'error', '-y', ...fixture.inputs, '-af', fixture.filter, '-c:a', 'flac', '-c:v', 'ffv1', file], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(made.status, 0, `${fixture.name}: ${made.stderr || ''}`);
      const probe = await probeMediaStreams(file);
      assert.equal(probe.ok, true, fixture.name);
      assert.equal(probe.formatStartTimeSec, fixture.formatStart, fixture.name);
      assert.equal(probe.audio[0].startTimeSec, fixture.trackStart, fixture.name);
      assert.equal(probe.audio[0].durationSec, fixture.duration, fixture.name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
