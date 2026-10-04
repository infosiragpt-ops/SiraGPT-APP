'use strict';

/**
 * media-capture — the last rung of transcribe_url: PLAY the recording in a
 * browser and record the audio it really plays (HTMLMediaElement
 * .captureStream() + MediaRecorder, opus/webm), from one timecode to another.
 *
 * It needs no downloadable URL, so it covers what yt-dlp / ffmpeg cannot read:
 * MediaSource (blob:) players fed by tokenised segments, separate DASH audio
 * tracks, players inside iframes, anything that ends up in a <video>/<audio>
 * the page plays. Same browser options as media-discovery: a throwaway
 * headless Chromium with the user's saved cookies, or `attach()` to the chat
 * computer's live Chrome (the user's own sign-ins) in a NEW tab that is closed
 * at the end. Every request of the tab passes the same SSRF guard.
 *
 * Not a DRM bypass: a media element with MediaKeys (EME) is reported as
 * `drm_protected` and nothing is recorded.
 *
 * Time: recording runs at `rate` × real time (preservesPitch on); the caller
 * slows the file back (ffmpeg atempo) so timestamps match the recording.
 *
 * Result: { ok, reason, detail, file, mime, mediaStart, mediaEnd, seconds,
 *           rate, title, finalUrl, elapsedMs, bytes, stopped }
 */

const fs = require('node:fs');
const {
  getPlaywright, chromiumLaunchOptions, isBlockedHost, cookiesForHost, DESKTOP_UA,
} = require('./media-discovery');

const POLL_MS = 1000;
const FIND_MEDIA_MS = 20_000;
const STALL_MS = 45_000;
const PLAY_SELECTORS = 'button[aria-label*="play" i], button[title*="play" i], button[aria-label*="reproducir" i], [class*="play-button" i], [class*="playButton" i], [data-testid*="play" i], .vjs-big-play-button, .plyr__control--overlaid, .ytp-large-play-button';

/** In-page: install the recorder on the longest media element (runs in the media's frame). */
/* istanbul ignore next -- serialised into the page */
function installRecorder({ start, end, rate, sliceMs, waitMs }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (el, ev, ms) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    el.addEventListener(ev, () => finish(true), { once: true });
    setTimeout(() => finish(false), ms);
  });
  return (async () => {
    const els = Array.from(document.querySelectorAll('video, audio'));
    if (!els.length) return { ok: false, reason: 'no_media_element' };
    const score = (el) => (Number.isFinite(el.duration) ? el.duration : 0) + (el.readyState || 0) + (el.paused ? 0 : 1000);
    const el = els.sort((a, b) => score(b) - score(a))[0];
    if (el.mediaKeys) return { ok: false, reason: 'drm_protected' };
    if (el.readyState < 1) await once(el, 'loadedmetadata', waitMs);
    if (el.mediaKeys) return { ok: false, reason: 'drm_protected' };
    const duration = Number.isFinite(el.duration) ? el.duration : null;
    if (duration != null && start >= duration) return { ok: false, reason: 'out_of_range', duration };
    // Muted: the page stays silent; the captured track still carries the audio.
    el.muted = true;
    try { el.preservesPitch = true; } catch (_) { /* old engines */ }
    el.playbackRate = rate;
    if (start > 0 && Math.abs((el.currentTime || 0) - start) > 0.5) {
      el.currentTime = start;
      await once(el, 'seeked', waitMs);
    }
    try { await el.play(); } catch (err) { return { ok: false, reason: 'play_blocked', detail: String(err && err.message || err).slice(0, 160) }; }
    el.playbackRate = rate;
    const stream = el.captureStream ? el.captureStream() : (el.mozCaptureStream ? el.mozCaptureStream() : null);
    if (!stream) return { ok: false, reason: 'capture_unsupported' };
    let tracks = stream.getAudioTracks();
    for (let i = 0; i < 50 && !tracks.length; i += 1) { await sleep(100); tracks = stream.getAudioTracks(); }
    if (!tracks.length) return { ok: false, reason: 'no_audio_track', duration };
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const cap = { chunks: [], done: false, error: null, mime, startedAt: el.currentTime, stopRequested: false };
    window.__siraCapture = cap;
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, audioBitsPerSecond: 48000 });
    cap.rec = rec;
    cap.el = el;
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      const buf = new Uint8Array(await e.data.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      cap.chunks.push(btoa(s));
    };
    rec.onerror = (e) => { cap.error = String((e && e.error && e.error.message) || 'recorder_error'); };
    rec.onstop = () => { setTimeout(() => { cap.done = true; }, 50); };
    cap.stop = () => { if (cap.stopRequested) return; cap.stopRequested = true; try { if (rec.state !== 'inactive') rec.stop(); else cap.done = true; } catch (_) { cap.done = true; } try { el.pause(); } catch (_) { /* ignore */ } };
    rec.start(sliceMs);
    cap.timer = setInterval(() => {
      if (cap.stopRequested) { clearInterval(cap.timer); return; }
      const stopAt = cap.endOverride != null ? cap.endOverride : end;
      if (stopAt != null && el.currentTime >= stopAt) { cap.stop(); return; }
      if (el.ended) { cap.stop(); return; }
      // A player that paused itself (overlay, focus loss) is nudged back.
      if (el.paused) { el.playbackRate = rate; el.play().catch(() => null); }
    }, 250);
    return { ok: true, duration, startedAt: el.currentTime, mime, title: document.title || '' };
  })();
}

async function captureMediaAudio(pageUrl, opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  const fsImpl = opts.fs || fs;
  const startedAt = Date.now();
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20 * 60 * 1000;
  const deadline = startedAt + timeoutMs;
  const start = Math.max(0, Number(opts.start) || 0);
  const maxSeconds = Number(opts.maxSeconds) > 0 ? Number(opts.maxSeconds) : 3 * 60 * 60;
  let end = Number(opts.end) > start ? Number(opts.end) : null;
  const rate = Math.min(4, Math.max(0.5, Number(opts.rate) || 1));
  const result = { ok: false, reason: null, detail: null, file: opts.outPath || null, mime: null, mediaStart: start, mediaEnd: null, seconds: 0, rate, title: null, finalUrl: null, elapsedMs: 0, bytes: 0, stopped: null };
  const signal = opts.signal || null;

  let page;
  try { page = new URL(String(pageUrl)); } catch (_) { return { ...result, reason: 'invalid_url' }; }
  if (!/^https?:$/.test(page.protocol) || isBlockedHost(page.hostname)) return { ...result, reason: 'invalid_url' };
  if (!opts.outPath) return { ...result, reason: 'no_output_path' };

  const attached = typeof opts.attach === 'function';
  const pw = opts.launch || attached ? null : getPlaywright();
  if (!opts.launch && !attached && (!pw || !pw.chromium)) return { ...result, reason: 'browser_unavailable' };

  const dnsCheck = typeof opts.dnsCheck === 'function' ? opts.dnsCheck : async () => true;
  const verdicts = new Map();
  const hostAllowed = (hostname) => {
    const host = String(hostname || '').toLowerCase();
    if (isBlockedHost(host)) return Promise.resolve(false);
    if (!verdicts.has(host)) verdicts.set(host, dnsCheck(host).then(() => true, () => false));
    return verdicts.get(host);
  };

  let browser = null; let context = null; let tab = null; let out = null;
  try {
    if (attached) {
      const handle = await opts.attach();
      browser = handle && handle.browser;
      context = (handle && handle.context) || (browser && browser.contexts ? browser.contexts()[0] : null);
      if (!browser || !context) throw new Error('attached browser has no context');
    } else {
      browser = opts.launch ? await opts.launch() : await pw.chromium.launch(chromiumLaunchOptions(env));
      context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 }, locale: 'es-PE' });
      const cookies = cookiesForHost(opts.cookies, page.hostname);
      if (cookies.length) { try { await context.addCookies(cookies.map((c) => ({ ...c, path: c.path || '/' }))); } catch (_) { /* ignore */ } }
    }
  } catch (err) {
    logger.warn('[media-capture] browser unavailable:', err && err.message ? err.message : err);
    if (browser && !attached) { try { await browser.close(); } catch (_) { /* ignore */ } }
    return { ...result, reason: 'browser_unavailable', detail: String((err && err.message) || err).slice(0, 200), elapsedMs: Date.now() - startedAt };
  }

  try {
    tab = await context.newPage();
    await tab.route('**/*', async (route) => {
      let url;
      try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
      if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
      if (!/^https?:$/.test(url.protocol)) return route.abort();
      if (!(await hostAllowed(url.hostname))) return route.abort();
      return route.continue();
    });
    try {
      await tab.goto(page.href, { waitUntil: 'domcontentloaded', timeout: Math.min(60_000, Math.max(5_000, deadline - Date.now())) });
    } catch (err) {
      result.detail = String((err && err.message) || err).slice(0, 200);
    }
    result.finalUrl = tab.url();

    // Find the frame that holds the player (iframes included), poking play buttons.
    let mediaFrame = null;
    const findUntil = Math.min(deadline, Date.now() + FIND_MEDIA_MS);
    while (!mediaFrame && Date.now() < findUntil) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      for (const frame of tab.frames()) {
        let n = 0;
        try {
          n = await frame.evaluate((sel) => {
            for (const b of Array.from(document.querySelectorAll(sel)).slice(0, 3)) { try { b.click(); } catch (_) { /* ignore */ } }
            return document.querySelectorAll('video, audio').length;
          }, PLAY_SELECTORS);
        } catch (_) { n = 0; }
        if (n > 0) { mediaFrame = frame; break; }
      }
      if (!mediaFrame) await tab.waitForTimeout(800).catch(() => null);
    }
    if (!mediaFrame) {
      const hasPassword = await tab.evaluate(() => Boolean(document.querySelector('input[type="password"]'))).catch(() => false);
      result.reason = hasPassword ? 'login_wall' : 'no_media_element';
      return result;
    }

    // Unknown end: cap at the duration (when known) or start + maxSeconds.
    const setup = await mediaFrame.evaluate(installRecorder, { start, end: end != null ? end : null, rate, sliceMs: 4000, waitMs: 15_000 });
    if (!setup || !setup.ok) {
      result.reason = (setup && setup.reason) || 'capture_failed';
      if (setup && setup.detail) result.detail = setup.detail;
      return result;
    }
    if (end == null) end = setup.duration != null ? Math.min(setup.duration, start + maxSeconds) : start + maxSeconds;
    if (end - start > maxSeconds) end = start + maxSeconds;
    await mediaFrame.evaluate((e) => { const c = window.__siraCapture; if (c) c.endOverride = e; }, end).catch(() => null);
    result.title = setup.title || null;
    result.mime = setup.mime;
    out = fsImpl.openSync(opts.outPath, 'w');

    let lastTime = setup.startedAt || start;
    let lastAdvanceAt = Date.now();
    let stopped = null;
    let finalDrain = 0;
    for (;;) {
      if (signal && signal.aborted) { stopped = 'aborted'; }
      const now = Date.now();
      const state = await mediaFrame.evaluate((e) => {
        const c = window.__siraCapture;
        if (!c) return { gone: true };
        if (c.endOverride != null && c.el && c.el.currentTime >= c.endOverride) c.stop();
        if (e && !c.stopRequested) c.stop();
        const chunks = c.chunks.splice(0);
        return { chunks, done: c.done, error: c.error, t: c.el ? c.el.currentTime : null, ended: c.el ? c.el.ended : false };
      }, Boolean(stopped)).catch((err) => ({ gone: true, error: String((err && err.message) || err).slice(0, 120) }));
      if (state.gone) { stopped = stopped || 'page_gone'; if (state.error) result.detail = state.error; break; }
      for (const b64 of state.chunks || []) {
        const buf = Buffer.from(b64, 'base64');
        fsImpl.writeSync(out, buf);
        result.bytes += buf.length;
      }
      if (typeof state.t === 'number') {
        if (state.t > lastTime + 0.2) { lastTime = state.t; lastAdvanceAt = now; }
        result.mediaEnd = Math.max(result.mediaEnd || 0, state.t);
      }
      if (state.error) { stopped = stopped || 'recorder_error'; result.detail = state.error; }
      if (state.done) { stopped = stopped || (state.t != null && state.t >= end - 1 ? 'range_end' : state.ended ? 'media_ended' : 'stopped'); break; }
      if (!stopped && now > deadline - 5_000) stopped = 'deadline';
      if (!stopped && now - lastAdvanceAt > STALL_MS) stopped = 'stalled';
      if (stopped) {
        finalDrain += 1;
        if (finalDrain > 6) break; // the recorder never confirmed: keep what landed
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    result.stopped = stopped;
    if (stopped === 'aborted') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (result.mediaEnd != null && end != null) result.mediaEnd = Math.min(result.mediaEnd, end);
    result.seconds = Math.max(0, (result.mediaEnd || start) - start);
    result.ok = result.bytes > 0 && result.seconds >= 1;
    if (!result.ok) result.reason = stopped === 'aborted' ? 'aborted' : stopped === 'stalled' ? 'playback_stalled' : 'nothing_recorded';
    return result;
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    result.reason = 'capture_failed';
    result.detail = String((err && err.message) || err).slice(0, 200);
    return result;
  } finally {
    if (out != null) { try { fsImpl.closeSync(out); } catch (_) { /* ignore */ } }
    if (tab) { try { await tab.close(); } catch (_) { /* ignore */ } }
    // Headless: closes the throwaway browser. Attached (CDP): only disconnects.
    if (browser) { try { await browser.close(); } catch (_) { /* ignore */ } }
    result.elapsedMs = Date.now() - startedAt;
  }
}

/**
 * Pick the playback rate so `span` seconds of media fit in `budgetMs`
 * (real time when they fit; up to `maxRate` otherwise). Returns null when the
 * span cannot fit even at maxRate.
 */
function pickCaptureRate(spanSeconds, budgetMs, maxRate = 2) {
  const span = Number(spanSeconds);
  const budget = Number(budgetMs) / 1000;
  if (!(span > 0) || !(budget > 0)) return 1;
  const needed = span / budget;
  if (needed <= 1) return 1;
  if (needed > maxRate) return null;
  return Math.ceil(needed * 20) / 20;
}

module.exports = { captureMediaAudio, pickCaptureRate, installRecorder };
