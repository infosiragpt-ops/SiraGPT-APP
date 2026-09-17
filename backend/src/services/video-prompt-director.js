'use strict';

/**
 * Video Prompt Director — professional-grade prompt engineering + cross-clip
 * continuity ("hilación") for AI video generation.
 *
 * Two responsibilities:
 *
 * 1. PROFESSIONALIZE — turn a raw user prompt into a cinematic, model-ready
 *    prompt: camera framing per aspect ratio, duration-aware pacing, lighting /
 *    quality suffix, audio cues (for audio-capable models), and a strong
 *    default negative prompt that suppresses morphing, flicker, deformed
 *    faces/hands, watermarks and abrupt cuts.
 *
 * 2. CONTINUITY — keep visual coherence across consecutive videos generated in
 *    the same chat/project without any UI change: the backend auto-attaches
 *    recent video history, and the director decides between:
 *      - `none`   — first video, no history to anchor to.
 *      - `style`  — soft bible: same visual universe / art direction / palette.
 *      - `strict` — direct sequel: same character, wardrobe, location, style +
 *        locked capture settings (aspect, resolution, audio, model) so the
 *        next clip cuts cleanly against the previous one.
 *
 * Pure, dependency-free and deterministic — safe to call from routes, the
 * agent tool and unit tests.
 */

const MAX_PROMPT_CHARS = 1200;
const MAX_HISTORY_CONSIDERED = 5;
const ANCHOR_MAX_CHARS = 220;

// Explicit sequel / "keep it" signals, ES + EN. Matched against the raw prompt.
const CONTINUATION_PATTERNS = [
  /contin[uú][a-záéíóú]*/i,
  /siguiente\s+(escena|plano|toma|clip|parte)/i,
  /mism[oa]s?\s+(personajes?|escena|toma|estilo|universo|lugar|vestuario|ropa|plano)/i,
  /igual\s+que\s+antes/i,
  /mant[eé]n\s+(el|la|lo|al)/i,
  /mant[eé]n\s+mism/i,
  /parte\s*\d+/i,
  /\bepisodio\b/i,
  /plano\s+siguiente/i,
  /despu[eé]s\s+de\s+(eso|esto|la|el)/i,
  /secuela/i,
  /hilaci[oó]n/i,
  /mismo\s+video/i,
  /same\s+(character|style|scene|universe|outfit|place|video|clip|shot)/i,
  /keep\s+(the\s+)?same/i,
  /next\s+(shot|scene|clip|part)/i,
  /\bsequel\b/i,
  /\bpart\s*\d+/i,
];

// Stopwords (ES + EN) for the soft-overlap signal.
const STOPWORDS = new Set(
  ('el,la,los,las,un,una,unos,unas,de,del,en,y,o,que,con,por,para,como,sin,sobre,entre,' +
    'este,esta,estos,estas,ese,esa,eso,haz,hacer,crea,crear,genera,generar,video,con,al,' +
    'the,a,an,of,to,in,on,and,or,with,make,create,generate,video,from,for,this,that,it,is')
    .split(',')
);

const CAMERA_BY_ASPECT = {
  '9:16': 'vertical 9:16 framing, subject centred with headroom, composed for mobile full-screen',
  '16:9': 'widescreen cinematic framing, rule of thirds, balanced headroom',
  '1:1': 'centred square composition, subject filling the frame',
  '4:3': 'classic 4:3 framing, centred subject, stable composition',
  '3:4': 'vertical 3:4 framing, subject centred, portrait-friendly composition',
  '21:9': 'ultrawide anamorphic framing, lateral depth, epic scope',
  auto: 'clean centred framing with balanced headroom',
};

const DEFAULT_NEGATIVE_PROMPT =
  'blurry, low resolution, distorted face, deformed hands, extra fingers, ' +
  'extra limbs, morphing, flickering, watermark, logo, text overlay, subtitles, ' +
  'abrupt scene cuts, shaky camera, oversaturated, noisy';

const QUALITY_SUFFIX =
  'professional color grading, natural skin tones, high detail, sharp focus, ' +
  'smooth cinematic motion at 24fps, single coherent shot, no flicker, no morphing';

/**
 * Map a fal.ai endpoint id (or legacy alias) to a director family.
 * Families drive audio-cue behaviour; explicit supportsAudio opts always win.
 */
function inferDirectorFamily(endpoint) {
  const id = String(endpoint || '').toLowerCase();
  if (/veo/.test(id)) return 'veo';
  if (/seedance|bytedance|doubao/.test(id)) return 'seedance';
  if (/kling/.test(id)) return 'kling';
  if (/sora/.test(id)) return 'sora';
  if (/pixverse/.test(id)) return 'pixverse';
  if (/hailuo|minimax/.test(id)) return 'hailuo';
  if (/wan|happy-horse|alibaba/.test(id)) return 'wan';
  if (/ltx/.test(id)) return 'ltx';
  if (/cosmos|nvidia/.test(id)) return 'cosmos';
  return 'other';
}

function familySupportsAudio(family) {
  return family === 'veo' || family === 'seedance' || family === 'kling'
    || family === 'pixverse' || family === 'ltx';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Remove a previously injected bible / sequel header so re-enhancing an
 * already-enhanced prompt never stacks duplicated anchors.
 */
function stripPreviousDirection(text) {
  return cleanText(
    String(text || '')
      .replace(/Direct sequel to the previous shot[^.]*\.\s*/gi, '')
      .replace(/Same visual universe[^.]*\.\s*/gi, '')
      .replace(/Mismo universo visual[^.]*\.\s*/gi, '')
  );
}

function contentTokens(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-záéíóúñü0-9]+/i)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function tokenOverlapRatio(a, b) {
  const setA = new Set(contentTokens(a));
  const setB = new Set(contentTokens(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / Math.max(setA.size, setB.size);
}

function normaliseHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const prompt = cleanText(entry.prompt || entry.originalPrompt || '');
  if (!prompt) return null;
  return {
    prompt,
    enhancedPrompt: cleanText(entry.enhancedPrompt || entry.enhanced_prompt || ''),
    aspect_ratio: entry.aspect_ratio || entry.aspectRatio || null,
    resolution: entry.resolution || null,
    audio: typeof entry.audio === 'boolean' ? entry.audio : null,
    model: entry.model || entry.resolvedModel || entry.modelDisplayName || null,
    createdAt: entry.createdAt || null,
  };
}

function getRecentHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(normaliseHistoryEntry).filter(Boolean).slice(-MAX_HISTORY_CONSIDERED);
}

/**
 * Decide the continuity mode for the incoming prompt given recent history.
 * Returns { mode: 'none'|'style'|'strict', matched: string[] }.
 */
function detectContinuity(prompt, history) {
  const recent = getRecentHistory(history);
  if (!recent.length) return { mode: 'none', matched: [] };

  const text = cleanText(prompt);
  const matched = CONTINUATION_PATTERNS.filter((re) => {
    re.lastIndex = 0;
    return re.test(text);
  }).map((re) => re.source);

  if (matched.length) return { mode: 'strict', matched };

  const last = recent[recent.length - 1];
  const overlap = tokenOverlapRatio(text, last.prompt);
  // Short follow-up sharing subject vocabulary with the previous shot →
  // treat as a soft sequel even without an explicit marker.
  if (overlap >= 0.25 && cleanText(text).length <= 220) {
    return { mode: 'strict', matched: ['soft:subject-overlap'] };
  }

  return { mode: 'style', matched: [] };
}

function buildAnchor(prompt) {
  return cleanText(stripPreviousDirection(prompt)).slice(0, ANCHOR_MAX_CHARS);
}

function pacingForDuration(seconds) {
  if (seconds <= 5) return 'single beat, one clear action from start to finish';
  if (seconds <= 8) return 'two-beat micro-story: setup in the first half, payoff in the second, one smooth transition';
  return 'structured mini-sequence: opening setup, development, closing beat, smooth transitions throughout';
}

function cameraForAspect(aspectRatio) {
  return CAMERA_BY_ASPECT[aspectRatio] || CAMERA_BY_ASPECT.auto;
}

function audioCue({ audio, supportsAudio }) {
  if (supportsAudio && audio) {
    return 'with synchronized ambient audio, natural foley and matching room tone';
  }
  if (!audio) return 'silent footage, no dialogue, no music cues';
  return null;
}

/**
 * Direct a raw user prompt into a professional, continuity-aware prompt.
 *
 * @param {object} opts
 * @param {string} opts.prompt            raw user prompt (required)
 * @param {string} [opts.aspectRatio='16:9']
 * @param {number} [opts.durationSeconds=8]
 * @param {boolean} [opts.audio=true]
 * @param {string} [opts.endpoint='']     fal.ai endpoint id (family inference)
 * @param {boolean|null} [opts.supportsAudio=null]  explicit override from the
 *        resolved model definition; null falls back to family inference.
 * @param {Array}  [opts.history=null]    recent video entries (oldest→newest)
 * @param {boolean|null} [opts.continuation=null] explicit override: true forces
 *        strict, false disables strict (falls back to style/none). null = auto.
 * @param {boolean} [opts.professionalize=true] false = continuity only, prompt
 *        text untouched (plus bible header when strict).
 */
function directVideoPrompt(opts = {}) {
  const rawPrompt = cleanText(opts.prompt);
  if (!rawPrompt) throw new Error('directVideoPrompt: prompt is required');

  const aspectRatio = opts.aspectRatio || '16:9';
  const durationSeconds = Number.isFinite(Number(opts.durationSeconds))
    ? Math.min(Math.max(Number(opts.durationSeconds), 1), 30)
    : 8;
  const audio = opts.audio !== false;
  const family = inferDirectorFamily(opts.endpoint || opts.modelFamily || '');
  const supportsAudio = typeof opts.supportsAudio === 'boolean'
    ? opts.supportsAudio
    : familySupportsAudio(family);
  const professionalize = opts.professionalize !== false;

  const recent = getRecentHistory(opts.history);
  const last = recent.length ? recent[recent.length - 1] : null;
  const auto = detectContinuity(rawPrompt, recent);

  let mode = auto.mode;
  if (opts.continuation === true && last) mode = 'strict';
  else if (opts.continuation === false) mode = last ? 'style' : 'none';

  const base = stripPreviousDirection(rawPrompt);
  const parts = [];

  let bible = null;
  if (last) {
    bible = {
      anchor: buildAnchor(last.prompt),
      aspect_ratio: last.aspect_ratio,
      resolution: last.resolution,
      audio: last.audio,
      model: last.model,
    };
  }

  if (mode === 'strict' && bible) {
    parts.push(
      `Direct sequel to the previous shot — same character, same wardrobe, same location, ` +
        `same art style and color palette. Previous shot: "${bible.anchor}". ` +
        `Maintain identical appearance with no recast and no style change.`
    );
  } else if (mode === 'style' && bible) {
    parts.push(
      `Same visual universe and art direction as the previous shot ("${bible.anchor}"). ` +
        `Consistent color palette, lighting and style.`
    );
  }

  parts.push(base);

  if (professionalize) {
    parts.push(`Pacing: ${pacingForDuration(durationSeconds)}.`);
    parts.push(`Camera: ${cameraForAspect(aspectRatio)}.`);
    const cue = audioCue({ audio, supportsAudio });
    if (cue) parts.push(`${cue}.`);
    parts.push(`${QUALITY_SUFFIX}.`);
  }

  let directed = cleanText(parts.join(' '));
  if (directed.length > MAX_PROMPT_CHARS) {
    // Never truncate the user's own words: shrink the bible anchor first.
    const overflow = directed.length - MAX_PROMPT_CHARS;
    if (bible && overflow < bible.anchor.length) {
      const shorter = bible.anchor.slice(0, bible.anchor.length - overflow - 3).trim();
      directed = directed.replace(bible.anchor, `${shorter}…`);
      bible.anchor = `${shorter}…`;
    } else {
      directed = directed.slice(0, MAX_PROMPT_CHARS).trim();
    }
  }

  // Capture settings: strict mode locks them to the previous clip so cuts match.
  const settingsLocked = [];
  const settings = {
    aspect_ratio: aspectRatio,
    resolution: opts.resolution || null,
    audio,
    model: opts.endpoint || opts.modelName || null,
  };
  if (mode === 'strict' && last) {
    for (const key of ['aspect_ratio', 'resolution', 'audio', 'model']) {
      const prev = key === 'aspect_ratio' ? last.aspect_ratio
        : key === 'resolution' ? last.resolution
        : key === 'audio' ? last.audio
        : last.model;
      if (prev !== null && prev !== undefined && prev !== settings[key]) {
        settings[key] = prev;
        settingsLocked.push(key);
      }
    }
  }

  return {
    prompt: directed,
    originalPrompt: rawPrompt,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    continuityMode: mode,
    matchedSignals: auto.matched,
    anchorUsed: bible ? bible.anchor : null,
    bible,
    settings,
    settingsLocked,
    professionalized: professionalize,
  };
}

/**
 * Build the lightweight history entries the director consumes from stored
 * video operations / chat messages.
 */
function toHistoryEntries(items) {
  return getRecentHistory(items);
}

module.exports = {
  directVideoPrompt,
  detectContinuity,
  toHistoryEntries,
  stripPreviousDirection,
  inferDirectorFamily,
  DEFAULT_NEGATIVE_PROMPT,
  MAX_PROMPT_CHARS,
  CONTINUATION_PATTERNS,
};
