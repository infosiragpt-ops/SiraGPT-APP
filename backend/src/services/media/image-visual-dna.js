'use strict';

/**
 * image-visual-dna — Multimodal Visual Identity Lock, Pixel Colorimetry &
 * Cumulative State-Delta Engine for SiraGPT Image Generation.
 *
 * Ensures zero-drift subject & attribute continuity across multi-turn image
 * conversations on ANY image model (both pixel-edit models like GPT Image /
 * Gemini Flash Image and text-to-image-only models like FLUX 1.1 Pro, Flux
 * Schnell, Imagen 4, Grok 2 Image, DALL-E 3, Recraft, Ideogram) without ever
 * silently switching the user's chosen model or provider (AGENTS.md §13).
 *
 * Three layers:
 *   1. Deterministic `<3ms` `sharp` Pixel Colorimetry & Luminance Signature
 *      (`extractPixelColorSignature`) — works 100% offline with zero network,
 *      measuring center-subject vs outer-backdrop dominant `#RRGGBB` palettes
 *      and lighting key directly from the prior rendered image bytes.
 *   2. Bounded Multimodal Vision Identity Extractor (`extractMultimodalVisualDna`)
 *      — uses `services/ai/vision-runtime` (when configured) under a strict
 *      timeout budget to extract objective forensic subject morphology (breed,
 *      facial structure, markings, eyes, wardrobe, pose, setting), cached on
 *      message metadata so Turn 3+ reuses it in `0ms`.
 *   3. Bilingual Chromatic & Cumulative State-Delta Compiler
 *      (`extractChromaticAndTraitOverrides` + `compileCumulativeVisualState`)
 *      — translates ambiguous Spanish color modifiers (e.g. `"de color celeste"`
 *      → `vivid sky-blue / light cerulean (#7DD3FC)`) into high-attention T5/CLIP
 *      chromatic locks, carries deltas forward across Turn 1 → Turn 2 → Turn 3+,
 *      and neutralizes conflicting `"true-to-life natural color"` archetype cues.
 */

const sharp = require('sharp');
const OpenAI = require('openai');
const { visionClientConfig, visionRuntimeCandidates } = require('../ai/vision-runtime');

const MAX_DNA_CHARS = 380;
const DEFAULT_VISION_DNA_TIMEOUT_MS = 3200;
const PIXEL_SAMPLE_SIZE = 48;
const MAX_INPUT_PIXELS = 40 * 1024 * 1024;
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test'
  || Boolean(process.env.NODE_TEST_CONTEXT)
  || process.execArgv.includes('--test');

const STANDARD_RATIOS = [
  ['1:1', 1],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
];

// ── Normalization & Sanitization Helpers ──────────────────────────────────

function collapseSpaces(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function normalizePlain(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SECRET_OR_SLUG_RE = /\b(?:sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}|AKIA[0-9A-Z]{16}|openrouter|deepseek|fal-ai\/[a-z0-9._/-]+)\b/gi;
const ARTIST_IMITATION_RE = /,?\s*\b(?:in\s+the\s+style\s+of|al\s+estilo\s+de|estilo\s+de|inspired\s+by)\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]+){0,2}/g;
const INJECTION_CLAUSE_RE = /\b(?:ignore\s+(?:all\s+|previous\s+|prior\s+)*instructions?|disregard\s+(?:all\s+|previous\s+)*instructions?|system\s*prompt\s*:|developer\s*prompt\s*:|<\|im_start\|>|\[INST\])/i;

function sanitizeDnaText(raw, maxChars = MAX_DNA_CHARS) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(ARTIST_IMITATION_RE, '')
    .replace(SECRET_OR_SLUG_RE, '')
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((s) => s.trim())
    .filter((s) => s && !INJECTION_CLAUSE_RE.test(s))
    .join(' ');
  const compact = collapseSpaces(cleaned).replace(/^["'«“]+|["'»”]+$/g, '').trim();
  if (!compact) return '';
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1).trim()}…`;
}

// ── 1. Deterministic `sharp` Pixel Colorimetry & Luminance Signature ──────

function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

/**
 * Classify an RGB color into a concise perceptual English color descriptor.
 */
function describeRgbColor(r, g, b) {
  const { h, s, l } = rgbToHsl(r, g, b);
  if (l <= 0.14) return 'deep charcoal black';
  if (l >= 0.90 && s <= 0.18) return 'crisp ivory white';
  if (s <= 0.12) {
    if (l < 0.35) return 'dark slate gray';
    if (l > 0.72) return 'light silver gray';
    return 'neutral mid-gray';
  }
  if (h >= 18 && h < 44 && l < 0.52 && s < 0.65) return 'warm chestnut brown';
  if (h >= 25 && h < 52 && l >= 0.72 && s < 0.45) return 'warm cream beige';
  if (h < 15 || h >= 345) return l < 0.42 ? 'deep crimson red' : 'vivid red';
  if (h >= 15 && h < 42) return l < 0.48 ? 'terracotta amber brown' : 'vibrant warm orange';
  if (h >= 42 && h < 68) return l < 0.52 ? 'warm golden ochre' : 'bright golden yellow';
  if (h >= 68 && h < 162) return l < 0.42 ? 'deep forest olive green' : 'vibrant emerald green';
  if (h >= 162 && h < 196) return 'bright turquoise cyan';
  if (h >= 196 && h < 222) return l >= 0.55 ? 'vivid sky blue' : 'cerulean blue';
  if (h >= 222 && h < 258) return l < 0.35 ? 'deep navy blue' : 'rich cobalt blue';
  if (h >= 258 && h < 305) return 'rich violet purple';
  return l >= 0.68 ? 'soft pastel rose pink' : 'vivid magenta rose';
}

function nearestStandardRatio(width, height) {
  if (!width || !height) return null;
  const target = width / height;
  let best = '1:1';
  let bestDiff = Infinity;
  for (const [label, ratio] of STANDARD_RATIOS) {
    const diff = Math.abs(Math.log(target / ratio));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = label;
    }
  }
  return best;
}

function topQuantizedColors(pixels, maxColors = 2) {
  if (!pixels.length) return [];
  const buckets = new Map();
  const step = 32;
  for (const [r, g, b] of pixels) {
    const key = `${Math.floor(r / step)},${Math.floor(g / step)},${Math.floor(b / step)}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
      buckets.set(key, entry);
    }
    entry.count += 1;
    entry.sumR += r;
    entry.sumG += g;
    entry.sumB += b;
  }
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const out = [];
  const usedNames = new Set();
  for (const bucket of sorted) {
    const avgR = Math.round(bucket.sumR / bucket.count);
    const avgG = Math.round(bucket.sumG / bucket.count);
    const avgB = Math.round(bucket.sumB / bucket.count);
    const hex = rgbToHex(avgR, avgG, avgB);
    const name = describeRgbColor(avgR, avgG, avgB);
    if (usedNames.has(name) && out.length > 0) continue;
    usedNames.add(name);
    out.push({
      hex,
      name,
      share: Number((bucket.count / pixels.length).toFixed(2)),
    });
    if (out.length >= maxColors) break;
  }
  return out;
}

/**
 * Deterministic `<3ms` pixel signature over an image buffer using `sharp`.
 * Returns `null` cleanly if `imageBuffer` is missing or non-image stub bytes.
 */
async function extractPixelColorSignature(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 16) return null;
  try {
    const meta = await sharp(imageBuffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    if (!meta || !meta.width || !meta.height) return null;

    const raw = await sharp(imageBuffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize(PIXEL_SAMPLE_SIZE, PIXEL_SAMPLE_SIZE, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();

    const subjectPixels = [];
    const backdropPixels = [];
    let lumSum = 0;
    let opaqueCount = 0;

    const innerMin = Math.floor(PIXEL_SAMPLE_SIZE * 0.25);
    const innerMax = Math.ceil(PIXEL_SAMPLE_SIZE * 0.75);

    for (let y = 0; y < PIXEL_SAMPLE_SIZE; y += 1) {
      for (let x = 0; x < PIXEL_SAMPLE_SIZE; x += 1) {
        const idx = (y * PIXEL_SAMPLE_SIZE + x) * 4;
        const r = raw[idx];
        const g = raw[idx + 1];
        const b = raw[idx + 2];
        const a = raw[idx + 3];
        if (a < 40) continue;
        opaqueCount += 1;
        lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (x >= innerMin && x < innerMax && y >= innerMin && y < innerMax) {
          subjectPixels.push([r, g, b]);
        } else {
          backdropPixels.push([r, g, b]);
        }
      }
    }

    if (opaqueCount === 0) return null;
    const meanLuminance = Number((lumSum / opaqueCount).toFixed(2));
    const lightingKey = meanLuminance < 0.28
      ? 'low-key dramatic lighting'
      : meanLuminance > 0.72
        ? 'high-key bright lighting'
        : 'balanced natural key lighting';

    return {
      width: meta.width,
      height: meta.height,
      aspectRatio: nearestStandardRatio(meta.width, meta.height),
      subjectColors: topQuantizedColors(subjectPixels.length ? subjectPixels : backdropPixels, 2),
      backdropColors: topQuantizedColors(backdropPixels.length ? backdropPixels : subjectPixels, 2),
      lightingKey,
      meanLuminance,
    };
  } catch {
    return null;
  }
}

// ── 2. Bilingual Chromatic & Attribute Override Lexicon ───────────────────

// Ordered longest-first so multi-word color expressions ("azul celeste",
// "verde esmeralda", "rosa pastel") win before generic base hues ("azul").
const CHROMATIC_LEXICON = [
  {
    id: 'sky_blue',
    en: 'vivid sky-blue / light cerulean',
    hex: '#7DD3FC',
    family: 'blue',
    nonNatural: true,
    re: /\b(?:azul(?:es)?\s+celestes?|color\s+celeste|tono\s+celeste|celestes?(?:\s+clar[oa]s?|\s+brillantes?|\s+intens[oa]s?|\s+pastel)?|azul(?:es)?\s+cielo|sky[\s-]?blue|light\s+cerulean|baby\s+blue)\b/i,
  },
  {
    id: 'electric_blue',
    en: 'vivid electric cobalt blue',
    hex: '#2563EB',
    family: 'blue',
    nonNatural: true,
    re: /\b(?:azul(?:es)?\s+electric[oa]s?|azul(?:es)?\s+cobalto|azul(?:es)?\s+rey|electric\s+blue|cobalt\s+blue|royal\s+blue)\b/i,
  },
  {
    id: 'navy_blue',
    en: 'deep navy midnight blue',
    hex: '#1E3A8A',
    family: 'blue',
    nonNatural: true,
    re: /\b(?:azul(?:es)?\s+marin[oa]s?|azul(?:es)?\s+oscur[oa]s?|azul(?:es)?\s+medianoche|navy\s+blue|midnight\s+blue|dark\s+blue)\b/i,
  },
  {
    id: 'turquoise',
    en: 'bright turquoise cyan',
    hex: '#2DD4BF',
    family: 'cyan',
    nonNatural: true,
    re: /\b(?:verdes?\s+agua|azul(?:es)?\s+turquesas?|turquesas?|aguamarinas?|cian|cyan|turquoise|aquamarine|teal)\b/i,
  },
  {
    id: 'emerald_green',
    en: 'vivid emerald green',
    hex: '#10B981',
    family: 'green',
    nonNatural: true,
    re: /\b(?:verdes?\s+esmeraldas?|esmeraldas?|verdes?\s+intens[oa]s?|verdes?\s+brillantes?|emerald\s+green)\b/i,
  },
  {
    id: 'mint_green',
    en: 'soft pastel mint green',
    hex: '#6EE7B7',
    family: 'green',
    nonNatural: true,
    re: /\b(?:verdes?\s+menta|verdes?\s+pastel|verdes?\s+clar[oa]s?|mint\s+green|pastel\s+green)\b/i,
  },
  {
    id: 'pastel_pink',
    en: 'soft pastel rose pink',
    hex: '#F9A8D4',
    family: 'pink',
    nonNatural: true,
    re: /\b(?:rosas?\s+pastel|rosad[oa]s?\s+clar[oa]s?|rosas?\s+clar[oa]s?|rosas?\s+bebe|pastel\s+pink|soft\s+pink|blush\s+pink)\b/i,
  },
  {
    id: 'magenta',
    en: 'vivid fuchsia magenta',
    hex: '#D946EF',
    family: 'pink',
    nonNatural: true,
    re: /\b(?:fucsias?|magentas?|rosas?\s+neon|hot\s+pink|fuchsia)\b/i,
  },
  {
    id: 'pink',
    en: 'vivid rose pink',
    hex: '#EC4899',
    family: 'pink',
    nonNatural: true,
    re: /\b(?:color\s+rosa(?:do)?|rosas?|rosad[oa]s?|pink|rose\s+pink)\b/i,
  },
  {
    id: 'purple',
    en: 'rich violet purple',
    hex: '#8B5CF6',
    family: 'purple',
    nonNatural: true,
    re: /\b(?:morad[oa]s?|violetas?|purpuras?|lilas?|lavandas?|purple|violet|lilac|lavender)\b/i,
  },
  {
    id: 'crimson_red',
    en: 'deep crimson scarlet red',
    hex: '#DC2626',
    family: 'red',
    nonNatural: true,
    re: /\b(?:roj[oa]s?\s+carmesi(?:es)?|roj[oa]s?\s+escarlatas?|roj[oa]s?\s+intens[oa]s?|carmesi(?:es)?|escarlatas?|vino\s+tinto|burdeos|crimson(?:\s+red)?|scarlet(?:\s+red)?|burgundy)\b/i,
  },
  {
    id: 'red',
    en: 'vivid red',
    hex: '#EF4444',
    family: 'red',
    nonNatural: true,
    re: /\b(?:color\s+rojo|roj[oa]s?|red)\b/i,
  },
  {
    id: 'gold',
    en: 'lustrous metallic gold',
    hex: '#F59E0B',
    family: 'gold',
    nonNatural: true,
    re: /\b(?:amarill[oa]s?\s+dorad[oa]s?|color\s+oro|dorad[oa]s?|golden|metallic\s+gold)\b/i,
  },
  {
    id: 'silver',
    en: 'sleek metallic silver',
    hex: '#CBD5E1',
    family: 'silver',
    nonNatural: true,
    re: /\b(?:gris(?:es)?\s+plata|color\s+plata|platead[oa]s?|cromad[oa]s?|metallic\s+silver|chrome\s+silver|silver)\b/i,
  },
  {
    id: 'yellow',
    en: 'bright canary yellow',
    hex: '#FACC15',
    family: 'yellow',
    nonNatural: true,
    re: /\b(?:color\s+amarillo|amarill[oa]s?|yellow)\b/i,
  },
  {
    id: 'orange',
    en: 'vibrant tangerine orange',
    hex: '#F97316',
    family: 'orange',
    nonNatural: false,
    re: /\b(?:color\s+naranja|naranjas?|anaranjad[oa]s?|orange)\b/i,
  },
  {
    id: 'green',
    en: 'vibrant green',
    hex: '#22C55E',
    family: 'green',
    nonNatural: true,
    re: /\b(?:color\s+verde|verdes?|green)\b/i,
  },
  {
    id: 'blue',
    en: 'rich cobalt blue',
    hex: '#3B82F6',
    family: 'blue',
    nonNatural: true,
    re: /\b(?:color\s+azul|azul(?:es)?|blue)\b/i,
  },
  {
    id: 'black_and_white',
    en: 'high-contrast monochrome black-and-white',
    hex: '#1E293B',
    family: 'monochrome',
    nonNatural: true,
    re: /\b(?:blanco\s+y\s+negro|monocromatic[oa]s?|escala\s+de\s+grises|black\s+and\s+white|monochrome|grayscale)\b/i,
  },
  {
    id: 'white',
    en: 'pure snow white',
    hex: '#F8FAFC',
    family: 'white',
    nonNatural: false,
    re: /\b(?:blanc[oa]s?\s+nieve|color\s+blanco|albin[oa]s?|blanc[oa]s?|snow\s+white|pure\s+white|white)\b/i,
  },
  {
    id: 'black',
    en: 'deep jet black',
    hex: '#0F172A',
    family: 'black',
    nonNatural: false,
    re: /\b(?:negr[oa]s?\s+azabache|negr[oa]s?\s+mate|color\s+negro|negr[oa]s?|jet\s+black|matte\s+black|black)\b/i,
  },
  {
    id: 'brown',
    en: 'rich warm chestnut brown',
    hex: '#78350F',
    family: 'brown',
    nonNatural: false,
    re: /\b(?:color\s+marron|color\s+cafe|marron(?:es)?|castan[oa]s?|chocolate|brown|chestnut)\b/i,
  },
  {
    id: 'gray',
    en: 'sleek slate gray',
    hex: '#64748B',
    family: 'gray',
    nonNatural: false,
    re: /\b(?:color\s+gris|gris(?:es)?|plomos?|gray|grey)\b/i,
  },
];

const BACKGROUND_SCOPE_RE = /\b(?:fondo|background|cielo|sky|escenario|pared|backdrop)\s*(?:de\s+color|en\s+color|color|en|a|to|in|is)?\s*$/i;
const EYES_SCOPE_BEFORE_RE = /\b(?:ojos?|mirada|iris|eyes?)\s*(?:de\s+color|en\s+color|color|en|a|to|in)?\s*$/i;
const EYES_SCOPE_AFTER_RE = /^\s*(?:eyes?|ojos?)\b/i;
const ACCESSORY_SCOPE_RE = /\b(sombrero|gorra|casco|corona|collar|bufanda|gafas|lentes|camisa|camiseta|vestido|chaqueta|abrigo|traje|corbata|zapatos|marco|borde|hat|cap|helmet|crown|collar|scarf|glasses|sunglasses|shirt|t-shirt|dress|jacket|coat|suit|tie|shoes|frame|border)\s*(?:de\s+color|en\s+color|color|en|a)?\s*$/i;
const LIGHTING_SCOPE_RE = /\b(?:luz|luces|iluminacion|neon|resplandor|lighting|glow)\s*(?:de\s+color|en\s+color|color|en|a)?\s*$/i;

const ADDITIVE_PROP_PATTERNS = [
  { id: 'hat', en: 'wearing a stylish hat', re: /\b(?:con\s+(?:un\s+)?sombrero|ponle\s+(?:un\s+)?sombrero|agregale\s+(?:un\s+)?sombrero|with\s+a\s+hat|wearing\s+a\s+hat)\b/i },
  { id: 'cap', en: 'wearing a cap', re: /\b(?:con\s+(?:una\s+)?gorra|ponle\s+(?:una\s+)?gorra|with\s+a\s+cap)\b/i },
  { id: 'glasses', en: 'wearing glasses/sunglasses', re: /\b(?:con\s+(?:unas\s+)?(?:gafas|lentes)(?:\s+de\s+sol)?|ponle\s+(?:unas\s+)?(?:gafas|lentes)(?:\s+de\s+sol)?|with\s+(?:sun)?glasses|wearing\s+(?:sun)?glasses)\b/i },
  { id: 'crown', en: 'wearing a royal crown', re: /\b(?:con\s+(?:una\s+)?corona|ponle\s+(?:una\s+)?corona|with\s+a\s+crown|wearing\s+a\s+crown)\b/i },
  { id: 'collar', en: 'wearing a collar', re: /\b(?:con\s+(?:un\s+)?collar|ponle\s+(?:un\s+)?collar|with\s+a\s+collar)\b/i },
  { id: 'scarf', en: 'wearing a scarf', re: /\b(?:con\s+(?:una\s+)?bufanda|ponle\s+(?:una\s+)?bufanda|with\s+a\s+scarf)\b/i },
  { id: 'suit', en: 'dressed in a tailored suit', re: /\b(?:con\s+(?:un\s+)?traje|vestid[oa]\s+de\s+traje|in\s+a\s+suit|wearing\s+a\s+suit)\b/i },
];

const ENVIRONMENT_DELTA_PATTERNS = [
  { id: 'night', en: 'nighttime scene under moonlight/ambient night lighting', re: /\b(?:de\s+noche|en\s+la\s+noche|nocturn[oa]|at\s+night|nighttime)\b/i },
  { id: 'sunset', en: 'warm golden sunset horizon lighting', re: /\b(?:al\s+atardecer|en\s+el\s+atardecer|puesta\s+de\s+sol|at\s+sunset|sunset\s+sky)\b/i },
  { id: 'rain', en: 'atmospheric rain with wet reflective surfaces', re: /\b(?:bajo\s+la\s+lluvia|con\s+lluvia|lloviendo|in\s+the\s+rain|rainy)\b/i },
  { id: 'snow', en: 'snowy winter setting with crisp snow', re: /\b(?:en\s+la\s+nieve|con\s+nieve|nevando|in\s+the\s+snow|snowy)\b/i },
  { id: 'beach', en: 'coastal beach setting with ocean horizon', re: /\b(?:en\s+la\s+playa|frente\s+al\s+mar|on\s+the\s+beach|at\s+the\s+beach)\b/i },
  { id: 'space', en: 'outer space cosmic backdrop', re: /\b(?:en\s+el\s+espacio|en\s+la\s+luna|in\s+outer\s+space|on\s+the\s+moon)\b/i },
];

function classifyColorScope(normPrompt, matchIndex, matchLength) {
  const before = normPrompt.slice(Math.max(0, matchIndex - 34), matchIndex);
  const after = normPrompt.slice(matchIndex + matchLength, matchIndex + matchLength + 20);
  if (BACKGROUND_SCOPE_RE.test(before) && !/\bsin\s+fondo\b/i.test(before)) {
    return { scope: 'background', targetNoun: 'background' };
  }
  if (EYES_SCOPE_BEFORE_RE.test(before) || EYES_SCOPE_AFTER_RE.test(after)) {
    return { scope: 'eyes', targetNoun: 'eyes' };
  }
  const accMatch = before.match(ACCESSORY_SCOPE_RE);
  if (accMatch) {
    return { scope: 'accessory', targetNoun: accMatch[1] };
  }
  if (LIGHTING_SCOPE_RE.test(before)) {
    return { scope: 'lighting', targetNoun: 'lighting' };
  }
  return { scope: 'subject', targetNoun: 'subject' };
}

/**
 * Extract structured chromatic & trait overrides from a user prompt in `<0.5ms`.
 */
function extractChromaticAndTraitOverrides(prompt) {
  const raw = String(prompt == null ? '' : prompt);
  const norm = normalizePlain(raw);
  if (!norm) return [];

  const overrides = [];
  const consumedSpans = [];

  const overlapsConsumed = (start, end) => consumedSpans.some(([s, e]) => start < e && end > s);

  // 1. Explicit #HEX color codes in the user prompt.
  for (const hexMatch of raw.matchAll(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g)) {
    const rawHex = hexMatch[0].toUpperCase();
    const hex = rawHex.length === 4
      ? `#${rawHex[1]}${rawHex[1]}${rawHex[2]}${rawHex[2]}${rawHex[3]}${rawHex[3]}`
      : rawHex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const approxIdx = norm.indexOf(rawHex.toLowerCase());
    const { scope, targetNoun } = classifyColorScope(norm, Math.max(0, approxIdx), rawHex.length);
    overrides.push({
      kind: 'color',
      id: `hex_${hex.slice(1).toLowerCase()}`,
      en: `${describeRgbColor(r, g, b)} (${hex})`,
      hex,
      family: 'custom_hex',
      scope,
      targetNoun,
      nonNatural: true,
    });
  }

  // 2. Named Spanish / English chromatic overrides (longest match first).
  const explicitDeColor = /\b(?:de\s+color|en\s+color|color|en\s+tono|tono|pintad[oa]\s+de|tenid[oa]\s+de|in\s+color)\b/.test(norm);
  for (const entry of CHROMATIC_LEXICON) {
    const m = entry.re.exec(norm);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsConsumed(start, end)) continue;
    // Guard Spanish noun homographs ("una rosa azul" = rose flower, "una naranja" = orange fruit).
    const beforeSlice = norm.slice(Math.max(0, start - 22), start);
    if (entry.id === 'pink' && /^rosas?$/.test(m[0]) && /\b(?:una|unas|la|las|dos|tres|cuatro|ramo\s+de)\s+$/.test(beforeSlice)) {
      continue;
    }
    if (entry.id === 'orange' && /^naranjas?$/.test(m[0]) && /\b(?:una|unas|la|las|dos|tres|jugo\s+de|zumo\s+de)\s+$/.test(beforeSlice)) {
      continue;
    }
    consumedSpans.push([start, end]);
    const { scope, targetNoun } = classifyColorScope(norm, start, m[0].length);
    overrides.push({
      kind: 'color',
      id: entry.id,
      en: entry.en,
      hex: entry.hex,
      family: entry.family,
      scope,
      targetNoun,
      nonNatural: Boolean(entry.nonNatural || (scope === 'subject' && explicitDeColor)),
    });
  }

  // 3. Additive props / wardrobe deltas.
  for (const prop of ADDITIVE_PROP_PATTERNS) {
    if (prop.re.test(norm)) {
      overrides.push({
        kind: 'prop',
        id: prop.id,
        en: prop.en,
        scope: 'accessory',
        targetNoun: prop.id,
        nonNatural: false,
      });
    }
  }

  // 4. Environment / time-of-day deltas.
  for (const envDelta of ENVIRONMENT_DELTA_PATTERNS) {
    if (envDelta.re.test(norm)) {
      overrides.push({
        kind: 'environment',
        id: envDelta.id,
        en: envDelta.en,
        scope: 'environment',
        targetNoun: 'environment',
        nonNatural: false,
      });
    }
  }

  return overrides;
}

// ── 3. Multimodal Vision DNA Extractor ────────────────────────────────────

const VISION_DNA_SYSTEM_PROMPT = [
  'You are an objective visual continuity analyst for an AI image studio.',
  'Describe ONLY the concrete visible traits of this image in ONE compact English paragraph (maximum 60 words):',
  '1) exact main subject (species/breed or person appearance, facial structure, markings/stripes/spots, eye color, fur/hair/skin color, wardrobe/accessories, pose and gaze direction),',
  '2) background environment, depth-of-field, lighting direction/mood, and framing.',
  'Do NOT include greetings, artist names, camera brand guesses, or meta commentary.',
].join(' ');

function stripLeadingCreateWrapper(promptText) {
  return String(promptText || '')
    .replace(/^(?:por\s+favor\s+)?(?:crea(?:me)?|genera(?:me)?|haz(?:me)?|dibuja(?:me)?|disena(?:me)?|quiero|dame|muestrame|make|create|generate|draw)\s+(?:una?\s+|otra?\s+)?(?:(?:imagen|foto|fotografia|ilustracion|dibujo|retrato|image|photo|picture)\s+(?:de\s+|con\s+|sobre\s+)?)?/i, '')
    .trim();
}

function formatOfflinePixelSummary(pixelSignature, priorPrompt) {
  const cleanPrior = sanitizeDnaText(stripLeadingCreateWrapper(priorPrompt || ''), 170);
  const parts = [];
  if (cleanPrior) parts.push(`subject "${cleanPrior}"`);
  if (pixelSignature) {
    if (Array.isArray(pixelSignature.subjectColors) && pixelSignature.subjectColors.length > 0) {
      const subj = pixelSignature.subjectColors
        .map((c) => `${c.name} (${c.hex})`)
        .join(' and ');
      parts.push(`dominant subject palette ${subj}`);
    }
    if (Array.isArray(pixelSignature.backdropColors) && pixelSignature.backdropColors.length > 0) {
      const bg = pixelSignature.backdropColors
        .map((c) => `${c.name} (${c.hex})`)
        .join(' and ');
      parts.push(`backdrop palette ${bg}`);
    }
    if (pixelSignature.lightingKey) {
      parts.push(pixelSignature.lightingKey);
    }
  }
  return sanitizeDnaText(parts.join(', '), MAX_DNA_CHARS);
}

/**
 * Extract Multimodal Visual DNA from the prior image buffer + metadata.
 * Reuses `cachedVisualDna` in `0ms` when already stored on message metadata.
 */
async function extractMultimodalVisualDna(imageBuffer, mimeType = 'image/png', {
  cachedVisualDna = null,
  priorPrompt = '',
  env = process.env,
  timeoutMs = DEFAULT_VISION_DNA_TIMEOUT_MS,
  visionComplete = null,
  allowLiveVision = !IS_TEST_RUNTIME,
  signal = null,
} = {}) {
  const pixelSignature = Buffer.isBuffer(imageBuffer)
    ? await extractPixelColorSignature(imageBuffer)
    : null;

  if (typeof cachedVisualDna === 'string' && cachedVisualDna.trim()) {
    const cleanCached = sanitizeDnaText(cachedVisualDna, MAX_DNA_CHARS);
    if (cleanCached) {
      return {
        visualDna: cleanCached,
        pixelSignature,
        source: 'cache',
      };
    }
  }

  const canRunVision = typeof visionComplete === 'function'
    || Boolean(
      allowLiveVision
      && Buffer.isBuffer(imageBuffer)
      && pixelSignature
      && pixelSignature.width >= 16
      && pixelSignature.height >= 16
      && visionRuntimeCandidates(env).length > 0
    );

  if (canRunVision && Buffer.isBuffer(imageBuffer)) {
    let timer = null;
    try {
      const dataUrl = `data:${mimeType || 'image/png'};base64,${imageBuffer.toString('base64')}`;
      const runVisionCall = async () => {
        if (typeof visionComplete === 'function') {
          return visionComplete({ dataUrl, mimeType, systemPrompt: VISION_DNA_SYSTEM_PROMPT, priorPrompt });
        }
        const candidates = visionRuntimeCandidates(env);
        for (const candidate of candidates) {
          const cfg = visionClientConfig(candidate.provider, env);
          if (!cfg || !cfg.apiKey || cfg.protocol === 'anthropic') continue;
          try {
            const client = new OpenAI({
              apiKey: cfg.apiKey,
              ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
            });
            const completion = await client.chat.completions.create({
              model: candidate.model,
              temperature: 0,
              max_tokens: 180,
              messages: [
                { role: 'system', content: VISION_DNA_SYSTEM_PROMPT },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Extract the compact visual continuity description of this image.' },
                    { type: 'image_url', image_url: { url: dataUrl } },
                  ],
                },
              ],
            }, signal ? { signal } : undefined);
            const content = completion?.choices?.[0]?.message?.content || '';
            if (content && content.trim()) return content;
          } catch {
            // Try next configured vision runtime candidate before offline fallback.
          }
        }
        return '';
      };

      const timeoutSentinel = Symbol('vision_dna_timeout');
      const rawVision = await Promise.race([
        runVisionCall(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(timeoutSentinel), Math.max(250, timeoutMs));
          if (timer && typeof timer.unref === 'function') timer.unref();
        }),
      ]);

      if (rawVision !== timeoutSentinel && typeof rawVision === 'string' && rawVision.trim()) {
        const cleanVision = sanitizeDnaText(rawVision, 320);
        if (cleanVision) {
          const lightingTail = pixelSignature?.backdropColors?.length
            ? ` (backdrop ${pixelSignature.backdropColors[0].hex}, ${pixelSignature.lightingKey})`
            : '';
          return {
            visualDna: sanitizeDnaText(`${cleanVision}${lightingTail}`, MAX_DNA_CHARS),
            pixelSignature,
            source: 'vision',
          };
        }
      }
    } catch {
      // Fail-open to deterministic pixel + prompt DNA.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const offlineDna = formatOfflinePixelSummary(pixelSignature, priorPrompt);
  return {
    visualDna: offlineDna,
    pixelSignature,
    source: pixelSignature ? 'pixel+prompt' : 'prompt',
  };
}

// ── 4. Cumulative Multi-Turn Visual State & Chromatic Compiler ────────────

const NATURAL_SUBJECT_COLOR_WORDS_RE = /\b(?:warm\s+chestnut\s+brown|terracotta\s+amber\s+brown|golden[\s-]?brown|dark\s+brown|light\s+brown|chestnut\s+brown|blue[\s-]?merle|merle|tricolor|bicolor|calico|tortoiseshell|ginger|orange[\s-]?and[\s-]?white|orange|brown|tan|tawny|beige|fawn|gray|grey|black|white|marron|cafe|naranja|anaranjad[oa]|gris|blanco|negro|pardo)\b/gi;

/**
 * When a new `scope === 'subject'` color override is active (e.g. `sky_blue`),
 * scrub conflicting natural coat/surface hue words and stale subject `#HEX`
 * tokens from the inherited `visualDna` while preserving all morphology,
 * pattern markings (tabby stripes, spots, texture), eye color, pose, and
 * background setting.
 */
function scrubConflictingSubjectColorsFromDna(visualDna, subjectColorOverride) {
  const activeSubjectOverride = Array.isArray(subjectColorOverride)
    ? subjectColorOverride.find((o) => o && o.kind === 'color' && o.scope === 'subject')
    : subjectColorOverride;
  if (!visualDna || !activeSubjectOverride) return visualDna || '';
  let scrubbed = String(visualDna);
  // Drop automated "dominant subject palette ..." clause from pixel signature
  // because the subject's palette is explicitly overridden by `subjectColorOverride`.
  scrubbed = scrubbed.replace(/,?\s*dominant subject palette [^,;.)]+/gi, '');
  // Split before backdrop clause so we never erase eye or backdrop colors.
  const backdropIdx = scrubbed.search(/\b(?:backdrop|background|set against|in a|against a)\b/i);
  if (backdropIdx > 0) {
    const head = scrubbed.slice(0, backdropIdx).replace(NATURAL_SUBJECT_COLOR_WORDS_RE, '').replace(/\s+/g, ' ').trim();
    const tail = scrubbed.slice(backdropIdx);
    scrubbed = `${head} ${tail}`.replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
  } else {
    scrubbed = scrubbed.replace(NATURAL_SUBJECT_COLOR_WORDS_RE, '').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
  }
  return sanitizeDnaText(scrubbed, MAX_DNA_CHARS);
}

/**
 * Merge an ordered list of per-turn override arrays (`oldest → newest`),
 * applying state replacement on matching `(kind: 'color', scope, targetNoun)`
 * while carrying forward earlier un-replaced overrides across turns!
 */
function mergeOverrideChain(overrideLists) {
  const bySlot = new Map();
  for (const list of overrideLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.id || !item.en) continue;
      const slotKey = item.kind === 'color'
        ? `color:${item.scope || 'subject'}:${item.scope === 'accessory' ? (item.targetNoun || 'acc') : ''}`
        : `${item.kind || 'trait'}:${item.id}`;
      bySlot.set(slotKey, {
        kind: item.kind || 'color',
        id: String(item.id),
        en: String(item.en),
        ...(item.hex ? { hex: String(item.hex) } : {}),
        ...(item.family ? { family: String(item.family) } : {}),
        scope: item.scope || 'subject',
        targetNoun: item.targetNoun || 'subject',
        nonNatural: Boolean(item.nonNatural),
      });
    }
  }
  return [...bySlot.values()];
}

/**
 * Neutralize archetype phrases like `"honest uncontrived color rendition"` or
 * `"calibrated neutral-true"` when an explicit non-natural subject color (such
 * as a sky-blue `#7DD3FC` cat) is active so T5/CLIP never fights the color!
 */
function neutralizeConflictingColorRealism(directionClause, activeOverrides = []) {
  if (typeof directionClause !== 'string' || !directionClause) return '';
  const subjectColor = Array.isArray(activeOverrides)
    ? activeOverrides.find((o) => o && o.kind === 'color' && o.scope === 'subject' && o.nonNatural)
    : null;
  if (!subjectColor) return directionClause;

  const replacement = `faithful rendering of the requested ${subjectColor.en}${subjectColor.hex ? ` (${subjectColor.hex})` : ''} subject color under physically plausible lighting and natural shadow falloff`;
  return directionClause
    .replace(/\bhonest\s+uncontrived\s+color\s+rendition\b/gi, replacement)
    .replace(/\bcalibrated\s+neutral-true\s+color\s+accuracy\b/gi, replacement)
    .replace(/\bnatural\s+skin\s+tone\s+fidelity\s+without\s+plastic\s+over-smoothing\b/gi, `${replacement} without plastic over-smoothing`)
    .replace(/\btrue-to-life\s+color(?:\s+accuracy|\s+rendition)?\b/gi, replacement);
}

const FRAMED_DELIVERABLE_ADAPT_RE = /\b(portadas?(?:\s+de\s+[a-z0-9]+)?|banners?(?:\s+de\s+[a-z0-9]+)?|covers?(?:\s+for\s+[a-z0-9]+)?|cabeceras?|posters?|cartel(?:es)?|miniaturas?|thumbnails?|wallpapers?|fondos?\s+de\s+pantalla|histori(?:a|as)(?:\s+de\s+[a-z0-9]+)?|reels?|fotos?\s+de\s+perfil|avatar(?:es)?)\b/i;

/**
 * Compile the complete Cumulative Visual State across Turn 1 → Turn 2 → Turn N:
 *   - Recovers the founding subject & `visualDna` from `historyAnchorSource`
 *     and chronological `historyEntries` (`oldest → newest`),
 *   - Accumulates active chromatic & prop overrides across turns (so Turn 3
 *     `"quiero el gato como portada de Facebook"` remembers BOTH Turn 1's cat
 *     identity AND Turn 2's `"color celeste"` `#7DD3FC` override!),
 *   - Produces high-attention front/identity clauses for text-to-image models
 *     AND targeted chromatic/continuity reinforcement for pixel-edit models.
 */
function compileCumulativeVisualState({
  currentPrompt = '',
  historyAnchorSource = null,
  historyEntries = [],
  extractedDna = null,
  aspectRatio = '1:1',
} = {}) {
  const currentOverrides = extractChromaticAndTraitOverrides(currentPrompt);

  // `historyEntries` arrives newest-first from DB (`timestamp: 'desc'`); reverse
  // to replay turns chronologically from Turn 1 → latest prior turn.
  const chronologicalPriors = Array.isArray(historyEntries)
    ? [...historyEntries].reverse()
    : [];

  const chainOverrideLists = [];
  for (const entry of chronologicalPriors) {
    if (Array.isArray(entry?.activeOverrides) && entry.activeOverrides.length > 0) {
      chainOverrideLists.push(entry.activeOverrides);
    } else if (entry?.prompt) {
      chainOverrideLists.push(extractChromaticAndTraitOverrides(entry.prompt));
    }
  }
  if (Array.isArray(historyAnchorSource?.metadata?.activeOverrides) && historyAnchorSource.metadata.activeOverrides.length > 0) {
    chainOverrideLists.push(historyAnchorSource.metadata.activeOverrides);
  } else if (historyAnchorSource?.metadata?.prompt) {
    chainOverrideLists.push(extractChromaticAndTraitOverrides(historyAnchorSource.metadata.prompt));
  }
  chainOverrideLists.push(currentOverrides);

  const activeOverrides = mergeOverrideChain(chainOverrideLists);
  const subjectColor = activeOverrides.find((o) => o.kind === 'color' && o.scope === 'subject') || null;
  const eyesColor = activeOverrides.find((o) => o.kind === 'color' && o.scope === 'eyes') || null;
  const bgColor = activeOverrides.find((o) => o.kind === 'color' && o.scope === 'background') || null;
  const accessoryOverrides = activeOverrides.filter((o) => o.scope === 'accessory');
  const envOverrides = activeOverrides.filter((o) => o.kind === 'environment');

  // Recover founding origin prompt/subject (Turn 1) + best Visual DNA.
  const originPromptRaw = chronologicalPriors[0]?.prompt
    || historyAnchorSource?.metadata?.prompt
    || '';
  const originSubject = sanitizeDnaText(stripLeadingCreateWrapper(originPromptRaw), 120);

  const rawVisualDna = extractedDna?.visualDna
    || historyAnchorSource?.metadata?.visualDna
    || chronologicalPriors.find((e) => e?.visualDna)?.visualDna
    || originSubject
    || '';
  const effectiveVisualDna = scrubConflictingSubjectColorsFromDna(rawVisualDna, subjectColor);

  const hasHistoryContext = Boolean(
    historyAnchorSource
    || chronologicalPriors.length > 0
    || effectiveVisualDna
  );

  // Build 100% positive chromatic specification fragments (NEVER emit negative
  // color words like "brown/orange/tan/gray", which activate unwanted channels
  // in rectified-flow CLIP/T5 encoders!).
  const mandatoryAttributeFragments = [];
  if (subjectColor) {
    const hexPart = subjectColor.hex ? ` (${subjectColor.hex})` : '';
    const positiveSaturation = subjectColor.nonNatural
      ? ' uniformly saturated across the entire fur, coat, plumage, skin, or body surface'
      : '';
    mandatoryAttributeFragments.push(
      `primary subject color strictly ${subjectColor.en}${hexPart}${positiveSaturation}`
    );
  }
  if (eyesColor) {
    mandatoryAttributeFragments.push(
      `eyes colored ${eyesColor.en}${eyesColor.hex ? ` (${eyesColor.hex})` : ''}`
    );
  }
  for (const acc of accessoryOverrides) {
    if (acc.kind === 'color') {
      mandatoryAttributeFragments.push(
        `${acc.targetNoun} colored ${acc.en}${acc.hex ? ` (${acc.hex})` : ''}`
      );
    } else {
      mandatoryAttributeFragments.push(acc.en);
    }
  }
  if (bgColor) {
    mandatoryAttributeFragments.push(
      `background in ${bgColor.en}${bgColor.hex ? ` (${bgColor.hex})` : ''}`
    );
  }
  for (const envDelta of envOverrides) {
    mandatoryAttributeFragments.push(envDelta.en);
  }

  // Deliverable framing adaptation cue (e.g. "como portada de Facebook" -> 16:9 cover banner).
  const deliverableMatch = normalizePlain(currentPrompt).match(FRAMED_DELIVERABLE_ADAPT_RE);
  const deliverableClause = deliverableMatch
    ? `Compose as a clean ${aspectRatio} (${deliverableMatch[1]}) layout with balanced breathing room around the subject and zero unintended text or UI chrome.`
    : '';

  let frontLockPrefix = '';
  let identityLockClause = '';
  if (hasHistoryContext) {
    const baseSubjectLabel = originSubject || 'the reference subject';
    const attrSummary = mandatoryAttributeFragments.length > 0
      ? `; mandatory active attributes: ${mandatoryAttributeFragments.join('; ')}`
      : '';
    frontLockPrefix = collapseSpaces(
      `Reference continuity lock: Depict the exact same subject (${baseSubjectLabel}) from the previous image without changing identity, species/breed, facial structure, or signature markings${attrSummary}. ${deliverableClause}`
    );
    if (effectiveVisualDna) {
      identityLockClause = `Subject visual DNA (keep consistent, do not vary into a different subject): ${effectiveVisualDna}.`;
    }
  }

  let editEnhancementClause = '';
  if (mandatoryAttributeFragments.length > 0 || deliverableClause) {
    const parts = [];
    if (mandatoryAttributeFragments.length > 0) {
      parts.push(`Mandatory visual state: ${mandatoryAttributeFragments.join('; ')}.`);
    }
    if (deliverableClause) {
      parts.push(
        `${deliverableClause} Keep the exact same subject identity, facial features, markings, and active colors from the input image — never substitute a different animal, person, or object.`
      );
    }
    editEnhancementClause = collapseSpaces(parts.join(' '));
  }

  return {
    hasHistoryContext,
    originSubject: originSubject || null,
    visualDna: effectiveVisualDna || null,
    rawVisualDna: rawVisualDna || null,
    activeOverrides,
    currentOverrides,
    hasNonNaturalSubjectColor: Boolean(subjectColor?.nonNatural),
    frontLockPrefix,
    identityLockClause,
    editEnhancementClause,
  };
}

module.exports = {
  extractPixelColorSignature,
  extractChromaticAndTraitOverrides,
  extractMultimodalVisualDna,
  compileCumulativeVisualState,
  scrubConflictingSubjectColorsFromDna,
  mergeOverrideChain,
  neutralizeConflictingColorRealism,
  describeRgbColor,
};
