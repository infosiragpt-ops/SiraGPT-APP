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
 */

const fs = require('fs').promises;

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

const TASK_PROMPTS = Object.freeze({
  text: 'Text Recognition:',
  table: 'Table Recognition:',
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
  };
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
    clear() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    },
  };
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
 * Downscale + PNG-encode so a 12 MP phone photo does not travel as a 6 MB
 * JPEG base64 to a 0.9B model that works at ~2k px anyway. Best-effort: an
 * undecodable buffer goes through untouched and Ollama reports it.
 */
async function prepareImage(buffer, { maxSide, sharpImpl } = {}) {
  const sharp = sharpImpl || require('sharp');
  try {
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
  const getFetch = () => fetchImpl || globalThis.fetch;

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

  function remember(cfg, state) {
    availability.set(cacheKey(cfg), { ...state, checkedAt: now() });
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
    if (!force && cached && now() - cached.checkedAt < cfg.probeTtlMs) {
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
   * One OCR read. `{ ok:true, text, provider, model, durationMs }` or
   * `{ ok:false, reason, status? }`. Never throws.
   */
  async function recognize({ buffer, filePath, task, signal } = {}) {
    const cfg = config();
    const started = now();
    if (!cfg.enabled) return { ok: false, reason: 'ollama_ocr_disabled' };
    if (!cfg.baseUrl) return { ok: false, reason: 'ollama_ocr_no_base_url' };
    const fetchFn = getFetch();
    if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch_unavailable' };

    let imageBuffer = buffer;
    try {
      if (!imageBuffer && filePath) imageBuffer = await fs.readFile(filePath);
    } catch (error) {
      return { ok: false, reason: `read_failed:${String((error && error.code) || 'EIO')}` };
    }
    if (!imageBuffer || !imageBuffer.length) return { ok: false, reason: 'empty_image' };

    const prepared = await prepareImage(imageBuffer, { maxSide: cfg.maxSide, sharpImpl });
    const prompt = TASK_PROMPTS[task] || TASK_PROMPTS[cfg.task] || TASK_PROMPTS.text;
    const body = {
      model: cfg.model,
      messages: [{ role: 'user', content: prompt, images: [prepared.toString('base64')] }],
      stream: false,
      keep_alive: cfg.keepAlive,
      options: { temperature: 0, num_predict: cfg.numPredict },
    };

    const t = timeoutSignal(cfg.timeoutMs, signal);
    try {
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
      const json = await response.json().catch(() => null);
      const content = json && json.message && typeof json.message.content === 'string' ? json.message.content : '';
      const text = cleanModelOutput(content);
      if (!text) return { ok: false, reason: 'empty_output' };
      return {
        ok: true,
        text,
        model: cfg.model,
        provider: `ollama:${cfg.model}`,
        durationMs: Math.max(0, now() - started),
        evalCount: json && Number.isFinite(json.eval_count) ? json.eval_count : null,
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, reason: signal && signal.aborted ? 'aborted' : 'timeout' };
      }
      // A connection refused mid-session means Ollama went away: memoise so
      // the next pages do not each wait for the TCP failure.
      remember(cfg, { available: false, reason: 'ollama_unreachable' });
      return { ok: false, reason: 'ollama_unreachable', detail: String((error && error.message) || error).slice(0, 160) };
    } finally {
      t.clear();
    }
  }

  function resetCache() {
    availability.clear();
    pullFailures.clear();
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
  TASK_PROMPTS,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
