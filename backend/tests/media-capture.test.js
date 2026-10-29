'use strict';

/**
 * «Rastrear el audio»: when a page has no downloadable stream, transcribe_url
 * PLAYS the recording in a browser and records what it plays
 * (captureStream + MediaRecorder). Unit ladder with fakes + one real-Chromium
 * run (skipped where Chromium cannot launch).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const tool = require('../src/services/agent-harness/tools/transcribe-url-tool');
const capture = require('../src/services/agent-harness/tools/media-capture');
const discovery = require('../src/services/agent-harness/tools/media-discovery');
const { createToolRegistry } = require('../src/services/agent-harness/tool-registry');

const PAGE = 'https://upn.class.com/player/recording/f46a0e74';

function runner({ probeOk = new Set(), download = true } = {}) {
  const calls = [];
  const runCommand = async (bin, args, { cwd } = {}) => {
    calls.push({ bin, args });
    const target = args[args.length - 1];
    if (bin === 'yt-dlp' && args.includes('--dump-single-json')) {
      if (!probeOk.has(target)) return { code: 1, stdout: '', stderr: `ERROR: Unsupported URL: ${target}` };
      return { code: 0, stdout: JSON.stringify({ title: 'Clase 9', duration: 7200 }), stderr: '' };
    }
    if (bin === 'yt-dlp') {
      if (!download) return { code: 1, stdout: '', stderr: 'ERROR: HTTP Error 403: Forbidden' };
      fs.writeFileSync(path.join(cwd, 'source.m4a'), 'audio');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (bin === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], 'aac'); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected ${bin}`);
  };
  return { calls, runCommand };
}

function deps(over = {}) {
  const r = runner(over.runner);
  const captures = [];
  return {
    calls: r.calls,
    captures,
    deps: {
      runCommand: r.runCommand,
      dnsCheck: async () => true,
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')),
      env: { TRANSCRIBE_URL_MAX_SECONDS: String(3 * 3600), ...(over.env || {}) },
      discoverMedia: over.discoverMedia || (async () => ({ ok: false, reason: 'no_media_found', candidates: [], loginWall: false })),
      cookieJar: { save: async () => ({ hosts: [] }), load: async () => null },
      loadAttachedCookies: async () => null,
      computer: over.computer === undefined ? null : over.computer,
      capture: over.capture === undefined
        ? async (url, ctx, opts) => {
          captures.push({ url, opts });
          fs.writeFileSync(opts.outPath, 'webm');
          return { ok: true, seconds: (opts.end || opts.start + 60) - opts.start, stopped: 'range_end', title: 'Clase 9 · grabación', browser: 'computer' };
        }
        : over.capture,
      transcribe: async () => ({ ok: true, language: 'es', transcript: 'texto', segments: [{ start: 0, end: 3, text: 'Buenos días.' }, { start: 4, end: 8, text: 'Hoy vemos costos.' }] }),
      saveArtifact: (input) => ({ id: 'a1', filename: input.filename, mime: input.mime, format: 'txt', sizeBytes: 1, downloadUrl: '/x' }),
    },
  };
}

test('no downloadable stream → the recording is played and its audio recorded, then transcribed on the recording clock', async () => {
  const d = deps();
  const res = await tool.executeTranscribeUrl({ url: PAGE, start: '1:00:00', end: '1:20' }, { userId: 'u1', chatId: 'c1' }, d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.via, 'computer+capture');
  assert.equal(res.title, 'Clase 9 · grabación');
  assert.deepEqual(res.range, { start: 3600, end: 4800, label: '1:00:00 → 1:20:00' });
  assert.equal(d.captures.length, 1);
  const { opts } = d.captures[0];
  assert.equal(opts.start, 3600);
  assert.equal(opts.end, 4800);
  assert.ok(opts.rate >= 1 && opts.rate <= 2, `rate ${opts.rate}`);
  assert.ok(opts.timeoutMs > 20 * 60 * 1000, 'the capture budget comes from the tool budget');
  const ff = d.calls.find((c) => c.bin === 'ffmpeg');
  assert.equal(ff.args[ff.args.indexOf('-i') + 1], opts.outPath);
  if (opts.rate !== 1) assert.ok(ff.args.includes(`atempo=${(1 / opts.rate).toFixed(4)}`), 'sped-up capture is slowed back');
  assert.match(res.text, /^\[1:00:00\] Buenos días\./);
  assert.equal(res.discovery.capture.why, 'no_stream_found');
});

test('a stream that yt-dlp and ffmpeg cannot read is recorded instead; one capture per call; a failed capture keeps the original error', async () => {
  const STREAM = 'https://cdn.class.com/v/master.m3u8';
  const d = deps({
    runner: { probeOk: new Set([PAGE]), download: false },
  });
  const ok = await tool.executeTranscribeUrl({ url: PAGE, start: 0, end: 120 }, {}, d.deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.via, 'computer+capture');
  assert.equal(ok.discovery.capture.why, 'download_failed');

  let attempts = 0;
  const failing = deps({
    discoverMedia: async () => ({ ok: true, candidates: [{ url: STREAM, kind: 'hls' }], title: 'x' }),
    capture: async () => { attempts += 1; return { ok: false, reason: 'drm_protected', browser: 'browser' }; },
  });
  const baseRun = failing.deps.runCommand;
  failing.deps.runCommand = async (bin, args, o) => (bin === 'ffmpeg' && args.includes('-headers')
    ? { code: 1, stdout: '', stderr: 'Server returned 403 Forbidden' }
    : baseRun(bin, args, o));
  const res = await tool.executeTranscribeUrl({ url: PAGE }, {}, failing.deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'media_download_failed', JSON.stringify(res));
  assert.equal(res.discovery.capture.reason, "drm_protected", JSON.stringify(res));
  assert.equal(attempts, 1);

  const partial = deps({ capture: async (url, ctx, opts) => { fs.writeFileSync(opts.outPath, 'w'); return { ok: true, seconds: 300, stopped: 'stalled', browser: 'browser' }; } });
  const p = await tool.executeTranscribeUrl({ url: PAGE, start: 0, end: 1200 }, {}, partial.deps);
  assert.equal(p.ok, true);
  assert.equal(p.partial, 'stalled', 'a capture cut short says so');
  assert.deepEqual(p.range, { start: 0, end: 300, label: '00:00 → 05:00' });

  const off = deps({ env: { TRANSCRIBE_URL_CAPTURE: '0' }, capture: async () => { throw new Error('disabled'); } });
  assert.equal((await tool.executeTranscribeUrl({ url: PAGE }, {}, off.deps)).code, 'media_unsupported_url');
});

test('a missing or throttled yt-dlp still reaches the browser rungs', async () => {
  for (const stderr of ['ERROR: HTTP Error 429: Too Many Requests']) {
    const d = deps();
    d.deps.runCommand = async (bin, args, { cwd } = {}) => {
      if (bin === 'yt-dlp') return { code: 1, stdout: '', stderr };
      fs.writeFileSync(args[args.length - 1], 'aac'); return { code: 0, stdout: '', stderr: '' };
    };
    const res = await tool.executeTranscribeUrl({ url: PAGE, start: 0, end: 60 }, {}, d.deps);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.via, 'computer+capture');
  }
  assert.ok(tool.DISCOVERY_ELIGIBLE.has('ytdlp_missing'));
});

test('captured audio survives asynchronous capture, conversion and transcription on every fallback path', async (t) => {
  const stream = 'https://cdn.class.com/v/capture-fixture.m3u8';
  const routes = [
    ['browser', {}],
    ['computer', { computer: {
      available: async () => true,
      discover: async () => ({ session: { id: 'capture-test' }, disc: { reason: 'no_media_found', candidates: [], loginWall: false } }),
    } }],
    ['download failure', { runner: { probeOk: new Set([PAGE]), download: false } }],
    ['stream failure', { discoverMedia: async () => ({ candidates: [{ url: stream, kind: 'hls' }], loginWall: false }) }],
  ];
  for (const [route, options] of routes) await t.test(route, async (t) => {
    const d = deps(options);
    t.after(() => fs.promises.rm(d.deps.tmpDir, { recursive: true, force: true }));
    const events = [];
    let captures = 0;
    let cleanupStarted = false;
    d.deps.fs = { ...fs, promises: { ...fs.promises, rm: async (...args) => {
      cleanupStarted = true;
      events.push('cleanup');
      return fs.promises.rm(...args);
    } } };
    d.deps.capture = async (_url, _ctx, opts) => {
      captures++;
      await new Promise(setImmediate);
      assert.equal(cleanupStarted, false, 'capture must finish before cleanup');
      await fs.promises.writeFile(opts.outPath, 'captured audio');
      events.push('capture');
      return { ok: true, seconds: 60, stopped: 'range_end', browser: route === 'computer' ? 'computer' : 'browser' };
    };
    const originalRun = d.deps.runCommand;
    d.deps.runCommand = async (bin, args, opts) => {
      if (bin !== 'ffmpeg') return originalRun(bin, args, opts);
      if (args.includes('-headers')) return { code: 1, stderr: 'Server returned 403 Forbidden', stdout: '' };
      await new Promise(setImmediate);
      assert.equal(cleanupStarted, false, 'conversion must finish before cleanup');
      assert.equal(await fs.promises.readFile(args[args.indexOf('-i') + 1], 'utf8'), 'captured audio');
      await fs.promises.writeFile(args.at(-1), 'converted audio');
      events.push('conversion');
      return { code: 0, stderr: '', stdout: '' };
    };
    d.deps.transcribe = async (file) => {
      await new Promise(setImmediate);
      assert.equal(cleanupStarted, false, 'transcription must finish before cleanup');
      assert.equal(await fs.promises.readFile(file, 'utf8'), 'converted audio');
      events.push('transcription');
      return { ok: true, language: 'es', transcript: 'La grabación explica el análisis de costos.', segments: [] };
    };
    const result = await tool.executeTranscribeUrl({ url: PAGE, start: 0, end: 60 }, { userId: 'u1', chatId: 'c1' }, d.deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.via, /\+capture$/);
    assert.equal(captures, 1, 'the fallback must not recapture');
    assert.deepEqual(events, ['capture', 'conversion', 'transcription', 'cleanup']);
    assert.deepEqual(fs.readdirSync(d.deps.tmpDir), []);
  });
});

test('cancelling capture or its transcription preserves AbortError and cleans only after the consumer stops', { timeout: 5000 }, async (t) => {
  for (const stage of ['capture', 'transcription']) await t.test(stage, async (t) => {
    const d = deps({ runner: { probeOk: new Set([PAGE]), download: false } });
    t.after(() => fs.promises.rm(d.deps.tmpDir, { recursive: true, force: true }));
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('test cancellation'), { name: 'AbortError', code: 'ABORT_ERR' });
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    let consumerStopped = false;
    let prematureCleanup = false;
    let cleanupCalls = 0;
    let captures = 0;
    let deliveries = 0;
    d.deps.fs = { ...fs, promises: { ...fs.promises, rm: async (...args) => {
      cleanupCalls++;
      prematureCleanup ||= !consumerStopped;
      return fs.promises.rm(...args);
    } } };
    const waitForCancellation = async (file, signal) => {
      assert.equal(signal, controller.signal);
      try {
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          notifyStarted();
        });
      } finally {
        await new Promise(setImmediate);
        assert.ok((await fs.promises.readFile(file)).length, 'the cancelled consumer still owns its input until it stops');
        consumerStopped = true;
      }
    };
    d.deps.capture = async (_url, _ctx, opts) => {
      captures++;
      await fs.promises.writeFile(opts.outPath, 'captured audio');
      if (stage === 'capture') await waitForCancellation(opts.outPath, opts.signal);
      return { ok: true, seconds: 60, stopped: 'range_end', browser: 'browser' };
    };
    d.deps.transcribe = async (file, _mime, _name, opts) => waitForCancellation(file, opts.signal);
    d.deps.saveArtifact = () => { deliveries++; throw new Error('cancelled work must not deliver an artifact'); };
    const result = tool.executeTranscribeUrl({ url: PAGE, start: 0, end: 60 }, { signal: controller.signal }, d.deps);
    const rejected = assert.rejects(result, (err) => err === cancellation);
    await started;
    controller.abort(cancellation);
    await rejected;
    assert.equal(consumerStopped, true);
    assert.equal(prematureCleanup, false);
    assert.equal(cleanupCalls, 1);
    assert.equal(captures, 1, 'cancellation must not start a second capture');
    assert.equal(deliveries, 0);
    assert.deepEqual(fs.readdirSync(d.deps.tmpDir), []);
  });
});

test('capture rate: real time when it fits the budget, up to the cap, null beyond it', () => {
  assert.equal(capture.pickCaptureRate(600, 20 * 60_000), 1);
  assert.equal(capture.pickCaptureRate(1800, 20 * 60_000), 1.5);
  assert.equal(capture.pickCaptureRate(3 * 3600, 20 * 60_000), null);
  assert.equal(capture.pickCaptureRate(3000, 20 * 60_000, 4), 2.5);
});

test('the harness honours transcribe_url\'s own timeout (it used to cut every tool at 2 min)', () => {
  const def = tool.buildTranscribeUrlTool({ env: {} });
  assert.ok(def.timeoutMs >= 25 * 60 * 1000, `timeoutMs ${def.timeoutMs}`);
  assert.equal(tool.toolTimeoutMs({ TRANSCRIBE_URL_TOOL_TIMEOUT_MS: '90000' }), 90_000);
  const registry = createToolRegistry();
  registry.register(def);
  assert.equal(registry.toAgentTool('transcribe_url').timeoutMs, def.timeoutMs, 'toAgentTool keeps the bound for wrapTools');
  const stream = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
  assert.match(stream, /isLinkTranscription[\s\S]{0,400}toolTimeoutMs\(process\.env\)/, 'a link-transcription turn gets the tool budget');
});

// ── real browser: plain <audio>, MediaSource (blob:) and a player in an iframe ──

test('real browser: records the played audio of a plain player, an MSE/blob player and an iframe player, only the asked range', { timeout: 120_000 }, async (t) => {
  const pw = discovery.getPlaywright();
  if (!pw || !pw.chromium) return t.skip('playwright not installed');
  const ff = spawnSync('ffmpeg', ['-version']);
  if (ff.status !== 0) return t.skip('ffmpeg not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-real-'));
  const tone = path.join(dir, 'tone.webm');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'libopus', '-b:a', '32k', tone]);
  if (!fs.existsSync(tone)) return t.skip('ffmpeg cannot encode opus here');
  const host = 'capture-test.example';
  const launch = async () => {
    const o = discovery.chromiumLaunchOptions();
    return pw.chromium.launch({ ...o, args: [...(o.args || []), `--host-resolver-rules=MAP ${host} 127.0.0.1`] });
  };
  try { const b = await launch(); await b.close(); } catch (err) { return t.skip(`chromium cannot launch here: ${String(err && err.message).slice(0, 80)}`); }
  const audio = fs.readFileSync(tone);
  const server = http.createServer((req, res) => {
    if (req.url === '/tone.webm') { res.writeHead(200, { 'content-type': 'audio/webm' }); return res.end(audio); }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/mse') return res.end('<title>MSE</title><video id=a></video><script>const ms=new MediaSource();a.src=URL.createObjectURL(ms);ms.addEventListener("sourceopen",async()=>{const sb=ms.addSourceBuffer(\'audio/webm; codecs="opus"\');sb.appendBuffer(await (await fetch("/tone.webm")).arrayBuffer());sb.addEventListener("updateend",()=>{try{ms.endOfStream()}catch(e){}},{once:true})})</script>');
    if (req.url === '/outer') return res.end('<title>Clase</title><iframe src="/plain"></iframe>');
    return res.end('<title>Plain</title><audio src="/tone.webm" controls></audio>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://${host}:${server.address().port}`;
  const volume = (file) => {
    const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = /mean_volume: (-?[\d.]+) dB/.exec(out);
    return m ? Number(m[1]) : null;
  };
  try {
    for (const [p, start, end, rate] of [['/plain', 2, 5, 1], ['/mse', 1, 4, 1], ['/outer', 0, 4, 2]]) {
      const outPath = path.join(dir, `${p.slice(1)}.webm`);
      const r = await capture.captureMediaAudio(`${origin}${p}`, { launch, outPath, start, end, rate, timeoutMs: 40_000, dnsCheck: async () => true });
      assert.equal(r.ok, true, `${p}: ${JSON.stringify(r)}`);
      assert.equal(r.stopped, 'range_end', p);
      assert.ok(Math.abs(r.seconds - (end - start)) < 1.2, `${p}: ${r.seconds}s of media`);
      const db = volume(outPath);
      assert.ok(db != null && db > -40, `${p}: real audio was recorded (${db} dB)`);
    }
    const none = await capture.captureMediaAudio(`${origin}/nothing-here-${'x'}`, { launch, outPath: path.join(dir, 'n.webm'), timeoutMs: 30_000, dnsCheck: async () => true }).catch((e) => e);
    assert.equal(typeof none, 'object');
  } finally {
    server.close();
  }
});
