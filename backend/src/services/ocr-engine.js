const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs').promises;
const OpenAI = require('openai');
const imageAnalyzer = require('./image-analyzer');
const ollamaOcr = require('./ollama-ocr');
const ocrInput = require('./ocr-input');
const ocrQuality = require('./ocr-quality');
const ocrEnsemble = require('./ocr-ensemble');

const OCR_PLACEHOLDER_RE = /^(no text found in image|no text detected(?: in image pdf)?|no content available|binary file|file content could not be extracted|file ".*?" uploaded successfully|error processing file:|unsupported file type)/i;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function positiveIntFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedIntFromEnv(name, fallback, min, max) {
  const value = positiveIntFromEnv(name, fallback);
  return Math.max(min, Math.min(value, max));
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Letters and numbers of ANY script (Cyrillic, CJK ×2, Arabic, Greek…): the
// old Latin-only class scored a perfect non-Latin read as 0 useful chars.
function usefulCharCount(text) {
  return ocrQuality.usefulCharCount(text);
}

// Local (Tesseract) wall-clock budget for ONE image, both passes included.
// Default 20 s: comfortably above a clean screenshot (1-3 s) and far below
// the six-minute photo reads seen in production. Tunable per deployment.
// Share of the local image budget kept for the orientation alternate (two
// variants on the other orientation) when there is one.
const ALTERNATE_RESERVE_SHARE = 0.3;

function localImageBudgetMs(options = {}) {
  const fromOpts = Number(options.localBudgetMs);
  if (Number.isFinite(fromOpts) && fromOpts > 0) return fromOpts;
  const fromEnv = Number(process.env.SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 20_000;
}

// Tesseract core narrates every rejected blob ("Image too small to scale!!",
// "Line cannot be recognized!!") through the worker's error channel; without
// a handler tesseract.js throws them on the message bus and the process log
// fills with hundreds of WARN lines per photo. Count them, never print them.
const TESSERACT_NOISE_RE = /Image too small to scale|Line cannot be recognized|Empty page|Estimating resolution/i;

// Language data. tesseract.js without `langPath` downloads every language
// from cdn.jsdelivr.net on EVERY worker and caches it in the cwd, which is
// root-owned (/app) in the runner image — so the "local" rung depended on a
// CDN. The image already ships tessdata (apk tesseract-ocr-data-*): use it
// when every requested language is there; otherwise keep the download but
// cache it in a writable directory. A local load that fails once switches
// this process back to the download path for good (one WARN line).
const workerState = { localBroken: false, unavailableUntil: 0, warnedCdn: new Set() };

function resetWorkerState() {
  workerState.localBroken = false;
  workerState.unavailableUntil = 0;
  workerState.warnedCdn.clear();
}

function tessdataOptions(language, { forceCdn = false, inputModule = ocrInput } = {}) {
  if (!language) return {};
  if (!forceCdn && !workerState.localBroken) {
    const local = inputModule.resolveLocalTessdata(language);
    if (local) return { langPath: local.dir, gzip: false, cacheMethod: 'none' };
  }
  const cachePath = inputModule.tessdataCacheDir();
  if (!workerState.warnedCdn.has(language)) {
    workerState.warnedCdn.add(language);
    console.warn(`[ocr-engine] no local tessdata for ${String(language).slice(0, 40)}; tesseract.js downloads it (cache: ${cachePath || 'none'})`);
  }
  return cachePath ? { cachePath } : {};
}

/**
 * Worker options: the noise filter, plus the tessdata options when a
 * language is given. `onInitError(message)` lets the worker factory turn an
 * init failure into an immediate rejection (tesseract.js otherwise leaves
 * createWorker pending forever when loadLanguage/initialize fails).
 */
function tesseractWorkerOptions(language, { onInitError, forceCdn = false, inputModule = ocrInput } = {}) {
  return {
    errorHandler: (err) => {
      const msg = String((err && err.message) || err || '');
      if (TESSERACT_NOISE_RE.test(msg)) return;
      if (typeof onInitError === 'function' && onInitError(msg)) return;
      console.warn('[ocr-engine] tesseract worker:', msg.slice(0, 200));
    },
    ...tessdataOptions(language, { forceCdn, inputModule }),
  };
}

class OcrWorkerInitError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OcrWorkerInitError';
    this.code = code;
  }
}

function workerInitTimeoutMs() {
  const value = Number(process.env.SIRAGPT_OCR_WORKER_INIT_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1000 ? value : 60_000;
}

function workerRetryCooldownMs() {
  const value = Number(process.env.SIRAGPT_OCR_WORKER_RETRY_MS);
  return Number.isFinite(value) && value >= 0 ? value : 5 * 60_000;
}

async function terminateWorker(worker) {
  if (!worker || typeof worker.terminate !== 'function') return;
  try { await worker.terminate(); } catch { /* already gone */ }
}

/**
 * Start ONE tesseract.js worker, bounded: an init error reported through
 * the error handler rejects at once, and a silent hang rejects after
 * SIRAGPT_OCR_WORKER_INIT_TIMEOUT_MS. A worker that still comes up late is
 * terminated, never leaked into a caller.
 */
async function startTesseractWorker(createWorkerImpl, language, { forceCdn = false, inputModule = ocrInput } = {}) {
  let ready = false;
  let rejectInit = null;
  const initFailed = new Promise((_, reject) => { rejectInit = reject; });
  initFailed.catch(() => {});
  const options = tesseractWorkerOptions(language, {
    forceCdn,
    inputModule,
    onInitError: (message) => {
      if (ready) return false;
      rejectInit(new OcrWorkerInitError('tesseract_init_failed', `tesseract init failed: ${String(message).slice(0, 120)}`));
      return true;
    },
  });
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OcrWorkerInitError('tesseract_init_timeout')), workerInitTimeoutMs());
  });
  timeout.catch(() => {});
  const creating = Promise.resolve().then(() => createWorkerImpl(language, undefined, options));
  try {
    const worker = await Promise.race([creating, initFailed, timeout]);
    ready = true;
    return { worker, local: Boolean(options.langPath) };
  } catch (err) {
    creating.then((late) => terminateWorker(late)).catch(() => {});
    if (err instanceof OcrWorkerInitError) throw err;
    throw new OcrWorkerInitError('tesseract_init_failed', err && err.message ? String(err.message).slice(0, 160) : undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Race one recognize() against the absolute deadline and the caller's
// AbortSignal. On timeout or abort the worker is terminated (the only way to
// stop the WASM job; `terminated: true`) and the caller must not reuse it;
// the pending promise is left to settle on its own.
async function recognizeWithin(worker, image, deadlineAt, signal) {
  if (signal && signal.aborted) return { result: null, timedOut: false, aborted: true, terminated: false };
  if (!deadlineAt && !signal) return { result: await worker.recognize(image), timedOut: false };
  const remaining = deadlineAt ? deadlineAt - Date.now() : Infinity;
  if (remaining <= 0) return { result: null, timedOut: true, terminated: false };
  let timer = null;
  let onAbort = null;
  const job = Promise.resolve()
    .then(() => worker.recognize(image))
    .then((result) => ({ result, timedOut: false }));
  const races = [job];
  if (deadlineAt) {
    races.push(new Promise((resolve) => {
      // Not unref'd on purpose: the deadline must fire even if the hung WASM
      // job is the only thing left on the loop.
      timer = setTimeout(() => resolve({ result: null, timedOut: true }), remaining);
    }));
  }
  if (signal) {
    races.push(new Promise((resolve) => {
      onAbort = () => resolve({ result: null, timedOut: false, aborted: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }
  try {
    const outcome = await Promise.race(races);
    if (outcome.timedOut || outcome.aborted) {
      // The WASM job cannot be interrupted: terminating the worker is the
      // only way to stop it. The caller needs a new worker afterwards.
      job.catch(() => {});
      await terminateWorker(worker);
      return { ...outcome, terminated: true };
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}


// ── Vision ladder helpers ────────────────────────────────────────────────

// Anti-hallucination contract for every cloud OCR read: transcribe only what
// is legible, mark the rest instead of guessing, keep the original language.
const OCR_VISION_SYSTEM_PROMPT = [
  'You are a professional OCR / document-transcription engine.',
  'Your FIRST output line must be exactly "TIPO: <clase>" where <clase> is one of: captura de pantalla | documento escaneado | texto denso | fotografía | manuscrito | gráfico o diagrama | ticket o recibo | otro.',
  'From the SECOND line on, transcribe ALL the legible text of the image VERBATIM, in natural reading order (top to bottom; in multi-column layouts finish the left column before the right). Preserve the structure with Markdown: headings as #/##, bullet/numbered lists, tables as Markdown tables. Do NOT summarize, shorten or omit legible text.',
  'Keep the original language and spelling exactly (accents á é í ó ú ñ ü, ¿ ¡); never translate, correct, modernize or complete the text.',
  'HONESTY RULES (mandatory):',
  '- Transcribe only what you can actually read in the pixels. Never infer, guess, autocomplete or "fix" words, names, numbers or dates from context.',
  '- A word or passage you cannot read: write [ilegible] in its place (one marker per unreadable stretch).',
  '- A word you can partly read but are not sure of: write it as [¿palabra?].',
  '- Numbers, amounts, dates, codes, IDs and proper names are copied character by character; if any character is unreadable, mark that part [ilegible] instead of guessing it.',
  '- Do not describe pictures, logos or stamps unless they contain text. No preamble, no commentary, no notes.',
  'If there is no legible text at all, output the TIPO line and then exactly: OCR_EMPTY',
].join('\n');

const TRUNCATED_MARK = '[transcripción incompleta: el texto continúa pero no se pudo leer completo en esta pasada]';

// The «no legible text» sentinel, as models really write it: «OCR_EMPTY»,
// «**OCR_EMPTY**», «OCR_EMPTY.», «OCR_EMPTY (sin texto)», «`OCR_EMPTY`».
const OCR_EMPTY_RE = /^[\s*_`>#.:\-]*OCR_EMPTY[\s*_`.!:\-]*(?:\([^)\n]{0,40}\))?[\s*_`.!:\-]*$/i;

function isOcrEmptySentinel(text) {
  return OCR_EMPTY_RE.test(String(text || '').trim());
}

/**
 * The model's «TIPO: …» verdict, taken ONLY from the first line (the old
 * multiline regex deleted a document's own «TIPO: DNI» line when the model
 * left its header out).
 */
function splitVisionTypeLine(text) {
  const source = String(text || '');
  const nl = source.indexOf('\n');
  const first = (nl >= 0 ? source.slice(0, nl) : source).trim();
  const match = /^\**TIPO:\**\s*(.+?)\**$/i.exec(first);
  if (!match) return { text: source.trim(), visionType: null };
  return { text: (nl >= 0 ? source.slice(nl + 1) : '').trim(), visionType: match[1].trim().slice(0, 60) };
}

/**
 * The Tesseract text when it is good enough to vote (≥ 20 useful chars, not
 * garbage, page confidence ≥ 40), else null.
 */
function comparableLocalText(localQuality) {
  if (!localQuality || typeof localQuality.text !== 'string') return null;
  const text = localQuality.text.trim();
  if (!text || localQuality.placeholder) return null;
  const useful = Number.isFinite(Number(localQuality.usefulChars)) ? Number(localQuality.usefulChars) : usefulCharCount(text);
  if (useful < 20) return null;
  if (localQuality.garbageLikely) return null;
  if (Number(localQuality.confidence || 0) < 40) return null;
  return text;
}

/**
 * Share of `reference`'s words (multiset) found in `candidate`: 1 when the
 * candidate contains everything the reference read. Null without words.
 */
function tokenCoverage(reference, candidate) {
  const tokens = (text) => ocrQuality.normalizeForComparison(ocrQuality.stripIllegibleMarkers(text))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const ref = tokens(reference);
  if (!ref.length) return null;
  const counts = new Map();
  for (const token of tokens(candidate)) counts.set(token, (counts.get(token) || 0) + 1);
  let hit = 0;
  for (const token of ref) {
    const left = counts.get(token) || 0;
    if (left > 0) { hit += 1; counts.set(token, left - 1); }
  }
  return hit / ref.length;
}

function envFlagOn(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

class OcrEngine {
  constructor() {
    // Configurable default language via env. Falls back to spa+eng.
    this.defaultLanguage = process.env.OCR_DEFAULT_LANGUAGE || 'spa+eng';
    // GLM-OCR on the Lenovo's Ollama: first vision rung, before the paid
    // cloud model. Injectable so tests never touch the network.
    this.ollamaOcr = ollamaOcr;
    // Input normalisation (HEIC/BMP/TIFF pages, EXIF, OSD) and the
    // tesseract.js factory; both injectable for offline tests.
    this.ocrInput = ocrInput;
    this.createWorkerImpl = createWorker;
    // (candidate, clientConfig, { timeoutMs }) → OpenAI-compatible client
    // for one cloud vision runtime. Null = real SDK clients; tests inject.
    this.createVisionRuntimeClient = null;
  }

  /**
   * The ONLY way the engine creates a Tesseract worker: local tessdata when
   * present, bounded init, one fallback to the download path when the local
   * data cannot be loaded, and a cooldown after a total failure so a dead
   * CDN does not stall every image (the vision rungs take over instead).
   */
  async createOcrWorker(language) {
    const lang = language || this.defaultLanguage;
    if (workerState.unavailableUntil > Date.now()) {
      throw new OcrWorkerInitError('tesseract_unavailable');
    }
    const usesLocal = !workerState.localBroken && Boolean(this.ocrInput.resolveLocalTessdata(lang));
    try {
      const { worker } = await startTesseractWorker(this.createWorkerImpl, lang, { inputModule: this.ocrInput });
      return worker;
    } catch (firstError) {
      let error = firstError;
      if (usesLocal && error.code === 'tesseract_init_failed') {
        workerState.localBroken = true;
        console.warn('[ocr-engine] local tessdata could not be loaded; switching this process to the tesseract.js download');
      }
      if (error.code === 'tesseract_init_failed') {
        // One retry: either the download path after a broken local load, or
        // a cache file another worker was still writing.
        try {
          const { worker } = await startTesseractWorker(this.createWorkerImpl, lang, { forceCdn: true, inputModule: this.ocrInput });
          return worker;
        } catch (retryError) {
          error = retryError;
        }
      }
      const cooldown = workerRetryCooldownMs();
      workerState.unavailableUntil = Date.now() + cooldown;
      console.warn(`[ocr-engine] tesseract unavailable (${error.code || 'init_failed'}); local OCR skipped for ${Math.round(cooldown / 1000)} s, vision rungs only`);
      throw error;
    }
  }

  /**
   * Normalise any image input (path or Buffer) into upright PNG/JPEG pages.
   * Never throws; `{ ok:false }` means "use the raw input as before".
   */
  async normalizeImage(input, options = {}) {
    try {
      return await this.ocrInput.normalizeImageInput(input, {
        mime: options.mimeType,
        name: options.fileName || options.originalName || options.name,
        signal: options.signal,
        osd: options.osd,
      });
    } catch {
      return { ok: false, error: 'normalize_failed', pages: [], warnings: [] };
    }
  }

  get config() {
    return {
      mode: String(process.env.OCR_MODE || 'hybrid').toLowerCase(),
      // Raised from 70 → 85: a Tesseract read at 70-85% confidence is the
      // "mediocre but confident" zone that used to be accepted verbatim (a
      // garbled phone-photo read became the stored transcription and the vision
      // model never saw the image). 85 lets those fall through to the stronger
      // vision OCR. Tunable down via OCR_MIN_CONFIDENCE if cost matters.
      minConfidence: numberFromEnv('OCR_MIN_CONFIDENCE', 85),
      minUsefulChars: numberFromEnv('OCR_MIN_USEFUL_CHARS', 20),
      // Default to gpt-4o (far better OCR on dense/printed/photographed docs
      // than gpt-4o-mini). Override with OCR_VISION_MODEL / VISION_MODEL.
      visionModel: process.env.OCR_VISION_MODEL || process.env.VISION_MODEL || 'gpt-4o',
      visionPdfMaxPages: numberFromEnv('OCR_VISION_PDF_MAX_PAGES', 20),
      visionPdfStrategy: process.env.OCR_VISION_PDF_STRATEGY || 'first', // first | first-last-middle | first
      pdfMaxPages: numberFromEnv('OCR_PDF_MAX_PAGES', 0),
      pdfMaxChars: positiveIntFromEnv('OCR_PDF_MAX_CHARS', 6_000_000),
      pdfScale: numberFromEnv('OCR_PDF_RENDER_SCALE', 2.4),
      pdfMaxSide: positiveIntFromEnv('OCR_PDF_MAX_SIDE', 2600),
      pdfMaxVariants: boundedIntFromEnv('OCR_PDF_MAX_VARIANTS', 4, 1, 5),
      pdfDeepVariantPages: boundedIntFromEnv('OCR_PDF_DEEP_VARIANT_PAGES', 60, 1, 1000),
      pdfPageMetaLimit: boundedIntFromEnv('OCR_PDF_PAGE_META_LIMIT', 200, 1, 2000),
      // Cloud vision ladder (vision-runtime order, keys only).
      visionLadderMax: boundedIntFromEnv('OCR_VISION_LADDER_MAX', 3, 1, 6),
      visionLadderBudgetMs: boundedIntFromEnv('OCR_VISION_LADDER_BUDGET_MS', 150_000, 5_000, 15 * 60_000),
      visionTimeoutMs: boundedIntFromEnv('OCR_VISION_TIMEOUT_MS', 25_000, 1_000, 10 * 60_000),
      visionMaxTokens: boundedIntFromEnv('OCR_VISION_MAX_TOKENS', 8192, 256, 65_536),
      visionTileEnabled: envFlagOn('OCR_VISION_TILING', true),
      visionTileMinSide: boundedIntFromEnv('OCR_VISION_TILE_MIN_SIDE', 2400, 800, 20_000),
      visionTileMax: boundedIntFromEnv('OCR_VISION_TILE_MAX', 4, 2, 8),
      // Ensemble (paid calls, opt-in): OCR_ENSEMBLE_VERIFY_GLM=1 sends a
      // trusted GLM read Tesseract cannot confirm to the cloud for a second
      // opinion (+1 paid call per such image); OCR_ENSEMBLE_MAX_CLOUD_CALLS=2
      // lets a GLM/cloud disagreement call a second cloud runtime (+1 more).
      // Defaults keep today's cost: GLM is the free final rung when its read
      // passes the gate, and one cloud read when it does not.
      ensembleVerifyGlm: envFlagOn('OCR_ENSEMBLE_VERIFY_GLM', false),
      ensembleMaxCloudCalls: boundedIntFromEnv('OCR_ENSEMBLE_MAX_CLOUD_CALLS', 1, 1, 4),
      ensembleVerifyMinChars: boundedIntFromEnv('OCR_ENSEMBLE_VERIFY_MIN_CHARS', 40, 1, 100_000),
      // Scanned PDFs: per-page Tesseract budget, whole-document budget (under
      // the 15-min async extraction budget so finished pages are never lost)
      // and a cap on pages that may use the vision ladder.
      pdfPageBudgetMs: boundedIntFromEnv('SIRAGPT_OCR_PDF_PAGE_BUDGET_MS', 15_000, 1_000, 10 * 60_000),
      pdfBudgetMs: boundedIntFromEnv('SIRAGPT_OCR_PDF_BUDGET_MS', 12 * 60_000, 10_000, 12 * 60 * 60_000),
      // Vision on scanned-PDF pages: local GLM-OCR (free) is on by default;
      // SIRAGPT_OCR_PDF_VISION=0 keeps PDFs Tesseract-only, as before. The
      // CLOUD rung on full scanned PDFs is paid and opt-in
      // (SIRAGPT_OCR_PDF_VISION_CLOUD=1: up to one cloud read per weak page,
      // more for large dense pages read by bands, capped by
      // SIRAGPT_OCR_PDF_VISION_MAX_PAGES). Mixed PDFs keep the image cloud
      // rung they always had.
      pdfVisionEnabled: envFlagOn('SIRAGPT_OCR_PDF_VISION', true),
      pdfVisionCloudEnabled: envFlagOn('SIRAGPT_OCR_PDF_VISION_CLOUD', false),
      // A page with less ink than this share of its pixels (margins cropped)
      // is blank (duplex backs): no vision call, no vision page used.
      pdfBlankInkRatio: Math.min(0.02, Math.max(0, numberFromEnv('SIRAGPT_OCR_BLANK_INK_RATIO', 0.001))),
      pdfVisionMaxPages: boundedIntFromEnv('SIRAGPT_OCR_PDF_VISION_MAX_PAGES', 40, 1, 2000),
      pdfVisionPageBudgetMs: boundedIntFromEnv('SIRAGPT_OCR_PDF_VISION_PAGE_BUDGET_MS', 120_000, 5_000, 15 * 60_000),
    };
  }

  skipped(reason = 'not_ocr_applicable') {
    return {
      text: '',
      ocr: {
        status: 'skipped',
        confidence: null,
        provider: null,
        reason,
      },
    };
  }

  hasUsefulText(value, config = this.config) {
    const text = normalizeOcrText(value);
    if (!text || OCR_PLACEHOLDER_RE.test(text)) return false;
    return usefulCharCount(text) >= Math.min(3, config.minUsefulChars);
  }

  evaluateQuality({ text, confidence = 0 } = {}, config = this.config) {
    const normalized = normalizeOcrText(text);
    const lineCount = normalized
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean).length;
    const usefulChars = usefulCharCount(normalized);
    const numericConfidence = Number(confidence || 0);
    const placeholder = !normalized || OCR_PLACEHOLDER_RE.test(normalized);
    const enoughText = usefulChars >= config.minUsefulChars;
    const confident = numericConfidence >= config.minConfidence;
    // Math counts as legible on its own («√2», «x²=4»).
    const mathSymbols = usefulChars < 3 ? ocrQuality.mathSymbolCount(normalized) : 0;
    const legibleShort = !placeholder && confident
      && ocrQuality.isLegibleShort({ usefulChars, mathSymbols }, Math.min(3, config.minUsefulChars));
    // Plausibility signals for variant selection and for the ladder (never
    // part of `accepted`): sampled so multi-megabyte PDF text stays cheap.
    const assessment = placeholder ? null : ocrQuality.assessText(normalized.slice(0, 50_000));

    return {
      text: normalized,
      confidence: numericConfidence,
      usefulChars,
      lineCount,
      placeholder,
      enoughText,
      confident,
      legibleShort,
      accepted: !placeholder && enoughText && confident,
      usefulButWeak: !placeholder && enoughText && !confident,
      reason: placeholder ? 'empty_or_placeholder' : !enoughText ? 'too_little_text' : !confident ? 'low_confidence' : 'ok',
      wordRatio: assessment ? assessment.wordRatio : null,
      garbageLikely: assessment ? assessment.garbageLikely : false,
      garbageReasons: assessment ? assessment.reasons : [],
    };
  }

  /**
   * Is a VISION read usable text? Same useful-character gate as a local
   * read, but a short read («√2», «Total: 45», a stamp) never needs the
   * Tesseract page-confidence threshold: a vision read's confidence is
   * calibrated from agreement, not a glyph score.
   */
  isUsableVisionQuality(quality, config = this.config) {
    if (!quality || quality.placeholder || !quality.text) return false;
    if (quality.enoughText) return true;
    const mathSymbols = quality.usefulChars < 3 ? ocrQuality.mathSymbolCount(quality.text) : 0;
    return ocrQuality.isLegibleShort({ usefulChars: quality.usefulChars, mathSymbols }, Math.min(3, config.minUsefulChars));
  }

  shouldUseVisionFallback(quality, options = {}) {
    const mode = String(options.mode || this.config.mode || 'hybrid').toLowerCase();
    if (mode === 'off' || mode === 'local') return false;
    if (mode === 'vision') return true;
    // A «confident» Tesseract read made of implausible words (stylised
    // fonts, a photo of a screen) is not accepted either.
    return !quality?.accepted || Boolean(quality?.garbageLikely);
  }

  async extractFromImage(input, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return this.skipped('ocr_disabled');
    if (options.signal && options.signal.aborted) return this.abortedResult();

    // Every image is normalised first: HEIC/HEIF and BMP decoded, EXIF and
    // OSD orientation applied, every TIFF page split out. When that fails
    // (unknown format, tool missing) the raw input goes down the ladder
    // exactly as before — unless it failed because the caller cancelled.
    const normalized = options.normalize === false ? null : await this.normalizeImage(input, options);
    if ((options.signal && options.signal.aborted) || (normalized && normalized.error === 'aborted')) {
      return this.abortedResult();
    }
    if (normalized && normalized.ok && (
      normalized.pages.length > 1
      || normalized.truncatedPages > 0
      || (normalized.unreadablePages || []).length > 0
    )) {
      return this._extractFromPages(normalized, options);
    }
    const page = normalized && normalized.ok ? normalized.pages[0] : null;
    const orientation = {};
    const result = await this._extractFromSingleImage(page ? page.buffer : input, {
      ...options,
      mimeType: page ? page.mime : options.mimeType,
      page,
      orientationOut: orientation,
    });
    return this._withInputMeta(result, normalized, orientation);
  }

  /** Typed failure for a cancelled read (no ladder, no vision call). */
  abortedResult(extra = {}) {
    return this.asFailedResult(null, 'aborted', extra);
  }

  /**
   * The other orientation hypothesis of a normalised page, or null:
   *  - after a CONFIDENT OSD rotation, the page as it was before it;
   *  - after a low-confidence OSD verdict (`orientationHint`), the upright
   *    page turned by the hinted angle — built lazily, only if the upright
   *    read turns out weak.
   * `rotation` is the total clockwise rotation of that hypothesis.
   */
  _orientationAlternate(page) {
    if (!page || !Buffer.isBuffer(page.buffer)) return null;
    const base = Number(page.rotation) || 0;
    if (page.preRotation && Buffer.isBuffer(page.preRotation.buffer)) {
      const osdTurn = Number(page.osd && page.osd.rotate) || 0;
      return {
        kind: 'pre_rotation',
        buffer: page.preRotation.buffer,
        mime: page.preRotation.mime || page.mime,
        rotation: (((base - osdTurn) % 360) + 360) % 360,
      };
    }
    const hint = page.orientationHint;
    const turn = Number(hint && hint.rotate) || 0;
    if (![90, 180, 270].includes(turn)) return null;
    const jpeg = page.mime === 'image/jpeg';
    let built = null;
    return {
      kind: 'osd_hint',
      make: async () => {
        if (!built) {
          built = await sharp(page.buffer)
            .rotate(turn, { background: '#ffffff' })
            .toFormat(jpeg ? 'jpeg' : 'png', jpeg ? { quality: 92, chromaSubsampling: '4:4:4' } : {})
            .toBuffer();
        }
        return built;
      },
      mime: jpeg ? 'image/jpeg' : 'image/png',
      rotation: (base + turn) % 360,
    };
  }

  /**
   * The single-image ladder (Tesseract variants → tiles → GLM-OCR → cloud).
   * `options.page` is the normalised page when there is one: its buffer
   * feeds every rung and its other orientation (see _orientationAlternate)
   * is tried when the first read is weak; every later rung — tiles and the
   * vision models — gets the orientation that actually read better.
   * `options.orientationOut` (object) receives { rotation, alternate }.
   */
  async _extractFromSingleImage(input, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    const page = options.page || null;
    const mimeType = options.mimeType || 'image/png';
    const signal = options.signal || null;
    const orientationOut = options.orientationOut && typeof options.orientationOut === 'object' ? options.orientationOut : null;
    if (orientationOut && page) {
      orientationOut.rotation = Number(page.rotation) || 0;
      orientationOut.alternate = null;
    }
    if (signal && signal.aborted) return this.abortedResult();

    // Accepts a file path OR an in-memory Buffer (embedded Office images
    // never touch disk). sharp + tesseract already handle both; only the
    // vision fallback needs to know which one it got.
    let source = input;
    let sourceMime = page ? page.mime : mimeType;
    let stats = options.analyze === false ? null : await imageAnalyzer.computeImageStats(source);

    // Vision rungs get a provider-safe copy (PNG/JPEG, ≤3072 px, ≤8 MB) of
    // a normalised page; a raw path keeps today's behaviour.
    const visionInput = async (buffer, mime) => {
      if (!page) return Buffer.isBuffer(input) ? { buffer: input, mimeType } : { filePath: input, mimeType };
      if (typeof this.ocrInput.toVisionImage !== 'function') return { buffer, mimeType: mime || mimeType };
      const prepared = await this.ocrInput.toVisionImage(buffer, { mime });
      return { buffer: prepared.buffer || buffer, mimeType: prepared.mime || mime || mimeType };
    };

    if (mode === 'vision') {
      const ref = await visionInput(page ? page.buffer : input, sourceMime);
      const visionOnly = await this.runVisionFallback({
        ...ref,
        config,
        signal,
        sourceBuffer: page && Buffer.isBuffer(page.buffer) ? page.buffer : (Buffer.isBuffer(input) ? input : null),
        imageType: stats ? imageAnalyzer.classifyImage(stats, {}).type : null,
      });
      return this._withImageMeta(visionOnly, stats, { tiled: 0 });
    }

    const alternate = this._orientationAlternate(page);
    let localResult;
    try {
      localResult = await this.runLocalImageOcr(source, {
        ...options,
        alternateInput: alternate && alternate.buffer ? alternate.buffer : undefined,
        alternateFactory: alternate && alternate.make ? alternate.make : undefined,
      });
    } catch (error) {
      localResult = {
        quality: this.evaluateQuality({ text: '', confidence: 0 }, config),
        error: error?.code === 'tesseract_unavailable' || error?.code === 'tesseract_init_timeout' || error?.code === 'tesseract_init_failed'
          ? error.code
          : error?.message || 'local_ocr_failed',
      };
    }
    if (localResult.usedAlternate && alternate) {
      // The other orientation read better: every later rung uses it.
      source = Buffer.isBuffer(localResult.alternateSource) ? localResult.alternateSource : (alternate.buffer || source);
      sourceMime = alternate.mime || sourceMime;
      if (orientationOut) {
        orientationOut.rotation = alternate.rotation;
        orientationOut.alternate = alternate.kind;
      }
      if (stats) stats = await imageAnalyzer.computeImageStats(source);
    }
    if (localResult.aborted || (signal && signal.aborted)) return this.abortedResult();

    // Tiled second pass for oversized dense-text images (huge screenshots,
    // rendered text walls): the single pass downscales to ~3000px and tiny
    // glyphs dissolve. Tiles keep native resolution; the better read wins.
    let tiledUsed = 0;
    if (!localResult.timedOut && imageAnalyzer.shouldTileOcr(stats, localResult.quality)) {
      try {
        const tiled = await this.runTiledImageOcr(source, stats, options);
        if (tiled && this.scoreQuality(tiled.quality) > this.scoreQuality(localResult.quality)) {
          localResult = { ...tiled, blur: localResult.blur };
          tiledUsed = tiled.tiles;
        }
      } catch (tileErr) {
        console.warn('[ocr-engine] tiled OCR pass failed (keeping single pass):', tileErr?.message || tileErr);
      }
    }

    const withMeta = (result) => this._withBlurMeta(this._withImageMeta(result, stats, { tiled: tiledUsed }), localResult.blur);

    if (localResult.quality.accepted && !localResult.quality.garbageLikely) {
      return withMeta(this.asLocalResult(localResult));
    }

    if (signal && signal.aborted) return this.abortedResult();
    let lastVision = null;
    if (this.shouldUseVisionFallback(localResult.quality, { mode }) && options.allowVision !== false) {
      const ref = await visionInput(Buffer.isBuffer(source) ? source : input, sourceMime);
      const visionResult = await this.runVisionFallback({
        ...ref,
        config,
        localQuality: localResult.quality,
        signal,
        // Native upright resolution for band reads of large dense pages
        // (`ref.buffer` is the ≤3072-px provider copy).
        sourceBuffer: Buffer.isBuffer(source) ? source : null,
        imageType: stats ? imageAnalyzer.classifyImage(stats, localResult.quality).type : null,
      });

      if (visionResult && visionResult.ocr && visionResult.ocr.status === 'vision_fallback') {
        return withMeta(visionResult);
      }
      if (visionResult && visionResult.ocr && visionResult.ocr.reason === 'aborted') return this.abortedResult();
      lastVision = visionResult;
    }

    if (localResult.quality.enoughText || localResult.quality.legibleShort) {
      const result = this.asLocalResult(localResult);
      result.ocr.warning = 'vision_fallback_unavailable_or_weaker';
      // The local read is all there is: never present it as more certain
      // than it is (the header and the chat label read confidenceLevel).
      if (result.ocr.confidenceLevel === 'alta') result.ocr.confidenceLevel = 'media';
      if (lastVision && lastVision.ocr) {
        result.ocr.visionLadder = lastVision.ocr.visionLadder || { attempted: true, attempts: [] };
        if (lastVision.ocr.ollamaOcr) result.ocr.ollamaOcr = lastVision.ocr.ollamaOcr;
        result.ocr.visionReason = lastVision.ocr.reason || null;
      }
      return withMeta(result);
    }

    const failure = localResult.error || (localResult.timedOut ? 'local_ocr_timeout' : undefined);
    const failedResult = this.asFailedResult(localResult.quality, failure);
    if (lastVision && lastVision.ocr) {
      failedResult.ocr.visionLadder = lastVision.ocr.visionLadder || { attempted: true, attempts: [] };
      if (lastVision.ocr.ollamaOcr) failedResult.ocr.ollamaOcr = lastVision.ocr.ollamaOcr;
      failedResult.ocr.visionReason = lastVision.ocr.reason || null;
    }
    return withMeta(failedResult);
  }

  /**
   * Multi-page images (every page of a fax/scanner TIFF, a HEIC with
   * several top-level images): each page runs the single-image ladder; the
   * text keeps `[page N]` blocks like PDFs, unreadable pages and pages past
   * the cap are MARKED instead of silently dropped. Bounded by
   * SIRAGPT_OCR_MULTIPAGE_BUDGET_MS and by `options.signal`.
   */
  async _extractFromPages(normalized, options = {}) {
    const budgetMs = (() => {
      const value = Number(process.env.SIRAGPT_OCR_MULTIPAGE_BUDGET_MS);
      return Number.isFinite(value) && value >= 1000 ? value : 10 * 60_000;
    })();
    const deadlineAt = Date.now() + budgetMs;
    const startedAt = Date.now();
    const blocks = [];
    const pageQuality = [];
    const providers = new Set();
    let usefulChars = 0;
    let lineCount = 0;
    let confSum = 0;
    let confN = 0;
    let pagesWithText = 0;
    let anyVision = false;
    let stoppedAt = null;
    let stopReason = null;
    let firstImageMeta = null;

    // Readable pages and pages the decoder could not open, in SOURCE page
    // order: an unreadable page 3 is marked as page 3 and page 4 stays 4.
    const entries = [
      ...normalized.pages.map((page, idx) => ({ number: Number(page.page) || idx + 1, page })),
      ...(normalized.unreadablePages || []).map((u) => ({ number: Number(u.page) || 0, unreadable: u })),
    ].filter((entry) => entry.number > 0).sort((a, b) => a.number - b.number);
    const lastListed = entries.length ? entries[entries.length - 1].number : 0;
    let firstOrientation = null;

    for (const entry of entries) {
      if (options.signal && options.signal.aborted) { stoppedAt = entry.number; stopReason = 'lectura cancelada'; break; }
      if (entry.unreadable) {
        const reason = entry.unreadable.error || 'decode_failed';
        blocks.push(`[page ${entry.number}]\n${ocrQuality.unreadablePageMarker(entry.number, reason)}`);
        pageQuality.push({
          page: entry.number, status: 'failed', provider: null, confidence: 0, usefulChars: 0, reason, rotation: 0,
        });
        continue;
      }
      if (Date.now() >= deadlineAt) { stoppedAt = entry.number; stopReason = 'tiempo agotado'; break; }
      const { page } = entry;
      const orientation = {};
      let res;
      try {
        res = await this._extractFromSingleImage(page.buffer, { ...options, mimeType: page.mime, page, orientationOut: orientation });
      } catch (error) {
        res = { text: '', ocr: { status: 'failed', reason: 'page_failed' } };
      }
      if (!firstOrientation) firstOrientation = orientation;
      const ocr = res.ocr || {};
      if (!firstImageMeta && ocr.image) firstImageMeta = ocr.image;
      if (res.text) {
        pagesWithText += 1;
        blocks.push(`[page ${entry.number}]\n${res.text}`);
        usefulChars += Number(ocr.usefulChars || 0);
        lineCount += Number(ocr.lineCount || 0);
        confSum += Number(ocr.confidence || 0);
        confN += 1;
        if (ocr.provider) providers.add(ocr.provider);
        if (ocr.status === 'vision_fallback') anyVision = true;
      } else {
        blocks.push(`[page ${entry.number}]\n${ocrQuality.unreadablePageMarker(entry.number, ocr.reason)}`);
      }
      pageQuality.push({
        page: entry.number,
        status: ocr.status || 'failed',
        provider: res.text ? ocr.provider || null : null,
        confidence: Math.round(Number(ocr.confidence || 0)),
        usefulChars: Number(ocr.usefulChars || 0),
        reason: res.text ? 'ok' : ocr.reason || 'too_little_text',
        rotation: Number.isFinite(orientation.rotation) ? orientation.rotation : page.rotation || 0,
      });
    }

    const total = Math.max(normalized.totalPages || 0, lastListed);
    if (stoppedAt) blocks.push(ocrQuality.pageCapMarker(stoppedAt, lastListed, stopReason));
    if (normalized.truncatedPages > 0) {
      blocks.push(ocrQuality.pageCapMarker(lastListed + 1, total, 'límite'));
    }
    const partial = Boolean(stoppedAt) || normalized.truncatedPages > 0;
    const input = this._inputMeta(normalized, firstOrientation);
    const meta = {
      pages: total,
      pagesRead: pageQuality.length,
      pagesWithText,
      partial,
      partialReason: stoppedAt ? (stopReason === 'tiempo agotado' ? 'budget' : 'aborted') : normalized.truncatedPages > 0 ? 'page_cap' : null,
      pageQuality: pageQuality.slice(0, 200),
      elapsedMs: Date.now() - startedAt,
      ...(input ? { input } : {}),
      ...(firstImageMeta ? { image: firstImageMeta } : {}),
    };

    if (pagesWithText === 0) {
      return {
        text: '',
        ocr: {
          status: 'failed',
          confidence: 0,
          provider: null,
          usefulChars: 0,
          lineCount: 0,
          reason: stoppedAt && stopReason === 'lectura cancelada' ? 'aborted' : 'no_page_text',
          ...meta,
        },
      };
    }
    return {
      text: normalizeOcrText(blocks.join('\n\n')),
      ocr: {
        status: anyVision ? 'vision_fallback' : 'local_ok',
        confidence: Math.round(confN ? confSum / confN : 0),
        provider: providers.size ? [...providers].join('+') : 'tesseract',
        usefulChars,
        lineCount,
        ...meta,
      },
    };
  }

  /**
   * `ocr.input` metadata. `orientation` ({ rotation, alternate }) is what
   * the ladder actually used for the (first) page: when the other
   * orientation read better, `rotation` reports it and a warning says so
   * (`osd_rotation_reverted` / `osd_hint_applied`).
   */
  _inputMeta(normalized, orientation = null) {
    if (!normalized) return null;
    if (!normalized.ok) {
      return normalized.error && normalized.error !== 'not_an_image'
        ? { format: normalized.format || null, error: normalized.error }
        : null;
    }
    const first = normalized.pages[0] || {};
    let rotation = normalized.pages.some((p) => p.rotation) ? first.rotation || 0 : 0;
    const warnings = (normalized.warnings || []).slice();
    if (orientation && Number.isFinite(orientation.rotation)) rotation = orientation.rotation;
    if (orientation && orientation.alternate) {
      warnings.push(orientation.alternate === 'osd_hint' ? 'osd_hint_applied' : 'osd_rotation_reverted');
    }
    const trivial = (normalized.format === 'jpeg' || normalized.format === 'png')
      && !rotation
      && normalized.pages.length <= 1
      && !normalized.truncatedPages
      && !(normalized.unreadablePages || []).length
      && warnings.length === 0;
    if (trivial) return null;
    return {
      format: normalized.format,
      source: first.source || null,
      rotation,
      pages: normalized.totalPages || normalized.pages.length,
      warnings: warnings.slice(0, 10),
    };
  }

  _withInputMeta(result, normalized, orientation = null) {
    if (!result || !result.ocr) return result;
    const input = this._inputMeta(normalized, orientation);
    if (input) result.ocr.input = input;
    return result;
  }

  _withBlurMeta(result, blur) {
    if (!result || !result.ocr || !blur || !blur.ok) return result;
    if (result.ocr.image) {
      result.ocr.image.blurVariance = blur.variance;
      result.ocr.image.blurry = Boolean(blur.blurry);
    }
    return result;
  }

  /**
   * Attach image classification metadata (`ocr.image`) to an extraction
   * result. The vision model's own TYPE verdict (when it ran) beats the
   * statistical guess. Never throws; returns the result untouched when
   * stats are unavailable and no vision type exists.
   */
  _withImageMeta(result, stats, { tiled = 0 } = {}) {
    if (!result || !result.ocr) return result;
    const visionType = imageAnalyzer.normalizeVisionType(result.ocr.visionType);
    if (!stats && !visionType) return result;
    const classification = imageAnalyzer.classifyImage(stats, {
      usefulChars: result.ocr.usefulChars,
      lineCount: result.ocr.lineCount,
      confidence: result.ocr.confidence,
    });
    const type = visionType || classification.type;
    result.ocr.image = {
      width: stats?.width ?? null,
      height: stats?.height ?? null,
      type,
      typeLabelEs: imageAnalyzer.TYPE_LABELS_ES[type] || imageAnalyzer.TYPE_LABELS_ES.unknown,
      typeConfidence: visionType ? 0.9 : classification.confidence,
      textDensity: classification.textDensity,
      tiledOcr: tiled > 1 ? tiled : null,
    };
    return result;
  }

  /**
   * Tiled OCR: split the image into overlapping tiles (row-major reading
   * order), OCR each at native resolution, and join. Consecutive duplicate
   * lines from tile overlap are collapsed.
   */
  async runTiledImageOcr(input, stats, options = {}) {
    const cfg = imageAnalyzer.tilingConfig();
    const tiles = imageAnalyzer.planTiles(stats.width, stats.height, cfg);
    if (tiles.length <= 1) return null;

    const worker = await this.createOcrWorker(options.language || this.defaultLanguage);
    const texts = [];
    let confSum = 0;
    let confSamples = 0;
    // Time budget for a single picture: a chat attachment must never hold the
    // turn for a minute of tesseract tiles when a vision model can read it.
    const budgetMs = Number(process.env.SIRAGPT_OCR_IMAGE_BUDGET_MS) || 12000;
    const startedAt = Date.now();
    try {
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: '1',
        }).catch(() => null);
      }
      for (const tile of tiles) {
        if (options.signal && options.signal.aborted) break;
        if (Date.now() - startedAt > budgetMs) break;
        // Tiles are cut from the normalised (upright) page; a slow tile is
        // interrupted at the budget instead of only being checked between
        // tiles.
        const buf = await sharp(input)
          .extract({ left: tile.left, top: tile.top, width: tile.width, height: tile.height })
          .greyscale()
          .normalize()
          .sharpen()
          .png()
          .toBuffer();
        const recognized = await recognizeWithin(worker, buf, startedAt + budgetMs, options.signal);
        if (recognized.timedOut || recognized.aborted) break;
        const { data: { text, confidence } } = recognized.result;
        const clean = normalizeOcrText(text);
        if (clean) {
          texts.push(clean);
          confSum += Number(confidence || 0);
          confSamples += 1;
        }
      }
    } finally {
      await terminateWorker(worker);
    }

    // Collapse consecutive duplicate lines produced by tile overlap.
    const lines = normalizeOcrText(texts.join('\n\n')).split('\n');
    const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1] || line === '');
    const joined = deduped.join('\n');

    return {
      quality: this.evaluateQuality({ text: joined, confidence: confSamples ? confSum / confSamples : 0 }),
      variants: null,
      variant: `tiled_${tiles.length}`,
      tiles: tiles.length,
    };
  }

  async extractFromPdfImages(filePath, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return this.skipped('ocr_disabled');

    if (options.streaming !== false) {
      return this.extractFromPdfImagesStreaming(filePath, options);
    }

    const pageBuffers = await this.renderPdfPages(filePath, options);
    if (pageBuffers.length === 0) {
      return {
        text: '',
        ocr: {
          status: 'failed',
          confidence: 0,
          provider: 'tesseract',
          reason: 'no_pdf_pages_rendered',
        },
      };
    }

    if (mode === 'vision') {
      return this.runVisionPdfFallback(pageBuffers, { config });
    }

    let localResult;
    try {
      localResult = await this.recognizePageBuffers(pageBuffers, { language: options.language || this.defaultLanguage });
    } catch (error) {
      localResult = {
        quality: this.evaluateQuality({ text: '', confidence: 0 }, config),
        error: error?.message || 'local_pdf_ocr_failed',
      };
    }
    if (localResult.quality.accepted) {
      return {
        text: localResult.quality.text,
        ocr: {
          status: 'local_ok',
          confidence: Math.round(localResult.quality.confidence),
          provider: 'tesseract',
          usefulChars: localResult.quality.usefulChars,
          lineCount: localResult.quality.lineCount,
          pages: pageBuffers.length,
        },
      };
    }

    if (this.shouldUseVisionFallback(localResult.quality, { mode }) && options.allowVision !== false) {
      const visionResult = await this.runVisionPdfFallback(pageBuffers, { config, localQuality: localResult.quality });
      if (visionResult.ocr.status === 'vision_fallback') return visionResult;
    }

    if (localResult.quality.enoughText || localResult.quality.legibleShort) {
      return {
        text: localResult.quality.text,
        ocr: {
          status: 'local_ok',
          confidence: Math.round(localResult.quality.confidence),
          provider: 'tesseract',
          usefulChars: localResult.quality.usefulChars,
          lineCount: localResult.quality.lineCount,
          pages: pageBuffers.length,
          warning: localResult.quality.legibleShort ? 'below_min_useful_chars_but_confident' : 'vision_fallback_unavailable_or_weaker',
        },
      };
    }

    return this.asFailedResult(localResult.quality, localResult.error, { pages: pageBuffers.length });
  }

  /**
   * Tiny banners (URL strips, stamps, 610×94 screenshots) need a 4×
   * upscale before Tesseract; large photos stay at the default max side.
   */
  pickImageOcrMaxSide(width, height, options = {}) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    const minSide = Math.min(w, h);
    const maxSide = Math.max(w, h);
    const area = w * h;
    const cap = Number(options.cap) > 0 ? Number(options.cap) : 4000;
    const fallback = Number(options.defaultMaxSide) > 0 ? Number(options.defaultMaxSide) : 3000;
    if (minSide > 0 && (minSide < 400 || maxSide < 800 || area < 120_000)) {
      return Math.min(cap, Math.max(Math.round(maxSide * 4), 1600));
    }
    return fallback;
  }

  isSmallOcrImage(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (w <= 0 || h <= 0) return false;
    return Math.min(w, h) < 400 || Math.max(w, h) < 800 || (w * h) < 120_000;
  }

  async resolveImageOcrMaxSide(input, fallback = 3000) {
    try {
      const meta = await sharp(input).metadata();
      return this.pickImageOcrMaxSide(meta.width, meta.height, { defaultMaxSide: fallback });
    } catch {
      return fallback;
    }
  }

  /**
   * Returns an ordered list of lazy variant factories. Each factory
   * produces a preprocessed image buffer on demand so callers that
   * early-exit (e.g. a clean screenshot accepted on variant 1) never
   * pay the sharp cost of generating variants they won't OCR.
   * Order matters: variant 1 (normalize+sharpen) handles the common
   * well-lit / screenshot case, so it runs first.
   */
  createImageVariantFactories(input, options = {}) {
    const maxSide = options.maxSide || 3000;
    const profile = options.profile === 'pdf' ? 'pdf' : 'image';
    const makeBase = (angle = 0, side = maxSide) => {
      let pipeline = sharp(input).rotate();
      if (angle) {
        pipeline = pipeline.rotate(angle, { background: '#ffffff' });
      }
      return pipeline
        .resize(side, side, { fit: 'inside', withoutEnlargement: false })
        .greyscale();
    };
    // 2× lanczos upscale (capped at 4000 px) + unsharp mask: small or blurry
    // glyphs get more pixels and crisper edges before Tesseract sees them.
    const nativeMaxSide = Number(options.nativeMaxSide) || 0;
    const upscaleSide = Math.min(4000, Math.max(maxSide, Math.round(nativeMaxSide * 2)));

    const variants = {
      // Normalize + sharpen (best for well-lit documents / screenshots)
      normalize_sharpen: () => makeBase().normalize().sharpen().png().toBuffer(),
      // High contrast — linear stretch (best for faded text)
      contrast_sharpen: () => makeBase().linear(1.25, -8).normalize().sharpen().png().toBuffer(),
      // Hard threshold binarization (best for clean scans)
      threshold_165: () => makeBase().normalize().threshold(165).png().toBuffer(),
      // Sauvola local threshold (shadows, uneven lighting, photocopies)
      adaptive_threshold: () => this._adaptiveThreshold(makeBase()),
      // CLAHE: local contrast for phone photos with uneven light
      clahe: () => this._claheVariant(makeBase()),
      upscale_unsharp: () => sharp(input)
        .rotate()
        .resize(upscaleSide, upscaleSide, { fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
        .greyscale()
        .normalize()
        .sharpen({ sigma: 1.5, m1: 0.5, m2: 3 })
        .png()
        .toBuffer(),
      // Inverted — white text on black (important for some diagrams)
      inverted_normalized: () => makeBase().negate({ alpha: false }).normalize().sharpen().png().toBuffer(),
    };

    // Order matters (early exit + time budget). PDF pages keep their
    // historical first four (pdfMaxVariants defaults to 4); images try CLAHE
    // early, and a blurry image tries the upscale right after the base pass.
    let order;
    if (profile === 'pdf') {
      order = ['normalize_sharpen', 'contrast_sharpen', 'threshold_165', 'adaptive_threshold', 'clahe', 'inverted_normalized'];
    } else if (options.blurry) {
      order = ['normalize_sharpen', 'upscale_unsharp', 'clahe', 'contrast_sharpen', 'adaptive_threshold', 'threshold_165', 'inverted_normalized'];
    } else {
      order = ['normalize_sharpen', 'clahe', 'contrast_sharpen', 'adaptive_threshold', 'threshold_165', 'upscale_unsharp', 'inverted_normalized'];
    }
    const factories = order.map((name) => ({ name, make: variants[name] }));

    if (options.deskew !== false) {
      factories.push(
        { name: 'deskew_plus_3', make: () => makeBase(3).normalize().sharpen().png().toBuffer() },
        { name: 'deskew_minus_3', make: () => makeBase(-3).normalize().sharpen().png().toBuffer() },
      );
    }

    return factories;
  }

  createImageVariants(filePath) {
    return this.createImageVariantFactories(filePath, { maxSide: 3000 });
  }

  async createImageVariantsForInput(input, options = {}) {
    let width = 0;
    let height = 0;
    try {
      const meta = await sharp(input).metadata();
      width = Number(meta.width) || 0;
      height = Number(meta.height) || 0;
    } catch { /* unreadable: defaults below, the variants fail on their own */ }
    const maxSide = options.maxSide
      || (width && height ? this.pickImageOcrMaxSide(width, height, { defaultMaxSide: 3000 }) : 3000);
    return this.createImageVariantFactories(input, { ...options, maxSide, nativeMaxSide: Math.max(width, height) });
  }

  createPdfPageVariants(pageBuffer, config = this.config) {
    return this.createImageVariantFactories(pageBuffer, {
      maxSide: config.pdfMaxSide || 2600,
      profile: 'pdf',
    });
  }

  /**
   * Sauvola local thresholding on the raw greyscale pixels (window ≈ 1/80
   * of the short side, k 0.3): handles documents photographed with
   * shadows or uneven lighting. The old |I − blur| approximation (an
   * inverted high-pass) remains as the fallback when the raw path fails.
   */
  async _adaptiveThreshold(sharpInstance) {
    try {
      const { data, info } = await sharpInstance
        .clone()
        .flatten({ background: '#ffffff' })
        .normalize()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const binary = await ocrInput.sauvolaBinarize(data, info.width, info.height, { channels: info.channels });
      return await sharp(binary, { raw: { width: info.width, height: info.height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
    } catch {
      const blurred = sharpInstance.clone().blur(20);
      return sharpInstance
        .composite([{ input: await blurred.png().toBuffer(), blend: 'difference' }])
        .normalize()
        .threshold(128)
        .png()
        .toBuffer();
    }
  }

  /** CLAHE (tile grid, clip 3) + light sharpen, from the greyscale base. */
  async _claheVariant(sharpInstance) {
    const { data, info } = await sharpInstance
      .clone()
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const equalized = await ocrInput.claheGray(data, info.width, info.height, { channels: info.channels, clipLimit: 3 });
    return sharp(equalized, { raw: { width: info.width, height: info.height, channels: 1 } }).sharpen().toColourspace('b-w').png().toBuffer();
  }

  /**
   * Variant/read ranking. The character term is discounted by word
   * plausibility so a threshold or negated variant that turns noise into
   * 300 junk glyphs no longer beats a clean 100-character read. A read with
   * too few Latin words to judge (short, numeric, non-Latin) keeps the full
   * weight, exactly as before.
   */
  scoreQuality(quality = {}) {
    const usefulChars = Number(quality.usefulChars || 0);
    const confidence = Number(quality.confidence || 0);
    const lineCount = Number(quality.lineCount || 0);
    const acceptedBoost = quality.accepted ? 500 : 0;
    // ≥75 % plausible words keeps the full weight; 45 % halves it; noise
    // (≤20 %) keeps a tenth.
    const wordRatio = Number(quality.wordRatio);
    const plausibility = Number.isFinite(wordRatio) && quality.wordRatio !== null
      ? Math.max(0.1, Math.min(1, (wordRatio - 0.15) / 0.6))
      : 1;
    return usefulChars * 2 * plausibility + confidence + Math.min(lineCount, 80) + acceptedBoost;
  }

  async recognizeBestVariant(worker, variantFactories, config = this.config, options = {}) {
    let best = this.evaluateQuality({ text: '', confidence: 0 });
    let bestVariant = null;
    let variantsProcessed = 0;
    const maxVariants = Math.max(1, Math.min(
      Number.parseInt(options.maxVariants || variantFactories.length, 10) || variantFactories.length,
      variantFactories.length,
    ));
    let lastError = null;
    // Wall-clock deadline (absolute ms) shared by every variant of this
    // image. A phone photo with no text makes Tesseract chew on thousands
    // of spurious blobs ("Image too small to scale!!" spam) for MINUTES per
    // variant — prod 2026-10-03: one WhatsApp picture held the upload for
    // 371 s before the vision rungs got a look. Past the deadline the loop
    // stops, and a recognize() still running is abandoned by terminating
    // the worker (the WASM job cannot be interrupted any other way).
    const deadlineAt = Number(options.deadlineAt) || 0;
    const signal = options.signal || null;
    let timedOut = false;
    let aborted = false;
    let workerTerminated = false;

    for (let idx = 0; idx < maxVariants; idx += 1) {
      if (signal && signal.aborted) { aborted = true; break; }
      if (deadlineAt && Date.now() >= deadlineAt) { timedOut = true; break; }
      const entry = variantFactories[idx];
      const makeVariant = typeof entry === 'function' ? entry : entry.make;
      const variantName = typeof entry === 'function' ? `variant_${idx + 1}` : entry.name;
      try {
        const variant = await makeVariant();
        const recognized = await recognizeWithin(worker, variant, deadlineAt, signal);
        if (recognized.terminated) workerTerminated = true;
        if (recognized.aborted) { aborted = true; break; }
        if (recognized.timedOut) { timedOut = true; break; }
        const { data: { text, confidence } } = recognized.result;
        variantsProcessed += 1;
        const quality = this.evaluateQuality({ text, confidence }, config);
        if (this.scoreQuality(quality) > this.scoreQuality(best)) {
          best = quality;
          bestVariant = variantName;
        }
      } catch (err) {
        lastError = err;
        continue;
      }
      // Early-exit: a clean screenshot / page is usually accepted on the first
      // normalized pass. Low-quality pages continue through contrast/threshold
      // variants, which is the path that recovers scans and photocopies.
      if (best.accepted) break;
    }

    if (variantsProcessed === 0 && lastError && !timedOut && !aborted) throw lastError;
    return {
      quality: best,
      variants: variantsProcessed,
      variant: bestVariant,
      timedOut,
      ...(aborted ? { aborted: true } : {}),
      ...(workerTerminated ? { workerTerminated: true } : {}),
    };
  }

  /**
   * Local Tesseract pass for one image (variants, then a 4000 px retry), all
   * inside ONE wall-clock budget. Returns { quality, variants, variant,
   * timedOut, aborted?, blur, usedAlternate?, alternateSource? }.
   *
   * The orientation alternate is either `options.alternateInput` (the page
   * as it was before a confident OSD rotation) or `options.alternateFactory`
   * (async → Buffer: the page turned by a low-confidence OSD hint, built
   * only when needed). It is tried (two variants) when the first read is
   * weak, BEFORE the 4000 px pass, and part of the budget is reserved for
   * it: a first sweep that runs out of time never skips it (a terminated
   * worker is replaced). The better read wins; `alternateSource` is the
   * buffer it came from.
   */
  async runLocalImageOcr(filePath, options = {}) {
    const blur = options.blur !== undefined
      ? options.blur
      : (typeof this.ocrInput.measureBlur === 'function' ? await this.ocrInput.measureBlur(filePath) : null);
    const blurry = Boolean(blur && blur.blurry);
    const signal = options.signal || null;
    const language = options.language || this.defaultLanguage;
    const variantFactories = await this.createImageVariantsForInput(filePath, { blurry });
    let worker = await this.createOcrWorker(language);
    // One budget for the whole local attempt (both passes). Past it the
    // picture goes straight to the vision rungs (GLM-OCR local → cloud),
    // which read photos far better than Tesseract anyway.
    const budgetMs = localImageBudgetMs(options);
    const deadlineAt = Date.now() + budgetMs;
    const hasAlternate = Buffer.isBuffer(options.alternateInput) || typeof options.alternateFactory === 'function';
    const firstDeadline = hasAlternate ? deadlineAt - Math.round(budgetMs * ALTERNATE_RESERVE_SHARE) : deadlineAt;

    try {
      let first = await this.recognizeBestVariant(worker, variantFactories, this.config, {
        maxVariants: variantFactories.length,
        deadlineAt: firstDeadline,
        signal,
      });
      if (first?.quality?.accepted) return { ...first, blur };
      if (first?.aborted) return { ...first, blur };
      const firstTimedOut = Boolean(first?.timedOut);
      if (firstTimedOut && !hasAlternate) {
        console.warn(`[ocr-engine] local OCR budget (${budgetMs} ms) exhausted after ${first.variants} variant(s) — handing the image to the vision rungs`);
        return { ...first, timedOut: true, blur };
      }

      let source = filePath;
      let usedAlternate = false;
      let alternateSource = null;
      if (hasAlternate) {
        let altBuffer = null;
        if (Buffer.isBuffer(options.alternateInput)) {
          altBuffer = options.alternateInput;
        } else {
          try {
            const made = await options.alternateFactory();
            altBuffer = Buffer.isBuffer(made) ? made : null;
          } catch { altBuffer = null; }
        }
        let altWorker = worker;
        if (altBuffer && first.workerTerminated) {
          // The timed-out first sweep killed its worker: the reserved budget
          // pays for a fresh one.
          worker = null;
          try {
            altWorker = Date.now() < deadlineAt ? await this.createOcrWorker(language) : null;
          } catch { altWorker = null; }
          worker = altWorker;
        }
        if (altBuffer && altWorker) {
          const altFactories = await this.createImageVariantsForInput(altBuffer, { blurry });
          let alt;
          try {
            alt = await this.recognizeBestVariant(altWorker, altFactories, this.config, { maxVariants: 2, deadlineAt, signal });
          } catch {
            // An unreadable alternate never costs the first read.
            alt = { quality: this.evaluateQuality({ text: '', confidence: 0 }), variants: 0, variant: null, timedOut: false };
          }
          if (alt.workerTerminated) worker = null;
          if (this.scoreQuality(alt.quality) > this.scoreQuality(first.quality)) {
            first = alt;
            source = altBuffer;
            usedAlternate = true;
            alternateSource = altBuffer;
          }
          const altMeta = usedAlternate ? { usedAlternate, alternateSource } : { usedAlternate };
          if (alt.aborted) return { ...first, aborted: true, blur, ...altMeta };
          if (first.quality.accepted) return { ...first, blur, ...altMeta };
          if (alt.timedOut || firstTimedOut) {
            console.warn(`[ocr-engine] local OCR budget (${budgetMs} ms) exhausted (orientation alternate tried) — handing the image to the vision rungs`);
            return { ...first, timedOut: true, blur, ...altMeta };
          }
        } else if (firstTimedOut) {
          return { ...first, timedOut: true, blur, usedAlternate };
        }
      }

      if (!worker) return { ...first, timedOut: true, blur, usedAlternate, ...(usedAlternate ? { alternateSource } : {}) };
      const enlargedFactories = await this.createImageVariantsForInput(source, { maxSide: 4000, blurry });
      const second = await this.recognizeBestVariant(worker, enlargedFactories, this.config, {
        maxVariants: enlargedFactories.length,
        deadlineAt,
        signal,
      });
      if (second.workerTerminated) worker = null;
      const timedOut = Boolean(second.timedOut);
      const extra = { retriedEnlarged: true, timedOut, blur, usedAlternate, ...(usedAlternate ? { alternateSource } : {}) };
      if (second.aborted) extra.aborted = true;
      if (this.scoreQuality(second.quality) > this.scoreQuality(first.quality)) {
        return { ...second, ...extra };
      }
      return { ...first, ...extra };
    } finally {
      await terminateWorker(worker);
    }
  }

  async recognizePageBuffers(pageBuffers, options = {}) {
    const worker = await this.createOcrWorker(options.language || this.defaultLanguage);
    const pageResults = [];
    try {
      for (const pageBuffer of pageBuffers) {
        const { data: { text, confidence } } = await worker.recognize(pageBuffer);
        pageResults.push({
          text: normalizeOcrText(text),
          confidence: Number(confidence || 0),
        });
      }
    } finally {
      await terminateWorker(worker);
    }

    const text = pageResults.map(page => page.text).filter(Boolean).join('\n\n');
    const confidence = pageResults.length
      ? pageResults.reduce((sum, page) => sum + page.confidence, 0) / pageResults.length
      : 0;

    return {
      quality: this.evaluateQuality({ text, confidence }),
      pages: pageResults,
    };
  }

  async preprocessPdfPage(page, config = this.config) {
    return sharp(page)
      .rotate()
      .resize(config.pdfMaxSide || 2600, config.pdfMaxSide || 2600, { fit: 'inside', withoutEnlargement: false })
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  }

  /**
   * Weak page → Tesseract OSD (native CLI + osd data, feature-detected) →
   * when it says the page is rotated with enough confidence, re-read the
   * upright page (two variants) and keep the better read. Bounded by the
   * OSD timeout; a no-op when OSD is unavailable or the read was accepted.
   */
  async _retryOrientedPage(worker, pageBuffer, localResult, config = this.config, { deadlineAt = 0, signal = null } = {}) {
    if (!localResult || !localResult.quality || localResult.quality.accepted || localResult.timedOut) return localResult;
    if (!Buffer.isBuffer(pageBuffer)) return localResult;
    if (deadlineAt && Date.now() >= deadlineAt) return localResult;
    try {
      const verdict = await this.ocrInput.detectOrientation(pageBuffer);
      // Only an alternate hypothesis that must read better: the low hint
      // threshold is enough here.
      const osdCfg = this.ocrInput.inputConfig();
      const minConfidence = Number.isFinite(osdCfg.osdHintConfidence) ? osdCfg.osdHintConfidence : osdCfg.osdMinConfidence;
      if (!verdict || !verdict.ok || !verdict.rotate || verdict.confidence < minConfidence) return localResult;
      const rotated = await sharp(pageBuffer).rotate(verdict.rotate, { background: '#ffffff' }).png().toBuffer();
      const retry = await this.recognizeBestVariant(worker, this.createPdfPageVariants(rotated, config), config, {
        maxVariants: 2,
        ...(deadlineAt ? { deadlineAt } : {}),
        ...(signal ? { signal } : {}),
      });
      // A retry cut at the page deadline killed the worker: the caller must
      // know even when the original read is kept.
      const terminated = retry.workerTerminated ? { workerTerminated: true } : {};
      if (this.scoreQuality(retry.quality) > this.scoreQuality(localResult.quality)) {
        return { ...retry, rotated: verdict.rotate, orientedBuffer: rotated };
      }
      return { ...localResult, ...terminated };
    } catch { /* keep the original read */ }
    return localResult;
  }

  /**
   * Open a PDF for page rendering (pdf-to-img: async-iterable pages,
   * `length`, `getPage(n)`). The single seam tests replace with a fake.
   */
  async _openPdf(filePath, scale = 2.4) {
    const { pdf } = await import('pdf-to-img');
    return pdf(filePath, { scale });
  }

  async renderPdfPages(filePath, options = {}) {
    const config = this.config;
    const pages = await this._openPdf(filePath, options.scale || config.pdfScale || 2.4);
    const buffers = [];
    const maxPages = Number.parseInt(options.maxPages ?? config.pdfMaxPages ?? 0, 10) || 0;
    let pageNumber = 0;

    for await (const page of pages) {
      pageNumber += 1;
      if (maxPages > 0 && pageNumber > maxPages) break;
      const buffer = await this.preprocessPdfPage(page, config);
      buffers.push(buffer);
    }

    return buffers;
  }

  /**
   * Tesseract worker for PDF pages (PSM 1, interword spaces). Null when
   * Tesseract is unavailable: the pages then go straight to the vision
   * ladder instead of failing the whole document.
   */
  async _createPdfWorker(language) {
    const worker = await this.createOcrWorker(language);
    if (worker && typeof worker.setParameters === 'function') {
      await worker.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: '1',
      }).catch(() => null);
    }
    return worker;
  }

  /**
   * Is this rendered page blank (the back of a duplex scan)? Ink = pixels
   * clearly darker than the page (≥ 45 levels under its mean), counted on a
   * ≤ 600-px copy with 4 % margins cropped (scanner edges). Show-through and
   * paper texture stay under that; a short handwritten line does not.
   * False on any failure (the page then goes down the ladder as before).
   */
  async _isBlankPage(buffer, config = this.config) {
    const maxRatio = Number(config.pdfBlankInkRatio);
    if (!(maxRatio > 0) || !Buffer.isBuffer(buffer)) return false;
    try {
      const meta = await sharp(buffer).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w < 50 || h < 50) return false;
      const mx = Math.floor(w * 0.04);
      const my = Math.floor(h * 0.04);
      const { data, info } = await sharp(buffer)
        .extract({ left: mx, top: my, width: w - 2 * mx, height: h - 2 * my })
        .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const step = info.channels || 1;
      const pixels = Math.floor(data.length / step);
      if (!pixels) return false;
      let sum = 0;
      for (let i = 0; i < data.length; i += step) sum += data[i];
      const threshold = (sum / pixels) - 45;
      let ink = 0;
      for (let i = 0; i < data.length; i += step) if (data[i] < threshold) ink += 1;
      return ink / pixels < maxRatio;
    } catch {
      return false;
    }
  }

  /** `[page N]` marker text for a page without text, honest about WHY. */
  _pdfPageMarker(pageNumber, reason) {
    if (reason === 'blank') return `[página ${pageNumber} — en blanco]`;
    if (reason === 'vision_page_cap') return `[página ${pageNumber} — sin OCR completo: límite de páginas con visión]`;
    if (reason === 'vision_no_time') return `[página ${pageNumber} — sin OCR completo: tiempo agotado]`;
    if (reason === 'tesseract_unavailable') return `[página ${pageNumber} — sin OCR: OCR local no disponible]`;
    return ocrQuality.unreadablePageMarker(pageNumber, reason);
  }

  /** Is the local GLM-OCR rung switched on (it may still be unavailable)? */
  _glmEnabled() {
    const client = this.ollamaOcr;
    try {
      return Boolean(client && typeof client.isEnabled === 'function' && client.isEnabled());
    } catch {
      return false;
    }
  }

  /** Provider-safe copy of a rendered page for the vision rungs (≤ 3072 px, ≤ 8 MB). */
  async _pdfVisionImage(pageBuffer) {
    if (!this.ocrInput || typeof this.ocrInput.toVisionImage !== 'function') return { buffer: pageBuffer, mimeType: 'image/png' };
    try {
      const prepared = await this.ocrInput.toVisionImage(pageBuffer, { mime: 'image/png' });
      if (prepared && Buffer.isBuffer(prepared.buffer) && prepared.buffer.length) {
        return { buffer: prepared.buffer, mimeType: prepared.mime || 'image/png' };
      }
    } catch { /* keep the render */ }
    return { buffer: pageBuffer, mimeType: 'image/png' };
  }

  /**
   * Read ONE rendered PDF page through the full ladder:
   *   Tesseract (variants, bounded by the page deadline; a weak deep page
   *   may be re-read upright via OSD) → a blank page stops here → when the
   *   read is not accepted or looks like garbage, the vision ladder (GLM-OCR
   *   gated → cloud runtimes when `allowCloud` → reconciliation), within the
   *   vision page budget and cap.
   * Vision never eats the time the remaining pages need for Tesseract:
   * `pagesLeft` × the measured Tesseract time per page is reserved out of
   * the document budget before a vision call may start, and its deadline
   * stops at that reserve.
   * `state` carries the worker across pages ({ worker, broken, language }),
   * the vision page counter ({ visionPages }) and the Tesseract timing
   * ({ localMs, localPages }). Never throws.
   *
   * Returns { text, provider, confidence, usedVision, lowConfidence, reason,
   * marker, quality, variant, variants, timedOut, aborted, visionReason }.
   */
  async _readPdfPage(pageBuffer, {
    pageNumber, totalPages = null, config = this.config, state, signal = null,
    pageDeadlineAt, docDeadlineAt, maxVariants, allowVision = true, allowCloud = true, visionMaxPages, pagesLeft = 0,
  }) {
    let localResult = { quality: this.evaluateQuality({ text: '', confidence: 0 }, config), variants: 0, variant: null };
    if (!state.worker && !state.broken) {
      try {
        state.worker = await this._createPdfWorker(state.language);
      } catch (error) {
        state.broken = true;
        state.workerError = error?.code || 'tesseract_unavailable';
        console.warn(`[ocr-engine] PDF OCR: Tesseract unavailable (${state.workerError}); pages go to the vision rungs only`);
      }
    }
    if (state.worker) {
      const localStarted = Date.now();
      try {
        localResult = await this.recognizeBestVariant(state.worker, this.createPdfPageVariants(pageBuffer, config), config, {
          maxVariants,
          deadlineAt: pageDeadlineAt,
          signal,
        });
      } catch (error) {
        localResult = { quality: this.evaluateQuality({ text: '', confidence: 0 }, config), error: error?.message || 'page_ocr_failed' };
      }
      // A recognize() cut at the deadline killed the worker: next page gets a new one.
      if (localResult.workerTerminated) state.worker = null;
      if (maxVariants > 1 && state.worker && !localResult.timedOut && !localResult.aborted) {
        localResult = await this._retryOrientedPage(state.worker, pageBuffer, localResult, config, { deadlineAt: pageDeadlineAt, signal });
        if (localResult.workerTerminated) state.worker = null;
      }
      state.localMs = (state.localMs || 0) + (Date.now() - localStarted);
      state.localPages = (state.localPages || 0) + 1;
    }
    if (localResult.aborted || (signal && signal.aborted)) {
      return { text: '', aborted: true, quality: localResult.quality, reason: 'aborted', usedVision: false };
    }
    const quality = localResult.quality;
    const localOk = quality.accepted && !quality.garbageLikely;
    let text = '';
    let provider = null;
    let confidence = Number(quality.confidence || 0);
    let usedVision = false;
    let lowConfidence = false;
    let visionReason = null;
    let engines = null;
    let blank = false;

    // A page Tesseract found nothing on and that carries no ink is blank:
    // it never reaches a vision rung nor counts toward the vision page cap.
    if (!localOk && allowVision && !localResult.timedOut && Number(quality.usefulChars || 0) === 0) {
      blank = await this._isBlankPage(pageBuffer, config);
    }

    // No rung can run (cloud off and GLM-OCR disabled): nothing to call and
    // nothing to count against the vision page cap.
    const visionPossible = allowCloud || this._glmEnabled();
    if (!localOk && allowVision && !blank && !visionPossible) visionReason = 'vision_unavailable';

    if (!localOk && allowVision && !blank && visionPossible) {
      // Reserve the Tesseract time of the pages still to come (measured
      // average × 1.2, at least 0.5 s, at most the page budget).
      const estLocalMs = state.localPages
        ? Math.min(config.pdfPageBudgetMs, Math.max(500, (state.localMs / state.localPages) * 1.2))
        : 0;
      const visionEndAt = docDeadlineAt - Math.max(0, Number(pagesLeft) || 0) * estLocalMs;
      const remaining = visionEndAt - Date.now();
      if (state.visionPages >= visionMaxPages) {
        visionReason = 'vision_page_cap';
      } else if (remaining < 2500) {
        visionReason = 'vision_no_time';
      } else {
        state.visionPages += 1;
        const upright = localResult.orientedBuffer || pageBuffer;
        // Provider-safe copy for the vision models; band reads keep the
        // native render (`sourceBuffer`).
        const visionRef = await this._pdfVisionImage(upright);
        const vision = await this.runVisionFallback({
          buffer: visionRef.buffer,
          mimeType: visionRef.mimeType,
          config,
          localQuality: quality,
          promptPrefix: `Página ${pageNumber}${totalPages ? ` de ${totalPages}` : ''}.`,
          signal,
          deadlineAt: Math.min(Date.now() + config.pdfVisionPageBudgetMs, visionEndAt),
          sourceBuffer: upright,
          allowCloud,
        });
        if (vision && vision.ocr && vision.ocr.status === 'vision_fallback' && vision.text) {
          text = vision.text;
          provider = vision.ocr.provider;
          engines = vision.ocr.engines || null;
          confidence = Number(vision.ocr.confidence || 0);
          lowConfidence = vision.ocr.confidenceLevel === 'baja';
          usedVision = true;
        } else {
          visionReason = (vision && vision.ocr && vision.ocr.reason) || 'vision_fallback_failed';
          if (visionReason === 'aborted') return { text: '', aborted: true, quality, reason: 'aborted', usedVision: false };
        }
      }
    }
    if (!text && (quality.enoughText || quality.legibleShort)) {
      text = quality.text;
      provider = 'tesseract';
      lowConfidence = !localOk;
    }
    // Why a page has no text — never «no legible» for a page no capable
    // engine read (vision capped / out of time, Tesseract unavailable).
    let reason = 'ok';
    if (!text) {
      if (blank) reason = 'blank';
      else if (visionReason === 'vision_page_cap' || visionReason === 'vision_no_time') reason = visionReason;
      else if (localResult.timedOut) reason = 'timeout';
      // Tesseract never ran and no vision rung read the page as empty.
      else if (state.broken && !/empty/.test(String(visionReason || ''))) reason = 'tesseract_unavailable';
      else reason = quality.reason;
    }
    return {
      text,
      provider,
      engines,
      confidence,
      usedVision,
      lowConfidence,
      reason,
      marker: text ? null : this._pdfPageMarker(pageNumber, reason),
      blank,
      visionReason,
      quality,
      variant: localResult.variant || null,
      variants: localResult.variants || 0,
      timedOut: Boolean(localResult.timedOut),
      aborted: false,
    };
  }

  /** `[page N]` block of a scanned PDF page, honest about weak or empty pages. */
  _pdfPageBlock(pageNumber, read) {
    if (read.text) {
      if (read.lowConfidence) {
        return `[page ${pageNumber}]\n[página ${pageNumber} — lectura poco fiable (${ocrEnsemble.describeEngines(read.provider)}, confianza ${Math.round(read.confidence)} %): verifícala con el original]\n${read.text}`;
      }
      return `[page ${pageNumber}]\n${read.text}`;
    }
    return `[page ${pageNumber}]\n${read.marker || this._pdfPageMarker(pageNumber, read.reason)}`;
  }

  async extractFromPdfImagesStreaming(filePath, options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return this.skipped('ocr_disabled');
    const signal = options.signal || null;
    if (signal && signal.aborted) return this.abortedResult({ streaming: true });

    const pages = await this._openPdf(filePath, options.scale || config.pdfScale || 2.4);
    const totalPages = Number(pages && pages.length) || null;
    const maxPages = Number.parseInt(options.maxPages ?? config.pdfMaxPages ?? 0, 10) || 0;
    const maxChars = positiveIntFromEnv('OCR_PDF_MAX_CHARS', config.pdfMaxChars || 6_000_000);
    const language = options.language || this.defaultLanguage;
    const onPage = typeof options.onPage === 'function' ? options.onPage : null;
    const startedAt = Date.now();
    const docDeadlineAt = startedAt + (Number(options.budgetMs) > 0 ? Number(options.budgetMs) : config.pdfBudgetMs);
    const allowVision = options.allowVision !== false && config.pdfVisionEnabled && this.shouldUseVisionFallback({ accepted: false }, { mode });
    // Full scanned PDFs never had a cloud rung: paid, opt-in.
    const allowCloud = typeof options.allowCloud === 'boolean' ? options.allowCloud : config.pdfVisionCloudEnabled;
    const visionMaxPages = Number(options.visionMaxPages) > 0 ? Number(options.visionMaxPages) : config.pdfVisionMaxPages;
    const state = { worker: null, broken: false, language, visionPages: 0, localMs: 0, localPages: 0 };
    const pageResults = [];
    const textParts = [];
    const providers = new Set();
    let pageNumber = 0;
    let processedPages = 0;
    let totalUsefulChars = 0;
    let totalConfidence = 0;
    let textConfidence = 0;
    let textConfidenceSamples = 0;
    let maxVariantsSeen = 0;
    let outputChars = 0;
    let partial = false;
    let partialReason = null;
    let stoppedAt = null;
    let visionPagesUsed = 0;

    try {
      // Render time counts toward the per-page time reserved for the pages
      // still to come (see _readPdfPage).
      let iterationEndedAt = Date.now();
      for await (const page of pages) {
        if (state.localPages) state.localMs += Date.now() - iterationEndedAt;
        pageNumber += 1;
        if (maxPages > 0 && pageNumber > maxPages) {
          partial = true; partialReason = 'page_cap'; stoppedAt = pageNumber;
          break;
        }
        if (signal && signal.aborted) {
          partial = true; partialReason = 'aborted'; stoppedAt = pageNumber;
          break;
        }
        if (Date.now() >= docDeadlineAt) {
          partial = true; partialReason = 'budget'; stoppedAt = pageNumber;
          break;
        }

        const pageVariantLimit = pageNumber <= config.pdfDeepVariantPages ? config.pdfMaxVariants : 1;
        const lastPage = maxPages > 0 && totalPages ? Math.min(totalPages, maxPages) : (totalPages || maxPages || pageNumber);
        const read = await this._readPdfPage(page, {
          pageNumber,
          totalPages,
          config,
          state,
          signal,
          pageDeadlineAt: Math.min(Date.now() + config.pdfPageBudgetMs, docDeadlineAt),
          docDeadlineAt,
          maxVariants: pageVariantLimit,
          allowVision,
          allowCloud,
          visionMaxPages,
          pagesLeft: Math.max(0, lastPage - pageNumber),
        });
        if (read.aborted) {
          partial = true; partialReason = 'aborted'; stoppedAt = pageNumber;
          break;
        }
        const quality = read.quality;
        maxVariantsSeen = Math.max(maxVariantsSeen, read.variants || 0);
        const usefulChars = read.text ? usefulCharCount(read.text) : quality.usefulChars;
        const pageResult = {
          page: pageNumber,
          text: read.text,
          confidence: Number(read.confidence || 0),
          usefulChars,
          lineCount: read.text ? read.text.split('\n').filter((l) => l.trim()).length : quality.lineCount,
          accepted: Boolean(read.text),
          reason: read.reason,
          variant: read.variant,
          variants: read.variants,
          deep: pageVariantLimit > 1,
          provider: read.provider,
          lowConfidence: Boolean(read.text && read.lowConfidence),
          ...(read.blank ? { blank: true } : {}),
          ...(read.visionReason ? { visionReason: read.visionReason } : {}),
        };
        pageResults.push(pageResult);
        processedPages += 1;
        totalUsefulChars += usefulChars;
        totalConfidence += pageResult.confidence;
        if (read.usedVision) visionPagesUsed += 1;
        if (read.text) {
          textConfidence += pageResult.confidence;
          textConfidenceSamples += 1;
          for (const engine of (read.engines && read.engines.length ? read.engines : [read.provider])) {
            if (engine) providers.add(engine);
          }
        }

        const pageBlock = this._pdfPageBlock(pageNumber, read);
        const separatorChars = textParts.length > 0 ? 2 : 0;
        if (outputChars + separatorChars + pageBlock.length > maxChars) {
          partial = true; partialReason = 'char_cap'; stoppedAt = pageNumber;
          break;
        }
        textParts.push(pageBlock);
        outputChars += separatorChars + pageBlock.length;

        if (onPage) {
          try {
            await onPage({
              page: pageNumber,
              processedPages,
              usefulChars,
              confidence: pageResult.confidence,
              accepted: pageResult.accepted,
              variant: pageResult.variant,
              variants: pageResult.variants,
              provider: pageResult.provider,
              lowConfidence: pageResult.lowConfidence,
              totalPages,
            });
          } catch { /* a progress callback never breaks the OCR */ }
        }
        iterationEndedAt = Date.now();
      }
    } finally {
      await terminateWorker(state.worker);
    }

    if (stoppedAt) {
      const why = partialReason === 'budget' ? 'tiempo agotado'
        : partialReason === 'aborted' ? 'lectura cancelada'
          : partialReason === 'char_cap' ? 'límite de caracteres'
            : 'límite';
      const last = totalPages && totalPages >= stoppedAt ? totalPages : null;
      textParts.push(ocrQuality.pageCapMarker(stoppedAt, last, why));
    }

    const pagesWithText = pageResults.filter((page) => page.accepted && page.text).length;
    const joinedText = normalizeOcrText(textParts.join('\n\n'));
    const avgConfidence = processedPages ? totalConfidence / processedPages : 0;
    const confidence = textConfidenceSamples ? textConfidence / textConfidenceSamples : avgConfidence;
    // Blank = detected blank, or empty where an engine did look (a page
    // nobody read — capped, out of time, no Tesseract — is not «blank»).
    const notRead = new Set(['vision_page_cap', 'vision_no_time', 'tesseract_unavailable', 'timeout']);
    const blankPages = pageResults.filter((page) => !page.text && (page.blank || (page.usefulChars === 0 && !notRead.has(page.reason)))).length;
    const weakPages = pageResults.filter((page) => page.lowConfidence || (!page.text && page.usefulChars > 0)).length;
    // A blank page is not an unread page.
    const unreadPages = pageResults.filter((page) => !page.text && !page.blank).map((page) => page.page).slice(0, 200);
    const pageMeta = pageResults
      .slice(0, config.pdfPageMetaLimit)
      .map((page) => ({
        page: page.page,
        confidence: Math.round(Number(page.confidence || 0)),
        usefulChars: page.usefulChars,
        lineCount: page.lineCount,
        accepted: Boolean(page.accepted),
        reason: page.reason,
        variant: page.variant,
        variants: page.variants,
        provider: page.provider || null,
        ...(page.lowConfidence ? { lowConfidence: true } : {}),
        ...(page.visionReason ? { visionReason: page.visionReason } : {}),
      }));
    const omittedPageMeta = Math.max(0, pageResults.length - pageMeta.length);
    const meta = {
      pages: processedPages,
      totalPages,
      pagesWithText,
      blankPages,
      weakPages,
      unreadPages,
      visionPages: visionPagesUsed,
      streaming: true,
      partial,
      partialReason,
      elapsedMs: Date.now() - startedAt,
      mode: 'local_multipass',
      maxVariants: config.pdfMaxVariants,
      maxVariantsSeen,
      deepVariantPages: config.pdfDeepVariantPages,
      pageQuality: pageMeta,
      omittedPageQuality: omittedPageMeta,
      ...(state.broken ? { tesseract: state.workerError || 'unavailable' } : {}),
    };

    if (pagesWithText > 0) {
      const level = ocrEnsemble.confidenceLevel(Math.round(confidence));
      console.log(`[ocr-engine] scanned PDF: ${pagesWithText}/${processedPages} page(s) with text, vision=${visionPagesUsed}, weak=${weakPages}, unread=${unreadPages.length}${partial ? `, partial=${partialReason}` : ''}, ${meta.elapsedMs} ms`);
      return {
        text: joinedText,
        pages: pageResults,
        ocr: {
          status: visionPagesUsed > 0 ? 'vision_fallback' : 'local_ok',
          confidence: Math.round(confidence),
          confidenceLevel: weakPages > 0 && level === 'alta' ? 'media' : level,
          provider: providers.size ? [...providers].join('+') : 'tesseract',
          usefulChars: totalUsefulChars,
          lineCount: joinedText.split('\n').filter((l) => l.trim()).length,
          language,
          maxPages: maxPages || null,
          ...meta,
        },
      };
    }

    const quality = this.evaluateQuality({ text: '', confidence: avgConfidence }, config);
    return this.asFailedResult(quality, partialReason === 'aborted' && processedPages === 0 ? 'aborted' : 'local_pdf_ocr_empty', meta);
  }

  /**
   * OCR a SPECIFIC subset of PDF pages (1-based page numbers) and return
   * per-page results. This powers mixed PDFs — documents whose text layer
   * covers some pages while others are scans/images (or carry a broken or
   * stamp-only text layer): the caller keeps the good text-layer pages and
   * asks this method only for the others. Pages are rendered individually
   * via pdf-to-img's getPage(), so a 300-page contract with 4 scanned
   * annexes renders 4 pages, not 300.
   *
   * Each page runs the full ladder (Tesseract bounded by the page budget →
   * vision ladder with reconciliation). `options.budgetMs` bounds the whole
   * subset: pages left when it runs out come back with reason 'budget' (the
   * caller marks them) instead of holding the text-layer pages hostage.
   */
  async extractPdfPagesSubset(filePath, pageNumbers = [], options = {}) {
    const config = this.config;
    const mode = String(options.mode || config.mode).toLowerCase();
    if (mode === 'off') return { pages: [], ocr: { status: 'skipped', reason: 'ocr_disabled' } };
    const signal = options.signal || null;

    const doc = await this._openPdf(filePath, options.scale || config.pdfScale || 2.4);
    const docLength = Number(doc.length || 0);
    const targets = [...new Set(pageNumbers)]
      .filter(n => Number.isInteger(n) && n >= 1 && (docLength === 0 || n <= docLength))
      .sort((a, b) => a - b);
    const maxPages = Number.parseInt(options.maxPages ?? 0, 10) || 0;
    const selected = maxPages > 0 ? targets.slice(0, maxPages) : targets;
    if (selected.length === 0) {
      return { pages: [], ocr: { status: 'skipped', reason: 'no_target_pages', pagesRequested: pageNumbers.length } };
    }

    const language = options.language || this.defaultLanguage;
    const startedAt = Date.now();
    const docDeadlineAt = startedAt + (Number(options.budgetMs) > 0 ? Number(options.budgetMs) : config.pdfBudgetMs);
    const allowVision = options.allowVision !== false && config.pdfVisionEnabled && this.shouldUseVisionFallback({ accepted: false }, { mode });
    // Mixed PDFs always had the image cloud rung (GLM → cloud): kept.
    const allowCloud = typeof options.allowCloud === 'boolean' ? options.allowCloud : true;
    const visionMaxPages = Number(options.visionMaxPages) > 0 ? Number(options.visionMaxPages) : config.pdfVisionMaxPages;
    const state = { worker: null, broken: false, language, visionPages: 0, localMs: 0, localPages: 0 };
    const pages = [];
    let budgetHit = false;
    try {
      for (const [index, pageNumber] of selected.entries()) {
        if ((signal && signal.aborted) || Date.now() >= docDeadlineAt) {
          budgetHit = budgetHit || !(signal && signal.aborted);
          const why = signal && signal.aborted ? 'aborted' : 'budget';
          pages.push({ page: pageNumber, text: '', confidence: 0, provider: null, reason: why, marker: this._pdfPageMarker(pageNumber, why) });
          continue;
        }
        let raw;
        const renderStartedAt = Date.now();
        try {
          raw = await doc.getPage(pageNumber);
          if (state.localPages) state.localMs += Date.now() - renderStartedAt;
        } catch {
          pages.push({ page: pageNumber, text: '', confidence: 0, provider: null, reason: 'render_failed' });
          continue;
        }
        const read = await this._readPdfPage(raw, {
          pageNumber,
          totalPages: docLength || null,
          config,
          state,
          signal,
          pageDeadlineAt: Math.min(Date.now() + config.pdfPageBudgetMs, docDeadlineAt),
          docDeadlineAt,
          maxVariants: config.pdfMaxVariants,
          allowVision,
          allowCloud,
          visionMaxPages,
          pagesLeft: selected.length - index - 1,
        });
        const reason = read.aborted ? 'aborted' : read.reason;
        pages.push({
          page: pageNumber,
          text: read.text || '',
          confidence: Math.round(Number(read.confidence || 0)),
          usefulChars: read.text ? usefulCharCount(read.text) : read.quality?.usefulChars || 0,
          provider: read.text ? read.provider : null,
          reason,
          ...(read.text ? {} : { marker: read.marker || this._pdfPageMarker(pageNumber, reason) }),
          ...(read.blank ? { blank: true } : {}),
          ...(read.text && read.lowConfidence ? { lowConfidence: true } : {}),
        });
      }
    } finally {
      await terminateWorker(state.worker);
    }

    const pagesWithText = pages.filter(page => page.text).length;
    return {
      pages,
      ocr: {
        status: pagesWithText > 0 ? 'pages_subset_ok' : 'failed',
        provider: 'hybrid',
        pagesRequested: pageNumbers.length,
        pagesProcessed: selected.length,
        pagesWithText,
        visionPages: state.visionPages,
        capped: targets.length > selected.length,
        budgetHit,
        elapsedMs: Date.now() - startedAt,
        language,
      },
    };
  }

  async runVisionPdfFallback(pageBuffers, { config = this.config, localQuality = null } = {}) {
    const maxPages = Math.min(pageBuffers.length, config.visionPdfMaxPages || 20, 50);
    const strategy = config.visionPdfStrategy || 'first';

    // Select pages based on strategy
    let pageIndices = [];
    if (strategy === 'first-last-middle' && pageBuffers.length > 3) {
      // First pages, middle pages, last pages
      const firstCount = Math.ceil(maxPages * 0.4);
      const lastCount = Math.ceil(maxPages * 0.3);
      const middleCount = maxPages - firstCount - lastCount;
      for (let i = 0; i < firstCount; i++) pageIndices.push(i);
      const midStart = Math.max(firstCount, Math.floor((pageBuffers.length - middleCount) / 2));
      for (let i = 0; i < middleCount; i++) pageIndices.push(midStart + i);
      for (let i = 0; i < lastCount; i++) pageIndices.push(pageBuffers.length - lastCount + i);
    } else {
      // 'first' strategy: take first N pages
      for (let i = 0; i < maxPages; i++) pageIndices.push(i);
    }

    pageIndices = [...new Set(pageIndices)].sort((a, b) => a - b).slice(0, maxPages);

    const texts = [];
    let totalConfidence = 0;
    let usedPages = 0;
    const providers = new Set();

    for (let idx = 0; idx < pageIndices.length; idx += 1) {
      const pageIdx = pageIndices[idx];
      const result = await this.runVisionFallback({
        buffer: pageBuffers[pageIdx],
        mimeType: 'image/png',
        config,
        localQuality,
        promptPrefix: `Pagina ${pageIdx + 1} de ${pageBuffers.length}.`,
      });

      if (result.ocr.status === 'vision_fallback' && result.text) {
        texts.push(result.text);
        totalConfidence += Number(result.ocr.confidence || 0);
        usedPages += 1;
        if (result.ocr.provider) providers.add(result.ocr.provider);
      }
    }

    const text = normalizeOcrText(texts.join('\n\n'));
    const quality = this.evaluateQuality({
      text,
      confidence: usedPages ? totalConfidence / usedPages : 0,
    }, config);

    if (this.isUsableVisionQuality(quality, config)) {
      return {
        text: quality.text,
        ocr: {
          status: 'vision_fallback',
          confidence: Math.round(quality.confidence || 0),
          confidenceLevel: ocrEnsemble.confidenceLevel(Math.round(quality.confidence || 0)),
          // Pages may have been read by GLM-OCR (local) and/or the cloud model.
          provider: providers.size ? [...providers].join('+') : `openai:${config.visionModel}`,
          usefulChars: quality.usefulChars,
          lineCount: quality.lineCount,
          pages: pageBuffers.length,
          pagesReadByVision: usedPages,
          localConfidence: localQuality?.confidence ?? null,
        },
      };
    }

    return this.asFailedResult(quality, 'vision_fallback_empty', { pages: pageBuffers.length });
  }

  /**
   * GLM-OCR through the Lenovo's Ollama (`ollama run glm-ocr`). Runs BEFORE
   * the cloud vision models: free, local, and #1 on OmniDocBench for scanned
   * documents, tables and formulas. Returns `null` when the rung is off or
   * not configured, a `vision_fallback` result when it read the image, and a
   * `failed` result (with the reason) when Ollama/the model were unavailable
   * or produced nothing — the caller then continues down the ladder.
   *
   * The read is GATED (`ocr.gate`), never accepted at a fixed confidence:
   * a repetition loop or a cut answer (timeout, num_predict) keeps only the
   * text before the problem and is flagged; a read that disagrees with a
   * usable Tesseract read (word agreement, digits) is flagged; garbage is
   * flagged. `gate.verified` (Tesseract confirms it) is the only case where
   * the cloud is skipped. The task prompt follows the image class
   * (table / formula / text).
   */
  async runOllamaOcrFallback({
    filePath, buffer, mimeType = 'image/png', config = this.config, localQuality = null,
    signal = null, deadlineAt = null, task = null, imageType = null,
  } = {}) {
    const client = this.ollamaOcr;
    if (!client || typeof client.isEnabled !== 'function' || !client.isEnabled()) return null;
    const modelName = (() => {
      try { return client.config().model; } catch { return 'glm-ocr'; }
    })();
    const provider = `ollama:${modelName}`;
    const failed = (reason, extra = {}) => ({
      text: '',
      ocr: {
        status: 'failed',
        confidence: 0,
        provider,
        reason,
        localConfidence: localQuality?.confidence ?? null,
        ...extra,
      },
    });

    try {
      if (signal && signal.aborted) return failed('aborted');
      const remaining = deadlineAt ? deadlineAt - Date.now() : null;
      if (remaining !== null && remaining < 3000) return failed('ollama_ocr_no_time');
      const availability = await client.ensureAvailable();
      if (!availability || !availability.available) return failed(availability?.reason || 'ollama_ocr_unavailable');

      const tessText = comparableLocalText(localQuality, config);
      const chosenTask = task || ocrEnsemble.chooseGlmTask({ text: localQuality?.text || '', imageType });
      const result = await client.recognize({
        buffer,
        filePath,
        mimeType,
        task: chosenTask,
        signal,
        ...(remaining !== null ? { timeoutMs: remaining } : {}),
      });
      if (!result || !result.ok) return failed(result?.reason || 'ollama_ocr_failed');

      const raw = normalizeOcrText(ocrQuality.normalizeIllegibleMarkers(result.text));
      const text = isOcrEmptySentinel(raw) ? '' : raw;
      const gate = this._gateVisionRead(text, {
        tessText,
        loop: Boolean(result.loop),
        truncated: Boolean(result.truncated),
      });
      gate.task = result.task || chosenTask;
      gate.doneReason = result.doneReason || null;
      const confidence = ocrEnsemble.calibrateConfidence({
        agreement: gate.agreement,
        voters: tessText ? 2 : 1,
        kind: 'glm',
        garbage: gate.issues.includes('garbage'),
        loop: gate.issues.includes('loop'),
        truncated: gate.issues.includes('truncated'),
        illegibleRatio: ocrQuality.illegibleRatio(text),
      });
      const quality = this.evaluateQuality({ text, confidence }, config);
      if (!this.isUsableVisionQuality(quality, config)) {
        return this.asFailedResult(quality, result.loop ? 'ollama_ocr_loop' : 'ollama_ocr_empty', { provider, gate });
      }
      const verdict = gate.verified ? 'verified' : gate.trusted ? 'unverified' : `flagged:${gate.issues.join(',')}`;
      console.log(`[ocr-engine] ${provider} read ${quality.usefulChars} chars in ${result.durationMs ?? '?'} ms (task=${gate.task}, ${verdict}${result.tokensPerSec ? `, ${result.tokensPerSec} tok/s` : ''})`);
      return {
        text: quality.text,
        ocr: {
          status: 'vision_fallback',
          confidence,
          confidenceLevel: ocrEnsemble.confidenceLevel(confidence),
          provider: result.provider || provider,
          usefulChars: quality.usefulChars,
          lineCount: quality.lineCount,
          localConfidence: localQuality?.confidence ?? null,
          elapsedMs: result.durationMs ?? null,
          truncated: gate.issues.includes('truncated') || gate.issues.includes('loop'),
          gate,
        },
      };
    } catch (error) {
      return failed(error?.message || 'ollama_ocr_failed');
    }
  }

  /**
   * Quality gate for one vision read. `issues`: loop | truncated | garbage |
   * tesseract_disagrees | digits_disagree. `verified` only when a usable
   * Tesseract read agrees (≥ 0.6) and nothing else is wrong; `trusted` when
   * nothing is wrong (a read with no Tesseract to compare is trusted but not
   * verified). Never throws.
   */
  _gateVisionRead(text, { tessText = null, loop = false, truncated = false } = {}) {
    const issues = [];
    if (loop) issues.push('loop');
    if (truncated && !loop) issues.push('truncated');
    const assessment = ocrQuality.assessText(ocrQuality.stripIllegibleMarkers(text).slice(0, 50_000));
    const garbageReasons = (assessment.reasons || []).filter((r) => r !== 'repetition_loop');
    if (garbageReasons.length) issues.push('garbage');
    let agreement = null;
    let digitRecall = null;
    if (tessText && text) {
      const score = ocrQuality.agreementScore(tessText, text);
      agreement = Math.round(score.score * 1000) / 1000;
      // A fuller read that contains most of Tesseract's words is a
      // superset, not a disagreement.
      const coverage = score.score < 0.5 ? tokenCoverage(tessText, text) : null;
      if (score.score < 0.5 && !(coverage !== null && coverage >= 0.5)) issues.push('tesseract_disagrees');
      const digits = ocrQuality.digitAgreement(tessText, text);
      if (digits.comparable && digits.referenceCount >= 2) {
        digitRecall = Math.round(digits.recall * 1000) / 1000;
        if (digits.recall < 0.8) issues.push('digits_disagree');
      }
    }
    const trusted = issues.length === 0;
    return {
      trusted,
      verified: trusted && agreement !== null && agreement >= 0.6,
      issues,
      agreement,
      digitRecall,
      garbageReasons,
    };
  }

  /**
   * The cloud vision runtimes for OCR, in vision-runtime order (Gemini → Meta
   * → xAI → OpenRouter → OpenAI; only providers with a key), capped by
   * OCR_VISION_LADDER_MAX. The OpenAI rung keeps OCR_VISION_MODEL /
   * VISION_MODEL / gpt-4o (today's model). `exclude`: provider names already
   * used for this image (a second opinion must come from another runtime).
   */
  _cloudVisionCandidates(config = this.config, { exclude = [], env = process.env } = {}) {
    let list = [];
    try {
      const { visionRuntimeCandidates } = require('./ai/vision-runtime');
      list = visionRuntimeCandidates(env).map((c) => (c.provider === 'OpenAI' ? { ...c, model: config.visionModel } : c));
    } catch {
      list = env.OPENAI_API_KEY ? [{ provider: 'OpenAI', model: config.visionModel }] : [];
    }
    const skip = new Set((exclude || []).map((p) => String(p).toLowerCase()));
    return list.filter((c) => !skip.has(String(c.provider).toLowerCase())).slice(0, config.visionLadderMax);
  }

  /** OpenAI-compatible client for one runtime. Overridable for offline tests. */
  _visionRuntimeClient(candidate, clientConfig, timeoutMs) {
    if (typeof this.createVisionRuntimeClient === 'function') {
      return this.createVisionRuntimeClient(candidate, clientConfig, { timeoutMs });
    }
    const client = new OpenAI({
      apiKey: clientConfig.apiKey,
      ...(clientConfig.baseURL ? { baseURL: clientConfig.baseURL } : {}),
      timeout: timeoutMs,
      // The ladder is the retry: a failing runtime hands over to the next one.
      maxRetries: 0,
    });
    if (candidate.provider === 'OpenAI') {
      try { require('./ai/openai-sampling-params').wrapOpenAIChatClient(client, { provider: 'OpenAI' }); } catch { /* optional */ }
    }
    return client;
  }

  /**
   * ONE cloud read of one image through the runtime ladder: the first
   * runtime that answers wins, a dead key (401/403) or an unfunded one
   * (billing) is memoised in provider-key-health so later pages skip it, any
   * other failure moves to the next runtime. `preferred` (provider name)
   * is tried first. Bounded by `deadlineAt` and `signal`.
   *
   * Returns { ok, text, empty, provider, model, providerName, visionType,
   * truncated, finishReason, attempts } or { ok:false, reason, attempts }.
   */
  async _cloudVisionRead({
    buffer, mimeType = 'image/png', promptPrefix = '', signal = null, deadlineAt = null,
    config = this.config, exclude = [], preferred = null,
  } = {}) {
    const attempts = [];
    let candidates = this._cloudVisionCandidates(config, { exclude });
    if (preferred) {
      const idx = candidates.findIndex((c) => c.provider === preferred);
      if (idx > 0) candidates = [candidates[idx], ...candidates.slice(0, idx), ...candidates.slice(idx + 1)];
    }
    if (!candidates.length) return { ok: false, reason: 'vision_api_unavailable', attempts };
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'vision_input_missing', attempts };
    let keyHealth = null;
    let billing = null;
    let visionClientConfig = null;
    let isDefaultTemperatureOnlyModel = () => false;
    try { keyHealth = require('../utils/provider-key-health'); } catch { keyHealth = null; }
    try { billing = require('./ai/billing-failover'); } catch { billing = null; }
    try { ({ visionClientConfig } = require('./ai/vision-runtime')); } catch { visionClientConfig = null; }
    try { ({ isDefaultTemperatureOnlyModel } = require('./ai/openai-sampling-params')); } catch { /* keep default */ }

    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    const userText = `${promptPrefix ? `${promptPrefix} ` : ''}Transcribe COMPLETO y textual todo el texto legible de esta imagen, conservando su estructura (títulos, listas, tablas) en Markdown y sin resumir. Lo que no se pueda leer va como [ilegible]; una palabra dudosa va como [¿palabra?]. Si no hay texto legible, responde exactamente: OCR_EMPTY`;

    for (const candidate of candidates) {
      if (signal && signal.aborted) return { ok: false, reason: 'aborted', attempts };
      const remaining = deadlineAt ? deadlineAt - Date.now() : config.visionTimeoutMs;
      if (remaining < 2000) {
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, reason: 'no_time' });
        break;
      }
      const clientConfig = visionClientConfig ? visionClientConfig(candidate.provider) : { apiKey: process.env.OPENAI_API_KEY };
      if (!clientConfig || !clientConfig.apiKey || clientConfig.protocol === 'anthropic') {
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, reason: 'not_configured' });
        continue;
      }
      if (keyHealth && keyHealth.isRejected(candidate.provider, clientConfig.apiKey)) {
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, reason: 'key_rejected' });
        continue;
      }
      const timeoutMs = Math.max(1000, Math.min(config.visionTimeoutMs, remaining));
      const payload = {
        model: candidate.model,
        temperature: 0,
        max_tokens: config.visionMaxTokens,
        messages: [
          { role: 'system', content: OCR_VISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
      };
      if (candidate.provider === 'OpenAI' && isDefaultTemperatureOnlyModel(candidate.model)) {
        // Reasoning-class ids (gpt-5.x, o-series) reject temperature and
        // max_tokens.
        delete payload.temperature;
        payload.max_completion_tokens = payload.max_tokens;
        delete payload.max_tokens;
      }
      const started = Date.now();
      try {
        const client = this._visionRuntimeClient(candidate, clientConfig, timeoutMs);
        const response = await client.chat.completions.create(payload, { timeout: timeoutMs, ...(signal ? { signal } : {}) });
        const choice = response && response.choices && response.choices[0];
        const content = choice && choice.message ? choice.message.content : '';
        const rawText = typeof content === 'string'
          ? content
          : (Array.isArray(content) ? content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '');
        const { text, visionType } = splitVisionTypeLine(normalizeOcrText(rawText));
        const finishReason = choice && choice.finish_reason ? String(choice.finish_reason) : null;
        const empty = !text || isOcrEmptySentinel(text);
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: true, empty, ms: Date.now() - started });
        return {
          ok: true,
          text: empty ? '' : normalizeOcrText(ocrQuality.normalizeIllegibleMarkers(text)),
          empty,
          provider: `${String(candidate.provider).toLowerCase()}:${candidate.model}`,
          providerName: candidate.provider,
          model: candidate.model,
          visionType,
          finishReason,
          truncated: finishReason === 'length' || finishReason === 'max_tokens',
          attempts,
        };
      } catch (error) {
        if (signal && signal.aborted) return { ok: false, reason: 'aborted', attempts };
        const cause = error && error.cause ? error.cause : error;
        const status = Number(cause?.status || cause?.statusCode || error?.status || 0) || null;
        let reason = 'failed';
        if (keyHealth && keyHealth.isInvalidKeyError(cause)) {
          reason = 'key_rejected';
          try { keyHealth.markRejected(candidate.provider, clientConfig.apiKey, cause); } catch { /* advisory */ }
        } else if (billing && billing.isBillingError(cause)) {
          reason = 'billing';
          try { keyHealth && keyHealth.markRejected(candidate.provider, clientConfig.apiKey, cause, process.env, { reason: 'billing' }); } catch { /* advisory */ }
        } else if (/timeout|timed out|aborted/i.test(String(error?.name || '') + String(error?.message || ''))) {
          reason = 'timeout';
        } else if (status === 429) {
          reason = 'rate_limited';
        } else if (status && status >= 500) {
          reason = `http_${status}`;
        } else if (status) {
          reason = `http_${status}`;
        }
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, status, reason, ms: Date.now() - started });
        console.warn(`[ocr-engine] vision OCR ${candidate.provider}:${candidate.model} failed (${reason}${status ? ` ${status}` : ''}) — trying the next runtime`);
      }
    }
    const last = attempts.length ? attempts[attempts.length - 1] : null;
    return { ok: false, reason: last && last.reason === 'no_time' ? 'vision_no_time' : 'vision_fallback_failed', attempts };
  }

  /**
   * Should the cloud read go by horizontal bands? Only for large pages
   * (long side ≥ OCR_VISION_TILE_MIN_SIDE) that are dense (many lines or
   * characters in the local read, dense-text class) or very tall: the APIs
   * downscale a whole page until small text is unreadable.
   */
  _shouldTileForVision({ width, height, localQuality = null, imageType = null } = {}, config = this.config) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!config.visionTileEnabled || w <= 0 || h <= 0) return false;
    if (Math.max(w, h) < config.visionTileMinSide) return false;
    const tall = h / w >= 2.2;
    const dense = Number(localQuality?.lineCount || 0) >= 30
      || Number(localQuality?.usefulChars || 0) >= 1200
      || imageType === 'text_dense';
    return tall || dense;
  }

  /**
   * Row ink profile of an upright page (`ink[y]` = dark pixels in row y of
   * a ≤300-px-wide copy) for snapping band cuts between text lines. Null on
   * any failure.
   */
  async _rowInkProfile(buffer) {
    try {
      const { data, info } = await sharp(buffer)
        .resize({ width: 300, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const ink = new Uint32Array(info.height);
      let sum = 0;
      for (let i = 0; i < data.length; i += info.channels) sum += data[i];
      const mean = sum / Math.max(1, data.length / info.channels);
      const threshold = Math.max(40, mean - 40);
      for (let y = 0; y < info.height; y += 1) {
        let count = 0;
        const row = y * info.width * info.channels;
        for (let x = 0; x < info.width; x += 1) if (data[row + x * info.channels] < threshold) count += 1;
        ink[y] = count;
      }
      return { ink, scale: info.width / Math.max(1, (await sharp(buffer).metadata()).width || info.width) };
    } catch {
      return null;
    }
  }

  /**
   * Read an upright page band by band through the cloud ladder (the runtime
   * that answered the first band is tried first for the next ones) and merge
   * the bands in reading order. Null when tiling is not possible or a band
   * could not be read (the caller then reads the whole image).
   */
  async _cloudReadBands(source, { width, height, promptPrefix = '', signal = null, deadlineAt = null, config = this.config, exclude = [] } = {}) {
    let bands = ocrEnsemble.planBands(width, height, { maxBands: config.visionTileMax });
    if (bands.length < 2) return null;
    const profile = await this._rowInkProfile(source);
    if (profile && profile.scale > 0 && profile.scale <= 1) {
      const s = profile.scale;
      const scaled = bands.map((b) => ({ left: 0, top: Math.round(b.top * s), width: Math.round(b.width * s), height: Math.max(1, Math.round(b.height * s)) }));
      const snapped = ocrEnsemble.snapCutsToWhitespace(scaled, profile.ink);
      if (snapped !== scaled) {
        bands = snapped.map((b, i) => {
          const top = Math.max(0, Math.round(b.top / s));
          const bottom = i === snapped.length - 1 ? height : Math.min(height, Math.round((b.top + b.height) / s));
          return { left: 0, top, width, height: Math.max(1, bottom - top) };
        });
      }
    }
    const texts = [];
    const attempts = [];
    let preferred = null;
    let first = null;
    let truncated = false;
    for (let i = 0; i < bands.length; i += 1) {
      if (signal && signal.aborted) return null;
      if (deadlineAt && deadlineAt - Date.now() < 3000) return null;
      let crop;
      try {
        crop = await sharp(source).extract(bands[i]).png().toBuffer();
      } catch {
        return null;
      }
      const prepared = typeof this.ocrInput.toVisionImage === 'function'
        ? await this.ocrInput.toVisionImage(crop, { mime: 'image/png' })
        : { buffer: crop, mime: 'image/png' };
      const read = await this._cloudVisionRead({
        buffer: prepared.buffer || crop,
        mimeType: prepared.mime || 'image/png',
        promptPrefix: `${promptPrefix ? `${promptPrefix} ` : ''}Franja ${i + 1} de ${bands.length} (de arriba abajo) de la misma página: transcribe solo lo que se ve en esta franja; si una línea está cortada por el borde, transcribe solo la parte legible.`,
        signal,
        deadlineAt,
        config,
        exclude,
        preferred,
      });
      attempts.push(...(read.attempts || []));
      if (!read.ok) return null;
      if (!first) first = read;
      preferred = read.providerName;
      truncated = truncated || read.truncated;
      texts.push(read.text || '');
    }
    const text = ocrEnsemble.mergeBandTexts(texts);
    return {
      ok: true,
      text,
      empty: !text,
      provider: first.provider,
      providerName: first.providerName,
      model: first.model,
      visionType: first.visionType,
      truncated,
      tiled: bands.length,
      attempts,
    };
  }

  /**
   * The cloud rung for one image: by bands for large dense/tall pages
   * (`sourceBuffer` keeps the native upright resolution), otherwise the
   * whole image; a whole read cut at the token limit is retried by bands
   * when the page allows it.
   */
  async runCloudVisionLadder({
    buffer, sourceBuffer = null, mimeType = 'image/png', promptPrefix = '', signal = null,
    deadlineAt = null, config = this.config, localQuality = null, imageType = null, exclude = [],
  } = {}) {
    const native = Buffer.isBuffer(sourceBuffer) ? sourceBuffer : buffer;
    let dims = null;
    let upright = null;
    const ensureUpright = async () => {
      if (upright) return upright;
      try {
        upright = await sharp(native).rotate().png().toBuffer();
        const meta = await sharp(upright).metadata();
        dims = { width: meta.width || 0, height: meta.height || 0 };
      } catch { upright = null; }
      return upright;
    };
    try {
      const meta = await sharp(native).metadata();
      const swap = Number(meta.orientation) >= 5;
      dims = { width: (swap ? meta.height : meta.width) || 0, height: (swap ? meta.width : meta.height) || 0 };
    } catch { dims = null; }

    const attempts = [];
    if (dims && this._shouldTileForVision({ ...dims, localQuality, imageType }, config) && await ensureUpright()) {
      const banded = await this._cloudReadBands(upright, { ...dims, promptPrefix, signal, deadlineAt, config, exclude });
      if (banded) return banded;
    }
    if (signal && signal.aborted) return { ok: false, reason: 'aborted', attempts };
    const whole = await this._cloudVisionRead({ buffer, mimeType, promptPrefix, signal, deadlineAt, config, exclude });
    attempts.push(...(whole.attempts || []));
    if (whole.ok && whole.truncated && dims && Math.max(dims.width, dims.height) >= 1400 && await ensureUpright()) {
      const banded = await this._cloudReadBands(upright, { ...dims, promptPrefix, signal, deadlineAt, config, exclude });
      if (banded && banded.text) return { ...banded, attempts: [...attempts, ...(banded.attempts || [])] };
    }
    return { ...whole, attempts };
  }

  /**
   * The vision ladder for ONE image (photo, scan, PDF page):
   *   1. GLM-OCR (local, gated). A read Tesseract confirms ends here.
   *   2. Cloud runtimes (Gemini → Meta → xAI → OpenRouter → OpenAI, first
   *      healthy one; by bands for large dense pages; anti-hallucination
   *      prompt with the [ilegible] convention).
   *   3. When GLM and the cloud disagree, a second cloud runtime votes
   *      (OCR_ENSEMBLE_MAX_CLOUD_CALLS).
   *   4. Reconciliation: the read the others agree with most is the primary;
   *      words another engine contradicts become `[¿palabra?]`; confidence is
   *      calibrated from agreement (never a fixed 95).
   * Bounded by `deadlineAt` (default OCR_VISION_LADDER_BUDGET_MS) and
   * `signal`. `allowCloud: false` stops after the local GLM rung (paid rungs
   * off, e.g. full scanned PDFs without SIRAGPT_OCR_PDF_VISION_CLOUD=1).
   * Same result shape as before: `vision_fallback` or `failed`; a vision
   * read the gate rejects in favour of a usable Tesseract read fails with
   * `vision_read_gated` (the caller keeps the local read).
   */
  async runVisionFallback({
    filePath, buffer, mimeType = 'image/png', config = this.config, localQuality = null, promptPrefix = '',
    signal = null, deadlineAt = null, sourceBuffer = null, imageType = null, allowCloud = true,
  } = {}) {
    const started = Date.now();
    const deadline = deadlineAt || (started + config.visionLadderBudgetMs);
    if (signal && signal.aborted) return this.abortedResult();
    let imageBuffer = Buffer.isBuffer(buffer) ? buffer : null;
    if (!imageBuffer && filePath) {
      try { imageBuffer = await fs.readFile(filePath); } catch { imageBuffer = null; }
    }

    // Rung 1: local GLM-OCR (gated).
    const glm = await this.runOllamaOcrFallback({
      filePath, buffer: imageBuffer || buffer, mimeType, config, localQuality, signal, deadlineAt: deadline, imageType,
    });
    if (signal && signal.aborted) return this.abortedResult();
    const glmRead = glm && glm.ocr && glm.ocr.status === 'vision_fallback' && glm.text ? glm : null;
    const glmReason = glm && !glmRead ? glm.ocr?.reason || null : null;
    const reads = [];
    if (glmRead) {
      reads.push({
        engine: glmRead.ocr.provider,
        kind: 'glm',
        text: glmRead.text,
        truncated: Boolean(glmRead.ocr.truncated),
        loop: Boolean(glmRead.ocr.gate && glmRead.ocr.gate.issues.includes('loop')),
        gate: glmRead.ocr.gate,
      });
      const gate = glmRead.ocr.gate || {};
      const verifiedLocally = Boolean(gate.verified);
      // A clean GLM read nothing could confirm still gets a cloud second
      // opinion (plausible-looking hallucinations pass every text check),
      // unless it is a tiny read (a logo, a stamp: low stakes, not worth a
      // paid call) or verification is switched off.
      const smallClean = gate.trusted && Number(glmRead.ocr.usefulChars || 0) < config.ensembleVerifyMinChars;
      const skipCloud = verifiedLocally || (gate.trusted && (!config.ensembleVerifyGlm || smallClean));
      if (skipCloud) {
        return this._finalizeVisionReads(reads, { config, localQuality, started, glm: glmRead, attempts: [], tiled: 0 });
      }
    }

    // Rung 2: cloud runtimes.
    const attempts = [];
    let cloud = null;
    let cloudCalls = 0;
    if (allowCloud && imageBuffer && deadline - Date.now() >= 2000) {
      cloud = await this.runCloudVisionLadder({
        buffer: imageBuffer, sourceBuffer, mimeType, promptPrefix, signal, deadlineAt: deadline, config, localQuality, imageType,
      });
      attempts.push(...(cloud.attempts || []));
      if (cloud.ok) cloudCalls += 1;
    }
    if (signal && signal.aborted) return this.abortedResult();
    if (cloud && cloud.ok && cloud.text) {
      reads.unshift({ engine: cloud.provider, kind: 'vlm', text: cloud.text, truncated: Boolean(cloud.truncated), loop: false, visionType: cloud.visionType, providerName: cloud.providerName });
    }

    // Rung 3: a second cloud opinion when GLM and the cloud disagree.
    const cloudRead = reads.find((r) => r.kind === 'vlm');
    if (allowCloud && cloudRead && glmRead && cloudCalls < config.ensembleMaxCloudCalls && deadline - Date.now() >= 5000) {
      const score = ocrQuality.agreementScore(cloudRead.text, glmRead.text);
      if (!score.comparable || score.score < 0.5) {
        const second = await this._cloudVisionRead({
          buffer: imageBuffer, mimeType, promptPrefix, signal, deadlineAt: deadline, config, exclude: [cloudRead.providerName],
        });
        attempts.push(...(second.attempts || []));
        if (second.ok && second.text) {
          cloudCalls += 1;
          reads.push({ engine: second.provider, kind: 'vlm', text: second.text, truncated: Boolean(second.truncated), loop: false, visionType: second.visionType, providerName: second.providerName });
        }
      }
    }
    if (signal && signal.aborted) return this.abortedResult();

    if (!reads.length) {
      const noCloud = !this._cloudVisionCandidates(config).length;
      const cloudEmpty = cloud && cloud.ok && cloud.empty;
      const reason = !allowCloud
        ? (glm && glm.ocr && /empty/.test(String(glm.ocr.reason || '')) ? 'vision_fallback_empty' : 'vision_cloud_disabled')
        : noCloud ? 'vision_api_unavailable' : cloudEmpty ? 'vision_fallback_empty' : (cloud && cloud.reason) || 'vision_fallback_failed';
      const failed = this.asFailedResult(null, reason, {
        provider: cloud && cloud.ok ? cloud.provider : null,
        localConfidence: localQuality?.confidence ?? null,
        ...(glmReason ? { ollamaOcr: glmReason } : {}),
        ...(cloud && cloud.visionType ? { visionType: cloud.visionType } : {}),
        visionLadder: { attempted: attempts.length > 0 || Boolean(glm), attempts: attempts.slice(0, 12), elapsedMs: Date.now() - started },
      });
      failed.ocr.confidence = 0;
      return failed;
    }
    return this._finalizeVisionReads(reads, {
      config, localQuality, started, glm: glmRead, glmReason, attempts, tiled: cloud && cloud.tiled ? cloud.tiled : 0,
      visionType: (cloud && cloud.visionType) || null,
      // The cloud saw NO text where GLM read some: a disagreement too.
      cloudEmpty: Boolean(cloud && cloud.ok && cloud.empty),
    });
  }

  /**
   * Turn the vision reads (+ the Tesseract read when usable) into the final
   * `vision_fallback` result: primary = the complete read the others agree
   * with most, reconciliation marks contested words, calibrated confidence.
   */
  _finalizeVisionReads(reads, {
    config = this.config, localQuality = null, started = Date.now(), glm = null, glmReason = null,
    attempts = [], tiled = 0, visionType = null, cloudEmpty = false,
  } = {}) {
    const vision = reads.filter((r) => r && r.text);
    // Primary: prefer complete reads, then the highest summed agreement with
    // the other vision reads; ties keep the cloud read (listed first).
    const scored = vision.map((r, i) => {
      let sum = 0;
      for (let j = 0; j < vision.length; j += 1) {
        if (j === i) continue;
        sum += ocrQuality.agreementScore(r.text, vision[j].text).score;
      }
      return { r, i, sum };
    });
    scored.sort((a, b) => (Number(a.r.truncated) - Number(b.r.truncated)) || (b.sum - a.sum) || (a.i - b.i));
    const ordered = scored.map((s) => s.r);
    const primary = ordered[0];
    const tessText = comparableLocalText(localQuality, config);

    // The gate DECIDES, it does not only flag: a primary vision read that
    // looks like garbage, still loops, or contradicts a usable Tesseract
    // read — with no other vision read backing it — never replaces that
    // read. The caller keeps the Tesseract text with its warning.
    if (tessText) {
      const gated = this._gatePrimaryAgainstLocal(primary, ordered, tessText);
      if (gated) {
        const failed = this.asFailedResult(null, 'vision_read_gated', {
          provider: primary.engine,
          localConfidence: localQuality?.confidence ?? null,
          gate: { ...(primary.gate || {}), trusted: false, verified: false, issues: gated.issues, agreement: gated.agreement, coverage: gated.coverage },
          ...(glmReason ? { ollamaOcr: glmReason } : {}),
          ...(visionType ? { visionType } : {}),
          visionLadder: { attempted: true, attempts: attempts.slice(0, 12), tiled: tiled || 0, elapsedMs: Date.now() - started },
        });
        failed.ocr.confidence = 0;
        console.log(`[ocr-engine] vision ladder: ${primary.engine} read rejected by the gate (${gated.issues.join(',')}, agreement=${gated.agreement}) — keeping the local read`);
        return failed;
      }
    }

    const voters = ordered.map((r) => ({ engine: r.engine, kind: r.kind, text: r.text }));
    if (tessText) voters.push({ engine: 'tesseract', kind: 'tesseract', text: tessText });
    const rec = ocrEnsemble.reconcile(voters);

    let text = normalizeOcrText(rec.text);
    const truncated = Boolean(primary.truncated || primary.loop);
    if (truncated) text = `${text}\n\n${TRUNCATED_MARK}`;
    const counts = ocrQuality.countIllegible(text);
    const assessment = ocrQuality.assessText(ocrQuality.stripIllegibleMarkers(text).slice(0, 50_000));
    const tessDisagrees = rec.agreements.some((a) => a.kind === 'tesseract' && !a.comparable);
    let confidence = ocrEnsemble.calibrateConfidence({
      agreement: rec.agreement,
      voters: rec.voters,
      kind: primary.kind === 'glm' ? 'glm' : 'vlm',
      garbage: (assessment.reasons || []).some((r) => r !== 'repetition_loop'),
      loop: Boolean(primary.loop),
      truncated: Boolean(primary.truncated) && !primary.loop,
      illegibleRatio: ocrQuality.illegibleRatio(text),
      uncertainShare: rec.tokens ? rec.uncertainMarked / rec.tokens : 0,
      contestedNumbers: rec.contestedNumbers,
    });
    if (rec.conflict || cloudEmpty) confidence = Math.max(5, confidence - 20);
    else if (tessDisagrees && rec.voters < 2) confidence = Math.max(5, confidence - 10);

    const quality = this.evaluateQuality({ text, confidence }, config);
    if (!this.isUsableVisionQuality(quality, config)) {
      const failed = this.asFailedResult(quality, 'vision_fallback_empty', { provider: primary.engine });
      if (visionType) failed.ocr.visionType = visionType;
      return failed;
    }
    const engines = [...new Set(rec.engines)];
    const result = {
      text: quality.text,
      ocr: {
        status: 'vision_fallback',
        confidence,
        confidenceLevel: ocrEnsemble.confidenceLevel(confidence),
        provider: primary.engine,
        engines,
        usefulChars: quality.usefulChars,
        lineCount: quality.lineCount,
        localConfidence: localQuality?.confidence ?? null,
        illegible: counts.illegible,
        uncertain: counts.uncertain,
        truncated,
        ensemble: {
          voters: rec.voters,
          agreement: rec.agreement,
          uncertainMarked: rec.uncertainMarked,
          contestedNumbers: rec.contestedNumbers,
          conflict: rec.conflict || cloudEmpty,
          primary: rec.primary,
        },
        elapsedMs: Date.now() - started,
        visionLadder: { attempted: true, attempts: attempts.slice(0, 12), tiled: tiled || 0 },
        ...((visionType || primary.visionType) ? { visionType: visionType || primary.visionType } : {}),
        ...(glm && glm.ocr && glm.ocr.gate ? { gate: glm.ocr.gate } : {}),
        ...(glmReason ? { ollamaOcr: glmReason } : {}),
      },
    };
    console.log(`[ocr-engine] vision ladder: primary=${primary.engine} engines=${engines.join('+')} agreement=${rec.agreement === null ? 'n/a' : rec.agreement} conf=${confidence} uncertain=${rec.uncertainMarked} illegible=${counts.illegible}${tiled ? ` bands=${tiled}` : ''} ms=${Date.now() - started}`);
    return result;
  }

  /**
   * Should a usable Tesseract read win over the primary vision read?
   * `{ issues, agreement, coverage }` when it should, else null:
   *   - garbage: the vision read (or its GLM gate) looks like garbage;
   *   - loop: a repetition loop survived in the text;
   *   - tesseract_disagrees: word/char agreement < 0.5 AND the vision read
   *     does not contain most of Tesseract's words (a fuller read of the
   *     same page is a superset, not a contradiction).
   * Another non-garbage vision read agreeing with the primary (≥ 0.5)
   * outvotes Tesseract.
   */
  _gatePrimaryAgainstLocal(primary, reads = [], tessText = null) {
    if (!primary || !primary.text || !tessText) return null;
    const issues = [];
    const assessment = ocrQuality.assessText(ocrQuality.stripIllegibleMarkers(primary.text).slice(0, 50_000));
    const reasons = assessment.reasons || [];
    const gateIssues = primary.gate && Array.isArray(primary.gate.issues) ? primary.gate.issues : [];
    if (reasons.some((r) => r !== 'repetition_loop') || gateIssues.includes('garbage')) issues.push('garbage');
    if (reasons.includes('repetition_loop')) issues.push('loop');
    const score = ocrQuality.agreementScore(tessText, primary.text);
    const agreement = Math.round(score.score * 1000) / 1000;
    const coverage = tokenCoverage(tessText, primary.text);
    if (score.score < 0.5 && (coverage === null || coverage < 0.5)) issues.push('tesseract_disagrees');
    if (!issues.length) return null;
    const backed = reads.some((r) => r && r !== primary && r.text
      && !ocrQuality.assessText(ocrQuality.stripIllegibleMarkers(r.text).slice(0, 50_000)).garbageLikely
      && ocrQuality.agreementScore(primary.text, r.text).score >= 0.5);
    if (backed) return null;
    return { issues, agreement, coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000 };
  }

  asLocalResult(localResult) {
    const quality = localResult.quality;
    const confidence = Math.round(quality.confidence);
    // A garbage-looking local read is never presented as better than «baja».
    const level = quality.garbageLikely ? 'baja' : ocrEnsemble.confidenceLevel(confidence);
    return {
      text: quality.text,
      ocr: {
        status: 'local_ok',
        confidence,
        confidenceLevel: level,
        provider: 'tesseract',
        usefulChars: quality.usefulChars,
        lineCount: quality.lineCount,
        variants: localResult.variants || null,
        ...(quality.garbageLikely ? { garbageLikely: true } : {}),
      },
    };
  }

  asFailedResult(quality, error, extra = {}) {
    return {
      text: '',
      ocr: {
        status: 'failed',
        confidence: Math.round(Number(quality?.confidence || 0)),
        provider: 'tesseract',
        usefulChars: quality?.usefulChars || 0,
        lineCount: quality?.lineCount || 0,
        reason: error || quality?.reason || 'ocr_failed',
        ...extra,
      },
    };
  }

  normalizeText(text) {
    return normalizeOcrText(text);
  }
}

module.exports = new OcrEngine();
// Test seams only (not part of the engine API).
module.exports._internals = {
  OCR_VISION_SYSTEM_PROMPT,
  TRUNCATED_MARK,
  isOcrEmptySentinel,
  splitVisionTypeLine,
  comparableLocalText,
  recognizeWithin,
  tesseractWorkerOptions,
  tessdataOptions,
  startTesseractWorker,
  OcrWorkerInitError,
  workerState,
  resetWorkerState,
  localImageBudgetMs,
  TESSERACT_NOISE_RE,
};
