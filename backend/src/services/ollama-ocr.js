'use strict';

/**
 * ollama-ocr — GLM-OCR (Z.ai, 0.9B, #1 OmniDocBench v1.5) served by the
 * Lenovo's Ollama as the FIRST vision-OCR rung of `ocr-engine`.
 *
 * Why
 * ---
 * The hybrid OCR path was Tesseract → OpenAI gpt-4o. Every weak Tesseract
 * read (phone photos, dense scans, tables) cost a paid vision call and a
 * round trip to the cloud. `ollama run glm-ocr` reads the same documents
 * locally on the office machine that already runs `siragpt-ollama`
 * (SiraGPT Mini), so the cloud model becomes the fallback of the fallback.
 *
 * Contract
 * --------
 * - Native Ollama API: `POST <base>/api/chat` with `messages[0].images`
 *   (base64) and the task prompt GLM-OCR was trained on
 *   (`Text Recognition:` / `Table Recognition:` / `Figure Recognition:`).
 *   Markdown out (tables as Markdown/HTML, formulas as LaTeX).
 * - Availability is probed once per `OLLAMA_OCR_PROBE_TTL_MS` through
 *   `GET <base>/api/tags`: an unreachable Ollama or a model that was never
 *   pulled is memoised as unavailable and the engine moves on in < 2 s. The
 *   moment `ollama pull glm-ocr` runs on the host, the next probe turns it on
 *   — no env change, no restart.
 * - Never throws. Every failure is `{ ok:false, reason }` so `ocr-engine`
 *   can keep its own fail-open ladder.
 * - Self-installing: when the probe finds Ollama up but the model missing,
 *   the client asks Ollama to download it (`POST /api/pull`, once, in the
 *   background) and re-probes when the pull finishes. Nobody needs a shell on
 *   the production host; the next publish brings the model along. Off with
 *   `OLLAMA_OCR_AUTO_PULL=0`; a failed pull is retried after
 *   `OLLAMA_OCR_PULL_RETRY_MS`.
 * - Default ON everywhere except `NODE_ENV=test` (unit tests never touch
 *   the network; they inject `fetchImpl`). Kill switch `SIRAGPT_OLLAMA_OCR=0`.
 * - Output is GATED, never trusted blindly: the answer is streamed so a
 *   timeout keeps the text read so far, a repetition loop is cut as soon as
 *   it appears (the text before it is kept), and `done_reason: 'length'` is
 *   reported as truncation. The engine then cross-checks the read against
 *   Tesseract and the cloud ladder (`ocr-engine` + `ocr-ensemble`).
 * - Small crops are upscaled (≤ 4×, short side to `OLLAMA_OCR_MIN_SHORT_SIDE`)
 *   before they reach the 0.9B model; requests run one at a time
 *   (`OLLAMA_OCR_CONCURRENCY`) on the CPU Ollama shared with SiraGPT Mini, and
 *   two consecutive timeouts park the rung for `OLLAMA_OCR_TIMEOUT_COOLDOWN_MS`.
 */

const fs = require('fs').promises;
const ocrQuality = require('./ocr-quality');

const DEFAULT_BASE_URL = 'http://siragpt-ollama:11434';
const DEFAULT_MODEL = 'glm-ocr';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_PROBE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SIDE = 2048;
const DEFAULT_NUM_PREDICT = 8192;
const DEFAULT_KEEP_ALIVE = '30m';
const DEFAULT_PULL_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_PULL_RETRY_MS = 30 * 60 * 1000;
// Small crops (URL strips, stamps, 360-px captures) are upscaled for the
// 0.9B model until their short side reaches this, never past maxSide and
// never more than MAX_UPSCALE× (Tesseract variants already did the same).
const DEFAULT_MIN_SHORT_SIDE = 1024;
const MAX_UPSCALE = 4;
// Two consecutive timeouts park the rung for this long: on the shared CPU
// Ollama every later page would otherwise wait the full timeout again.
const DEFAULT_TIMEOUT_STREAK = 2;
const DEFAULT_TIMEOUT_COOLDOWN_MS = 10 * 60 * 1000;
// Streamed output is checked for a repetition loop every this many chars.
const LOOP_CHECK_EVERY_CHARS = 1500;

const TASK_PROMPTS = Object.freeze({
  text: 'Text Recognition:',
  table: 'Table Recognition:',
  formula: 'Formula Recognition:',
  figure: 'Figure Recognition:',
});

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

function intFromEnv(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(env[name] || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  // Admin rows store the OpenAI-compatible root (…/v1); the native API lives
  // one level up.
  url = url.replace(/\/v1$/i, '');
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return '';
    return url;
  } catch {
    return '';
  }
}

function getOllamaOcrConfig(env = process.env) {
  const flag = String(env.SIRAGPT_OLLAMA_OCR ?? '').trim().toLowerCase();
  const explicitOn = TRUTHY.has(flag);
  const explicitOff = FALSY.has(flag);
  const enabled = explicitOn || (!explicitOff && env.NODE_ENV !== 'test');
  const model = String(env.OLLAMA_OCR_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return {
    enabled,
    baseUrl: normalizeBaseUrl(env.OLLAMA_OCR_BASE_URL || env.OLLAMA_BASE_URL || DEFAULT_BASE_URL),
    model,
    task: TASK_PROMPTS[String(env.OLLAMA_OCR_TASK || 'text').toLowerCase()] ? String(env.OLLAMA_OCR_TASK || 'text').toLowerCase() : 'text',
    timeoutMs: intFromEnv(env, 'OLLAMA_OCR_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 1000 }),
    probeTimeoutMs: intFromEnv(env, 'OLLAMA_OCR_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS, { min: 200 }),
    probeTtlMs: intFromEnv(env, 'OLLAMA_OCR_PROBE_TTL_MS', DEFAULT_PROBE_TTL_MS, { min: 1000 }),
    maxSide: intFromEnv(env, 'OLLAMA_OCR_MAX_SIDE', DEFAULT_MAX_SIDE, { min: 512, max: 8192 }),
    numPredict: intFromEnv(env, 'OLLAMA_OCR_NUM_PREDICT', DEFAULT_NUM_PREDICT, { min: 256, max: 65536 }),
    keepAlive: String(env.OLLAMA_OCR_KEEP_ALIVE || DEFAULT_KEEP_ALIVE),
    autoPull: !FALSY.has(String(env.OLLAMA_OCR_AUTO_PULL ?? '').trim().toLowerCase()),
    pullTimeoutMs: intFromEnv(env, 'OLLAMA_OCR_PULL_TIMEOUT_MS', DEFAULT_PULL_TIMEOUT_MS, { min: 10_000 }),
    pullRetryMs: intFromEnv(env, 'OLLAMA_OCR_PULL_RETRY_MS', DEFAULT_PULL_RETRY_MS, { min: 1000 }),
    minShortSide: intFromEnv(env, 'OLLAMA_OCR_MIN_SHORT_SIDE', DEFAULT_MIN_SHORT_SIDE, { min: 0, max: 4096 }),
    // Streamed /api/chat keeps the text read before a timeout and lets a
    // repetition loop be cut early. OLLAMA_OCR_STREAM=0 restores one JSON body.
    stream: !FALSY.has(String(env.OLLAMA_OCR_STREAM ?? '').trim().toLowerCase()),
    // One OCR request at a time on the shared CPU Ollama (SiraGPT Mini runs
    // there too); queued reads wait on their own budget (queueTimeoutMs).
    concurrency: intFromEnv(env, 'OLLAMA_OCR_CONCURRENCY', 1, { min: 1, max: 8 }),
    timeoutStreak: intFromEnv(env, 'OLLAMA_OCR_TIMEOUT_STREAK', DEFAULT_TIMEOUT_STREAK, { min: 1, max: 20 }),
    timeoutCooldownMs: intFromEnv(env, 'OLLAMA_OCR_TIMEOUT_COOLDOWN_MS', DEFAULT_TIMEOUT_COOLDOWN_MS, { min: 1000 }),
    // How long a read may wait for the gate before it gives up
    // (`queue_timeout`, never counted as an Ollama timeout). Default: the
    // inference timeout. A caller's `timeoutMs` bounds wait + inference.
    queueTimeoutMs: intFromEnv(env, 'OLLAMA_OCR_QUEUE_TIMEOUT_MS', intFromEnv(env, 'OLLAMA_OCR_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 1000 }), { min: 1000 }),
    // Optional sampling knobs (unset = Ollama defaults). Loops are handled by
    // the detector, so these stay opt-in.
    repeatPenalty: optionalNumber(env.OLLAMA_OCR_REPEAT_PENALTY, { min: 0.5, max: 2 }),
    repeatLastN: optionalNumber(env.OLLAMA_OCR_REPEAT_LAST_N, { min: -1, max: 4096, integer: true }),
  };
}

function optionalNumber(raw, { min, max, integer = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = integer ? Number.parseInt(String(raw), 10) : Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(value, max));
}

/**
 * Ollama lists pulled models as `name:tag`. A bare `glm-ocr` resolves to
 * `glm-ocr:latest` on the server, so only that tag counts as "pulled"; an
 * explicit tag (`glm-ocr:q8_0`) must match exactly.
 */
function isModelListed(models, model) {
  const wanted = String(model || '').trim();
  if (!wanted) return false;
  const accepted = new Set([wanted]);
  if (!wanted.includes(':')) accepted.add(`${wanted}:latest`);
  return (Array.isArray(models) ? models : []).some((entry) => {
    const name = String((entry && (entry.name || entry.model)) || '').trim();
    return accepted.has(name);
  });
}

/** Strip chat-template leftovers a small VLM sometimes echoes. */
function cleanModelOutput(text) {
  return String(text || '')
    .replace(/<\|[^|>]{1,40}\|>/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function timeoutSignal(ms, outer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ollama_ocr_timeout')), ms);
  const onOuterAbort = () => controller.abort(outer && outer.reason);
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason || new Error('ollama_ocr_stopped'));
    },
    clear() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    },
  };
}

/**
 * Read an Ollama /api/chat body: NDJSON stream (one JSON object per line) or
 * a single JSON object (stream:false, or a server that ignored `stream`).
 * `onMessage(obj)` returning true stops reading (the caller aborts the
 * request). Never throws on a malformed line; an aborted read rethrows.
 */
async function readChatBody(response, onMessage) {
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    let obj = null;
    try { obj = JSON.parse(trimmed); } catch { return false; }
    return obj && typeof obj === 'object' ? onMessage(obj) === true : false;
  };
  const body = response && response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let nl = buffered.indexOf('\n');
        while (nl >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (handleLine(line)) {
            try { await reader.cancel(); } catch { /* already closed */ }
            return { stopped: true };
          }
          nl = buffered.indexOf('\n');
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) handleLine(buffered);
      return { stopped: false };
    } finally {
      try { reader.releaseLock(); } catch { /* released */ }
    }
  }
  if (response && typeof response.text === 'function') {
    const text = await readBodyText(response);
    for (const line of String(text || '').split('\n')) {
      if (handleLine(line)) return { stopped: true };
    }
    return { stopped: false };
  }
  const json = response && typeof response.json === 'function' ? await response.json().catch(() => null) : null;
  if (json) onMessage(json);
  return { stopped: false };
}

/** Small FIFO semaphore: `run(fn)` waits for a slot; `signal` cancels the wait. */
function createGate(limitFn) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (waiting.length && active < Math.max(1, limitFn())) {
      const next = waiting.shift();
      if (next.cancelled) continue;
      active += 1;
      next.resolve();
    }
  };
  async function acquire(signal) {
    if (active < Math.max(1, limitFn()) && waiting.length === 0) { active += 1; return; }
    await new Promise((resolve, reject) => {
      const entry = { resolve, cancelled: false };
      const onAbort = () => {
        entry.cancelled = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      entry.resolve = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      waiting.push(entry);
    });
  }
  function release() {
    active = Math.max(0, active - 1);
    pump();
  }
  return { acquire, release, stats: () => ({ active, waiting: waiting.filter((e) => !e.cancelled).length }) };
}

function isAbortError(error) {
  return !!error && (error.name === 'AbortError' || /aborted|timeout/i.test(String(error.message || '')));
}

async function readBodyText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function classifyHttpFailure(status, bodyText) {
  if (status === 404 || /not found|no such model|pull the model/i.test(bodyText || '')) return 'model_not_found';
  if (status === 413) return 'image_too_large';
  if (status >= 500) return `ollama_http_${status}`;
  return `ollama_http_${status}`;
}

/**
 * Scale factor for the GLM input: down to fit `maxSide`, or UP (≤ 4×) until
 * the short side reaches `minShortSide` — 5–8 px glyphs of a small crop are
 * unreadable for the 0.9B model at native size. Never past `maxSide`.
 */
function planGlmScale(width, height, { maxSide = DEFAULT_MAX_SIDE, minShortSide = DEFAULT_MIN_SHORT_SIDE } = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return 1;
  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);
  const fit = maxSide > 0 ? maxSide / longSide : 1;
  if (fit < 1) return fit;
  const want = minShortSide > 0 ? minShortSide / shortSide : 1;
  if (want <= 1) return 1;
  return Math.max(1, Math.min(want, MAX_UPSCALE, fit));
}

/**
 * Downscale (or upscale a small crop) + PNG-encode so a 12 MP phone photo
 * does not travel as a 6 MB JPEG base64 to a 0.9B model that works at ~2k px
 * anyway. Best-effort: an undecodable buffer goes through untouched and
 * Ollama reports it.
 */
async function prepareImage(buffer, { maxSide, minShortSide = DEFAULT_MIN_SHORT_SIDE, sharpImpl } = {}) {
  const sharp = sharpImpl || require('sharp');
  try {
    let scale = null;
    try {
      const meta = typeof sharp(buffer).metadata === 'function' ? await sharp(buffer).metadata() : null;
      if (meta && meta.width && meta.height) {
        // EXIF orientations 5-8 swap the sides after .rotate().
        const swap = Number(meta.orientation) >= 5;
        const w = swap ? meta.height : meta.width;
        const h = swap ? meta.width : meta.height;
        scale = { w, h, factor: planGlmScale(w, h, { maxSide, minShortSide }) };
      }
    } catch { scale = null; }
    if (scale && scale.factor > 1) {
      return await sharp(buffer)
        .rotate()
        .resize({
          width: Math.round(scale.w * scale.factor),
          height: Math.round(scale.h * scale.factor),
          fit: 'inside',
          kernel: 'lanczos3',
        })
        .png()
        .toBuffer();
    }
    return await sharp(buffer)
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

function createOllamaOcrClient({ env = process.env, fetchImpl, now = () => Date.now(), sharpImpl, logger = console } = {}) {
  const availability = new Map();
  // key → { promise, startedAt } while a pull is in flight; key → { failedAt }
  // after a failed pull so a permanently missing model is retried on a slow cadence.
  const pulls = new Map();
  const pullFailures = new Map();
  const timeoutStreaks = new Map();
  const getFetch = () => fetchImpl || globalThis.fetch;
  const gate = createGate(() => getOllamaOcrConfig(env).concurrency);

  function config() {
    return getOllamaOcrConfig(env);
  }

  function isEnabled() {
    const cfg = config();
    return !!(cfg.enabled && cfg.baseUrl && typeof getFetch() === 'function');
  }

  function cacheKey(cfg) {
    return `${cfg.baseUrl}|${cfg.model}`;
  }

  function remember(cfg, state, ttlMs = null) {
    availability.set(cacheKey(cfg), { ...state, checkedAt: now(), ...(ttlMs ? { ttlMs } : {}) });
    return state;
  }

  /**
   * Ask Ollama to download the model (`POST /api/pull`). Fire-and-forget: the
   * returned promise never rejects; while it runs the memo reads
   * `model_pulling`, and when it ends the memo is dropped so the next
   * `ensureAvailable` re-probes right away. One pull per base+model at a time;
   * a failure parks retries for `pullRetryMs`.
   */
  function startPull(cfg) {
    const key = cacheKey(cfg);
    const inflight = pulls.get(key);
    if (inflight) return inflight.promise;
    const failed = pullFailures.get(key);
    if (failed && now() - failed.failedAt < cfg.pullRetryMs) return null;
    const fetchFn = getFetch();
    if (typeof fetchFn !== 'function') return null;

    logger.log(`[ollama-ocr] model «${cfg.model}» missing on ${cfg.baseUrl} — asking Ollama to pull it (this runs once, in the background)`);
    const t = timeoutSignal(cfg.pullTimeoutMs);
    const promise = (async () => {
      try {
        const response = await fetchFn(`${cfg.baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `model` is the current field; `name` keeps older Ollama builds happy.
          body: JSON.stringify({ model: cfg.model, name: cfg.model, stream: false }),
          signal: t.signal,
        });
        const bodyText = response ? await readBodyText(response) : '';
        let status = null;
        try { status = JSON.parse(bodyText || '{}').status || null; } catch { status = null; }
        if (!response || !response.ok || (status && !/success/i.test(String(status)))) {
          throw new Error(`pull answered ${response ? response.status : 0}${status ? ` (${status})` : ''}: ${bodyText.slice(0, 160)}`);
        }
        pullFailures.delete(key);
        logger.log(`[ollama-ocr] pull of «${cfg.model}» finished — local OCR becomes the first vision rung on the next read`);
        return { ok: true };
      } catch (error) {
        pullFailures.set(key, { failedAt: now(), reason: String((error && error.message) || error).slice(0, 200) });
        logger.warn(`[ollama-ocr] pull of «${cfg.model}» failed (${String((error && error.message) || error).slice(0, 160)}) — retrying in ${Math.round(cfg.pullRetryMs / 60000)} min; cloud vision OCR stays in charge`);
        return { ok: false };
      } finally {
        t.clear();
        pulls.delete(key);
        // Drop the memo so the next probe sees the real state immediately.
        availability.delete(key);
      }
    })();
    pulls.set(key, { promise, startedAt: now() });
    return promise;
  }

  /**
   * `{ available, reason }` — memoised per base+model for `probeTtlMs`.
   * `force:true` bypasses the memo (used after a surprising request failure).
   */
  async function ensureAvailable({ force = false } = {}) {
    const cfg = config();
    if (!cfg.enabled) return { available: false, reason: 'ollama_ocr_disabled' };
    if (!cfg.baseUrl) return { available: false, reason: 'ollama_ocr_no_base_url' };
    const cached = availability.get(cacheKey(cfg));
    if (!force && cached && now() - cached.checkedAt < (cached.ttlMs || cfg.probeTtlMs)) {
      return { available: cached.available, reason: cached.reason, cached: true };
    }
    const fetchFn = getFetch();
    if (typeof fetchFn !== 'function') return remember(cfg, { available: false, reason: 'fetch_unavailable' });
    const t = timeoutSignal(cfg.probeTimeoutMs);
    try {
      const response = await fetchFn(`${cfg.baseUrl}/api/tags`, { method: 'GET', signal: t.signal });
      if (!response || !response.ok) {
        const state = remember(cfg, { available: false, reason: `ollama_tags_http_${response ? response.status : 0}` });
        logger.warn(`[ollama-ocr] ${cfg.baseUrl} answered ${response ? response.status : 'nothing'} on /api/tags — cloud vision OCR stays in charge for ${Math.round(cfg.probeTtlMs / 1000)} s`);
        return state;
      }
      const json = await response.json().catch(() => ({}));
      if (!isModelListed(json && json.models, cfg.model)) {
        if (cfg.autoPull && (pulls.has(cacheKey(cfg)) || startPull(cfg))) {
          return remember(cfg, { available: false, reason: 'model_pulling' });
        }
        const state = remember(cfg, { available: false, reason: 'model_not_found' });
        logger.warn(`[ollama-ocr] model «${cfg.model}» is not pulled on ${cfg.baseUrl} (run: ollama pull ${cfg.model}) — cloud vision OCR stays in charge for ${Math.round(cfg.probeTtlMs / 1000)} s`);
        return state;
      }
      const wasDown = cached && !cached.available;
      if (!cached || wasDown) logger.log(`[ollama-ocr] ${cfg.model} available at ${cfg.baseUrl} — local OCR is the first vision rung`);
      return remember(cfg, { available: true, reason: null });
    } catch (error) {
      const reason = isAbortError(error) ? 'ollama_unreachable_timeout' : 'ollama_unreachable';
      const state = remember(cfg, { available: false, reason });
      logger.warn(`[ollama-ocr] cannot reach ${cfg.baseUrl} (${String((error && error.message) || error).slice(0, 120)}) — cloud vision OCR stays in charge for ${Math.round(cfg.probeTtlMs / 1000)} s`);
      return state;
    } finally {
      t.clear();
    }
  }

  /**
   * One OCR read. `{ ok:true, text, provider, model, durationMs, task,
   * doneReason, truncated, loop, partial }` or `{ ok:false, reason, status? }`.
   * Never throws.
   *
   * The answer is streamed (NDJSON) so a timeout keeps the text read so far
   * (`partial`, `truncated`), and a repetition loop — the typical failure of
   * a small VLM at temperature 0 on long tables — is cut as soon as it shows:
   * the request is aborted (freeing the shared CPU) and the text before the
   * loop is kept (`loop`, `truncated`). `done_reason: 'length'` (num_predict
   * reached) is reported as `truncated` too. `task`: text | table | formula.
   * `timeoutMs` can only shorten the configured timeout (ladder deadlines);
   * it bounds the gate wait AND the inference together.
   *
   * Timers: the wait for the shared gate has its own budget (`queue_timeout`
   * when it runs out); the inference timer starts only once the gate is
   * held. Only a timeout that had the FULL configured inference time counts
   * toward the streak that parks the rung: a read queued behind other reads
   * or shortened by a ladder deadline says nothing about Ollama's health.
   */
  async function recognize({ buffer, filePath, task, signal, timeoutMs } = {}) {
    const cfg = config();
    const started = now();
    if (!cfg.enabled) return { ok: false, reason: 'ollama_ocr_disabled' };
    if (!cfg.baseUrl) return { ok: false, reason: 'ollama_ocr_no_base_url' };
    const fetchFn = getFetch();
    if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch_unavailable' };
    if (signal && signal.aborted) return { ok: false, reason: 'aborted' };

    let imageBuffer = buffer;
    try {
      if (!imageBuffer && filePath) imageBuffer = await fs.readFile(filePath);
    } catch (error) {
      return { ok: false, reason: `read_failed:${String((error && error.code) || 'EIO')}` };
    }
    if (!imageBuffer || !imageBuffer.length) return { ok: false, reason: 'empty_image' };

    const prepared = await prepareImage(imageBuffer, { maxSide: cfg.maxSide, minShortSide: cfg.minShortSide, sharpImpl });
    const taskKey = TASK_PROMPTS[task] ? task : (TASK_PROMPTS[cfg.task] ? cfg.task : 'text');
    const options = { temperature: 0, num_predict: cfg.numPredict };
    if (cfg.repeatPenalty !== null) options.repeat_penalty = cfg.repeatPenalty;
    if (cfg.repeatLastN !== null) options.repeat_last_n = cfg.repeatLastN;
    const body = {
      model: cfg.model,
      messages: [{ role: 'user', content: TASK_PROMPTS[taskKey], images: [prepared.toString('base64')] }],
      stream: cfg.stream,
      keep_alive: cfg.keepAlive,
      options,
    };

    const requested = Number(timeoutMs);
    const callerBudgetMs = Number.isFinite(requested) && requested > 0 ? requested : null;
    const state = { text: '', done: false, doneReason: null, evalCount: null, evalDurationNs: null, loop: null, streamError: null, nextCheck: LOOP_CHECK_EVERY_CHARS };
    let acquired = false;
    let t = null;
    let fullBudget = false;

    const finish = (kind) => {
      let text = cleanModelOutput(state.text);
      const loop = state.loop || (text ? ocrQuality.detectRepetitionLoop(text) : null);
      const looping = Boolean(loop && loop.looping);
      if (looping) text = cleanModelOutput(loop.kept);
      const loopAtEnd = looping && loop.position === 'end';
      const truncated = kind === 'timeout' || state.doneReason === 'length' || loopAtEnd || (kind === 'stream_error');
      if (!text) {
        return { ok: false, reason: looping ? 'loop' : kind === 'timeout' ? 'timeout' : kind === 'stream_error' ? 'ollama_stream_error' : 'empty_output' };
      }
      const durationMs = Math.max(0, now() - started);
      const evalSeconds = state.evalDurationNs ? state.evalDurationNs / 1e9 : 0;
      return {
        ok: true,
        text,
        model: cfg.model,
        provider: `ollama:${cfg.model}`,
        durationMs,
        evalCount: state.evalCount,
        tokensPerSec: state.evalCount && evalSeconds > 0 ? Math.round((state.evalCount / evalSeconds) * 10) / 10 : null,
        task: taskKey,
        doneReason: looping && loopAtEnd ? 'loop' : kind === 'timeout' ? 'timeout' : state.doneReason,
        truncated,
        partial: kind === 'timeout' || kind === 'stream_error',
        loop: looping ? { kind: loop.kind, repeats: loop.repeats, position: loop.position } : null,
      };
    };

    try {
      // 1) Wait for the gate, on its own budget (never counted as a timeout).
      const queueBudgetMs = Math.max(1000, Math.min(cfg.queueTimeoutMs, callerBudgetMs !== null ? callerBudgetMs - Math.max(0, now() - started) : Infinity));
      const q = timeoutSignal(queueBudgetMs, signal);
      try {
        await gate.acquire(q.signal);
        acquired = true;
      } catch {
        if (signal && signal.aborted) return { ok: false, reason: 'aborted' };
        return { ok: false, reason: 'queue_timeout' };
      } finally {
        q.clear();
      }
      if (signal && signal.aborted) return { ok: false, reason: 'aborted' };
      // 2) Inference: the configured timeout, shortened by what is left of
      // the caller's budget. A wait that ate that budget is a queue timeout.
      const callerLeftMs = callerBudgetMs !== null ? callerBudgetMs - Math.max(0, now() - started) : Infinity;
      if (callerLeftMs <= 0) return { ok: false, reason: 'queue_timeout' };
      const limitMs = Math.max(1000, Math.min(cfg.timeoutMs, callerLeftMs));
      fullBudget = limitMs >= cfg.timeoutMs;
      t = timeoutSignal(limitMs, signal);
      const response = await fetchFn(`${cfg.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: t.signal,
      });
      if (!response || !response.ok) {
        const status = response ? response.status : 0;
        const bodyText = response ? await readBodyText(response) : '';
        const reason = classifyHttpFailure(status, bodyText);
        if (reason === 'model_not_found') remember(cfg, { available: false, reason });
        return { ok: false, reason, status };
      }
      await readChatBody(response, (obj) => {
        if (obj.error) {
          state.streamError = String(obj.error).slice(0, 160);
          return true;
        }
        const piece = obj.message && typeof obj.message.content === 'string'
          ? obj.message.content
          : (typeof obj.response === 'string' ? obj.response : '');
        if (piece) state.text += piece;
        if (obj.done) {
          state.done = true;
          state.doneReason = typeof obj.done_reason === 'string' ? obj.done_reason : null;
          if (Number.isFinite(obj.eval_count)) state.evalCount = obj.eval_count;
          if (Number.isFinite(obj.eval_duration)) state.evalDurationNs = obj.eval_duration;
        } else if (Number.isFinite(obj.eval_count) && state.evalCount === null) {
          state.evalCount = obj.eval_count;
        }
        if (cfg.stream && state.text.length >= state.nextCheck) {
          state.nextCheck = state.text.length + LOOP_CHECK_EVERY_CHARS;
          const loop = ocrQuality.detectRepetitionLoop(cleanModelOutput(state.text));
          if (loop.looping && loop.position === 'end') {
            state.loop = loop;
            return true;
          }
        }
        return false;
      });
      if (state.loop) t.abort(new Error('ollama_ocr_loop'));
      timeoutStreaks.delete(cacheKey(cfg));
      if (state.streamError) return finish('stream_error');
      return finish('complete');
    } catch (error) {
      if (isAbortError(error)) {
        if (signal && signal.aborted) return { ok: false, reason: 'aborted' };
        // Only a read that had the full configured inference time says
        // something about Ollama's health.
        if (fullBudget) noteTimeout(cfg);
        return finish('timeout');
      }
      // A connection refused mid-session means Ollama went away: memoise so
      // the next pages do not each wait for the TCP failure.
      remember(cfg, { available: false, reason: 'ollama_unreachable' });
      return { ok: false, reason: 'ollama_unreachable', detail: String((error && error.message) || error).slice(0, 160) };
    } finally {
      if (t) t.clear();
      if (acquired) gate.release();
    }
  }

  /**
   * Consecutive timeouts on the shared CPU Ollama: after `timeoutStreak` of
   * them the rung is parked for `timeoutCooldownMs` (ensureAvailable answers
   * `timeout_cooldown`), so a long scanned PDF does not wait the full timeout
   * on every page.
   */
  function noteTimeout(cfg) {
    const key = cacheKey(cfg);
    const streak = (timeoutStreaks.get(key) || 0) + 1;
    timeoutStreaks.set(key, streak);
    if (streak >= cfg.timeoutStreak) {
      timeoutStreaks.delete(key);
      remember(cfg, { available: false, reason: 'timeout_cooldown' }, cfg.timeoutCooldownMs);
      logger.warn(`[ollama-ocr] ${streak} consecutive timeouts on ${cfg.baseUrl} — local OCR parked for ${Math.round(cfg.timeoutCooldownMs / 60000)} min; cloud vision OCR stays in charge`);
    }
  }

  function resetCache() {
    availability.clear();
    pullFailures.clear();
    timeoutStreaks.clear();
  }

  /** Resolves when the in-flight pull (if any) settles. Tests + graceful shutdown. */
  async function waitForPull() {
    const cfg = config();
    const inflight = pulls.get(cacheKey(cfg));
    return inflight ? inflight.promise : null;
  }

  function describe() {
    const cfg = config();
    const cached = availability.get(cacheKey(cfg));
    return {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      task: cfg.task,
      available: cached ? cached.available : null,
      reason: cached ? cached.reason : null,
      checkedAt: cached ? cached.checkedAt : null,
      autoPull: cfg.autoPull,
      pulling: pulls.has(cacheKey(cfg)),
      lastPullFailure: pullFailures.get(cacheKey(cfg)) || null,
      stream: cfg.stream,
      queue: gate.stats(),
      timeoutStreak: timeoutStreaks.get(cacheKey(cfg)) || 0,
    };
  }

  return { config, isEnabled, ensureAvailable, recognize, resetCache, describe, startPull, waitForPull };
}

const defaultClient = createOllamaOcrClient();

module.exports = {
  ...defaultClient,
  createOllamaOcrClient,
  getOllamaOcrConfig,
  isModelListed,
  cleanModelOutput,
  normalizeBaseUrl,
  classifyHttpFailure,
  prepareImage,
  planGlmScale,
  readChatBody,
  TASK_PROMPTS,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
