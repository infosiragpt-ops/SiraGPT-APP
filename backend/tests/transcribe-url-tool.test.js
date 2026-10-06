'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tool = require('../src/services/agent-harness/tools/transcribe-url-tool');

const URL = 'https://www.youtube.com/watch?v=abc123';

/** Fake yt-dlp / ffmpeg: records every call, writes the files the real ones would. */
function fakeRunner({ probe = { duration: 1200, title: 'Clase 3 · Fotosíntesis' }, probeFail = null, downloadFail = null, ffmpegFail = null } = {}) {
  const calls = [];
  const runCommand = async (bin, args, { cwd } = {}) => {
    calls.push({ bin, args });
    if (bin === 'yt-dlp' && args.includes('--dump-single-json')) {
      if (probeFail) return { code: 1, stdout: '', stderr: probeFail };
      return { code: 0, stdout: JSON.stringify(probe), stderr: '' };
    }
    if (bin === 'yt-dlp') {
      if (downloadFail) return { code: 1, stdout: '', stderr: downloadFail };
      fs.writeFileSync(path.join(cwd, 'source.webm'), 'audio-bytes');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (bin === 'ffmpeg') {
      if (ffmpegFail) return { code: 1, stdout: '', stderr: ffmpegFail };
      fs.writeFileSync(args[args.length - 1], 'aac-bytes');
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected bin ${bin}`);
  };
  return { calls, runCommand };
}

function deps(over = {}) {
  const runner = fakeRunner(over.runner);
  const saved = [];
  const transcribed = [];
  return {
    calls: runner.calls,
    saved,
    transcribed,
    deps: {
      runCommand: runner.runCommand,
      dnsCheck: async () => true,
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tut-')),
      env: { TRANSCRIBE_URL_MAX_SECONDS: '3600', ...(over.env || {}) },
      // Browser discovery is injected: unit tests never launch Chromium.
      discoverMedia: over.discoverMedia || (async () => ({ ok: false, reason: 'no_media_found', candidates: [], loginWall: false })),
      cookieJar: over.cookieJar || { save: async () => ({ hosts: [] }), load: async () => null },
      loadAttachedCookies: over.loadAttachedCookies || (async () => null),
      computer: over.computer === undefined ? null : over.computer,
      capture: over.capture === undefined ? null : over.capture,
      transcribe: over.transcribe || (async (filePath, mime, name, opts) => {
        transcribed.push({ filePath, mime, name, opts });
        return {
          ok: true, status: 'ready', method: 'local-whisper', model: 'base', language: 'es',
          transcript: 'Hola a todos. Hoy vemos la fotosíntesis. Empecemos con la luz.',
          segments: [
            { start: 0, end: 2.4, text: 'Hola a todos.' },
            { start: 2.6, end: 6, text: 'Hoy vemos la fotosíntesis.' },
            { start: 40, end: 44, text: 'Empecemos con la luz.' },
          ],
        };
      }),
      saveArtifact: (input) => {
        saved.push(input);
        return { id: `art${saved.length}`, filename: input.filename, mime: input.mime, format: input.filename.split('.').pop(), sizeBytes: Buffer.from(input.base64, 'base64').length, downloadUrl: `/api/artifacts/art${saved.length}` };
      },
    },
  };
}

test('parseTimecode accepts seconds, mm:ss, hh:mm:ss, minutes and hours; rejects junk', () => {
  assert.equal(tool.parseTimecode('1:30'), 90);
  assert.equal(tool.parseTimecode('01:02:03'), 3723);
  assert.equal(tool.parseTimecode(90), 90);
  assert.equal(tool.parseTimecode('90'), 90);
  assert.equal(tool.parseTimecode('1.5 min'), 90);
  assert.equal(tool.parseTimecode('1,5 minutos'), 90);
  assert.equal(tool.parseTimecode('minuto 10'), 600);
  assert.equal(tool.parseTimecode('2h'), 7200);
  assert.equal(tool.parseTimecode('abc'), null);
  assert.equal(tool.parseTimecode(-5), null);
  assert.equal(tool.fmtClock(3723), '1:02:03');
  assert.equal(tool.fmtClock(90), '01:30');
  assert.equal(tool.fmtSrtTime(90.5), '00:01:30,500');
});

test('a timecode range downloads only that section, trims, transcribes and shifts timestamps to the recording clock', async () => {
  const d = deps();
  const events = [];
  const res = await tool.executeTranscribeUrl({ url: URL, start: '1:30', end: '10:00' }, { userId: 'u1', chatId: 'c1', onEvent: (e) => events.push(e) }, d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.title, 'Clase 3 · Fotosíntesis');
  assert.equal(res.host, 'youtube.com');
  assert.deepEqual(res.range, { start: 90, end: 600, label: '01:30 → 10:00' });
  assert.equal(res.durationSeconds, 1200);
  // yt-dlp: probe, then sectioned download; ffmpeg encodes mono 16 kHz AAC.
  const [probe, dl, ff] = d.calls;
  assert.ok(probe.args.includes('--dump-single-json') && probe.args.includes('--skip-download'));
  assert.ok(dl.args.includes('--download-sections') && dl.args.includes('*90-600'));
  assert.ok(dl.args.includes('--no-playlist'));
  assert.equal(dl.args[dl.args.length - 1], URL);
  assert.ok(ff.args.includes('-ar') && ff.args[ff.args.indexOf('-ar') + 1] === '16000');
  assert.ok(ff.args.includes('-t') && ff.args[ff.args.indexOf('-t') + 1] === '510');
  // The clip name carries the range; the transcriber gets the chat's signal-less options.
  assert.equal(d.transcribed.length, 1);
  assert.equal(d.transcribed[0].mime, 'audio/mp4');
  assert.match(d.transcribed[0].name, /Clase 3 Fotosintesis 01:30-10:00\.m4a$/);
  // Timestamps are shifted by the start offset (90 s).
  assert.match(res.text, /^\[01:30\] Hola a todos\. Hoy vemos la fotosíntesis\.\n\[02:10\] Empecemos con la luz\.$/);
  assert.equal(res.segments, 3);
  // One .txt artifact announced as a file card.
  assert.equal(d.saved.length, 1);
  assert.match(d.saved[0].filename, /transcripcion 01-30\.txt$/);
  assert.equal(d.saved[0].ownerUserId, 'u1');
  assert.match(Buffer.from(d.saved[0].base64, 'base64').toString('utf8'), /^Transcripción de «Clase 3 · Fotosíntesis» \(youtube\.com\) · 01:30 → 10:00 · idioma: es\n\n\[01:30\]/);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'file_artifact');
  assert.equal(events[0].artifact.filename, d.saved[0].filename);
  // The temp dir is removed.
  assert.deepEqual(fs.readdirSync(d.deps.tmpDir), []);
});

test('no range → whole recording, absolute ffmpeg trim is skipped and an .srt is delivered on request', async () => {
  const d = deps();
  const res = await tool.executeTranscribeUrl({ url: URL, subtitles: true }, {}, d.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.range, { start: 0, end: 1200, label: '00:00 → 20:00' });
  const dl = d.calls[1];
  assert.equal(dl.args.includes('--download-sections'), false);
  const ff = d.calls[2];
  assert.equal(ff.args.includes('-ss'), false);
  assert.equal(d.saved.length, 2);
  assert.match(d.saved[1].filename, /\.srt$/);
  assert.equal(d.saved[1].mime, 'application/x-subrip');
  assert.match(Buffer.from(d.saved[1].base64, 'base64').toString('utf8'), /^1\n00:00:00,000 --> 00:00:02,400\nHola a todos\.\n/);
  assert.ok(res.srtArtifact);
});

test('a login wall / private recording returns media_login_required with the two user paths, never a crash', async () => {
  const d = deps({ runner: { probeFail: 'ERROR: [generic] Unable to download webpage: HTTP Error 401: Unauthorized. Sign in to continue' } });
  const res = await tool.executeTranscribeUrl({ url: 'https://upn.class.com/player/recording/1d17' }, {}, d.deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'media_login_required');
  assert.match(res.userMessage, /iniciar sesión/);
  assert.match(res.userMessage, /adjúntalo en el chat/);
  assert.match(res.userMessage, /cookies\.txt/);
  assert.equal(res.discovery.reason, 'no_media_found', 'the browser rung ran before giving up');
  assert.equal(d.transcribed.length, 0);
  assert.equal(d.saved.length, 0);
});

test('download failures are classified: unsupported, not found, rate limited, missing yt-dlp', async () => {
  for (const [stderr, code] of [
    ['ERROR: Unsupported URL: https://example.com/page', 'media_unsupported_url'],
    ['ERROR: [youtube] abc: Video unavailable', 'media_not_found'],
    ['ERROR: HTTP Error 429: Too Many Requests', 'media_rate_limited'],
    ['ERROR: something odd', 'media_download_failed'],
  ]) {
    const d = deps({ runner: { downloadFail: stderr } });
    const res = await tool.executeTranscribeUrl({ url: URL, start: 0, end: 60 }, {}, d.deps);
    assert.equal(res.ok, false);
    assert.equal(res.code, code, stderr);
    assert.ok(res.userMessage);
  }
  const missing = deps();
  missing.deps.runCommand = async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }); };
  const res = await tool.executeTranscribeUrl({ url: URL }, {}, missing.deps);
  assert.equal(res.code, 'ytdlp_missing');
});

test('ranges are validated against the probed duration and the per-call cap', async () => {
  const bad = await tool.executeTranscribeUrl({ url: URL, start: '10:00', end: '5:00' }, {}, deps().deps);
  assert.equal(bad.code, 'invalid_range');
  const beyond = await tool.executeTranscribeUrl({ url: URL, start: '30:00' }, {}, deps().deps);
  assert.equal(beyond.code, 'invalid_range');
  assert.equal(beyond.durationSeconds, 1200);
  const junk = await tool.executeTranscribeUrl({ url: URL, start: 'ayer' }, {}, deps().deps);
  assert.equal(junk.code, 'invalid_range');
  const long = deps({ runner: { probe: { duration: 5 * 3600, title: 'Maratón' } } });
  const tooLong = await tool.executeTranscribeUrl({ url: URL }, {}, long.deps);
  assert.equal(tooLong.code, 'media_too_long');
  assert.equal(tooLong.maxSeconds, 3600);
  assert.match(tooLong.userMessage, /rango/);
  // A clipped end beyond the duration is tolerated (end = duration).
  const clipped = await tool.executeTranscribeUrl({ url: URL, start: '15:00', end: '40:00' }, {}, deps().deps);
  assert.equal(clipped.ok, true);
  assert.equal(clipped.range.end, 1200);
});

test('unsafe URLs never reach yt-dlp', async () => {
  for (const url of ['http://localhost/x', 'http://169.254.169.254/latest', 'ftp://example.com/a.mp3', 'http://user:pw@example.com/a', 'not a url']) {
    const d = deps();
    const res = await tool.executeTranscribeUrl({ url }, {}, d.deps);
    assert.equal(res.ok, false, url);
    assert.equal(res.code, 'invalid_url', url);
    assert.equal(d.calls.length, 0, url);
  }
});

test('a failed or speechless transcription reports transcription_failed; a long text is capped with the file intact', async () => {
  const failed = deps({ transcribe: async () => ({ ok: false, status: 'failed', reasonCode: 'local_unavailable' }) });
  const res = await tool.executeTranscribeUrl({ url: URL, start: 0, end: 30 }, {}, failed.deps);
  assert.equal(res.code, 'transcription_failed');
  assert.equal(res.detail, 'local_unavailable');
  const long = deps({ transcribe: async () => ({ ok: true, transcript: 'x'.repeat(tool.MAX_TEXT_CHARS + 500), segments: [] }) });
  const capped = await tool.executeTranscribeUrl({ url: URL, start: 0, end: 30 }, {}, long.deps);
  assert.equal(capped.ok, true);
  assert.equal(capped.truncated, true);
  assert.match(capped.text, /recortada en la respuesta/);
  assert.ok(Buffer.from(long.saved[0].base64, 'base64').length > tool.MAX_TEXT_CHARS);
});

test('the tool definition is harness-shaped and its human label names host and range', () => {
  const def = tool.buildTranscribeUrlTool();
  assert.equal(def.name, 'transcribe_url');
  assert.equal(def.permissionTier, 'auto');
  assert.ok(def.inputSchema.safeParse({ url: URL, start: '1:30', end: 600, subtitles: true }).success);
  assert.equal(def.inputSchema.safeParse({ url: URL, extra: 1 }).success, false);
  assert.equal(def.humanDescription({ url: URL, start: '1:30', end: '10:00' }), 'Transcribiendo el audio de youtube.com (01:30 → 10:00)');
  assert.equal(def.humanDescription({ url: URL }), 'Transcribiendo el audio de youtube.com');
  assert.match(def.description, /media_login_required/);
});

test('the harness registers transcribe_url, the loop labels it and the selector keeps it on transcription turns', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/agent-harness/run-agent-turn.js'), 'utf8');
  assert.match(src, /buildTranscribeUrlTool/);
  const loop = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
  assert.match(loop, /transcribe_url: \['transcribir el audio de un enlace'/);
  assert.match(loop, /usa `transcribe_url` con `start`\/`end`/);
  const { selectTools } = require('../src/services/agents/tool-selector');
  const tools = ['web_search', 'read_url', 'read_file', 'search_docs', 'transcribe_url', ...Array.from({ length: 30 }, (_, i) => `misc_tool_${i}`)].map((name) => ({ name, description: name }));
  const picked = selectTools({ tools, userQuery: 'transcribe este video del minuto 1 al 10', intent: 'code_generation', maxTools: 8, signals: {} }, { skillAdapter: null });
  assert.ok(picked.selectedNames.includes('transcribe_url'));
  const bySignal = selectTools({ tools, userQuery: 'hazlo', intent: 'code_generation', maxTools: 8, signals: { transcribeUrl: true } }, { skillAdapter: null });
  assert.ok(bySignal.selectedNames.includes('transcribe_url'));
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert.match(dockerfile, /pip3 install --no-cache-dir --break-system-packages "yt-dlp\[default\]>=2026\.8"/, 'yt-dlp with the EJS extra from PyPI');
  assert.doesNotMatch(dockerfile, /^\s+yt-dlp \\$/m, 'no stale apk yt-dlp');
});
