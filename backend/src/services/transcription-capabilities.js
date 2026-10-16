'use strict';

/**
 * transcription-capabilities — what the transcription and OCR stack can
 * actually do on THIS host, read from the feature detections the engines
 * already export (never re-implemented here):
 *
 *   - STT ladder: audio-transcriber providerOrder / cloudProviders /
 *     providerInCooldown / escalationRungs (no key ever leaves this module);
 *   - local engine: local-whisper-engine describeLocalWhisperAvailability,
 *     whisperCliCapabilities (`whisper-cli -h`, memoized), vadModelPath,
 *     vadRequested, resolveThreadCount;
 *   - ffmpeg filters: media-probe detectFfmpegFilters (definitive vs
 *     unknown, shared with the video paths) or, without it, audio-transcriber
 *     ffmpegFilterSet; VARIANT_FILTERS (enhanced-audio second opinions);
 *   - OCR inputs: ocr-input getOcrInputCapabilities (heif-dec, ffmpeg,
 *     tesseract CLI, tessdata, OSD) and resolveLocalTessdata; ocr-engine's
 *     worker state (local tessdata that failed to load once → CDN path);
 *   - GLM-OCR: ollama-ocr describe() (memo only) or ensureAvailable() when a
 *     network probe is allowed (the admin endpoint; never at boot);
 *   - cloud vision runtimes: ai/vision-runtime visionRuntimeCandidates;
 *   - dictation ladder policy (dictationLadderOptions): the single source of
 *     truth POST /api/elevenlabs/speech-to-text uses (free plans on-host by
 *     default) and that the report shows.
 *
 * Every probe is isolated (try/catch + its own timeout): one that throws or
 * hangs marks the report `status: 'degraded'` with a `probeErrors` entry and
 * the rest of the report is still filled. Never throws, never logs a key,
 * transcript, OCR text or file content.
 *
 * `logBootSummary({ logger })` writes ONE line (`[transcription]
 * capabilities …`) after boot; GET /api/admin/transcription-capabilities
 * returns the full report.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MEMO_TTL_MS = 60_000;
const SUMMARY_MAX_CHARS = 900;

// Languages the OCR stack is expected to read offline (apk tesseract-ocr-data-*).
const EXPECTED_TESSDATA = Object.freeze(['eng', 'spa', 'osd', 'por', 'fra', 'ita', 'deu']);
// Filters the transcription paths use or feature-detect (reported, not required).
const REPORTED_FILTERS = Object.freeze([
  'silencedetect', 'highpass', 'lowpass', 'loudnorm', 'dynaudnorm', 'speechnorm',
  'afftdn', 'anlmdn', 'arnndn', 'astats', 'ebur128', 'aphasemeter', 'select', 'scdet', 'showinfo',
]);
const WHISPER_FLAG_LABELS = Object.freeze({
  outputJsonFull: 'ojf',
  vad: 'vad',
  maxContext: 'mc',
  suppressNst: 'sns',
  detectLanguage: 'dl',
  carryInitialPrompt: 'carry-prompt',
});

const DEFAULT_LOADERS = Object.freeze({
  audioTranscriber: () => require('./audio-transcriber'),
  localWhisper: () => require('./local-whisper-engine'),
  mediaProbe: () => require('./media-probe'),
  ocrEngine: () => require('./ocr-engine'),
  ocrInput: () => require('./ocr-input'),
  ollamaOcr: () => require('./ollama-ocr'),
  visionRuntime: () => require('./ai/vision-runtime'),
  voiceStudio: () => require('./ai/voicestudio-client'),
});

function oneLine(value, max = 120) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function errorCode(err) {
  if (!err) return 'failed';
  if (err.code === 'PROBE_TIMEOUT') return 'timeout';
  if (err.code === 'MODULE_UNAVAILABLE') return 'module_unavailable';
  const code = typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(err.code) ? err.code : null;
  return code || oneLine(err.name || 'failed', 40) || 'failed';
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    // Not unref'd: a hung probe must still settle (it is cleared on completion).
    timer = setTimeout(() => reject(Object.assign(new Error('probe timed out'), { code: 'PROBE_TIMEOUT' })), Math.max(1, ms));
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Module lookup. Without injected modules every engine is required lazily
 * (a require that throws is «unavailable»). With injected modules (tests,
 * ad-hoc callers) ONLY those are used: an engine left out is unavailable,
 * so an injected report never spawns a real binary.
 */
function moduleResolver(modules = null) {
  const cache = new Map();
  const useDefaults = !modules;
  const given = modules || {};
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let mod = null;
    const injected = given[name];
    try {
      if (injected && typeof injected === 'object') mod = injected;
      else if (typeof injected === 'function') mod = injected();
      else if (useDefaults && DEFAULT_LOADERS[name]) mod = DEFAULT_LOADERS[name]();
    } catch { mod = null; }
    cache.set(name, mod || null);
    return mod || null;
  };
}

function requireModule(resolve, name) {
  const mod = resolve(name);
  if (!mod) throw Object.assign(new Error(`${name} unavailable`), { code: 'MODULE_UNAVAILABLE' });
  return mod;
}

function fnOf(mod, name) {
  return mod && typeof mod[name] === 'function' ? mod[name].bind(mod) : null;
}

function basename(p) {
  if (typeof p !== 'string' || !p) return null;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

// ── Dictation ladder policy (single source of truth) ───────────────────────
// POST /api/elevenlabs/speech-to-text asks this which rungs a dictation may
// use, and the report shows the same answer.
//   - SIRAGPT_DICTATION_PROVIDERS (e.g. «local,voicestudio» or «groq,local»)
//     sets the ladder for every plan.
//   - Otherwise FREE plans stay on-host (whisper.cpp, then Sira Voz): free
//     dictation never spends paid STT credit or sends audio off the host,
//     unless an operator opts in with SIRAGPT_DICTATION_FREE_CLOUD=1 (then the
//     shared TRANSCRIBE_PROVIDERS order).
//   - PAID plans use the shared TRANSCRIBE_PROVIDERS order after Scribe.
// `escalationProviders: []` keeps an operator-enabled paid escalation rung
// (TRANSCRIBE_ESCALATION_PROVIDERS) off the on-host free path too.
const DICTATION_FREE_PROVIDERS = Object.freeze(['local', 'voicestudio']);

function envFlag(value) {
  return /^(1|true|on|yes)$/i.test(String(value || '').trim());
}

function parseDictationProviders(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const list = [];
  for (const item of text.split(',')) {
    const name = item.trim().toLowerCase();
    if (/^[a-z]{2,20}$/.test(name) && !list.includes(name)) list.push(name);
  }
  return list.length ? list : null;
}

/**
 * Ladder restriction for one dictation: { providers?: string[],
 * escalationProviders?: string[], policy }. No `providers` → the shared
 * TRANSCRIBE_PROVIDERS order. Pure; never throws.
 */
function dictationLadderOptions(env = process.env, { paid = false } = {}) {
  const e = env || {};
  const explicit = parseDictationProviders(e.SIRAGPT_DICTATION_PROVIDERS);
  if (explicit) return { providers: explicit, policy: 'env' };
  if (paid) return { policy: 'shared' };
  if (envFlag(e.SIRAGPT_DICTATION_FREE_CLOUD)) return { policy: 'shared' };
  return { providers: DICTATION_FREE_PROVIDERS.slice(), escalationProviders: [], policy: 'on_host' };
}

// ── Probes ──────────────────────────────────────────────────────────────────

function probeStt(resolve, env) {
  const at = requireModule(resolve, 'audioTranscriber');
  const options = { env };
  const order = fnOf(at, 'providerOrder') ? at.providerOrder(options) : [];
  const cloud = fnOf(at, 'cloudProviders') ? at.cloudProviders(options) : [];
  const inCooldown = fnOf(at, 'providerInCooldown');
  const ladder = cloud.map((rung) => ({
    name: oneLine(rung.name, 40),
    kind: 'cloud',
    model: rung.model ? oneLine(rung.model, 80) : null,
    cooldown: inCooldown ? Boolean(inCooldown(rung)) : false,
  }));
  let voiceStudioConfigured = false;
  try {
    const vs = resolve('voiceStudio');
    voiceStudioConfigured = Boolean(vs && typeof vs.isConfigured === 'function' && vs.isConfigured(options));
  } catch { voiceStudioConfigured = false; }
  if (order.includes('voicestudio') && voiceStudioConfigured) {
    ladder.push({ name: 'voicestudio', kind: 'local', model: 'voicestudio-whisperx', cooldown: false });
  }
  if (order.includes('local')) ladder.push({ name: 'local', kind: 'local', model: null, cooldown: false });

  let escalation = [];
  if (fnOf(at, 'escalationRungs')) {
    try {
      escalation = at.escalationRungs(options, cloud).map((rung) => ({
        name: oneLine(rung.name, 40),
        model: rung.model ? oneLine(rung.model, 80) : null,
        cooldown: inCooldown ? Boolean(inCooldown(rung)) : false,
      }));
    } catch { escalation = []; }
  }
  const requestedEscalation = fnOf(at, 'escalationProviderNames') ? at.escalationProviderNames(options) : [];
  const elevenlabsKey = Boolean(String(env.ELEVENLABS_API_KEY || '').trim());
  const ladderLabel = (opts) => (opts.providers ? opts.providers.join(',') : 'ladder');
  const free = dictationLadderOptions(env, { paid: false });
  const paid = dictationLadderOptions(env, { paid: true });
  return {
    order: order.map((name) => oneLine(name, 40)),
    ladder,
    escalation,
    escalationRequested: requestedEscalation.map((name) => oneLine(name, 40)),
    voiceStudio: { configured: voiceStudioConfigured, inLadder: order.includes('voicestudio') },
    dictation: {
      scribeForPaidPlans: elevenlabsKey,
      // 'ladder' = the shared TRANSCRIBE_PROVIDERS order above.
      free: { providers: oneLine(ladderLabel(free), 120), policy: free.policy },
      paid: { providers: oneLine(ladderLabel(paid), 120), policy: paid.policy },
    },
  };
}

function probeLocal(resolve, env) {
  const lw = requireModule(resolve, 'localWhisper');
  const options = { env };
  const availability = fnOf(lw, 'describeLocalWhisperAvailability') ? lw.describeLocalWhisperAvailability(options) : null;
  let threads = null;
  try { threads = fnOf(lw, 'resolveThreadCount') ? lw.resolveThreadCount(options) : null; } catch { threads = null; }
  return {
    ok: Boolean(availability && availability.ok),
    code: availability ? availability.code || null : 'unknown',
    reason: availability && availability.reason ? oneLine(availability.reason, 200) : null,
    bin: availability ? availability.bin || null : null,
    model: availability ? availability.model || null : null,
    threads: Number.isFinite(threads) ? threads : null,
  };
}

async function probeWhisperFlags(resolve, env, local) {
  const lw = requireModule(resolve, 'localWhisper');
  if (!local || !local.bin) return { read: false, reason: 'binary_missing', flags: null };
  if (!fnOf(lw, 'whisperCliCapabilities')) return { read: false, reason: 'not_supported', flags: null };
  const caps = await lw.whisperCliCapabilities(local.bin, { env });
  const flags = {};
  for (const key of Object.keys(WHISPER_FLAG_LABELS)) flags[key] = Boolean(caps && caps[key] === true);
  return { read: true, reason: null, flags };
}

function probeVad(resolve, env, flags) {
  const lw = requireModule(resolve, 'localWhisper');
  const options = { env };
  const model = fnOf(lw, 'vadModelPath') ? lw.vadModelPath(options) : null;
  const requested = fnOf(lw, 'vadRequested') ? Boolean(lw.vadRequested(options)) : false;
  const flagSupported = Boolean(flags && flags.vad);
  return {
    model: model || null,
    requested,
    flagSupported,
    active: Boolean(requested && model && flagSupported),
  };
}

async function probeFfmpegFilters(resolve, env) {
  const mp = resolve('mediaProbe');
  const at = resolve('audioTranscriber');
  let filters = null;
  let available = null;
  let definitive = null;
  let reason = null;
  let source = null;
  if (fnOf(mp, 'detectFfmpegFilters')) {
    const answer = await mp.detectFfmpegFilters({ ffmpeg: env.FFMPEG_PATH || 'ffmpeg' });
    source = 'media-probe';
    available = Boolean(answer && answer.available);
    definitive = Boolean(answer && answer.definitive);
    reason = answer && answer.reason ? oneLine(answer.reason, 40) : null;
    filters = answer && answer.filters instanceof Set ? answer.filters : null;
  }
  if (!filters && fnOf(at, 'ffmpegFilterSet')) {
    const set = await at.ffmpegFilterSet({ env });
    const list = set instanceof Set ? set : new Set(Array.from(set || [], String));
    source = source ? `${source}+audio-transcriber` : 'audio-transcriber';
    if (list.size) {
      filters = list;
      available = true;
      definitive = true;
    }
  }
  if (!source) throw Object.assign(new Error('no ffmpeg filter detection'), { code: 'MODULE_UNAVAILABLE' });
  if (!filters) {
    return {
      source, available, definitive: false, reason: reason || 'unreadable',
      readable: false, count: 0, has: {}, variants: [], missingForVariants: {},
    };
  }
  const has = {};
  for (const name of REPORTED_FILTERS) has[name] = filters.has(name);
  const variants = [];
  const missingForVariants = {};
  const specs = at && at.VARIANT_FILTERS && typeof at.VARIANT_FILTERS === 'object' ? at.VARIANT_FILTERS : {};
  for (const [name, spec] of Object.entries(specs)) {
    const needs = Array.isArray(spec && spec.needs) ? spec.needs : [];
    const missing = needs.filter((f) => !filters.has(f));
    if (missing.length) missingForVariants[name] = missing;
    else variants.push(name);
  }
  return {
    source, available: available !== false, definitive: definitive !== false, reason,
    readable: filters.size > 0, count: filters.size, has, variants, missingForVariants,
  };
}

async function probeOcrInputs(resolve, env) {
  const oi = requireModule(resolve, 'ocrInput');
  if (!fnOf(oi, 'getOcrInputCapabilities')) throw Object.assign(new Error('ocr-input has no capability probe'), { code: 'MODULE_UNAVAILABLE' });
  const caps = await oi.getOcrInputCapabilities({ env });
  const languages = Array.isArray(caps && caps.tessdata && caps.tessdata.languages) ? caps.tessdata.languages.map((l) => oneLine(l, 20)) : [];
  let localSpaEng = false;
  try { localSpaEng = Boolean(fnOf(oi, 'resolveLocalTessdata') && oi.resolveLocalTessdata('spa+eng', { env })); } catch { localSpaEng = false; }
  // ocr-engine switches a process to the CDN path for good after a local
  // tessdata load failed once: worth seeing in the report.
  let localTessdataBroken = null;
  try {
    const oe = resolve('ocrEngine');
    const ws = oe && oe._internals && oe._internals.workerState;
    if (ws && typeof ws === 'object') localTessdataBroken = Boolean(ws.localBroken);
  } catch { localTessdataBroken = null; }
  return {
    heif: {
      available: Boolean(caps && caps.heif && caps.heif.available),
      bin: caps && caps.heif ? caps.heif.bin || null : null,
      version: caps && caps.heif ? caps.heif.version || null : null,
    },
    ffmpeg: {
      available: Boolean(caps && caps.ffmpeg && caps.ffmpeg.available),
      version: caps && caps.ffmpeg ? caps.ffmpeg.version || null : null,
    },
    tesseractCli: {
      available: Boolean(caps && caps.tesseractCli && caps.tesseractCli.available),
      version: caps && caps.tesseractCli ? caps.tesseractCli.version || null : null,
    },
    tessdata: {
      dir: caps && caps.tessdata ? caps.tessdata.dir || null : null,
      languages,
      missing: EXPECTED_TESSDATA.filter((lang) => !languages.includes(lang)),
      localForSpaEng: localSpaEng,
      localBrokenInProcess: localTessdataBroken,
    },
    osd: {
      available: Boolean(caps && caps.osd && caps.osd.available),
      reason: caps && caps.osd ? caps.osd.reason || null : null,
    },
    tessdataCacheDir: caps ? caps.tessdataCacheDir || null : null,
  };
}

async function probeGlmOcr(resolve, probeNetwork) {
  const ollama = requireModule(resolve, 'ollamaOcr');
  let state = fnOf(ollama, 'describe') ? ollama.describe() : null;
  let probed = false;
  if (probeNetwork && fnOf(ollama, 'ensureAvailable')) {
    const res = await ollama.ensureAvailable();
    probed = true;
    state = { ...(state || {}), available: Boolean(res && res.available), reason: res ? res.reason || null : null };
  }
  const s = state || {};
  return {
    enabled: Boolean(s.enabled),
    model: s.model ? oneLine(s.model, 80) : null,
    available: s.available === undefined || s.available === null ? null : Boolean(s.available),
    reason: s.reason ? oneLine(s.reason, 80) : null,
    pulling: Boolean(s.pulling),
    probed: probed || (s.checkedAt !== undefined && s.checkedAt !== null),
  };
}

function probeVision(resolve, env) {
  const vr = requireModule(resolve, 'visionRuntime');
  const list = fnOf(vr, 'visionRuntimeCandidates') ? vr.visionRuntimeCandidates(env) : [];
  const max = Number.parseInt(env.OCR_VISION_LADDER_MAX || '', 10);
  return {
    runtimes: (Array.isArray(list) ? list : []).map((c) => ({
      provider: oneLine(c && c.provider, 40),
      model: c && c.model ? oneLine(c.model, 80) : null,
    })),
    ocrLadderMax: Number.isFinite(max) && max > 0 ? Math.min(6, max) : 3,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

function collectWarnings(report) {
  const warnings = [];
  const { local, vad, ffmpeg, ocr, glmOcr, stt } = report;
  if (local && !local.ok) warnings.push(`local_whisper:${local.code || 'unavailable'}`);
  if (stt && Array.isArray(stt.ladder) && stt.ladder.length === 0) warnings.push('stt:no_rungs');
  if (vad && vad.requested && !vad.active) warnings.push(vad.flagSupported ? 'vad:model_missing' : 'vad:flag_unsupported');
  if (ffmpeg && ffmpeg.available === false) warnings.push('ffmpeg:missing');
  else if (ffmpeg && ffmpeg.readable === false) warnings.push('ffmpeg:filters_unreadable');
  if (ocr) {
    if (!ocr.tesseractCli.available) warnings.push('ocr:tesseract_cli_missing');
    if (!ocr.heif.available) warnings.push('ocr:heif_decoder_missing');
    if (!ocr.tessdata.dir) warnings.push('ocr:tessdata_dir_missing');
    else for (const lang of ocr.tessdata.missing) warnings.push(`ocr:tessdata_missing:${lang}`);
    if (ocr.tessdata.localBrokenInProcess) warnings.push('ocr:local_tessdata_failed_cdn_fallback');
  }
  if (glmOcr && glmOcr.enabled && glmOcr.available === false && glmOcr.reason) warnings.push(`glm_ocr:${glmOcr.reason}`);
  return warnings;
}

async function buildReport({ env, resolve, probeNetwork, timeoutMs, now }) {
  const probeErrors = [];
  const run = async (name, fn) => {
    try {
      return await withTimeout(Promise.resolve().then(fn), timeoutMs);
    } catch (err) {
      probeErrors.push({ probe: name, error: errorCode(err) });
      return null;
    }
  };

  const [stt, local, ffmpeg, ocr, glmOcr, vision] = await Promise.all([
    run('stt', () => probeStt(resolve, env)),
    run('local_whisper', () => probeLocal(resolve, env)),
    run('ffmpeg_filters', () => probeFfmpegFilters(resolve, env)),
    run('ocr_inputs', () => probeOcrInputs(resolve, env)),
    run('glm_ocr', () => probeGlmOcr(resolve, probeNetwork)),
    run('vision_runtimes', () => probeVision(resolve, env)),
  ]);
  const whisper = local ? await run('whisper_flags', () => probeWhisperFlags(resolve, env, local)) : null;
  const vad = await run('vad', () => probeVad(resolve, env, whisper && whisper.flags));

  const report = {
    generatedAt: new Date(now()).toISOString(),
    status: probeErrors.length ? 'degraded' : 'ok',
    probeErrors,
    stt,
    local,
    whisperFlags: whisper,
    vad,
    ffmpeg,
    ocr,
    glmOcr,
    vision,
  };
  report.warnings = collectWarnings(report);
  return report;
}

/**
 * The full capability report. Options:
 *   env           (default process.env)
 *   modules       injected modules or loaders: audioTranscriber, localWhisper,
 *                 ocrInput, ollamaOcr, visionRuntime, voiceStudio
 *   probeNetwork  allow ollama-ocr ensureAvailable() (HTTP to Ollama, memoized
 *                 there); false → its last known state only
 *   timeoutMs     per-probe bound (default 15 s)
 *   refresh       bypass this module's short memo
 * Never throws.
 */
// One memo entry PER KEY ('local' = boot / no network probe, 'net' = the
// admin endpoint's network probe): a boot pass that resolves while an admin
// pass is pending never writes its report under the other key, nor clears
// the other pass's dedupe.
function emptyMemoEntry() {
  return { at: 0, report: null, pending: null };
}
const memo = { local: emptyMemoEntry(), net: emptyMemoEntry() };

/**
 * Memoized run of `compute` under `key`: a fresh report is reused for `ttl`
 * ms, concurrent callers share one pending pass, `refresh` bypasses the
 * fresh report (not a pass already running). Each promise writes and clears
 * ONLY its own entry, and only while it is still that entry's pending pass.
 */
function memoized(key, compute, { refresh = false, ttl = DEFAULT_MEMO_TTL_MS, now = Date.now } = {}) {
  if (!memo[key]) memo[key] = emptyMemoEntry();
  const entry = memo[key];
  if (!refresh && entry.report && now() - entry.at < ttl) return Promise.resolve(entry.report);
  if (entry.pending) return entry.pending;
  const pending = Promise.resolve()
    .then(compute)
    .then((report) => {
      if (entry.pending === pending) {
        entry.report = report;
        entry.at = now();
      }
      return report;
    })
    .finally(() => {
      if (entry.pending === pending) entry.pending = null;
    });
  entry.pending = pending;
  return pending;
}

async function collectTranscriptionCapabilities(opts = {}) {
  const env = opts.env || process.env;
  const probeNetwork = Boolean(opts.probeNetwork);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const injected = Boolean(opts.modules) || env !== process.env;
  const ttl = Number.isFinite(opts.memoTtlMs) && opts.memoTtlMs >= 0 ? opts.memoTtlMs : DEFAULT_MEMO_TTL_MS;
  const key = probeNetwork ? 'net' : 'local';

  const compute = async () => {
    try {
      return await buildReport({ env, resolve: moduleResolver(opts.modules || null), probeNetwork, timeoutMs, now });
    } catch (err) {
      return {
        generatedAt: new Date(now()).toISOString(),
        status: 'degraded',
        probeErrors: [{ probe: 'report', error: errorCode(err) }],
        warnings: [],
      };
    }
  };

  // Injected modules/env (tests, ad-hoc callers) never share the process memo.
  if (injected) return compute();
  return memoized(key, compute, { refresh: Boolean(opts.refresh), ttl, now });
}

function resetCapabilitiesMemo() {
  // New entry objects: a pass still running writes into its detached entry.
  memo.local = emptyMemoEntry();
  memo.net = emptyMemoEntry();
}

// ── One-line summary ────────────────────────────────────────────────────────

function sttToken(stt) {
  if (!stt) return 'stt=?';
  const rungs = (stt.ladder || []).map((r) => `${r.name}${r.cooldown ? '(cooldown)' : ''}`);
  const esc = (stt.escalation || []).map((r) => r.name);
  const freeDictation = stt.dictation && stt.dictation.free ? stt.dictation.free.providers : null;
  return `stt=${rungs.join(',') || 'none'}${esc.length ? ` escalation=${esc.join(',')}` : ''}`
    + `${freeDictation ? ` dictation_free=${freeDictation}` : ''}`;
}

function localToken(local, whisper, vad) {
  const parts = [];
  if (!local) parts.push('local=?');
  else if (local.ok) parts.push(`local=ok(${basename(local.model) || '?'}${local.threads ? `,t=${local.threads}` : ''})`);
  else parts.push(`local=${local.code || 'unavailable'}`);
  if (whisper && whisper.flags) {
    const on = Object.keys(WHISPER_FLAG_LABELS).filter((k) => whisper.flags[k]).map((k) => WHISPER_FLAG_LABELS[k]);
    parts.push(`flags=${on.join(',') || 'base'}`);
  } else if (local && local.ok) {
    parts.push('flags=?');
  }
  if (vad) {
    const why = vad.active ? 'on' : `off(${[vad.model ? 'model' : 'no-model', vad.flagSupported ? 'flag' : 'no-flag', vad.requested ? 'requested' : 'not-requested'].join(',')})`;
    parts.push(`vad=${why}`);
  }
  return parts.join(' ');
}

function ffmpegToken(ffmpeg, ocr) {
  const version = ocr && ocr.ffmpeg && ocr.ffmpeg.version ? oneLine(ocr.ffmpeg.version, 30) : null;
  if (!ffmpeg) return `ffmpeg=${version || '?'} filters=?`;
  if (ffmpeg.available === false) return 'ffmpeg=missing';
  if (!ffmpeg.readable) return `ffmpeg=${version || 'yes'} filters=?(${ffmpeg.reason || 'unreadable'})`;
  return `ffmpeg=${version || 'yes'} filters=${ffmpeg.count}${ffmpeg.variants.length ? ` variants=${ffmpeg.variants.join(',')}` : ''}`;
}

function ocrToken(ocr) {
  if (!ocr) return 'tesseract=? tessdata=? heif=?';
  const tess = ocr.tesseractCli.available ? (ocr.tesseractCli.version || 'yes') : 'no';
  const langs = ocr.tessdata.languages.length ? ocr.tessdata.languages.join(',') : 'none';
  const heif = ocr.heif.available ? `${basename(ocr.heif.bin) || 'yes'}${ocr.heif.version ? `(${ocr.heif.version})` : ''}` : 'no';
  return `tesseract=${tess} tessdata=${langs} osd=${ocr.osd.available ? 'yes' : 'no'} heif=${heif}`;
}

function glmToken(glm) {
  if (!glm) return 'glm-ocr=?';
  if (!glm.enabled) return 'glm-ocr=disabled';
  if (glm.available === true) return 'glm-ocr=ok';
  if (glm.pulling) return 'glm-ocr=pulling';
  if (glm.available === false) return `glm-ocr=${glm.reason || 'unavailable'}`;
  return 'glm-ocr=unprobed';
}

function visionToken(vision) {
  if (!vision) return 'vision=?';
  const names = vision.runtimes.map((r) => r.provider).filter(Boolean);
  return `vision=${names.join(',') || 'none'}`;
}

/** One line, no newline, bounded; no key, path of a secret, or content. */
function summarizeCapabilities(report) {
  const r = report || {};
  const line = [
    '[transcription] capabilities',
    `status=${r.status || '?'}`,
    sttToken(r.stt),
    localToken(r.local, r.whisperFlags, r.vad),
    ffmpegToken(r.ffmpeg, r.ocr),
    '|',
    `ocr ${ocrToken(r.ocr)}`,
    glmToken(r.glmOcr),
    visionToken(r.vision),
    `warnings=${Array.isArray(r.warnings) && r.warnings.length ? r.warnings.join(',') : 'none'}`,
    ...(Array.isArray(r.probeErrors) && r.probeErrors.length
      ? [`probe_errors=${r.probeErrors.map((e) => `${e.probe}:${e.error}`).join(',')}`]
      : []),
  ].join(' ');
  return oneLine(line, SUMMARY_MAX_CHARS);
}

/**
 * Collect (no network probe) and log ONE line: info when everything was
 * readable and nothing is missing, warn otherwise. Never throws.
 */
async function logBootSummary({ logger = console, env, modules, timeoutMs } = {}) {
  let report = null;
  try {
    report = await collectTranscriptionCapabilities({ env, modules, timeoutMs, probeNetwork: false });
    const line = summarizeCapabilities(report);
    const clean = report.status === 'ok' && (!report.warnings || report.warnings.length === 0);
    const write = clean ? (logger.info || logger.log) : (logger.warn || logger.log);
    if (typeof write === 'function') write.call(logger, line);
  } catch {
    /* boot diagnostics are best-effort */
  }
  return report;
}

module.exports = {
  collectTranscriptionCapabilities,
  summarizeCapabilities,
  logBootSummary,
  resetCapabilitiesMemo,
  dictationLadderOptions,
  DICTATION_FREE_PROVIDERS,
  EXPECTED_TESSDATA,
  REPORTED_FILTERS,
  _internals: { withTimeout, moduleResolver, collectWarnings, errorCode, memoized },
};
