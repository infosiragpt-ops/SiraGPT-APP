'use strict';

/**
 * media-discovery — find the real audio/video stream behind a PLAYER PAGE.
 *
 * yt-dlp knows the public platforms (YouTube, Vimeo, Drive…). Institutional
 * players (class.com, Zoom-style recordings, LMS embeds, custom React
 * players) are single-page apps: the HTML carries no media, the player
 * fetches an HLS manifest or an MP4 after the JavaScript runs — and often
 * only with the user's session. yt-dlp's generic extractor gives up on them
 * («Unsupported URL»). This module opens the page in the headless Chromium
 * the backend image already ships (research-agent / preview-screenshot use
 * the same binary), optionally with the user's cookies, presses play, and
 * records every media request the player makes. The caller then hands the
 * best candidate (master .m3u8 > .mpd > .mp4/.m4a > .mp3) to yt-dlp or ffmpeg
 * together with the page's cookies and Referer.
 *
 * Posture: same SSRF rules as web_fetch for EVERY request the page makes
 * (route interception: no IP literals, no localhost/.internal, DNS checked
 * per host), bounded by a total timeout, browser always closed. Degrades to
 * `{ ok:false, reason:'browser_unavailable' }` when Playwright/Chromium are
 * not installed. Fully injectable for tests (`launch`, `dnsCheck`, `now`).
 */

const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 30_000;
const SETTLE_MS = 6_000;
const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4|m4a|m4v|webm|mp3|aac|ogg|oga|opus|wav|flac|mov)(?:[?#]|$)/i;
const SEGMENT_RE = /\.(ts|m4s|aac)(?:[?#]|$)|\/(seg|segment|chunk|frag)[-_]?\d+|[?&](range|bytes)=/i;
const MEDIA_TYPE_RE = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/|video\/)/i;
const LOGIN_PATH_RE = /\/(login|signin|sign-in|log-in|auth|sso|saml|oauth|account\/login|session\/new)(?:[/?#]|$)/i;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let playwrightModule = null;
function getPlaywright() {
  if (playwrightModule !== null) return playwrightModule;
  try { playwrightModule = require('playwright'); } catch (_) { playwrightModule = false; }
  return playwrightModule;
}

function chromiumLaunchOptions(env = process.env) {
  const executablePath = String(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || env.CHROMIUM_PATH || '').trim();
  return {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    ...(executablePath ? { executablePath } : {}),
  };
}

// ─── Candidates ───────────────────────────────────────────────────────────

function classifyMediaUrl(url, contentType = '') {
  const u = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  if (/mpegurl/.test(ct) || /\.m3u8(?:[?#]|$)/i.test(u)) return 'hls';
  if (/dash\+xml/.test(ct) || /\.mpd(?:[?#]|$)/i.test(u)) return 'dash';
  if (/^video\//.test(ct) || /\.(mp4|m4v|webm|mov)(?:[?#]|$)/i.test(u)) return 'video';
  if (/^audio\//.test(ct) || /\.(m4a|mp3|aac|ogg|oga|opus|wav|flac)(?:[?#]|$)/i.test(u)) return 'audio';
  return null;
}

/** True for a URL / content-type that looks like a playable media resource (not a segment). */
function isMediaCandidate(url, contentType = '') {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return false;
  if (SEGMENT_RE.test(u) && !/\.(m3u8|mpd)(?:[?#]|$)/i.test(u)) return false;
  if (MEDIA_TYPE_RE.test(String(contentType || ''))) return true;
  return MEDIA_EXT_RE.test(u);
}

const KIND_SCORE = { hls: 40, dash: 35, video: 30, audio: 25 };

function scoreCandidate(c) {
  let score = KIND_SCORE[c.kind] || 0;
  if (c.kind === 'hls' && /master|index|playlist|manifest/i.test(c.url)) score += 5;
  if (c.fromDom) score += 3;
  if (c.status && c.status >= 400) score -= 30;
  if (/preview|thumb|teaser|trailer|intro|ad[sv]?\b/i.test(c.url)) score -= 10;
  return score;
}

function rankCandidates(list) {
  const seen = new Map();
  for (const c of list) {
    if (!c || !c.url) continue;
    const kind = c.kind || classifyMediaUrl(c.url, c.contentType);
    if (!kind) continue;
    const key = c.url.split('#')[0];
    const prev = seen.get(key);
    const next = { ...c, kind, url: key };
    if (!prev || (next.status && !prev.status) || (next.fromDom && !prev.fromDom)) seen.set(key, { ...(prev || {}), ...next });
  }
  return [...seen.values()].map((c) => ({ ...c, score: scoreCandidate(c) })).sort((a, b) => b.score - a.score);
}

// ─── Cookies (Netscape ⇄ Playwright) ──────────────────────────────────────

function parseNetscapeCookies(text) {
  const out = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const httpOnly = line.startsWith('#HttpOnly_');
    if (line.startsWith('#') && !httpOnly) continue;
    const parts = (httpOnly ? line.slice('#HttpOnly_'.length) : line).split('\t');
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;
    const value = valueParts.join('\t');
    if (!domain || !name) continue;
    const exp = Number(expires);
    out.push({
      name,
      value,
      domain: domain.startsWith('.') ? domain : domain,
      path: cookiePath || '/',
      secure: String(secure).toUpperCase() === 'TRUE',
      httpOnly,
      ...(Number.isFinite(exp) && exp > 0 ? { expires: exp } : {}),
    });
  }
  return out;
}

function toNetscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Exported by SiraGPT media discovery', ''];
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || !c.name) continue;
    const domain = String(c.domain || '');
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = Number.isFinite(Number(c.expires)) && Number(c.expires) > 0 ? Math.floor(Number(c.expires)) : 0;
    lines.push(`${c.httpOnly ? '#HttpOnly_' : ''}${domain}\t${includeSub}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${expires}\t${c.name}\t${c.value == null ? '' : c.value}`);
  }
  return lines.join('\n') + '\n';
}

/** Only the cookies that apply to this host (so a jar for three sites never leaks to a fourth). */
function cookiesForHost(cookies, hostname) {
  const host = String(hostname || '').toLowerCase();
  return (Array.isArray(cookies) ? cookies : []).filter((c) => {
    const raw = String(c.domain || '').toLowerCase();
    const d = raw.replace(/^\./, '');
    if (!d) return false;
    // Netscape semantics: a leading dot covers subdomains; a bare host is exact.
    return host === d || (raw.startsWith('.') && host.endsWith(`.${d}`));
  });
}

// ─── Safety ───────────────────────────────────────────────────────────────

function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (net.isIP(host)) return true; // IP literals never (private ranges included)
  return false;
}

// ─── Discovery ────────────────────────────────────────────────────────────

/**
 * Open `pageUrl` headless, press play, and collect the media requests.
 * @param {string} pageUrl
 * @param {object} opts
 *   cookies: Playwright cookie objects (e.g. parseNetscapeCookies(jarText)) for the page's host
 *   timeoutMs: total budget (default 30 s)
 *   dnsCheck(hostname): throws when the host resolves to a private address
 *   launch(): Promise<Browser> (tests)
 *   attach(): Promise<{ browser, context }> — work inside an EXISTING, already
 *     signed-in browser (the chat computer's Chrome) instead of a fresh
 *     headless one: one new tab, routed through the same SSRF guard, closed
 *     at the end; the user's browser and its other tabs are never touched and
 *     only the cookies of the page / media hosts are exported.
 *   env, logger
 */
async function discoverMedia(pageUrl, opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const remaining = () => Math.max(500, deadline - Date.now());
  const result = { ok: false, reason: null, finalUrl: null, title: null, loginWall: false, candidates: [], best: null, cookiesNetscape: null, userAgent: DESKTOP_UA, elapsedMs: 0 };

  let page;
  try { page = new URL(String(pageUrl)); } catch (_) { return { ...result, reason: 'invalid_url' }; }
  if (!/^https?:$/.test(page.protocol) || isBlockedHost(page.hostname)) return { ...result, reason: 'invalid_url' };

  const attached = typeof opts.attach === 'function';
  const pw = opts.launch || attached ? null : getPlaywright();
  if (!opts.launch && !attached && (!pw || !pw.chromium || typeof pw.chromium.launch !== 'function')) {
    return { ...result, reason: 'browser_unavailable' };
  }

  const dnsCheck = typeof opts.dnsCheck === 'function' ? opts.dnsCheck : async () => true;
  const hostVerdicts = new Map();
  async function hostAllowed(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (isBlockedHost(host)) return false;
    if (hostVerdicts.has(host)) return hostVerdicts.get(host);
    const pending = dnsCheck(host).then(() => true, () => false);
    hostVerdicts.set(host, pending);
    return pending;
  }

  const seen = [];
  let browser = null;
  let existingContext = null;
  try {
    if (attached) {
      const handle = await opts.attach();
      browser = handle && handle.browser;
      existingContext = (handle && handle.context) || (browser && typeof browser.contexts === 'function' ? browser.contexts()[0] : null);
      if (!browser || !existingContext) throw new Error('attached browser has no context');
    } else {
      browser = opts.launch ? await opts.launch() : await pw.chromium.launch(chromiumLaunchOptions(env));
    }
  } catch (err) {
    logger.warn('[media-discovery] chromium launch failed:', err && err.message ? err.message : err);
    if (browser) { try { await browser.close(); } catch (_) { /* ignore */ } }
    return { ...result, reason: 'browser_unavailable', detail: String((err && err.message) || err).slice(0, 200) };
  }

  let tab = null;
  try {
    let context = existingContext;
    if (!attached) {
      context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 }, locale: 'es-PE' });
      const cookies = cookiesForHost(opts.cookies, page.hostname);
      if (cookies.length) {
        try { await context.addCookies(cookies.map((c) => ({ ...c, domain: c.domain, path: c.path || '/' }))); } catch (err) { logger.warn('[media-discovery] cookies rejected:', err && err.message); }
      }
    }
    tab = await context.newPage();
    if (attached) {
      // The user's real browser: report ITS user agent so the backend download
      // looks like the same browser the session belongs to.
      try { result.userAgent = (await tab.evaluate(() => navigator.userAgent)) || DESKTOP_UA; } catch (_) { /* keep default */ }
    }
    // Route only this tab: in an attached browser the user's other tabs keep
    // browsing normally.
    await (attached ? tab : context).route('**/*', async (route) => {
      let url;
      try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
      if (!/^https?:$/.test(url.protocol)) return route.abort();
      if (!(await hostAllowed(url.hostname))) return route.abort();
      return route.continue();
    });
    tab.on('request', (req) => {
      const url = req.url();
      if (isMediaCandidate(url)) seen.push({ url, kind: classifyMediaUrl(url), source: 'request' });
    });
    tab.on('response', (res) => {
      let ct = '';
      try { ct = res.headers()['content-type'] || ''; } catch (_) { ct = ''; }
      const url = res.url();
      if (isMediaCandidate(url, ct)) seen.push({ url, kind: classifyMediaUrl(url, ct), contentType: ct, status: res.status(), source: 'response' });
    });

    let navError = null;
    try {
      await tab.goto(page.href, { waitUntil: 'domcontentloaded', timeout: Math.min(remaining(), timeoutMs) });
    } catch (err) {
      navError = err;
    }
    // Let the SPA boot, then poke every player we can find.
    await tab.waitForTimeout(Math.min(1500, remaining())).catch(() => null);
    try {
      await tab.evaluate(() => {
        const clickables = [
          ...document.querySelectorAll('button[aria-label*="play" i], button[title*="play" i], [class*="play-button" i], [class*="playButton" i], [data-testid*="play" i], .vjs-big-play-button, .plyr__control--overlaid'),
        ];
        for (const el of clickables.slice(0, 4)) { try { el.click(); } catch (_) { /* ignore */ } }
        for (const media of document.querySelectorAll('video, audio')) {
          try { media.muted = true; const p = media.play(); if (p && p.catch) p.catch(() => null); } catch (_) { /* ignore */ }
        }
      });
    } catch (_) { /* page may be gone */ }

    const settleUntil = Math.min(Date.now() + SETTLE_MS, deadline);
    while (Date.now() < settleUntil) {
      await tab.waitForTimeout(400).catch(() => null);
      if (seen.some((c) => c.kind === 'hls' || c.kind === 'dash')) break;
    }

    // DOM-declared sources (currentSrc beats src: it is what actually plays).
    let dom = { sources: [], title: '', hasPassword: false, text: '' };
    try {
      dom = await tab.evaluate(() => {
        const sources = [];
        for (const el of document.querySelectorAll('video, audio, source')) {
          const src = el.currentSrc || el.src || el.getAttribute('src');
          if (src) sources.push(src);
        }
        for (const sel of ['meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]', 'meta[property="og:audio"]']) {
          const m = document.querySelector(sel);
          if (m && m.content) sources.push(m.content);
        }
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const json = JSON.parse(s.textContent || '');
            const walk = (node) => {
              if (!node || typeof node !== 'object') return;
              if (typeof node.contentUrl === 'string') sources.push(node.contentUrl);
              for (const v of Object.values(node)) walk(v);
            };
            walk(json);
          } catch (_) { /* ignore */ }
        }
        return {
          sources,
          title: document.title || '',
          hasPassword: Boolean(document.querySelector('input[type="password"]')),
          text: (document.body && document.body.innerText || '').slice(0, 2000),
        };
      });
    } catch (_) { /* ignore */ }
    for (const src of dom.sources) {
      if (/^https?:\/\//i.test(src) && (isMediaCandidate(src) || /blob:/.test(src) === false && classifyMediaUrl(src))) {
        seen.push({ url: src, kind: classifyMediaUrl(src), source: 'dom', fromDom: true });
      }
    }

    result.finalUrl = tab.url();
    result.title = dom.title || null;
    result.candidates = rankCandidates(seen).slice(0, 12);
    result.best = result.candidates[0] || null;
    let finalPath = '';
    try { finalPath = new URL(result.finalUrl).pathname; } catch (_) { finalPath = ''; }
    const loginText = /iniciar sesi[oó]n|inicia sesi[oó]n|log ?in|sign ?in|acceder|autenticar|contraseña|password/i.test(dom.text || '');
    result.loginWall = !result.best && (LOGIN_PATH_RE.test(finalPath) || dom.hasPassword || (loginText && !navError));
    try {
      // Attached: only the page's and the media hosts' cookies leave the user's
      // browser (Playwright filters by URL), never the whole profile.
      const scope = attached ? [page.href, ...result.candidates.slice(0, 3).map((c) => c.url)] : undefined;
      const jar = scope ? await context.cookies(scope) : await context.cookies();
      if (jar && jar.length) result.cookiesNetscape = toNetscapeCookies(jar);
    } catch (_) { /* optional */ }
    result.ok = Boolean(result.best);
    result.reason = result.ok ? null : result.loginWall ? 'login_wall' : navError ? 'navigation_failed' : 'no_media_found';
    if (navError) result.detail = String(navError.message || navError).slice(0, 200);
  } catch (err) {
    result.reason = 'discovery_failed';
    result.detail = String((err && err.message) || err).slice(0, 200);
  } finally {
    if (attached && tab) { try { await tab.close(); } catch (_) { /* ignore */ } }
    // Headless: closes the throwaway browser. Attached (CDP): only disconnects.
    try { await browser.close(); } catch (_) { /* ignore */ }
    result.elapsedMs = Date.now() - startedAt;
  }
  return result;
}

module.exports = {
  discoverMedia,
  rankCandidates,
  classifyMediaUrl,
  isMediaCandidate,
  parseNetscapeCookies,
  toNetscapeCookies,
  cookiesForHost,
  isBlockedHost,
  chromiumLaunchOptions,
  getPlaywright,
  DESKTOP_UA,
  DEFAULT_TIMEOUT_MS,
};
