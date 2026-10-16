const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const requirePaidPlan = require('../middleware/require-paid-plan');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const FormData = require('form-data');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const {
  contentDispositionHeader,
  parseHttpByteRange,
  resolveConfinedFile,
} = require('../middleware/file-response-safety');
const {
  generateOfficeSoundscape,
  officeSoundDefinition,
} = require('../services/ai/elevenlabs-office-soundscape');
const elevenLabsMusic = require('../services/ai/elevenlabs-music');
const {
  DEFAULT_PAID_PLANS,
  normalizePlan,
  subscriptionAllowsPaidAccess,
} = require('../middleware/require-paid-plan');

const router = express.Router();
const prisma = require('../config/database');
const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function audioContentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case '.wav':
      return 'audio/wav';
    case '.m4a':
    case '.m4b':
    case '.mp4':
      return 'audio/mp4';
    case '.webm':
      return 'audio/webm';
    case '.ogg':
      return 'audio/ogg';
    case '.mp3':
    case '.mpeg':
    default:
      return 'audio/mpeg';
  }
}

function generatedAudioFilename(prefix, extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

ensureDir(audioDir);

// Configure multer for audio file uploads
const upload = multer({
  dest: audioDir,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit
  },
  fileFilter: (req, file, cb) => {
    // Recorders label the same audio many ways (`audio/webm;codecs=opus`,
    // Safari `audio/mp4`, `audio/x-m4a`, video/webm for an audio-only
    // MediaRecorder): the ladder decodes any of them through ffmpeg.
    const allowedTypes = [
      'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp3', 'audio/m4a', 'audio/x-m4a',
      'audio/webm', 'audio/ogg', 'audio/opus', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-flac',
      'video/webm', 'video/mp4',
    ];
    const mimetype = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (allowedTypes.includes(mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid audio file type: ${mimetype || 'unknown'}. Allowed types: ${allowedTypes.join(', ')}`), false);
    }
  }
});

// ElevenLabs API key — read per request, never captured at module load: the
// admin-connections bridge applies a key saved in Admin → Conexiones into
// process.env at runtime, after this router has been required.
function elevenLabsApiKey() {
  return String(process.env.ELEVENLABS_API_KEY || '').trim();
}

// Uniform «not configured» answer for the action endpoints. The stable code
// lets observability treat it as a configuration state, not a user-facing
// failure (see services/observability/config-state.js).
function elevenLabsNotConfigured(res) {
  return res.status(400).json({ error: 'ElevenLabs API key not configured', code: 'provider_not_configured' });
}

// Lazy ElevenLabs client init — instantiating at module load crashes the
// whole backend when ELEVENLABS_API_KEY is missing in dev. Defer until
// the first request actually needs it; rebuild when the key rotates.
let elevenlabsClient = null;
let elevenlabsClientKey = '';
function elevenlabs() {
  const apiKey = elevenLabsApiKey();
  if (!apiKey) return null;
  if (!elevenlabsClient || elevenlabsClientKey !== apiKey) {
    elevenlabsClient = new ElevenLabsClient({ apiKey });
    elevenlabsClientKey = apiKey;
  }
  return elevenlabsClient;
}

// Get available voices. Catalog reads answer 200 even without a key: the
// /agentes voice pickers ask for the list, and «no key» simply means an
// empty catalog (`configured: false`), not an error on every page load.
router.get('/voices', authenticateToken, async (req, res) => {
  try {
    if (!elevenLabsApiKey()) {
      return res.json({ configured: false, voices: [] });
    }

    const voices = await elevenlabs().voices.getAll();

    // ElevenLabs API might return { voices: [...] } or just [...]
    // Ensure we always return { voices: [...] } format
    const voicesArray = voices?.voices || voices || [];
    res.json({ configured: true, voices: voicesArray });
  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/models', authenticateToken, async (req, res) => {
  try {
    if (!elevenLabsApiKey()) {
      return res.json({ configured: false, models: [] });
    }
    const models = await elevenlabs().models.list();

    // API seedha array return karti hai, hum use object mein wrap kar rahe hain
    res.json({ configured: true, models: models || [] });
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: error.message });
  }
});

// Curated office ambience. The browser can only request these fixed sound IDs;
// prompts and provider credentials remain server-side. Each result is generated
// once, written atomically, and reused by every later office session.
router.post('/office-soundscapes/:soundId', authenticateToken, async (req, res) => {
  const soundId = String(req.params.soundId || '').trim();
  if (!officeSoundDefinition(soundId)) {
    return res.status(404).json({ error: 'Office sound not found' });
  }

  try {
    const sound = await generateOfficeSoundscape({
      soundId,
      outputDir: audioDir,
    });
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(sound.generated ? 201 : 200).json({
      ok: true,
      soundId: sound.soundId,
      audio_url: sound.audioUrl,
      filename: sound.filename,
      cached: sound.cached,
      loop: sound.loop,
      durationSeconds: sound.durationSeconds,
      provider: 'elevenlabs',
      version: sound.version,
      fallback: sound.fallback,
    });
  } catch (error) {
    if (error?.code === 'ELEVENLABS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Office sound provider is not configured' });
    }
    if (error?.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ error: 'Office sound provider has insufficient credits' });
    }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return res.status(504).json({ error: 'Office sound generation timed out' });
    }
    console.error('Office sound generation error:', {
      soundId,
      code: error?.code || 'UNKNOWN',
      status: Number(error?.status) || null,
    });
    return res.status(502).json({ error: 'Office sound generation failed' });
  }
});

// Text-to-Speech
router.post('/text-to-speech', [
  body('text').trim().notEmpty().isLength({ max: 5000 }).withMessage('Text is required (max 5000 chars)'),
  body('voice_id').optional().isString().trim().isLength({ max: 120 }),
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
  body('voice_settings').optional().isObject()
], authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }

    const {
      text,
      voice_id, // No default - must be provided by frontend
      model_id = 'eleven_monolingual_v1',
      voice_settings = {
        stability: 0.5,
        similarity_boost: 0.5,
        style: 0.0,
        use_speaker_boost: true
      }
    } = req.body;

    // Validate voice_id is provided
    if (!voice_id) {
      return res.status(400).json({ error: 'voice_id is required' });
    }

    console.log('TTS Request received:', { text: text.substring(0, 50) + '...', voice_id, model_id });

    // Generate audio using ElevenLabs client
    console.log('Calling ElevenLabs TTS API...');
    const audioStream = await elevenlabs().textToSpeech.convert(voice_id, {
      text,
      model_id,
      voice_settings
    });

    console.log('Audio stream received from ElevenLabs');

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    // Generate unique filename
    const filename = generatedAudioFilename('tts');
    const filepath = path.join(audioDir, filename);
    ensureDir(audioDir);

    // Save audio file
    fs.writeFileSync(filepath, audioBuffer);

    // Track usage
    await prisma.apiUsage.create({
      data: {
        userId: req.user.id,
        model: 'elevenlabs-tts',
        tokens: text.length,
        cost: text.length * 0.0001 // Approximate cost
      }
    });

    res.json({
      success: true,
      audio_url: `/elevenlabs/audio/${filename}`,
      filename,
      text_length: text.length
    });

  } catch (error) {
    console.error('Text-to-Speech error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Dictation (POST /speech-to-text) ───────────────────────────────────────
// Every plan goes through the SAME transcription ladder as uploads
// (audio-transcriber.transcribe, short-clip path, short lane) with automatic
// language detection — no more forced «es» on a 20 s English note.
//   - FREE plans stay on-host by default (whisper.cpp, then Sira Voz), as
//     before: free dictation never spends paid STT credit nor sends audio
//     off the host unless an operator opts in (SIRAGPT_DICTATION_FREE_CLOUD=1
//     or SIRAGPT_DICTATION_PROVIDERS). Policy: transcription-capabilities
//     dictationLadderOptions (the admin report shows the same answer).
//   - PAID plans with an ElevenLabs key try Scribe first, inside its own
//     sub-budget, and fall back to the shared ladder on ANY Scribe failure
//     (quota, plan, key, rate limit, a slow or hung upstream), so a paid user
//     is never worse off than a free one.
// The whole request is bounded BELOW the browser's 30 s ApiClient timeout and
// a reached bound answers 408 (ApiClient never retries a 4xx), so the user
// gets the Spanish copy instead of «Request timed out» after three uploads.
// Nothing here ever invents text: a quota or plan failure that the ladder
// cannot cover is a typed error, never a «success» sentence inserted into the
// chat. The transcript is never logged (one summary line: tier, provider,
// outcome, duration, character count).
//
// Env:
//   SIRAGPT_DICTATION_TIMEOUT_MS         whole request bound (default 25000,
//                                        max 28000: under the client's 30 s)
//   SIRAGPT_DICTATION_SCRIBE_TIMEOUT_MS  Scribe sub-budget (default 10000,
//                                        never more than 40 % of the bound)
//   SIRAGPT_DICTATION_PROVIDERS          ladder for every plan, e.g.
//                                        «local,voicestudio» or «groq,local»
//   SIRAGPT_DICTATION_FREE_CLOUD=1       free plans use the shared
//                                        TRANSCRIBE_PROVIDERS order (paid
//                                        cloud rungs included; opt-in)
//   SIRAGPT_DICTATION_SCRIBE_COOLDOWN_MS skip Scribe this long after a quota /
//                                        plan / key rejection (default 600000)
//   ELEVENLABS_STT_MODEL                 Scribe model (default scribe_v1)
//
// Admission: the ladder call uses the short lane of the transcriber's gate.
// A dedicated interactive slot that queue jobs never take is the
// audio-transcriber owner's call; until then the request bound keeps a
// saturated gate from hanging the composer (408 after the bound).
function userHasPaidVoicePlan(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return DEFAULT_PAID_PLANS.includes(normalizePlan(user.plan)) && subscriptionAllowsPaidAccess(user);
}

function markVoiceTranscriptionTier(req, _res, next) {
  req.freeVoiceTranscription = !userHasPaidVoicePlan(req.user);
  next();
}

const DICTATION_NO_SPEECH_NOTE = 'No se detectó voz en la grabación.';
const DICTATION_UNAVAILABLE_ERROR = 'La transcripción no está disponible en este momento. Intenta de nuevo en unos segundos.';
const DICTATION_UNREADABLE_ERROR = 'No pude leer el audio de la grabación. Vuelve a grabar e inténtalo de nuevo.';
const DICTATION_TIMEOUT_ERROR = 'La transcripción tardó más de lo esperado. Intenta de nuevo en unos segundos.';
// Placeholder codes that say the recording itself could not be decoded.
const DICTATION_UNREADABLE_CODES = new Set([
  'no_audio_track', 'file_empty', 'file_unavailable', 'audio_decode_failed',
  'truncated_container', 'drm_protected', 'file_too_large',
]);
const SCRIBE_REJECTIONS = new Set(['quota', 'plan', 'auth']);
const SCRIBE_MODEL_RE = /^scribe_v\d+(?:_[a-z0-9]+)?$/i;
// Every dictation caller goes through lib/api.ts ApiClient (DEFAULT_TIMEOUT_MS
// 30 s, retries on a timeout abort and on 503). The bound must answer first.
const DICTATION_CLIENT_TIMEOUT_MS = 30_000;
const DICTATION_DEFAULT_TIMEOUT_MS = 25_000;
const DICTATION_MAX_TIMEOUT_MS = 28_000;
const SCRIBE_DEFAULT_TIMEOUT_MS = 10_000;
const SCRIBE_MAX_SHARE = 0.4;
const SCRIBE_MIN_TIMEOUT_MS = 200;

function boundedIntEnv(env, name, fallback, min, max) {
  const n = Number.parseInt(String(env[name] ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function dictationTimeoutMs(env = process.env) {
  return boundedIntEnv(env, 'SIRAGPT_DICTATION_TIMEOUT_MS', DICTATION_DEFAULT_TIMEOUT_MS, 1_000, DICTATION_MAX_TIMEOUT_MS);
}

/** Scribe's own budget: the env value, never more than 40 % of the request bound. */
function scribeTimeoutMs(env = process.env, requestMs = dictationTimeoutMs(env)) {
  const wanted = boundedIntEnv(env, 'SIRAGPT_DICTATION_SCRIBE_TIMEOUT_MS', SCRIBE_DEFAULT_TIMEOUT_MS, SCRIBE_MIN_TIMEOUT_MS, 60_000);
  const cap = Math.max(SCRIBE_MIN_TIMEOUT_MS, Math.floor(requestMs * SCRIBE_MAX_SHARE));
  return Math.min(wanted, cap);
}

function scribeCooldownMs(env = process.env) {
  return boundedIntEnv(env, 'SIRAGPT_DICTATION_SCRIBE_COOLDOWN_MS', 10 * 60_000, 0, 24 * 60 * 60_000);
}

/** Ladder options for one dictation (see transcription-capabilities). */
function dictationLadderOptions(env = process.env, { paid = false } = {}) {
  try {
    const { providers, escalationProviders } = require('../services/transcription-capabilities')
      .dictationLadderOptions(env, { paid });
    return {
      ...(providers ? { providers } : {}),
      ...(escalationProviders ? { escalationProviders } : {}),
    };
  } catch {
    // Policy unreadable: fail closed to the on-host ladder (never paid by accident).
    return { providers: ['local', 'voicestudio'], escalationProviders: [] };
  }
}

/** Back-compat seam: the providers list a dictation would use, or undefined (shared order). */
function dictationProviders(env = process.env, { paid = false } = {}) {
  return dictationLadderOptions(env, { paid }).providers;
}

/** A language the client asked for («es», «es-PE», «spa»), or undefined (detect). */
function dictationLanguage(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (!value || value === 'auto' || value === 'detect') return undefined;
  const base = value.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

function scribeModel(body = {}, env = process.env) {
  const fromEnv = String(env.ELEVENLABS_STT_MODEL || '').trim();
  if (SCRIBE_MODEL_RE.test(fromEnv)) return fromEnv;
  const requested = String(body.model_id || body.model || '').trim();
  return SCRIBE_MODEL_RE.test(requested) ? requested : 'scribe_v1';
}

// Text patterns, used ONLY when the error carries no HTTP status (the status
// decides otherwise: ElevenLabs' transient 429 bodies talk about
// «subscription» and «tiers», and a 500 may say «explanation»).
const SCRIBE_CREDITS_RE = /quota_exceeded|exceeds your quota|\bquota\b|\bcredits?\b|insufficient[_ ](?:credits|balance|funds)/;
const SCRIBE_QUOTA_TEXT_RE = /quota_exceeded|exceeds your quota|\bquota\b|\bcredits?\b|insufficient[_ ](?:credits|balance|funds)|character_limit_exceeded|payment[_ ]required/;
const SCRIBE_AUTH_TEXT_RE = /unauthori[sz]ed|invalid[_ ]?api[_ ]?key|api key is invalid|missing_api_key/;
const SCRIBE_PLAN_TEXT_RE = /subscription (?:plan )?(?:does not|doesn't) include|upgrade your (?:plan|subscription)|not available (?:on|for) your/;
const SCRIBE_RATE_TEXT_RE = /rate[ _-]?limit|too many (?:concurrent )?requests|concurrent requests|heavy traffic/;
const SCRIBE_TIMEOUT_TEXT_RE = /timed? ?out|timeout/;

function scribeErrorStatus(err) {
  const status = Number(err?.statusCode || err?.status || err?.response?.status || 0);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function scribeErrorDetail(err) {
  try {
    return `${err?.message || ''} ${typeof err?.body === 'string' ? err.body : JSON.stringify(err?.body || '')}`.slice(0, 2000).toLowerCase();
  } catch {
    return String(err?.message || '').slice(0, 2000).toLowerCase();
  }
}

/**
 * Why Scribe failed, as a stable category (never the provider's text):
 * quota | plan | auth | rate | timeout | error. Only quota / plan / auth
 * cool Scribe down for every paid user, so the HTTP status decides first and
 * the text is a tiebreaker for 401 / 403 (credits) or the only signal when
 * there is no status.
 */
function classifyScribeError(err) {
  const status = scribeErrorStatus(err);
  const detail = scribeErrorDetail(err);
  if (status) {
    if (status === 429) return 'rate';
    if (status === 408) return 'timeout';
    if (status >= 500) return 'error';
    if (status === 402) return 'quota';
    if (status === 401) return SCRIBE_CREDITS_RE.test(detail) ? 'quota' : 'auth';
    if (status === 403) return SCRIBE_CREDITS_RE.test(detail) ? 'quota' : 'plan';
    return 'error';
  }
  const name = String(err?.name || '');
  if (/timeout/i.test(name) || SCRIBE_TIMEOUT_TEXT_RE.test(detail)) return 'timeout';
  if (SCRIBE_RATE_TEXT_RE.test(detail)) return 'rate';
  if (SCRIBE_QUOTA_TEXT_RE.test(detail)) return 'quota';
  if (SCRIBE_AUTH_TEXT_RE.test(detail)) return 'auth';
  if (SCRIBE_PLAN_TEXT_RE.test(detail)) return 'plan';
  return 'error';
}

// Scribe rejections (no credits / plan / key) are remembered per key so the
// next dictations go straight to the ladder instead of paying a round trip.
const scribeCooldown = { fingerprint: null, until: 0, reason: null };

function keyFingerprint(key) {
  return require('crypto').createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16);
}

function scribeCoolingDown(key, now = Date.now()) {
  if (!scribeCooldown.until || scribeCooldown.fingerprint !== keyFingerprint(key)) return null;
  if (now >= scribeCooldown.until) return null;
  return scribeCooldown.reason;
}

function rememberScribeRejection(key, reason, env = process.env, now = Date.now()) {
  const ms = scribeCooldownMs(env);
  if (!ms) return;
  scribeCooldown.fingerprint = keyFingerprint(key);
  scribeCooldown.until = now + ms;
  scribeCooldown.reason = reason;
}

function resetScribeCooldown() {
  scribeCooldown.fingerprint = null;
  scribeCooldown.until = 0;
  scribeCooldown.reason = null;
}

function scribeText(body) {
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object') return '';
  if (typeof body.text === 'string') return body.text.trim();
  if (typeof body.transcript === 'string') return body.transcript.trim();
  if (Array.isArray(body.transcripts)) {
    return body.transcripts.map((t) => (t && typeof t.text === 'string' ? t.text.trim() : '')).filter(Boolean).join(' ');
  }
  if (Array.isArray(body.segments)) {
    return body.segments.map((s) => String(s?.text || s?.transcript || '').trim()).filter(Boolean).join(' ');
  }
  return '';
}

function abortErrorFrom(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts — even when
 * the work underneath ignores the signal (a hung provider SDK, a call stuck
 * in an admission gate). The abandoned promise stays handled.
 */
function untilAborted(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortErrorFrom(signal));
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/** `request` aborts OR `ms` elapse; `budget` says which one fired. */
function scribeBudgetSignal(request, ms) {
  const budget = new AbortController();
  const timer = setTimeout(() => {
    budget.abort(Object.assign(new Error('scribe budget exceeded'), { name: 'TimeoutError', code: 'SCRIBE_TIMEOUT' }));
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  const forward = () => budget.abort(abortErrorFrom(request));
  if (request.aborted) forward(); else request.addEventListener('abort', forward, { once: true });
  return {
    signal: budget.signal,
    expired: () => budget.signal.aborted && !request.aborted,
    dispose: () => {
      clearTimeout(timer);
      request.removeEventListener('abort', forward);
    },
  };
}

/** One Scribe request. Resolves { text, language } — never a placeholder sentence. */
async function scribeDictation({ client, filePath, mimeType, model, language, signal, timeoutMs }) {
  const audioBuffer = await fs.promises.readFile(filePath);
  const file = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
  const body = await untilAborted(client.speechToText.convert({
    file,
    modelId: model,
    // Dictation goes into the composer: «(risas)» / «(aplausos)» are noise.
    tagAudioEvents: false,
    diarize: false,
    ...(language ? { languageCode: language } : {}),
  }, {
    ...(signal ? { abortSignal: signal } : {}),
    timeoutInSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
    maxRetries: 0,
  }), signal);
  const lang = typeof body?.languageCode === 'string' ? body.languageCode
    : (typeof body?.language_code === 'string' ? body.language_code : null);
  return { text: scribeText(body), language: lang ? lang.slice(0, 8) : null };
}

function ladderProviderLabel(result) {
  const names = Object.keys(result?.providers || {});
  const first = names[0] || (result?.engine === 'local' ? 'local' : null);
  if (!first) return result?.method === 'local-whisper' ? 'local-whisper' : 'transcriber';
  if (first === 'local') return 'local-whisper';
  if (first === 'voicestudio') return 'sira-voz';
  return String(first).slice(0, 40);
}

function logDictation(fields) {
  try {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_').slice(0, 60)}`);
    console.log(`[dictation] ${parts.join(' ')}`);
  } catch { /* the summary line never fails a dictation */ }
}

router.post('/speech-to-text', authenticateToken, markVoiceTranscriptionTier, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required' });
  }
  const env = process.env;
  const started = Date.now();
  const filePath = req.file.path;
  const mimeType = req.file.mimetype;
  const originalName = req.file.originalname || 'dictation.webm';
  const paid = !req.freeVoiceTranscription;
  const tier = paid ? 'paid' : 'free';
  const language = dictationLanguage(req.body?.language);
  const timeoutMs = dictationTimeoutMs(env);

  // One controller for the whole request: the client hanging up (the
  // browser's own timeout, a closed tab) or our bound cancels whisper / the
  // provider call instead of burning CPU for a response nobody reads.
  const controller = new AbortController();
  let clientGone = false;
  let timedOut = false;
  const onClose = () => {
    if (!res.writableFinished) {
      clientGone = true;
      controller.abort();
    }
  };
  res.on('close', onClose);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const signal = controller.signal;

  let scribeFailure = null;
  let outcome = 'error';
  let provider = null;
  let chars = 0;
  try {
    const apiKey = elevenLabsApiKey();
    if (paid && apiKey) {
      const cooling = scribeCoolingDown(apiKey);
      if (cooling) {
        scribeFailure = cooling;
      } else {
        const model = scribeModel(req.body, env);
        const scribeMs = scribeTimeoutMs(env, timeoutMs);
        const budget = scribeBudgetSignal(signal, scribeMs);
        try {
          const scribe = await scribeDictation({
            client: elevenlabs(), filePath, mimeType, model, language, signal: budget.signal, timeoutMs: scribeMs,
          });
          if (scribe.text) {
            try {
              await prisma.apiUsage.create({
                data: { userId: req.user.id, model: `elevenlabs-${model.replace(/_/g, '-')}`, tokens: scribe.text.length, cost: 0.003 },
              });
            } catch { /* usage tracking never fails a dictation */ }
            outcome = 'ok';
            provider = 'elevenlabs';
            chars = scribe.text.length;
            return res.json({
              success: true,
              text: scribe.text,
              provider: 'elevenlabs',
              model,
              ...(scribe.language ? { language: scribe.language } : {}),
            });
          }
          // Scribe heard nothing: the ladder gives the second opinion before
          // the user is told there was no speech.
          scribeFailure = 'empty';
        } catch (err) {
          // Only the REQUEST's cancellation (client gone / bound reached)
          // stops here. Scribe's own sub-budget expiring is a slow or hung
          // upstream: classified 'timeout' and the ladder gets the time left.
          if (signal.aborted) throw err;
          scribeFailure = budget.expired() ? 'timeout' : classifyScribeError(err);
          if (SCRIBE_REJECTIONS.has(scribeFailure)) rememberScribeRejection(apiKey, scribeFailure, env);
          const status = scribeErrorStatus(err);
          console.warn(`[dictation] scribe failed (${scribeFailure}${status ? ` ${status}` : ''}); using the transcription ladder`);
        } finally {
          budget.dispose();
        }
      }
    }

    const audioTranscriber = require('../services/audio-transcriber');
    const ladder = dictationLadderOptions(env, { paid });
    const result = await untilAborted(audioTranscriber.transcribe(filePath, mimeType, originalName, {
      signal,
      lane: 'interactive',
      ...(language ? { language } : {}),
      ...ladder,
    }), signal);
    const transcript = result && result.ok
      ? String(result.transcript ?? '').trim()
      : '';
    provider = ladderProviderLabel(result);
    if (transcript) {
      outcome = 'ok';
      chars = transcript.length;
      return res.json({
        success: true,
        text: transcript,
        provider,
        model: result.model || null,
        ...(result.language ? { language: result.language } : {}),
        ...(paid ? {} : { free: true }),
        ...(scribeFailure && scribeFailure !== 'empty' ? { scribeFallback: scribeFailure } : {}),
      });
    }
    const reasonCode = result?.reasonCode || (result?.ok ? 'no_speech' : null);
    if (result?.status === 'no_speech' || reasonCode === 'no_speech') {
      outcome = 'no_speech';
      return res.json({
        success: true,
        text: '',
        provider,
        ...(paid ? {} : { free: true }),
        note: DICTATION_NO_SPEECH_NOTE,
      });
    }
    if (DICTATION_UNREADABLE_CODES.has(reasonCode)) {
      outcome = `unreadable:${reasonCode}`;
      return res.status(422).json({ error: DICTATION_UNREADABLE_ERROR, code: 'audio_unreadable', reason: reasonCode });
    }
    outcome = `unavailable:${reasonCode || 'unknown'}`;
    return res.status(503).json({
      error: DICTATION_UNAVAILABLE_ERROR,
      code: 'transcription_unavailable',
      ...(scribeFailure && scribeFailure !== 'empty' ? { scribe: scribeFailure } : {}),
    });
  } catch (err) {
    if (clientGone) {
      outcome = 'client_gone';
      return undefined;
    }
    if (timedOut) {
      // 408, not 503: ApiClient retries 503 and timeouts, and every retry
      // re-uploads the audio and restarts the whole ladder.
      outcome = 'timeout';
      return res.status(408).json({ error: DICTATION_TIMEOUT_ERROR, code: 'transcription_timeout' });
    }
    outcome = `failed:${String(err?.code || err?.name || 'error').slice(0, 40)}`;
    return res.status(503).json({
      error: DICTATION_UNAVAILABLE_ERROR,
      code: 'transcription_unavailable',
      ...(scribeFailure && scribeFailure !== 'empty' ? { scribe: scribeFailure } : {}),
    });
  } finally {
    clearTimeout(timer);
    res.removeListener('close', onClose);
    // Summary line first (synchronously, in the same tick as the response),
    // then the async cleanup of the upload.
    logDictation({
      tier,
      outcome,
      provider,
      scribe: scribeFailure,
      chars,
      ms: Date.now() - started,
    });
    await fs.promises.unlink(filePath).catch(() => {});
  }
});

// Serve audio files
router.get('/audio/:filename', (req, res) => {
  try {
    const resolved = resolveConfinedFile(audioDir, req.params.filename, {
      allowedExtensions: ['.mp3', '.mpeg', '.wav', '.m4a', '.m4b', '.mp4', '.webm', '.ogg'],
    });
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid audio filename' });
    }

    if (!fs.existsSync(resolved.filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }
    const stat = fs.statSync(resolved.filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    // Range support (same convention as /api/video/watch): seeking inside a
    // long narration must not force a full re-download, and some mobile
    // browsers stall duration without Accept-Ranges + 206.
    const range = parseHttpByteRange(req.headers.range, stat.size);
    if (range?.error) {
      res.setHeader('Content-Range', range.contentRange);
      return res.status(416).json({ error: 'Requested range not satisfiable' });
    }

    const contentType = audioContentType(resolved.filename);
    const disposition = contentDispositionHeader('inline', resolved.filename);
    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    if (range) {
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Content-Range': range.contentRange,
        'Accept-Ranges': 'bytes',
        'Content-Length': range.contentLength,
      });
    } else {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', stat.size);
    }

    const stream = (start === 0 && end === stat.size - 1)
      ? fs.createReadStream(resolved.filePath)
      : fs.createReadStream(resolved.filePath, { start, end });
    stream.on('error', (err) => {
      console.error('Error streaming audio file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming audio file' });
      } else {
        res.destroy(err);
      }
    });
    // Release the fd if the client aborts mid-download.
    res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
    stream.pipe(res);

  } catch (error) {
    console.error('Error serving audio file:', error);
    res.status(500).json({ error: 'Error serving audio file' });
  }
});

// Get voice settings for a specific voice
router.get('/voices/:voice_id/settings', authenticateToken, async (req, res) => {
  try {
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }

    const { voice_id } = req.params;
    const voice = await elevenlabs().voices.get(voice_id);

    res.json(voice.settings || {
      stability: 0.5,
      similarity_boost: 0.5,
      style: 0.0,
      use_speaker_boost: true
    });
  } catch (error) {
    console.error('Error fetching voice settings:', error);
    res.status(500).json({ error: error.message });
  }
});



// Test ElevenLabs STT availability
router.get('/test-stt', authenticateToken, async (req, res) => {
  try {
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }

    // Test if STT endpoint exists
    const testResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'OPTIONS',
      headers: {
        'xi-api-key': elevenLabsApiKey(),
      },
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000),
    });

    console.log('ElevenLabs STT test response:', testResponse.status, testResponse.statusText);

    res.json({
      sttAvailable: testResponse.status !== 404,
      status: testResponse.status,
      statusText: testResponse.statusText,
      headers: Object.fromEntries(testResponse.headers.entries())
    });
  } catch (error) {
    console.error('Error testing STT:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user's subscription info
router.get('/user/subscription', authenticateToken, async (req, res) => {
  try {
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }

    const subscriptionResponse = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: {
        'xi-api-key': elevenLabsApiKey(),
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000),
    });

    const subscription = await subscriptionResponse.json().catch(() => ({}));
    if (!subscriptionResponse.ok) {
      return res.status(subscriptionResponse.status).json({
        error: subscription?.detail || subscription?.message || 'Failed to fetch ElevenLabs subscription',
      });
    }

    res.json(subscription);
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});
// ── Clon de voz profesional (ElevenLabs PVC, oficial) ────────────────────────
// "Crear voz → Clon de voz profesional": réplica digital de alta fidelidad.
// Flujo oficial ElevenLabs: crear shell (POST /v1/voices/pvc {name, language})
// → subir muestras (POST /v1/voices/pvc/:id/samples, al menos 30 minutos de
// audio limpio) → entrenar (POST /v1/voices/pvc/:id/train, ~5 minutos) →
// sondear estado (GET /v1/voices/pvc/:id, .fine_tuning.state hasta
// `fine_tuned`). Requiere plan ElevenLabs de pago con slots PVC libres (ver
// GET /elevenlabs/user/subscription) y plan Sira de pago (voice_generation,
// igual que el TTS de ElevenLabs). La voz entrenada aparece automáticamente
// en GET /elevenlabs/voices y por tanto en el catálogo Voz del composer.
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const PVC_SAMPLE_MAX_FILES = 10;
const PVC_SAMPLE_MAX_BYTES = 25 * 1024 * 1024;
const PVC_UPLOAD_TIMEOUT_MS = Number(process.env.ELEVENLABS_UPLOAD_TIMEOUT_MS) || 600000;

const pvcUpload = multer({
  dest: audioDir,
  limits: { fileSize: PVC_SAMPLE_MAX_BYTES, files: PVC_SAMPLE_MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ok = /^(audio|video)\//.test(file.mimetype || '')
      || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm|mp4|mov|mkv|m4v|mpeg|mpg|wma|3gp)$/i.test(file.originalname || '');
    if (ok) return cb(null, true);
    cb(new Error(`Tipo de archivo no permitido: ${file.mimetype || file.originalname}. Sube audio o vídeo.`), false);
  },
});

function pvcVoiceId(req, res) {
  const voiceId = String(req.params.voiceId || '').trim();
  if (!voiceId || voiceId.length > 120) {
    res.status(400).json({ error: 'voiceId inválido' });
    return null;
  }
  return voiceId;
}

function elevenLabsDetail(data, fallback) {
  const detail = data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail.message === 'string' && detail.message.trim()) return detail.message;
  if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  return fallback;
}

async function proxyElevenLabs(res, targetPath, { method = 'GET', json, form, timeoutMs } = {}) {
  const headers = { 'xi-api-key': elevenLabsApiKey(), accept: 'application/json' };
  let body;
  if (form) {
    Object.assign(headers, form.getHeaders());
    body = form;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const upstream = await fetch(`${ELEVENLABS_API_BASE}${targetPath}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs || Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: elevenLabsDetail(data, 'ElevenLabs request failed') });
  }
  return res.status(upstream.status === 201 ? 201 : 200).json(data);
}

// Paso 1 — crear el shell de la voz profesional
router.post('/pvc/voices', [
  body('name').trim().notEmpty().isLength({ max: 80 }).withMessage('Name is required (max 80 chars)'),
  body('language').optional().isString().trim().isLength({ max: 10 }),
], authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    const { name, language = 'es' } = req.body;
    return await proxyElevenLabs(res, '/v1/voices/pvc', { method: 'POST', json: { name, language } });
  } catch (error) {
    console.error('PVC create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Paso 2 — subir muestras de entrenamiento (repetir hasta ≥ 30 minutos)
router.post('/pvc/voices/:voiceId/samples', authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), pvcUpload.array('files', PVC_SAMPLE_MAX_FILES), async (req, res) => {
  const voiceId = pvcVoiceId(req, res);
  if (!voiceId) {
    await Promise.all((req.files || []).map((f) => fs.promises.unlink(f.path).catch(() => {})));
    return;
  }
  try {
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Sube al menos un archivo de audio o vídeo' });
    }
    const form = new FormData();
    for (const file of req.files) {
      form.append('files', fs.createReadStream(file.path), {
        filename: file.originalname || 'muestra',
        contentType: file.mimetype,
      });
    }
    form.append('remove_background_noise', String(req.body?.remove_background_noise) === 'true' ? 'true' : 'false');
    return await proxyElevenLabs(res, `/v1/voices/pvc/${encodeURIComponent(voiceId)}/samples`, {
      method: 'POST',
      form,
      timeoutMs: PVC_UPLOAD_TIMEOUT_MS,
    });
  } catch (error) {
    console.error('PVC samples error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    await Promise.all((req.files || []).map((f) => fs.promises.unlink(f.path).catch(() => {})));
  }
});

// Paso 3 — entrenar (~5 minutos, trabajo en segundo plano en ElevenLabs)
router.post('/pvc/voices/:voiceId/train', [
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
], authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const voiceId = pvcVoiceId(req, res);
    if (!voiceId) return;
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    const { model_id } = req.body;
    return await proxyElevenLabs(res, `/v1/voices/pvc/${encodeURIComponent(voiceId)}/train`, {
      method: 'POST',
      json: model_id ? { model_id } : {},
      timeoutMs: PVC_UPLOAD_TIMEOUT_MS,
    });
  } catch (error) {
    console.error('PVC train error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Paso 4 — estado (.fine_tuning.state: queued | fine_tuning | fine_tuned | failed | delayed)
router.get('/pvc/voices/:voiceId', authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const voiceId = pvcVoiceId(req, res);
    if (!voiceId) return;
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    const encoded = encodeURIComponent(voiceId);
    const headers = { 'xi-api-key': elevenLabsApiKey(), accept: 'application/json' };
    const timeout = AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000);
    // El shell en entrenamiento se lee en /v1/voices/pvc/:id; una vez
    // entrenada, la lectura canónica es /v1/voices/:id.
    let upstream = await fetch(`${ELEVENLABS_API_BASE}/v1/voices/pvc/${encoded}`, { headers, signal: timeout });
    let data = await upstream.json().catch(() => ({}));
    if (upstream.status === 404) {
      upstream = await fetch(`${ELEVENLABS_API_BASE}/v1/voices/${encoded}`, {
        headers,
        signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000),
      });
      data = await upstream.json().catch(() => ({}));
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: elevenLabsDetail(data, 'ElevenLabs request failed') });
    }
    return res.json(data);
  } catch (error) {
    console.error('PVC status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Quitar una muestra del shell
router.delete('/pvc/voices/:voiceId/samples/:sampleId', authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const voiceId = pvcVoiceId(req, res);
    if (!voiceId) return;
    const sampleId = String(req.params.sampleId || '').trim();
    if (!sampleId || sampleId.length > 120) {
      return res.status(400).json({ error: 'sampleId inválido' });
    }
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    return await proxyElevenLabs(res, `/v1/voices/pvc/${encodeURIComponent(voiceId)}/samples/${encodeURIComponent(sampleId)}`, { method: 'DELETE' });
  } catch (error) {
    console.error('PVC delete-sample error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificación de identidad: captcha y verificación manual
router.get('/pvc/voices/:voiceId/captcha', authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const voiceId = pvcVoiceId(req, res);
    if (!voiceId) return;
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    return await proxyElevenLabs(res, `/v1/voices/pvc/${encodeURIComponent(voiceId)}/captcha`);
  } catch (error) {
    console.error('PVC captcha error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/pvc/voices/:voiceId/verification', authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const voiceId = pvcVoiceId(req, res);
    if (!voiceId) return;
    if (!elevenLabsApiKey()) {
      return elevenLabsNotConfigured(res);
    }
    return await proxyElevenLabs(res, `/v1/voices/pvc/${encodeURIComponent(voiceId)}/verification`, { method: 'POST', json: {} });
  } catch (error) {
    console.error('PVC verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ...existing code...

// Music Generation using ElevenLabs — thin wrapper over the shared
// `elevenlabs-music.js` service so the legacy route and
// `/api/ai/generate-music` share ONE generation + file-naming code path.
router.post('/generate-music', [
  body('text').trim().notEmpty().isLength({ max: 2000 }).withMessage('Text prompt is required (max 2000 chars)'),
  body('duration').optional().isInt({ min: 1, max: 300 }).toInt().withMessage('Duration must be an integer between 1 and 300 seconds'),
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
  body('output_format').optional().isString().trim().isLength({ max: 40 }),
], authenticateToken, requirePaidPlan({ feature: 'music_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!elevenLabsMusic.isElevenLabsConfigured()) {
      return elevenLabsNotConfigured(res);
    }

    const {
      text,
      duration: rawDuration = 10, // Default 10 seconds
      output_format = 'mp3_44100_128',
      model_id = 'music_v1'
    } = req.body;
    // Defense-in-depth: clamp the duration (1–300s) even if validation is
    // bypassed, so a bad value can never inflate the ElevenLabs request length
    // or the billed cost row below.
    const duration = Math.min(300, Math.max(1, Math.round(Number(rawDuration) || 10)));

    console.log('Music generation request received:', {
      text: String(text).substring(0, 50) + '...',
      duration,
    });

    // Generate music through the shared service (same contract as the chat route).
    console.log('Calling ElevenLabs Music Generation API...');
    let track;
    try {
      track = await elevenLabsMusic.generateMusicFile({
        prompt: text,
        durationSeconds: duration,
        modelId: model_id,
        outputFormat: output_format,
      });
    } catch (genErr) {
      console.error('ElevenLabs Music API error:', genErr?.status || '', genErr?.message || genErr);
      if (genErr?.code === 'INSUFFICIENT_CREDITS') {
        return res.status(402).json({
          error: 'Insufficient credits for music generation. Please upgrade your ElevenLabs subscription.'
        });
      }
      if (genErr?.code === 'INVALID_PARAMS' || genErr?.code === 'PROMPT_REQUIRED') {
        return res.status(400).json({
          error: 'Invalid music generation parameters. Please check your input.'
        });
      }
      return res.status(genErr?.status && Number.isFinite(Number(genErr.status)) ? Number(genErr.status) : 502).json({
        error: `Music generation failed: ${String(genErr?.message || genErr).slice(0, 300)}`
      });
    }

    console.log('Music generated successfully from ElevenLabs');

    // Track usage
    await prisma.apiUsage.create({
      data: {
        userId: req.user.id,
        model: 'elevenlabs-music',
        tokens: String(text).length,
        cost: duration * 0.01 // Approximate cost per second
      }
    });

    res.json({
      success: true,
      audio_url: track.audioUrl,
      filename: track.filename,
      duration: track.durationSeconds,
      text_prompt: text,
    });

  } catch (error) {
    console.error('Music generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Available music production styles. Mirrors the chat composer's
// MUSIC_STYLE_OPTIONS + MUSIC_STYLE_PROFILES so the audio-panel Music tab
// offers exactly the same directions as the "Producción musical" menu.
router.get('/music-styles', authenticateToken, async (req, res) => {
  try {
    const styles = [
      { id: 'auto', name: 'Auto', description: 'Deja que el modelo elija el genero segun tu prompt.' },
      { id: 'cinematic', name: 'Cinematic', description: 'Texturas amplias, tension y final de trailer.' },
      { id: 'pop', name: 'Pop', description: 'Hook claro, bateria pulida y estructura comercial.' },
      { id: 'electronic', name: 'Electronic', description: 'Sintetizadores, pulso moderno y energia digital.' },
      { id: 'ambient', name: 'Ambient', description: 'Capas suaves, atmosfera y movimiento discreto.' },
      { id: 'orchestral', name: 'Orchestral', description: 'Cuerdas, metales y dinamica de partitura.' },
      { id: 'latin', name: 'Latin', description: 'Ritmo calido, percusion marcada y sabor latino.' },
      { id: 'hip-hop', name: 'Hip-Hop', description: 'Beat con groove, bajo presente y espacio vocal.' },
      { id: 'jazz', name: 'Jazz', description: 'Armonia rica, swing sutil e instrumentacion organica.' }
    ];

    res.json({ styles });
  } catch (error) {
    console.error('Error fetching music styles:', error);
    res.status(500).json({ error: error.message });
  }
});

// ...existing code...


module.exports = router;
// Test seams for the dictation contract (not part of the HTTP API).
module.exports._dictation = {
  classifyScribeError,
  dictationLanguage,
  dictationLadderOptions,
  dictationProviders,
  dictationTimeoutMs,
  scribeTimeoutMs,
  scribeModel,
  scribeText,
  ladderProviderLabel,
  resetScribeCooldown,
  untilAborted,
  DICTATION_CLIENT_TIMEOUT_MS,
  DICTATION_MAX_TIMEOUT_MS,
};
