'use strict';

/**
 * media-discovery + cookie-jar-store + the transcribe_url ladder on top of
 * them. Pure parts run everywhere; the one real-browser case runs only when
 * Playwright can launch a Chromium (skipped otherwise, never failing CI).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const discovery = require('../src/services/agent-harness/tools/media-discovery');
const jar = require('../src/services/agent-harness/tools/cookie-jar-store');
const tool = require('../src/services/agent-harness/tools/transcribe-url-tool');

const NETSCAPE = '# Netscape HTTP Cookie File\n# comment\n.upn.class.com\tTRUE\t/\tTRUE\t1900000000\tsession\tabc123\n#HttpOnly_upn.class.com\tFALSE\t/\tTRUE\t0\tcsrf\tzzz\nwww.youtube.com\tFALSE\t/\tTRUE\t0\tCONSENT\tYES\n';

test('candidates: media URLs and content-types are recognised, segments ignored, HLS master ranks first', () => {
  assert.equal(discovery.isMediaCandidate('https://cdn.x.com/rec/master.m3u8?token=1'), true);
  assert.equal(discovery.isMediaCandidate('https://cdn.x.com/rec/seg_0001.ts'), false, 'HLS segments are not candidates');
  assert.equal(discovery.isMediaCandidate('https://cdn.x.com/api/stream', 'video/mp4'), true, 'content-type beats the extension');
  assert.equal(discovery.isMediaCandidate('https://x.com/page.html', 'text/html'), false);
  assert.equal(discovery.isMediaCandidate('blob:https://x.com/abc'), false);
  const ranked = discovery.rankCandidates([
    { url: 'https://cdn.x.com/a.mp4', status: 200 },
    { url: 'https://cdn.x.com/preview.mp4', status: 200 },
    { url: 'https://cdn.x.com/master.m3u8', status: 200 },
    { url: 'https://cdn.x.com/a.mp4', fromDom: true },
    { url: 'https://cdn.x.com/notmedia.html', contentType: 'text/html' },
  ]);
  assert.deepEqual(ranked.map((c) => c.url), ['https://cdn.x.com/master.m3u8', 'https://cdn.x.com/a.mp4', 'https://cdn.x.com/preview.mp4']);
  assert.equal(ranked[1].fromDom, true, 'duplicates merge (DOM + network)');
  assert.equal(ranked[1].status, 200);
});

test('cookies: Netscape ⇄ Playwright round-trip, per-host filtering, jar detection and merge', () => {
  const parsed = discovery.parseNetscapeCookies(NETSCAPE);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { name: 'session', value: 'abc123', domain: '.upn.class.com', path: '/', secure: true, httpOnly: false, expires: 1900000000 });
  assert.equal(parsed[1].httpOnly, true);
  assert.deepEqual(discovery.cookiesForHost(parsed, 'upn.class.com').map((c) => c.name), ['session', 'csrf']);
  assert.deepEqual(discovery.cookiesForHost(parsed, 'player.upn.class.com').map((c) => c.name), ['session'], 'subdomains only for leading-dot domains');
  assert.deepEqual(discovery.cookiesForHost(parsed, 'evil.com'), []);
  const back = discovery.toNetscapeCookies(parsed);
  assert.match(back, /^# Netscape HTTP Cookie File/);
  assert.match(back, /\n\.upn\.class\.com\tTRUE\t\/\tTRUE\t1900000000\tsession\tabc123\n/);
  assert.match(back, /\n#HttpOnly_upn\.class\.com\tFALSE\t\/\tTRUE\t0\tcsrf\tzzz\n/);
  assert.equal(jar.isNetscapeCookieText(NETSCAPE), true);
  assert.equal(jar.isNetscapeCookieText('hola, esto es un apunte de clase'), false);
  assert.equal(jar.isNetscapeCookieText('x'.repeat(jar.MAX_JAR_BYTES + 1)), false);
  assert.deepEqual(jar.cookieHosts(NETSCAPE), ['upn.class.com', 'www.youtube.com']);
  const merged = jar.mergeNetscapeCookies(NETSCAPE, 'upn.class.com\tFALSE\t/\tTRUE\t0\tcsrf\tNEW\n');
  assert.match(merged, /csrf\tNEW/);
  assert.doesNotMatch(merged, /csrf\tzzz/, 'later jar wins per (domain, path, name)');
});

test('cookie jar: encrypted at rest per user, only hosts reported, missing or corrupt jar reads as null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-'));
  const env = { SIRAGPT_COOKIE_JAR_DIR: dir };
  const cipher = { encrypt: (t) => `enc:${Buffer.from(t).toString('base64')}`, decrypt: (t) => Buffer.from(t.replace(/^enc:/, ''), 'base64').toString() };
  const saved = await jar.saveUserCookies('user/1 ../x', NETSCAPE, { env, cipher });
  assert.deepEqual(saved.hosts, ['upn.class.com', 'www.youtube.com']);
  const onDisk = fs.readFileSync(saved.path, 'utf8');
  assert.match(onDisk, /^enc:/);
  assert.doesNotMatch(onDisk, /abc123/, 'never plaintext on disk');
  assert.equal(path.basename(saved.path), 'user_1____x.cookies.enc', 'no path characters survive in the file name');
  assert.equal(await jar.loadUserCookies('user/1 ../x', { env, cipher }), NETSCAPE);
  assert.equal(await jar.loadUserCookies('nobody', { env, cipher }), null);
  fs.writeFileSync(saved.path, 'garbage');
  assert.equal(await jar.loadUserCookies('user/1 ../x', { env, cipher }), null);
  await assert.rejects(() => jar.saveUserCookies('u', 'not a jar', { env, cipher }), /cookie_jar_not_netscape/);
  assert.equal(await jar.forgetUserCookies('nobody', { env }), false);
});

test('safety: the browser never opens IP literals, localhost or .internal hosts', async () => {
  for (const bad of ['http://127.0.0.1/x', 'http://10.0.0.5/player', 'http://localhost/a', 'http://db.internal/x', 'ftp://x.com/a']) {
    const res = await discovery.discoverMedia(bad, { launch: async () => { throw new Error('must not launch'); } });
    assert.equal(res.ok, false, bad);
    assert.equal(res.reason, 'invalid_url', bad);
  }
  assert.equal(discovery.isBlockedHost('[::1]'), true);
  assert.equal(discovery.isBlockedHost('upn.class.com'), false);
});

// ── transcribe_url ladder on a fake browser ────────────────────────────────

function runnerWith({ probeOk = new Set(), download = true, duration = 2400 } = {}) {
  const calls = [];
  const runCommand = async (bin, args, { cwd } = {}) => {
    calls.push({ bin, args });
    const target = args[args.length - 1];
    if (bin === 'yt-dlp' && args.includes('--dump-single-json')) {
      if (!probeOk.has(target)) return { code: 1, stdout: '', stderr: `ERROR: Unsupported URL: ${target}` };
      return { code: 0, stdout: JSON.stringify({ title: 'Clase 7', duration }), stderr: '' };
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

function ladderDeps(over = {}) {
  const runner = runnerWith(over.runner);
  const saves = [];
  return {
    calls: runner.calls,
    saves,
    deps: {
      runCommand: runner.runCommand,
      dnsCheck: async () => true,
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-')),
      env: { TRANSCRIBE_URL_MAX_SECONDS: '3600', ...(over.env || {}) },
      discoverMedia: over.discoverMedia,
      cookieJar: { save: async (userId, text) => { saves.push({ userId, text }); return { hosts: jar.cookieHosts(text) }; }, load: async () => over.savedJar || null },
      loadAttachedCookies: async () => over.attached || null,
      computer: over.computer === undefined ? null : over.computer,
      transcribe: async () => ({ ok: true, transcript: 'texto', segments: [], language: 'es' }),
      saveArtifact: (input) => ({ id: 'a1', filename: input.filename, mime: input.mime, format: 'txt', sizeBytes: 1, downloadUrl: '/x' }),
    },
  };
}

const PAGE = 'https://upn.class.com/player/recording/1d17';
const STREAM = 'https://media.class.com/rec/1d17/master.m3u8?token=t1';

test('ladder: yt-dlp does not know the page → the browser finds the HLS → yt-dlp downloads it with Referer + the browser cookies', async () => {
  const d = ladderDeps({
    runner: { probeOk: new Set([STREAM]) },
    discoverMedia: async (url, opts) => {
      assert.equal(url, PAGE);
      assert.deepEqual(opts.cookies, [], 'no jar yet');
      return { ok: true, candidates: [{ url: STREAM, kind: 'hls' }], best: { url: STREAM, kind: 'hls' }, title: 'Clase 7 · Grabación', cookiesNetscape: '# Netscape HTTP Cookie File\nmedia.class.com\tFALSE\t/\tTRUE\t0\tcf\tv1\n', userAgent: 'UA-X', elapsedMs: 1200 };
    },
  });
  const res = await tool.executeTranscribeUrl({ url: PAGE, start: '1:30', end: '10:00' }, { userId: 'u1' }, d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.via, 'browser+yt-dlp');
  assert.equal(res.title, 'Clase 7');
  assert.deepEqual(res.discovery.picked, { kind: 'hls', host: 'media.class.com' });
  const [p1, p2, dl] = d.calls;
  assert.equal(p1.args[p1.args.length - 1], PAGE);
  assert.equal(p2.args[p2.args.length - 1], STREAM);
  assert.ok(p2.args.includes('--referer') && p2.args[p2.args.indexOf('--referer') + 1] === PAGE);
  assert.ok(p2.args.includes('User-Agent:UA-X'));
  assert.ok(dl.args.includes('--cookies'), 'the browser session travels to yt-dlp');
  assert.ok(dl.args.includes('--download-sections') && dl.args.includes('*90-600'));
  // Every yt-dlp call carries the JS runtime for YouTube's challenge.
  for (const c of d.calls.filter((x) => x.bin === 'yt-dlp')) assert.ok(c.args.includes('--js-runtimes') && c.args[c.args.indexOf('--js-runtimes') + 1] === `node:${process.execPath}`, c.args.join(' '));
});

test('ladder: yt-dlp refuses the discovered stream → ffmpeg reads it directly with Referer, UA and the host cookies', async () => {
  const d = ladderDeps({
    runner: { probeOk: new Set() },
    attached: { text: '# Netscape HTTP Cookie File\n.class.com\tTRUE\t/\tTRUE\t0\tsession\tS1\nother.com\tFALSE\t/\tTRUE\t0\tx\ty\n', filename: 'cookies.txt' },
    discoverMedia: async (url, opts) => {
      assert.equal(opts.cookies.length, 2, 'the attached jar reaches the browser');
      return { ok: true, candidates: [{ url: 'https://media.class.com/rec/1d17/video.mp4', kind: 'video' }], best: { url: 'https://media.class.com/rec/1d17/video.mp4', kind: 'video' }, title: 'Clase 7', userAgent: 'UA-X' };
    },
  });
  const res = await tool.executeTranscribeUrl({ url: PAGE, start: '0:10', end: '0:40' }, { userId: 'u1' }, d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.via, 'browser+ffmpeg');
  assert.equal(res.discovery.ytdlpOnCandidate, 'media_unsupported_url');
  assert.deepEqual(res.cookies, { source: 'attachment', hosts: ['class.com', 'other.com'], saved: true });
  assert.equal(d.saves.length, 1, 'the attached cookies.txt is saved for next time');
  const ff = d.calls.find((c) => c.bin === 'ffmpeg');
  const headers = ff.args[ff.args.indexOf('-headers') + 1];
  assert.match(headers, /^Referer: https:\/\/upn\.class\.com\/player\/recording\/1d17\r\nUser-Agent: UA-X\r\nCookie: session=S1\r\n$/, 'only class.com cookies, never other.com');
  assert.ok(ff.args.includes('-ss') && ff.args[ff.args.indexOf('-ss') + 1] === '10');
  assert.ok(ff.args.includes('-t') && ff.args[ff.args.indexOf('-t') + 1] === '30');
  assert.equal(ff.args[ff.args.indexOf('-i') + 1], 'https://media.class.com/rec/1d17/video.mp4');
  assert.deepEqual(res.range, { start: 10, end: 40, label: '00:10 → 00:40' });
});

test('ladder: a login wall with no media → media_login_required naming the cookies.txt path; a saved jar is reused silently', async () => {
  const wall = ladderDeps({ discoverMedia: async () => ({ ok: false, reason: 'login_wall', loginWall: true, candidates: [] }) });
  const res = await wall.executeTranscribeUrl ? null : await tool.executeTranscribeUrl({ url: PAGE }, { userId: 'u1' }, wall.deps);
  assert.equal(res.code, 'media_login_required');
  assert.equal(res.discovery.loginWall, true);
  assert.match(res.userMessage, /cookies\.txt/);
  const reused = ladderDeps({
    savedJar: '# Netscape HTTP Cookie File\n.class.com\tTRUE\t/\tTRUE\t0\tsession\tS1\n',
    runner: { probeOk: new Set([PAGE]) },
    discoverMedia: async () => { throw new Error('yt-dlp already succeeded: no browser needed'); },
  });
  const ok = await tool.executeTranscribeUrl({ url: PAGE, start: 0, end: 30 }, { userId: 'u1' }, reused.deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.via, 'yt-dlp');
  assert.deepEqual(ok.cookies, { source: 'saved', hosts: ['class.com'] });
  assert.ok(reused.calls[0].args.includes('--cookies'));
  const off = ladderDeps({ env: { TRANSCRIBE_URL_BROWSER_DISCOVERY: '0' }, discoverMedia: async () => { throw new Error('disabled'); } });
  const skipped = await tool.executeTranscribeUrl({ url: PAGE }, {}, off.deps);
  assert.equal(skipped.code, 'media_unsupported_url');
  assert.equal(skipped.discovery, undefined);
});

test('ladder: when the sectioned download fails, the whole recording is fetched and trimmed locally with absolute times', async () => {
  const calls = [];
  const runCommand = async (bin, args, { cwd } = {}) => {
    calls.push({ bin, args });
    if (bin === 'yt-dlp' && args.includes('--dump-single-json')) return { code: 0, stdout: JSON.stringify({ title: 'Clase 9', duration: 3000 }), stderr: '' };
    if (bin === 'yt-dlp' && args.includes('--download-sections')) return { code: 1, stdout: '', stderr: 'ERROR: ffmpeg exited with code 1' };
    if (bin === 'yt-dlp') { fs.writeFileSync(path.join(cwd, 'source.mp4'), 'whole'); return { code: 0, stdout: '', stderr: '' }; }
    if (bin === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], 'aac'); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected ${bin}`);
  };
  const d = ladderDeps({ runner: { probeOk: new Set([PAGE]) } });
  d.deps.runCommand = runCommand;
  const res = await tool.executeTranscribeUrl({ url: PAGE, start: '1:30', end: '10:00' }, { userId: 'u1' }, d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.via, 'yt-dlp');
  assert.match(res.discovery.fullDownloadFallback, /ffmpeg exited/);
  const [, sectioned, whole, ff] = calls;
  assert.ok(sectioned.args.includes('--download-sections'));
  assert.equal(whole.args.includes('--download-sections'), false, 'retry without sections');
  assert.equal(whole.args.includes('--force-keyframes-at-cuts'), false);
  assert.ok(whole.args.includes('--fixup') && whole.args[whole.args.indexOf('--fixup') + 1] === 'never');
  // Absolute trim on the whole file: -ss 90 -to 600, not -t.
  assert.equal(ff.args[ff.args.indexOf('-ss') + 1], '90');
  assert.equal(ff.args[ff.args.indexOf('-to') + 1], '600');
  assert.equal(ff.args.includes('-t'), false);
  assert.deepEqual(res.range, { start: 90, end: 600, label: '01:30 → 10:00' });
});

test('attached cookies: a Netscape .txt among the turn\'s files is picked by ownership, other text files are ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const notes = path.join(dir, 'apuntes.txt'); fs.writeFileSync(notes, 'apuntes de la clase');
  const cookies = path.join(dir, 'cookies.txt'); fs.writeFileSync(cookies, NETSCAPE);
  const prisma = { file: { findMany: async ({ where }) => (where.userId === 'u1' ? [
    { id: 'f1', originalName: 'apuntes.txt', mimeType: 'text/plain', size: 20, path: notes },
    { id: 'f2', originalName: 'cookies.txt', mimeType: 'text/plain', size: 200, path: cookies },
  ] : []) } };
  const found = await tool.loadAttachedCookies({ prisma, userId: 'u1', fileIds: ['f1', 'f2'] }, { objectStorage: { isRemote: () => false } });
  assert.equal(found.fileId, 'f2');
  assert.equal(found.text, NETSCAPE);
  assert.equal(await tool.loadAttachedCookies({ prisma, userId: 'u2', fileIds: ['f2'] }, { objectStorage: { isRemote: () => false } }), null, 'another user never sees the jar');
  assert.equal(await tool.loadAttachedCookies({ prisma, userId: 'u1', fileIds: [] }), null);
});

test('ladder: behind a login, the chat computer (the user\'s signed-in Chrome) finds the stream and the download uses ITS session', async () => {
  const seen = [];
  const d = ladderDeps({
    runner: { probeOk: new Set([STREAM]), duration: 2 * 3600 },
    discoverMedia: async () => ({ ok: false, reason: 'login_wall', loginWall: true, candidates: [] }),
    computer: {
      available: async (ctx) => { seen.push(['available', ctx.userId]); return true; },
      discover: async (url, ctx, opts) => {
        seen.push(['discover', url, ctx.chatId, opts.timeoutMs >= 60_000]);
        return { session: { sessionId: 's1' }, disc: { ok: true, candidates: [{ url: STREAM, kind: 'hls' }], title: 'Clase 7', userAgent: 'UA-COMPUTER', cookiesNetscape: '# Netscape HTTP Cookie File\n.class.com\tTRUE\t/\tTRUE\t0\tsession\tS9\n' } };
      },
      show: async () => { throw new Error('nothing to show: the stream was found'); },
    },
  });
  const res = await tool.executeTranscribeUrl({ url: PAGE, start: '1:00:00', end: '1:20' }, { userId: 'u1', chatId: 'c1' }, d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.via, 'computer+yt-dlp');
  assert.deepEqual(seen, [['available', 'u1'], ['discover', PAGE, 'c1', true]]);
  assert.equal(res.discovery.computer.candidates, 1);
  assert.deepEqual(res.range, { start: 3600, end: 4800, label: '1:00:00 → 1:20:00' }, '«del minuto 60 al 1:20» is 1:00:00 → 1:20:00');
  const dl = d.calls.find((c) => c.bin === 'yt-dlp' && !c.args.includes('--dump-single-json'));
  assert.ok(dl.args.includes('--cookies') && dl.args.includes('*3600-4800'));
  assert.ok(dl.args.includes('User-Agent:UA-COMPUTER'));
  assert.equal(d.saves.length, 0, 'the computer session is never copied into the saved jar');
});

test('ladder: the computer also hits the login → the page opens in the computer panel and the user is asked to sign in there', async () => {
  const shown = []; const events = [];
  const d = ladderDeps({
    discoverMedia: async () => ({ ok: false, reason: 'login_wall', loginWall: true, candidates: [] }),
    computer: {
      available: async () => true,
      discover: async () => ({ session: { sessionId: 's1' }, disc: { ok: false, reason: 'login_wall', loginWall: true, candidates: [] } }),
      show: async (session, url) => { shown.push([session.sessionId, url]); },
    },
  });
  const res = await tool.executeTranscribeUrl({ url: PAGE }, { userId: 'u1', chatId: 'c1', onEvent: (e) => events.push(e) }, d.deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'media_login_in_computer');
  assert.deepEqual(res.computerLogin, { url: PAGE, host: 'upn.class.com' });
  assert.match(res.userMessage, /computadora de este chat/);
  assert.match(res.userMessage, /«listo»/);
  assert.deepEqual(shown, [['s1', PAGE]]);
  assert.deepEqual(events, [{ type: 'computer_navigate', url: PAGE, tool: 'transcribe_url' }]);
  // No computer for this user (flag off, cold failure) → the attach-a-file / cookies.txt paths.
  for (const computer of [null, { available: async () => false }, { available: async () => true, discover: async () => { throw new Error('desktop down'); } }]) {
    const off = ladderDeps({ discoverMedia: async () => ({ ok: false, reason: 'login_wall', loginWall: true, candidates: [] }), computer });
    const r = await tool.executeTranscribeUrl({ url: PAGE }, { userId: 'u1', chatId: 'c1' }, off.deps);
    assert.equal(r.code, 'media_login_required', JSON.stringify(r));
  }
});

test('ranges: an «a:bb» end before an hour-plus start reads as hours:minutes; real minutes:seconds stay', () => {
  const s = tool.parseTimecode('1:00:00');
  assert.equal(tool.resolveRangeEnd(s, tool.parseTimecode('1:20'), '1:20'), 4800);
  assert.equal(tool.resolveRangeEnd(90, 600, '10:00'), 600);
  assert.equal(tool.resolveRangeEnd(3600, 80, '80'), 80, 'only the a:bb form is reinterpreted');
  assert.equal(tool.resolveRangeEnd(7200, 4800, '1:20'), 4800, 'still before the start → left for the range check');
  assert.equal(tool.resolveRangeEnd(600, 300, '5:00'), 300, 'before the hour «del 10:00 al 5:00» stays an invalid range');
});

// ── one real browser run (skipped where Chromium cannot launch) ──────────

test('real browser: an SPA player that only fetches its HLS after JS runs is discovered; a login redirect is reported as a wall', { timeout: 90_000 }, async (t) => {
  const pw = discovery.getPlaywright();
  if (!pw || !pw.chromium) return t.skip('playwright not installed');
  let browser;
  try { browser = await pw.chromium.launch(discovery.chromiumLaunchOptions()); } catch (err) { return t.skip(`chromium cannot launch here: ${String(err && err.message).slice(0, 80)}`); }
  await browser.close();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Clase 7</title></head><body><div id=a></div><script>setTimeout(()=>{const v=document.createElement("video");v.src="/stream/master.m3u8";document.getElementById("a").appendChild(v);fetch("/stream/master.m3u8")},200)</script></body></html>'); }
    if (u.pathname === '/stream/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:10,\nseg0.ts\n'); }
    if (u.pathname === '/private') { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body><h1>Iniciar sesión</h1><input type="password"></body></html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // The safety gate blocks IP literals and localhost by design, so the test
  // reaches its own server through a hostname the injected dnsCheck accepts.
  const hostname = 'discovery-test.example';
  const origin = `http://${hostname}:${port}`;
  const launch = async () => pw.chromium.launch({ ...discovery.chromiumLaunchOptions(), args: [...(discovery.chromiumLaunchOptions().args || []), `--host-resolver-rules=MAP ${hostname} 127.0.0.1`] });
  try {
    const found = await discovery.discoverMedia(`${origin}/player`, { launch, dnsCheck: async () => true, timeoutMs: 25_000 });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert.equal(found.best.kind, 'hls');
    assert.equal(found.best.url, `${origin}/stream/master.m3u8`);
    assert.equal(found.title, 'Clase 7');
    const wall = await discovery.discoverMedia(`${origin}/private`, { launch, dnsCheck: async () => true, timeoutMs: 25_000 });
    assert.equal(wall.ok, false);
    assert.equal(wall.loginWall, true);
    assert.equal(wall.reason, 'login_wall');
    assert.match(wall.finalUrl, /\/login$/);
  } finally {
    server.close();
  }
});

test('real browser, attached: works in a NEW tab of an existing signed-in browser, exports only the page/media cookies and leaves the user\'s tabs alone', { timeout: 90_000 }, async (t) => {
  const pw = discovery.getPlaywright();
  if (!pw || !pw.chromium) return t.skip('playwright not installed');
  const hostname = 'attached-test.example';
  let browser;
  try {
    browser = await pw.chromium.launch({ ...discovery.chromiumLaunchOptions(), args: [...(discovery.chromiumLaunchOptions().args || []), `--host-resolver-rules=MAP ${hostname} 127.0.0.1`] });
  } catch (err) { return t.skip(`chromium cannot launch here: ${String(err && err.message).slice(0, 80)}`); }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const signedIn = /(?:^|;\s*)session=S1/.test(req.headers.cookie || '');
    if (u.pathname === '/player') {
      if (!signedIn) { res.writeHead(302, { location: '/login' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><head><title>Clase 9</title></head><body><script>fetch("/stream/master.m3u8")</script></body></html>');
    }
    if (u.pathname === '/stream/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n'); }
    if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>Iniciar sesión<input type="password"></body></html>'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>home</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://${hostname}:${server.address().port}`;
  try {
    // The «user's» signed-in browser: a session cookie for the site, a cookie
    // of another site, and a tab of their own that must survive.
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'session', value: 'S1', url: origin },
      { name: 'private', value: 'P', domain: 'other-site.example', path: '/' },
    ]);
    const userTab = await context.newPage();
    await userTab.goto(`${origin}/home`);
    let disconnected = 0;
    const handle = { browser: { contexts: () => [context], close: async () => { disconnected += 1; } }, context };
    const found = await discovery.discoverMedia(`${origin}/player`, { attach: async () => handle, dnsCheck: async () => true, timeoutMs: 25_000 });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert.equal(found.best.url, `${origin}/stream/master.m3u8`);
    assert.equal(found.title, 'Clase 9');
    assert.match(found.cookiesNetscape, /\tsession\tS1/);
    assert.doesNotMatch(found.cookiesNetscape, /private/, 'other sites\' cookies never leave the browser');
    assert.equal(disconnected, 1, 'the attached browser is only disconnected');
    assert.deepEqual(context.pages(), [userTab], 'the discovery tab is closed, the user\'s tab stays');
    assert.equal(userTab.url(), `${origin}/home`);
    await context.clearCookies();
    const wall = await discovery.discoverMedia(`${origin}/player`, { attach: async () => handle, dnsCheck: async () => true, timeoutMs: 25_000 });
    assert.equal(wall.loginWall, true, 'without the session the same page is a login wall');
  } finally {
    server.close();
    await browser.close();
  }
});
