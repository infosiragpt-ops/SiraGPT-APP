'use strict';

/**
 * image-prompt-fidelity — Strict Bilingual Prompt Obedience, Compositional
 * ES→EN Scene Compiler & Positive Attribute-Binding Engine for SiraGPT.
 *
 * Solves cross-encoder prompt disobedience across ALL image models (FLUX 1.1 Pro,
 * Flux Schnell, Imagen 4, GPT Image, Gemini Flash Image, Grok 2 Image, DALL-E 3,
 * Recraft, Ideogram) without ever switching the user's selected model (AGENTS.md §13).
 *
 * Root causes eliminated:
 *   1. Post-nominal Spanish modifier loss & web-caption false cognates on
 *      English-trained CLIP-L (77 tokens) & T5-XXL encoders (e.g. Spanish
 *      `"un perro celeste"` drifting into a black/gray/white "blue-merle" dog
 *      with pale eyes instead of a vivid sky-blue `#7DD3FC` fur coat).
 *   2. Multi-entity color bleed (`"un perro rosado con gafas negras en la playa"`
 *      keeps pink strictly on the dog's coat and black strictly on the sunglasses).
 *   3. Negative-token cross-attention poisoning: NEVER emits negative color lists
 *      (`"not brown, orange, tan, or gray"`), which activate unwanted color
 *      channels in rectified-flow encoders; uses 100% positive surface locks.
 *   4. Spanish `"sin X"` / English `"without X"` negations converted into
 *      positive visual scene states (`"sin personas"` -> `"in an uninhabited
 *      empty setting"`).
 *   5. Verbatim preservation of quoted on-image text (`"CAFÉ AURORA"` is
 *      shielded before translation so lettering is never translated).
 *   6. Two-Tier Hybrid Coverage:
 *      - Tier 1 (`<1ms`, zero network): Deterministic compositional Spanish→English
 *        visual scene compiler covering 350+ subjects, colors, materials, counts,
 *        actions, poses, clothing, spatial relations, settings, and lighting.
 *      - Tier 2 (`<=1200ms` bounded fail-open): Optional fast literal visual
 *        translator via `services/ai/vision-runtime` ONLY when open-vocabulary
 *        Spanish content tokens remain untranslated (`coverage < 0.85`).
 */

const OpenAI = require('openai');
const { visionClientConfig, visionRuntimeCandidates } = require('../ai/vision-runtime');

const DEFAULT_TRANSLATION_TIMEOUT_MS = 1200;
const MAX_SCENE_SPEC_CHARS = 420;
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test'
  || Boolean(process.env.NODE_TEST_CONTEXT)
  || process.execArgv.includes('--test');

// ── Normalization & Safety Helpers ────────────────────────────────────────

function collapseSpaces(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function stripDiacritics(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeTokenKey(word) {
  return stripDiacritics(String(word || '').toLowerCase()).trim();
}

const SECRET_OR_VENDOR_RE = /\b(?:sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}|AKIA[0-9A-Z]{16}|openrouter|deepseek|fal-ai\/[a-z0-9._/-]+)\b/gi;
const ARTIST_IMITATION_CLEAN_RE = /,?\s*\b(?:in\s+the\s+style\s+of|al\s+estilo\s+de|styled\s+after|painted\s+by|art\s+by)\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]+){0,2}/g;
const PROMPT_INJECTION_CLEAN_RE = /\b(?:ignore\s+(?:all\s+|previous\s+|prior\s+)*instructions?|disregard\s+(?:all\s+|previous\s+)*instructions?|system\s*prompt\s*:|developer\s*prompt\s*:|<\|im_start\|>|\[INST\])/i;

function sanitizeCompiledScene(raw, maxChars = MAX_SCENE_SPEC_CHARS) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(ARTIST_IMITATION_CLEAN_RE, '')
    .replace(SECRET_OR_VENDOR_RE, '')
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((s) => s.trim())
    .filter((s) => s && !PROMPT_INJECTION_CLEAN_RE.test(s))
    .join(' ');
  const compact = collapseSpaces(cleaned).replace(/^["'«“]+|["'»”]+$/g, '').trim();
  if (!compact) return '';
  const bounded = compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1).trim()}…`;
  return /[.!?]$/.test(bounded) ? bounded : `${bounded}.`;
}

// Strip conversational Spanish/English creation prefixes while preserving
// determiners, counts, and the full visual subject (`"crea una imagen de un perro celeste"` -> `"un perro celeste"`).
const LEADING_CREATION_WRAPPER_RE = /^(?:(?:por\s+favor|oye|hola)\s*,?\s*)*(?:(?:quiero\s+que\s+(?:me\s+)?(?:crees|generes|hagas|dibujes|disenes)|puedes\s+(?:crearme|generarme|hacerme|dibujarme|crear|generar|hacer|dibujar)|necesito\s+que\s+(?:crees|generes|hagas)|crea(?:me)?|genera(?:me)?|haz(?:me)?|dibuja(?:me)?|disena(?:me)?|pinta(?:me)?|ilustra(?:me)?|renderiza(?:me)?|muestrame|dame|quiero(?:\s+ver)?|create|generate|make|draw|render|design|show\s+me)\s+)?(?:(?:una?\s+|otra?\s+|la\s+|el\s+)?(?:imagen|foto|fotografia|ilustracion|dibujo|pintura|render|retrato|escena|image|photo|photograph|picture|illustration|drawing|rendering)\s+(?:de\s+|con\s+|sobre\s+|mostrando\s+|of\s+|showing\s+|featuring\s+)?)/i;
const BARE_LEADING_VERB_RE = /^(?:(?:por\s+favor)\s*,?\s*)*(?:crea(?:me)?|genera(?:me)?|haz(?:me)?|dibuja(?:me)?|disena(?:me)?|pinta(?:me)?|ilustra(?:me)?|muestrame|dame|quiero\s+ver)\s+(?=(?:un|una|unos|unas|el|la|los|las|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\b)/i;

function stripCreationWrapper(text) {
  let out = collapseSpaces(text);
  const stripped1 = out.replace(LEADING_CREATION_WRAPPER_RE, '').trim();
  if (stripped1 && stripped1.length < out.length) {
    out = stripped1;
  } else {
    out = out.replace(BARE_LEADING_VERB_RE, '').trim();
  }
  return out;
}

// ── Verbatim Quote Shielding (On-Image Text Protection) ───────────────────

const QUOTED_LITERAL_PATTERNS = [
  /«([^«»\n]{1,80})»/g,
  /“([^“”\n]{1,80})”/g,
  /"([^"\n]{1,80})"/g,
];

function shieldQuotedLiterals(text) {
  const quotes = [];
  let shielded = String(text || '');
  for (const re of QUOTED_LITERAL_PATTERNS) {
    shielded = shielded.replace(re, (_match, inner) => {
      const cleanInner = collapseSpaces(inner);
      if (!cleanInner) return _match;
      const idx = quotes.length;
      quotes.push(cleanInner);
      return `__Q${idx}__`;
    });
  }
  return { shielded, quotes };
}

function restoreQuotedLiterals(text, quotes) {
  if (!quotes || quotes.length === 0) return text;
  return String(text || '').replace(/__Q(\d+)__/gi, (_m, idxStr) => {
    const idx = Number.parseInt(idxStr, 10);
    return Number.isFinite(idx) && quotes[idx] !== undefined ? `"${quotes[idx]}"` : _m;
  });
}

// ── Positive-State Negation Rewriter (`sin X` / `without X`) ──────────────

const POSITIVE_NEGATION_RULES = [
  {
    re: /\b(?:sin\s+(?:ningun[oa]?\s+)?(?:personas?|gente|humanos?|peatones|multitud)|without\s+(?:any\s+)?people|no\s+people)\b/gi,
    en: 'in an uninhabited empty setting',
  },
  {
    re: /\b(?:sin\s+(?:ningun\s+)?(?:texto|letras?|palabras?|letreros?|marcas?\s+de\s+agua)|without\s+(?:any\s+)?(?:text|letters|words|watermarks?))\b/gi,
    en: 'with clean unlabelled text-free surfaces',
  },
  {
    re: /\b(?:sin\s+nubes|cielo\s+despejado|cloudless\s+sky|without\s+clouds)\b/gi,
    en: 'under a clear cloudless sky',
  },
  {
    re: /\b(?:sin\s+fondo|aislad[oa]\s+sin\s+fondo)\b/gi,
    en: 'isolated cleanly on a plain neutral backdrop',
  },
  {
    re: /\b(?:sin\s+(?:gafas|lentes)|without\s+(?:sun)?glasses)\b/gi,
    en: 'with bare unobstructed eyes',
  },
  {
    re: /\b(?:sin\s+(?:sombrero|gorra|casco)|without\s+a?\s*(?:hat|cap|helmet))\b/gi,
    en: 'bareheaded',
  },
  {
    re: /\b(?:sin\s+arboles|without\s+trees)\b/gi,
    en: 'across open treeless terrain',
  },
  {
    re: /\b(?:sin\s+marco|sin\s+bordes?|frameless|borderless)\b/gi,
    en: 'with a full-bleed borderless edge',
  },
];

function rewriteNegationsPositively(text) {
  let out = String(text || '');
  let rewrote = false;
  for (const rule of POSITIVE_NEGATION_RULES) {
    if (rule.re.test(out)) {
      rewrote = true;
      out = out.replace(rule.re, ` ${rule.en} `);
    }
    rule.re.lastIndex = 0;
  }
  return { text: collapseSpaces(out), rewrote };
}

// ── Lexicons: Counts, Colors, Materials, Subjects, Adjectives & Connectors ─

const EXACT_COUNT_MAP = new Map([
  ['un', { det: 'a', plural: false, exactCount: 1 }],
  ['una', { det: 'a', plural: false, exactCount: 1 }],
  ['uno', { det: 'one', plural: false, exactCount: 1 }],
  ['el', { det: 'the', plural: false, exactCount: null }],
  ['la', { det: 'the', plural: false, exactCount: null }],
  ['los', { det: 'the', plural: true, exactCount: null }],
  ['las', { det: 'the', plural: true, exactCount: null }],
  ['unos', { det: 'several', plural: true, exactCount: null }],
  ['unas', { det: 'several', plural: true, exactCount: null }],
  ['mi', { det: 'my', plural: false, exactCount: null }],
  ['mis', { det: 'my', plural: true, exactCount: null }],
  ['su', { det: 'its', plural: false, exactCount: null }],
  ['sus', { det: 'their', plural: true, exactCount: null }],
  ['este', { det: 'this', plural: false, exactCount: null }],
  ['esta', { det: 'this', plural: false, exactCount: null }],
  ['estos', { det: 'these', plural: true, exactCount: null }],
  ['estas', { det: 'these', plural: true, exactCount: null }],
  ['ese', { det: 'that', plural: false, exactCount: null }],
  ['esa', { det: 'that', plural: false, exactCount: null }],
  ['otro', { det: 'another', plural: false, exactCount: 1 }],
  ['otra', { det: 'another', plural: false, exactCount: 1 }],
  ['dos', { det: 'exactly two (2) distinct', plural: true, exactCount: 2 }],
  ['2', { det: 'exactly two (2) distinct', plural: true, exactCount: 2 }],
  ['tres', { det: 'exactly three (3) distinct', plural: true, exactCount: 3 }],
  ['3', { det: 'exactly three (3) distinct', plural: true, exactCount: 3 }],
  ['cuatro', { det: 'exactly four (4) distinct', plural: true, exactCount: 4 }],
  ['4', { det: 'exactly four (4) distinct', plural: true, exactCount: 4 }],
  ['cinco', { det: 'exactly five (5) distinct', plural: true, exactCount: 5 }],
  ['5', { det: 'exactly five (5) distinct', plural: true, exactCount: 5 }],
  ['seis', { det: 'exactly six (6) distinct', plural: true, exactCount: 6 }],
  ['6', { det: 'exactly six (6) distinct', plural: true, exactCount: 6 }],
  ['siete', { det: 'exactly seven (7) distinct', plural: true, exactCount: 7 }],
  ['7', { det: 'exactly seven (7) distinct', plural: true, exactCount: 7 }],
  ['ocho', { det: 'exactly eight (8) distinct', plural: true, exactCount: 8 }],
  ['8', { det: 'exactly eight (8) distinct', plural: true, exactCount: 8 }],
  ['nueve', { det: 'exactly nine (9) distinct', plural: true, exactCount: 9 }],
  ['9', { det: 'exactly nine (9) distinct', plural: true, exactCount: 9 }],
  ['diez', { det: 'exactly ten (10) distinct', plural: true, exactCount: 10 }],
  ['10', { det: 'exactly ten (10) distinct', plural: true, exactCount: 10 }],
]);

// Multi-word & single-word color modifiers (ordered longest-first).
const COLOR_SPECS = [
  {
    id: 'sky_blue',
    phrases: ['de color azul celeste', 'de color celeste', 'en color celeste', 'color celeste', 'tono celeste', 'azul celeste', 'azules celestes', 'celeste claro', 'celeste brillante', 'celeste intenso', 'celeste pastel', 'azul cielo', 'celestes', 'celeste', 'sky-blue', 'sky blue', 'light cerulean', 'baby blue'],
    pre: 'vivid sky-blue',
    coatTone: 'bright light-cerulean sky-blue',
    hueLabel: 'sky-blue',
    hex: '#7DD3FC',
    nonNatural: true,
  },
  {
    id: 'electric_blue',
    phrases: ['de color azul electrico', 'azul electrico', 'azul cobalto', 'azul rey', 'electric blue', 'cobalt blue', 'royal blue'],
    pre: 'vivid electric cobalt-blue',
    coatTone: 'vibrant electric cobalt-blue',
    hueLabel: 'cobalt-blue',
    hex: '#2563EB',
    nonNatural: true,
  },
  {
    id: 'navy_blue',
    phrases: ['de color azul marino', 'azul marino', 'azul oscuro', 'azul medianoche', 'navy blue', 'midnight blue', 'dark blue'],
    pre: 'deep navy-blue',
    coatTone: 'deep midnight navy-blue',
    hueLabel: 'navy-blue',
    hex: '#1E3A8A',
    nonNatural: true,
  },
  {
    id: 'turquoise',
    phrases: ['de color turquesa', 'azul turquesa', 'verde agua', 'aguamarina', 'turquesas', 'turquesa', 'cian', 'cyan', 'turquoise', 'aquamarine', 'teal'],
    pre: 'bright turquoise-cyan',
    coatTone: 'vibrant turquoise-cyan',
    hueLabel: 'turquoise-cyan',
    hex: '#2DD4BF',
    nonNatural: true,
  },
  {
    id: 'emerald_green',
    phrases: ['de color verde esmeralda', 'verde esmeralda', 'verdes esmeraldas', 'verde intenso', 'verde brillante', 'emerald green'],
    pre: 'vivid emerald-green',
    coatTone: 'rich emerald-green',
    hueLabel: 'emerald-green',
    hex: '#10B981',
    nonNatural: true,
  },
  {
    id: 'mint_green',
    phrases: ['verde menta', 'verde pastel', 'verde claro', 'mint green', 'pastel green'],
    pre: 'pastel mint-green',
    coatTone: 'soft pastel mint-green',
    hueLabel: 'mint-green',
    hex: '#6EE7B7',
    nonNatural: true,
  },
  {
    id: 'pastel_pink',
    phrases: ['de color rosa pastel', 'rosa pastel', 'rosado claro', 'rosada clara', 'rosa claro', 'rosa bebe', 'pastel pink', 'blush pink'],
    pre: 'soft pastel rose-pink',
    coatTone: 'soft pastel rose-pink',
    hueLabel: 'pastel rose-pink',
    hex: '#F9A8D4',
    nonNatural: true,
  },
  {
    id: 'magenta',
    phrases: ['de color fucsia', 'rosa neon', 'fucsias', 'fucsia', 'magentas', 'magenta', 'hot pink', 'fuchsia'],
    pre: 'vivid fuchsia-magenta',
    coatTone: 'vibrant fuchsia-magenta',
    hueLabel: 'fuchsia-magenta',
    hex: '#D946EF',
    nonNatural: true,
  },
  {
    id: 'pink',
    phrases: ['de color rosado', 'de color rosa', 'en color rosa', 'color rosado', 'color rosa', 'rosados', 'rosadas', 'rosado', 'rosada', 'rosas', 'rosa', 'rose pink', 'pink'],
    pre: 'vivid rose-pink',
    coatTone: 'bright rose-pink',
    hueLabel: 'rose-pink',
    hex: '#EC4899',
    nonNatural: true,
    ambiguousNounForms: new Set(['rosa', 'rosas']),
  },
  {
    id: 'purple',
    phrases: ['de color morado', 'de color violeta', 'color morado', 'morados', 'moradas', 'morado', 'morada', 'violetas', 'violeta', 'purpuras', 'purpura', 'lilas', 'lila', 'lavanda', 'purple', 'violet', 'lilac', 'lavender'],
    pre: 'rich violet-purple',
    coatTone: 'vibrant violet-purple',
    hueLabel: 'violet-purple',
    hex: '#8B5CF6',
    nonNatural: true,
  },
  {
    id: 'crimson_red',
    phrases: ['de color rojo carmesi', 'rojo carmesi', 'rojo escarlata', 'rojo intenso', 'carmesi', 'escarlata', 'vino tinto', 'burdeos', 'crimson red', 'crimson', 'scarlet', 'burgundy'],
    pre: 'deep crimson-red',
    coatTone: 'deep crimson-scarlet red',
    hueLabel: 'crimson-red',
    hex: '#DC2626',
    nonNatural: true,
  },
  {
    id: 'red',
    phrases: ['de color rojo', 'en color rojo', 'color rojo', 'rojos', 'rojas', 'rojo', 'roja', 'red'],
    pre: 'vivid red',
    coatTone: 'bright vivid red',
    hueLabel: 'vivid red',
    hex: '#EF4444',
    nonNatural: true,
  },
  {
    id: 'gold',
    phrases: ['de color dorado', 'amarillo dorado', 'color oro', 'dorados', 'doradas', 'dorado', 'dorada', 'metallic gold', 'golden'],
    pre: 'lustrous golden',
    coatTone: 'shimmering golden',
    hueLabel: 'golden',
    hex: '#F59E0B',
    nonNatural: true,
  },
  {
    id: 'silver',
    phrases: ['de color plateado', 'gris plata', 'color plata', 'plateados', 'plateadas', 'plateado', 'plateada', 'cromado', 'cromada', 'metallic silver', 'silver'],
    pre: 'sleek metallic-silver',
    coatTone: 'gleaming silver',
    hueLabel: 'metallic-silver',
    hex: '#CBD5E1',
    nonNatural: true,
  },
  {
    id: 'yellow',
    phrases: ['de color amarillo', 'en color amarillo', 'color amarillo', 'amarillos', 'amarillas', 'amarillo', 'amarilla', 'yellow'],
    pre: 'bright canary-yellow',
    coatTone: 'bright sunny canary-yellow',
    hueLabel: 'canary-yellow',
    hex: '#FACC15',
    nonNatural: true,
  },
  {
    id: 'orange',
    phrases: ['de color naranja', 'de color anaranjado', 'color naranja', 'anaranjados', 'anaranjadas', 'anaranjado', 'anaranjada', 'naranjas', 'naranja', 'orange'],
    pre: 'vibrant tangerine-orange',
    coatTone: 'bright tangerine-orange',
    hueLabel: 'tangerine-orange',
    hex: '#F97316',
    nonNatural: false,
    ambiguousNounForms: new Set(['naranja', 'naranjas', 'orange']),
  },
  {
    id: 'green',
    phrases: ['de color verde', 'en color verde', 'color verde', 'verdes', 'verde', 'green'],
    pre: 'vibrant green',
    coatTone: 'bright lush green',
    hueLabel: 'green',
    hex: '#22C55E',
    nonNatural: true,
  },
  {
    id: 'blue',
    phrases: ['de color azul', 'en color azul', 'color azul', 'azules', 'azul', 'blue'],
    pre: 'vivid cobalt-blue',
    coatTone: 'rich vibrant cobalt-blue',
    hueLabel: 'cobalt-blue',
    hex: '#3B82F6',
    nonNatural: true,
  },
  {
    id: 'white',
    phrases: ['de color blanco', 'blanco nieve', 'blanca nieve', 'color blanco', 'blancos', 'blancas', 'blanco', 'blanca', 'albino', 'albina', 'snow white', 'pure white', 'white'],
    pre: 'pure snow-white',
    coatTone: 'pure snow-white',
    hueLabel: 'snow-white',
    hex: '#F8FAFC',
    nonNatural: false,
  },
  {
    id: 'black',
    phrases: ['de color negro', 'negro azabache', 'negro mate', 'color negro', 'negros', 'negras', 'negro', 'negra', 'jet black', 'matte black', 'black'],
    pre: 'jet-black',
    coatTone: 'deep jet-black',
    hueLabel: 'jet-black',
    hex: '#0F172A',
    nonNatural: false,
  },
  {
    id: 'brown',
    phrases: ['de color marron', 'de color cafe', 'color marron', 'color cafe', 'marrones', 'marron', 'castano', 'castana', 'pardo', 'chestnut brown', 'brown'],
    pre: 'warm chestnut-brown',
    coatTone: 'rich chestnut-brown',
    hueLabel: 'chestnut-brown',
    hex: '#78350F',
    nonNatural: false,
  },
  {
    id: 'gray',
    phrases: ['de color gris', 'color gris', 'grises', 'gris', 'plomo', 'slate gray', 'gray', 'grey'],
    pre: 'sleek slate-gray',
    coatTone: 'sleek slate-gray',
    hueLabel: 'slate-gray',
    hex: '#64748B',
    nonNatural: false,
  },
  {
    id: 'rainbow',
    phrases: ['multicolor', 'multicolores', 'color arcoiris', 'de muchos colores', 'rainbow-colored'],
    pre: 'vibrant rainbow-multicolored',
    coatTone: 'vivid rainbow-multicolored',
    hueLabel: 'rainbow-multicolored',
    hex: null,
    nonNatural: true,
  },
];

// Material / substance phrases (`de cristal`, `de hielo`, `de oro`, etc.)
const MATERIAL_SPECS = [
  { phrases: ['hecho de cristal', 'hecha de cristal', 'en cristal', 'de cristal'], adj: 'translucent crystal glass', surface: 'refractive translucent crystal glass' },
  { phrases: ['de vidrio soplado', 'hecho de vidrio', 'de vidrio'], adj: 'translucent glass', surface: 'clear blown glass' },
  { phrases: ['hecho de hielo', 'esculpido en hielo', 'de hielo'], adj: 'sculpted glacial-ice', surface: 'translucent sculpted ice' },
  { phrases: ['hecho de fuego', 'en llamas', 'de fuego'], adj: 'blazing fire', surface: 'glowing flames and incandescent embers' },
  { phrases: ['hecho de agua', 'de agua liquida', 'de agua'], adj: 'sculpted liquid-water', surface: 'clear splashing liquid water' },
  { phrases: ['banado en oro', 'hecho de oro', 'de oro macizo', 'de oro'], adj: 'polished 24k-gold', surface: 'mirror-polished metallic 24k gold' },
  { phrases: ['hecho de plata', 'de plata'], adj: 'polished sterling-silver', surface: 'gleaming metallic sterling silver' },
  { phrases: ['de bronce', 'en bronce'], adj: 'cast-bronze', surface: 'patinated cast bronze' },
  { phrases: ['de cobre'], adj: 'burnished-copper', surface: 'warm burnished metallic copper' },
  { phrases: ['de acero inoxidable', 'de acero', 'de metal', 'de titanio'], adj: 'brushed-metal', surface: 'machined brushed metal' },
  { phrases: ['tallado en madera', 'hecho de madera', 'de madera de nogal', 'de madera de roble', 'de madera'], adj: 'carved wooden', surface: 'hand-carved natural wood grain' },
  { phrases: ['esculpido en marmol', 'de marmol'], adj: 'sculpted marble', surface: 'polished veined marble stone' },
  { phrases: ['tallado en piedra', 'de piedra', 'de roca'], adj: 'carved stone', surface: 'chiselled natural stone' },
  { phrases: ['de origami', 'de papel doblado', 'hecho de papel', 'de papel'], adj: 'folded origami-paper', surface: 'crisp folded origami paper facets' },
  { phrases: ['tejido a crochet', 'de crochet', 'amigurumi', 'de lana'], adj: 'knitted wool-crochet', surface: 'hand-knitted yarn stitches' },
  { phrases: ['de peluche', 'de felpa'], adj: 'plush stuffed-toy', surface: 'soft stitched plush fabric' },
  { phrases: ['de porcelana', 'de ceramica artesanal', 'de ceramica'], adj: 'glazed ceramic porcelain', surface: 'smooth glazed ceramic porcelain' },
  { phrases: ['de neon', 'hecho de neon'], adj: 'glowing neon-tube', surface: 'luminous neon glass tubing' },
  { phrases: ['de chocolate'], adj: 'sculpted chocolate', surface: 'glossy tempered chocolate' },
  { phrases: ['de ladrillo', 'de ladrillos'], adj: 'brick', surface: 'textured brickwork' },
  { phrases: ['de cuero'], adj: 'leather', surface: 'supple natural leather' },
  { phrases: ['de seda'], adj: 'silk', surface: 'flowing lustrous silk' },
];

// Subject & Object Noun Lexicon (`surfaceClass`:
// 'furred' | 'hide' | 'feathered' | 'scaled' | 'person' | 'vehicle' | 'plant' | 'object' | 'place')
const NOUN_ENTRIES = [
  // Multi-word compound nouns FIRST
  [['oso polar', 'osos polares', 'polar bear', 'polar bears'], 'polar bear', 'polar bears', 'furred'],
  [['oso panda', 'osos panda', 'panda gigante', 'giant panda'], 'giant panda', 'giant pandas', 'furred'],
  [['pastor aleman', 'pastores alemanes'], 'German shepherd dog', 'German shepherd dogs', 'furred'],
  [['perro salchicha', 'perros salchicha'], 'dachshund dog', 'dachshund dogs', 'furred'],
  [['golden retriever'], 'golden retriever dog', 'golden retriever dogs', 'furred'],
  [['border collie'], 'border collie dog', 'border collie dogs', 'furred'],
  [['gato siames', 'gatos siameses'], 'Siamese cat', 'Siamese cats', 'furred'],
  [['gato persa', 'gatos persas'], 'Persian cat', 'Persian cats', 'furred'],
  [['leon marino', 'leones marinos'], 'sea lion', 'sea lions', 'scaled'],
  [['caballito de mar', 'caballitos de mar'], 'seahorse', 'seahorses', 'scaled'],
  [['estrella de mar', 'estrellas de mar'], 'starfish', 'starfish', 'scaled'],
  [['pavo real', 'pavos reales'], 'peacock', 'peacocks', 'feathered'],
  [['ave fenix', 'fenix'], 'phoenix bird', 'phoenix birds', 'feathered'],
  [['oso de peluche', 'osito de peluche'], 'teddy bear', 'teddy bears', 'object'],
  [['gafas de sol', 'lentes de sol', 'anteojos de sol', 'sunglasses'], 'sunglasses', 'sunglasses', 'object'],
  [['traje espacial', 'trajes espaciales'], 'spacesuit', 'spacesuits', 'object'],
  [['nave espacial', 'naves espaciales'], 'spaceship', 'spaceships', 'vehicle'],
  [['estacion espacial', 'estaciones espaciales'], 'space station', 'space stations', 'place'],
  [['coche deportivo', 'auto deportivo', 'carro deportivo', 'superdeportivo', 'coches deportivos'], 'sports car', 'sports cars', 'vehicle'],
  [['globo aerostatico', 'globos aerostaticos'], 'hot-air balloon', 'hot-air balloons', 'vehicle'],
  [['taza de cafe', 'tazas de cafe'], 'coffee cup', 'coffee cups', 'object'],
  [['taza de te', 'tazas de te'], 'teacup', 'teacups', 'object'],
  [['letrero de neon', 'cartel de neon'], 'neon sign', 'neon signs', 'object'],
  [['cartel luminoso', 'letrero luminoso'], 'illuminated sign', 'illuminated signs', 'object'],
  [['ciudad costera', 'ciudades costeras'], 'coastal city', 'coastal cities', 'place'],
  [['bosque encantado', 'bosques encantados'], 'enchanted forest', 'enchanted forests', 'place'],
  [['sala de estar', 'salas de estar'], 'living room', 'living rooms', 'place'],
  [['portada de facebook'], 'Facebook cover banner', 'Facebook cover banners', 'object'],
  [['arco iris', 'arcoiris'], 'rainbow', 'rainbows', 'place'],

  // Furred animals
  [['perro', 'perra', 'perros', 'perras', 'dog', 'dogs'], 'dog', 'dogs', 'furred'],
  [['perrito', 'perrita', 'cachorro', 'cachorra', 'perritos', 'cachorros', 'puppy', 'puppies'], 'puppy', 'puppies', 'furred'],
  [['gato', 'gata', 'gatos', 'gatas', 'cat', 'cats'], 'cat', 'cats', 'furred'],
  [['gatito', 'gatita', 'gatitos', 'gatitas', 'kitten', 'kittens'], 'kitten', 'kittens', 'furred'],
  [['lobo', 'loba', 'lobos', 'wolf', 'wolves'], 'wolf', 'wolves', 'furred'],
  [['zorro', 'zorra', 'zorros', 'fox', 'foxes'], 'fox', 'foxes', 'furred'],
  [['oso', 'osa', 'osos', 'bear', 'bears'], 'bear', 'bears', 'furred'],
  [['panda', 'pandas'], 'panda', 'pandas', 'furred'],
  [['leon', 'leona', 'leones', 'leonas', 'lion', 'lions'], 'lion', 'lions', 'furred'],
  [['tigre', 'tigresa', 'tigres', 'tiger', 'tigers'], 'tiger', 'tigers', 'furred'],
  [['leopardo', 'leopardos', 'leopard', 'leopards'], 'leopard', 'leopards', 'furred'],
  [['jaguar', 'jaguares'], 'jaguar', 'jaguars', 'furred'],
  [['pantera', 'panteras', 'panther', 'panthers'], 'panther', 'panthers', 'furred'],
  [['guepardo', 'guepardos', 'cheetah'], 'cheetah', 'cheetahs', 'furred'],
  [['conejo', 'coneja', 'conejito', 'conejos', 'rabbit', 'rabbits', 'bunny'], 'rabbit', 'rabbits', 'furred'],
  [['caballo', 'yegua', 'caballos', 'potro', 'horse', 'horses'], 'horse', 'horses', 'furred'],
  [['unicornio', 'unicornios', 'unicorn', 'unicorns'], 'unicorn', 'unicorns', 'furred'],
  [['ciervo', 'venado', 'ciervos', 'venados', 'deer'], 'deer', 'deer', 'furred'],
  [['oveja', 'ovejas', 'cordero', 'sheep', 'lamb'], 'sheep', 'sheep', 'furred'],
  [['cabra', 'cabras', 'goat', 'goats'], 'goat', 'goats', 'furred'],
  [['llama', 'llamas'], 'llama', 'llamas', 'furred'],
  [['alpaca', 'alpacas'], 'alpaca', 'alpacas', 'furred'],
  [['mono', 'mona', 'monos', 'monkey', 'monkeys'], 'monkey', 'monkeys', 'furred'],
  [['gorila', 'gorilas', 'gorilla', 'gorillas'], 'gorilla', 'gorillas', 'furred'],
  [['koala', 'koalas'], 'koala', 'koalas', 'furred'],
  [['perezoso', 'perezosos', 'sloth'], 'sloth', 'sloths', 'furred'],
  [['mapache', 'mapaches', 'raccoon'], 'raccoon', 'raccoons', 'furred'],
  [['ardilla', 'ardillas', 'squirrel', 'squirrels'], 'squirrel', 'squirrels', 'furred'],
  [['hamster', 'hamsters'], 'hamster', 'hamsters', 'furred'],
  [['raton', 'ratoncito', 'ratones', 'mouse', 'mice'], 'mouse', 'mice', 'furred'],
  [['erizo', 'erizos', 'hedgehog'], 'hedgehog', 'hedgehogs', 'furred'],
  [['nutria', 'nutrias', 'otter'], 'otter', 'otters', 'furred'],

  // Hide-skinned animals (skin/hide, NOT fur!)
  [['elefante', 'elefantes', 'elephant', 'elephants'], 'elephant', 'elephants', 'hide'],
  [['jirafa', 'jirafas', 'giraffe', 'giraffes'], 'giraffe', 'giraffes', 'hide'],
  [['rinoceronte', 'rinocerontes', 'rhino', 'rhinoceros'], 'rhinoceros', 'rhinoceroses', 'hide'],
  [['hipopotamo', 'hipopotamos', 'hippo', 'hippopotamus'], 'hippopotamus', 'hippopotamuses', 'hide'],
  [['vaca', 'vacas', 'toro', 'toros', 'cow', 'cows', 'bull'], 'cow', 'cows', 'hide'],
  [['cerdo', 'cerdito', 'cerdos', 'chancho', 'puerco', 'pig', 'pigs', 'piglet'], 'pig', 'pigs', 'hide'],
  [['cebra', 'cebras', 'zebra', 'zebras'], 'zebra', 'zebras', 'hide'],
  [['camello', 'camellos', 'dromedario', 'camel', 'camels'], 'camel', 'camels', 'hide'],
  [['canguro', 'canguros', 'kangaroo'], 'kangaroo', 'kangaroos', 'hide'],

  // Feathered birds
  [['pajaro', 'pajarito', 'pajaros', 'ave', 'aves', 'bird', 'birds'], 'bird', 'birds', 'feathered'],
  [['aguila', 'aguilas', 'eagle', 'eagles'], 'eagle', 'eagles', 'feathered'],
  [['buho', 'buhos', 'lechuza', 'lechuzas', 'owl', 'owls'], 'owl', 'owls', 'feathered'],
  [['pinguino', 'pinguinos', 'penguin', 'penguins'], 'penguin', 'penguins', 'feathered'],
  [['loro', 'loros', 'papagayo', 'guacamayo', 'guacamayos', 'parrot', 'parrots', 'macaw'], 'parrot', 'parrots', 'feathered'],
  [['flamenco', 'flamencos', 'flamingo', 'flamingos'], 'flamingo', 'flamingos', 'feathered'],
  [['cisne', 'cisnes', 'swan', 'swans'], 'swan', 'swans', 'feathered'],
  [['pato', 'patito', 'patos', 'patitos', 'duck', 'ducks', 'duckling'], 'duck', 'ducks', 'feathered'],
  [['colibri', 'colibries', 'hummingbird', 'hummingbirds'], 'hummingbird', 'hummingbirds', 'feathered'],
  [['tucan', 'tucanes', 'toucan'], 'toucan', 'toucans', 'feathered'],
  [['paloma', 'palomas', 'dove', 'pigeon'], 'dove', 'doves', 'feathered'],
  [['cuervo', 'cuervos', 'raven', 'crow'], 'raven', 'ravens', 'feathered'],
  [['halcon', 'halcones', 'falcon', 'hawk'], 'falcon', 'falcons', 'feathered'],
  [['gallo', 'gallos', 'gallina', 'gallinas', 'pollo', 'pollito', 'rooster', 'chicken', 'chick'], 'rooster', 'roosters', 'feathered'],

  // Scaled, marine & insect creatures
  [['dragon', 'dragones', 'dragons'], 'dragon', 'dragons', 'scaled'],
  [['dinosaurio', 'dinosaurios', 'tiranosaurio', 'dinosaur', 'dinosaurs'], 'dinosaur', 'dinosaurs', 'scaled'],
  [['tortuga', 'tortugas', 'turtle', 'turtles', 'tortoise'], 'turtle', 'turtles', 'scaled'],
  [['rana', 'ranas', 'sapo', 'frog', 'frogs'], 'frog', 'frogs', 'scaled'],
  [['serpiente', 'serpientes', 'cobra', 'snake', 'snakes'], 'snake', 'snakes', 'scaled'],
  [['camaleon', 'camaleones', 'iguana', 'lagarto', 'chameleon', 'lizard'], 'chameleon', 'chameleons', 'scaled'],
  [['cocodrilo', 'cocodrilos', 'caiman', 'crocodile'], 'crocodile', 'crocodiles', 'scaled'],
  [['delfin', 'delfines', 'dolphin', 'dolphins'], 'dolphin', 'dolphins', 'scaled'],
  [['ballena', 'ballenas', 'orca', 'whale', 'whales'], 'whale', 'whales', 'scaled'],
  [['tiburon', 'tiburones', 'shark', 'sharks'], 'shark', 'sharks', 'scaled'],
  [['pulpo', 'pulpos', 'octopus', 'octopuses'], 'octopus', 'octopuses', 'scaled'],
  [['medusa', 'medusas', 'jellyfish'], 'jellyfish', 'jellyfish', 'scaled'],
  [['pez', 'peces', 'koi', 'fish'], 'fish', 'fish', 'scaled'],
  [['cangrejo', 'cangrejos', 'crab', 'crabs'], 'crab', 'crabs', 'scaled'],
  [['mariposa', 'mariposas', 'butterfly', 'butterflies'], 'butterfly', 'butterflies', 'scaled'],
  [['abeja', 'abejas', 'bee', 'bees'], 'bee', 'bees', 'scaled'],
  [['mariquita', 'mariquitas', 'escarabajo', 'ladybug', 'beetle'], 'beetle', 'beetles', 'scaled'],

  // People & characters
  [['astronauta', 'astronautas', 'astronaut', 'astronauts'], 'astronaut', 'astronauts', 'person'],
  [['mujer', 'mujeres', 'chica', 'joven', 'woman', 'women'], 'woman', 'women', 'person'],
  [['hombre', 'hombres', 'chico', 'man', 'men'], 'man', 'men', 'person'],
  [['nino', 'ninos', 'boy', 'boys', 'child', 'children'], 'boy', 'children', 'person'],
  [['nina', 'ninas', 'girl', 'girls'], 'girl', 'girls', 'person'],
  [['bebe', 'bebes', 'baby', 'babies'], 'baby', 'babies', 'person'],
  [['anciano', 'anciana', 'abuelo', 'abuela', 'elderly man', 'elderly woman'], 'elderly person', 'elderly people', 'person'],
  [['chef', 'cocinero', 'cocinera'], 'chef', 'chefs', 'person'],
  [['cientifico', 'cientifica', 'investigador'], 'scientist', 'scientists', 'person'],
  [['medico', 'medica', 'doctor', 'doctora'], 'doctor', 'doctors', 'person'],
  [['caballero', 'guerrero', 'guerrera', 'samurai', 'knight', 'warrior'], 'warrior', 'warriors', 'person'],
  [['mago', 'hechicero', 'bruja', 'wizard', 'witch'], 'wizard', 'wizards', 'person'],
  [['robot', 'robots', 'androide', 'androides', 'android'], 'robot', 'robots', 'object'],
  [['personaje', 'personajes', 'protagonista'], 'character', 'characters', 'person'],

  // Vehicles
  [['coche', 'auto', 'carro', 'automovil', 'coches', 'autos', 'carros', 'car', 'cars'], 'car', 'cars', 'vehicle'],
  [['camion', 'camiones', 'camioneta', 'truck', 'trucks'], 'truck', 'trucks', 'vehicle'],
  [['autobus', 'bus', 'autobuses'], 'bus', 'buses', 'vehicle'],
  [['motocicleta', 'moto', 'motos', 'motorcycle'], 'motorcycle', 'motorcycles', 'vehicle'],
  [['bicicleta', 'bici', 'bicicletas', 'bicycle', 'bike'], 'bicycle', 'bicycles', 'vehicle'],
  [['tren', 'trenes', 'locomotora', 'train', 'trains'], 'train', 'trains', 'vehicle'],
  [['avion', 'aviones', 'avioneta', 'airplane', 'plane'], 'airplane', 'airplanes', 'vehicle'],
  [['helicoptero', 'helicopteros', 'helicopter'], 'helicopter', 'helicopters', 'vehicle'],
  [['barco', 'barcos', 'velero', 'veleros', 'bote', 'yate', 'boat', 'ship', 'sailboat'], 'sailboat', 'sailboats', 'vehicle'],
  [['submarino', 'submarinos', 'submarine'], 'submarine', 'submarines', 'vehicle'],
  [['cohete', 'cohetes', 'rocket', 'rockets'], 'rocket', 'rockets', 'vehicle'],

  // Plants, Food & Objects
  [['rosa', 'rosas', 'rose', 'roses'], 'rose flower', 'rose flowers', 'plant'],
  [['flor', 'flores', 'tulipan', 'girasol', 'orquidea', 'flower', 'flowers'], 'flower', 'flowers', 'plant'],
  [['arbol', 'arboles', 'cerezo', 'pino', 'roble', 'tree', 'trees'], 'tree', 'trees', 'plant'],
  [['hoja', 'hojas', 'leaf', 'leaves'], 'leaf', 'leaves', 'plant'],
  [['manzana', 'manzanas', 'apple', 'apples'], 'apple', 'apples', 'object'],
  [['naranja', 'naranjas'], 'orange fruit', 'orange fruits', 'object'],
  [['fresa', 'fresas', 'strawberry', 'strawberries'], 'strawberry', 'strawberries', 'object'],
  [['platano', 'banana', 'bananas'], 'banana', 'bananas', 'object'],
  [['cafe', 'espresso', 'capuchino', 'coffee'], 'coffee', 'coffees', 'object'],
  [['te', 'tea'], 'tea', 'teas', 'object'],
  [['pastel', 'torta', 'tarta', 'pasteles', 'cake'], 'cake', 'cakes', 'object'],
  [['helado', 'helados', 'ice cream'], 'ice cream', 'ice creams', 'object'],
  [['pizza', 'pizzas'], 'pizza', 'pizzas', 'object'],
  [['hamburguesa', 'hamburguesas', 'burger'], 'burger', 'burgers', 'object'],
  [['pan', 'croissant'], 'artisan bread', 'artisan breads', 'object'],
  [['copa', 'copas', 'vaso', 'vasos', 'glass'], 'glass', 'glasses', 'object'],
  [['taza', 'tazas', 'mug', 'cup'], 'cup', 'cups', 'object'],
  [['botella', 'botellas', 'frasco', 'frascos', 'bottle'], 'bottle', 'bottles', 'object'],
  [['reloj', 'relojes', 'watch', 'clock'], 'watch', 'watches', 'object'],
  [['libro', 'libros', 'book', 'books'], 'book', 'books', 'object'],
  [['silla', 'sillas', 'sillon', 'chair', 'armchair'], 'chair', 'chairs', 'object'],
  [['sofa', 'sofas', 'couch'], 'sofa', 'sofas', 'object'],
  [['mesa', 'mesas', 'escritorio', 'table', 'desk'], 'table', 'tables', 'object'],
  [['cama', 'camas', 'bed'], 'bed', 'beds', 'object'],
  [['ventana', 'ventanas', 'window', 'windows'], 'window', 'windows', 'object'],
  [['puerta', 'puertas', 'door', 'doors'], 'door', 'doors', 'object'],
  [['pared', 'paredes', 'muro', 'muros', 'wall', 'walls'], 'wall', 'walls', 'object'],
  [['cartel', 'carteles', 'letrero', 'letreros', 'poster', 'posters', 'afiche', 'sign'], 'sign', 'signs', 'object'],
  [['logo', 'logotipo', 'icono'], 'logo', 'logos', 'object'],
  [['globo', 'globos', 'balloon', 'balloons'], 'balloon', 'balloons', 'object'],
  [['paraguas', 'sombrilla', 'umbrella'], 'umbrella', 'umbrellas', 'object'],
  [['guitarra', 'guitarras', 'piano', 'violin', 'guitar'], 'guitar', 'guitars', 'object'],
  [['espada', 'espadas', 'escudo', 'sword'], 'sword', 'swords', 'object'],
  [['corona', 'coronas', 'crown'], 'crown', 'crowns', 'object'],
  [['sombrero', 'sombreros', 'gorra', 'gorras', 'hat', 'cap'], 'hat', 'hats', 'object'],
  [['gafas', 'lentes', 'anteojos', 'glasses'], 'glasses', 'glasses', 'object'],
  [['bufanda', 'bufandas', 'scarf'], 'scarf', 'scarves', 'object'],
  [['traje', 'trajes', 'suit', 'suits'], 'tailored suit', 'tailored suits', 'object'],
  [['vestido', 'vestidos', 'dress'], 'dress', 'dresses', 'object'],
  [['chaqueta', 'abrigo', 'capa', 'jacket', 'coat'], 'jacket', 'jackets', 'object'],
  [['corbata', 'corbatas', 'tie'], 'necktie', 'neckties', 'object'],
  [['collar', 'collares', 'necklace', 'collar'], 'collar', 'collars', 'object'],
  [['zapatilla', 'zapatillas', 'zapato', 'zapatos', 'botas', 'sneaker', 'shoe', 'shoes'], 'sneaker', 'sneakers', 'object'],
  [['mochila', 'mochilas', 'maleta', 'backpack'], 'backpack', 'backpacks', 'object'],
  [['lampara', 'lamparas', 'linterna', 'farol', 'lantern', 'lamp'], 'lantern', 'lanterns', 'object'],
  [['pelota', 'balon', 'esfera', 'ball', 'sphere'], 'ball', 'balls', 'object'],
  [['castillo', 'castillos', 'palacio', 'castle', 'palace'], 'castle', 'castles', 'place'],
  [['casa', 'casas', 'cabana', 'house', 'cabin'], 'house', 'houses', 'place'],
  [['edificio', 'edificios', 'rascacielos', 'torre', 'building', 'skyscraper', 'tower'], 'building', 'buildings', 'place'],
  [['puente', 'puentes', 'bridge'], 'bridge', 'bridges', 'place'],
  [['faro', 'faros', 'lighthouse'], 'lighthouse', 'lighthouses', 'place'],

  // Places, Settings & Nature
  [['playa', 'playas', 'costa', 'orilla', 'beach', 'coast'], 'sandy beach', 'sandy beaches', 'place'],
  [['mar', 'oceano', 'olas', 'sea', 'ocean'], 'ocean', 'oceans', 'place'],
  [['lago', 'laguna', 'lagos', 'lake'], 'lake', 'lakes', 'place'],
  [['rio', 'rios', 'cascada', 'cascadas', 'river', 'waterfall'], 'river', 'rivers', 'place'],
  [['bosque', 'bosques', 'selva', 'jungla', 'forest', 'jungle'], 'forest', 'forests', 'place'],
  [['parque', 'parques', 'jardin', 'jardines', 'prado', 'campo', 'park', 'garden', 'meadow'], 'park', 'parks', 'place'],
  [['montana', 'montanas', 'cordillera', 'volcan', 'valle', 'mountain', 'mountains'], 'mountain', 'mountains', 'place'],
  [['desierto', 'dunas', 'desert'], 'desert', 'deserts', 'place'],
  [['ciudad', 'ciudades', 'pueblo', 'aldea', 'city', 'town'], 'city', 'cities', 'place'],
  [['calle', 'calles', 'avenida', 'callejon', 'street', 'avenue'], 'street', 'streets', 'place'],
  [['oficina', 'oficinas', 'estudio', 'taller', 'office', 'studio', 'workshop'], 'office', 'offices', 'place'],
  [['cafeteria', 'restaurante', 'bar', 'cocina', 'cafe', 'restaurant', 'kitchen'], 'cafe', 'cafes', 'place'],
  [['biblioteca', 'libreria', 'museo', 'library', 'museum'], 'library', 'libraries', 'place'],
  [['habitacion', 'dormitorio', 'cuarto', 'room', 'bedroom'], 'room', 'rooms', 'place'],
  [['cielo', 'cielos', 'nube', 'nubes', 'sky', 'clouds'], 'sky', 'clouds', 'place'],
  [['espacio', 'cosmos', 'galaxia', 'universo', 'outer space', 'galaxy'], 'outer space', 'galaxies', 'place'],
  [['luna', 'moon'], 'moon', 'moons', 'place'],
  [['sol', 'sun'], 'sun', 'suns', 'place'],
  [['nieve', 'hielo', 'snow'], 'snow', 'snow', 'place'],
];

const ADJECTIVE_MAP = new Map([
  ['pequeno', 'small'], ['pequena', 'small'], ['pequenos', 'small'], ['pequenas', 'small'],
  ['grande', 'large'], ['grandes', 'large'],
  ['gigante', 'giant'], ['gigantes', 'giant'], ['enorme', 'enormous'], ['enormes', 'enormous'],
  ['diminuto', 'tiny miniature'], ['diminuta', 'tiny miniature'], ['miniatura', 'miniature'],
  ['tierno', 'cute'], ['tierna', 'cute'], ['tiernos', 'cute'], ['lindo', 'cute'], ['linda', 'cute'], ['adorable', 'adorable'], ['bonito', 'pretty'], ['bonita', 'pretty'],
  ['esponjoso', 'fluffy'], ['esponjosa', 'fluffy'], ['peludo', 'fluffy'], ['peluda', 'fluffy'],
  ['majestuoso', 'majestic'], ['majestuosa', 'majestic'], ['epico', 'epic'], ['epica', 'epic'],
  ['hermoso', 'beautiful'], ['hermosa', 'beautiful'], ['elegante', 'elegant'], ['elegantes', 'elegant'],
  ['moderno', 'modern'], ['moderna', 'modern'], ['modernos', 'modern'], ['modernas', 'modern'],
  ['antiguo', 'ancient'], ['antigua', 'ancient'], ['viejo', 'weathered'], ['vieja', 'weathered'], ['colonial', 'colonial'],
  ['futurista', 'futuristic'], ['futuristas', 'futuristic'], ['espacial', 'space'], ['espaciales', 'space'],
  ['costero', 'coastal'], ['costera', 'coastal'], ['costeros', 'coastal'], ['costeras', 'coastal'],
  ['tropical', 'tropical'], ['tropicales', 'tropical'],
  ['nevado', 'snow-covered'], ['nevada', 'snow-covered'], ['nevados', 'snow-covered'], ['nevadas', 'snow-covered'],
  ['soleado', 'sunlit'], ['soleada', 'sunlit'],
  ['lluvioso', 'rainy'], ['lluviosa', 'rainy'], ['mojado', 'wet'], ['mojada', 'wet'],
  ['nocturno', 'nighttime'], ['nocturna', 'nighttime'],
  ['brillante', 'bright glowing'], ['brillantes', 'bright glowing'], ['luminoso', 'luminous'], ['luminosa', 'luminous'],
  ['transparente', 'translucent'], ['transparentes', 'translucent'], ['translucido', 'translucent'], ['translucida', 'translucent'],
  ['metalico', 'metallic'], ['metalica', 'metallic'],
  ['realista', 'photorealistic'], ['fotorrealista', 'photorealistic'], ['hiperrealista', 'hyperrealistic'],
  ['minimalista', 'minimalist'], ['minimalistas', 'minimalist'],
  ['artesanal', 'artisanal'], ['artesanales', 'artisanal'],
  ['salvaje', 'wild'], ['salvajes', 'wild'],
  ['feliz', 'happy'], ['felices', 'happy'], ['sonriente', 'smiling'], ['alegre', 'cheerful'],
  ['serio', 'poised'], ['tranquilo', 'calm'], ['tranquila', 'calm'],
  ['volador', 'flying'], ['voladora', 'flying'], ['flotante', 'floating'],
  ['magico', 'magical'], ['magica', 'magical'], ['encantado', 'enchanted'], ['encantada', 'enchanted'],
  ['suave', 'soft'], ['oscuro', 'dark'], ['oscura', 'dark'], ['claro', 'light'], ['clara', 'light'],
  ['intenso', 'vivid'], ['intensa', 'vivid'], ['vivo', 'vivid'], ['viva', 'vivid'], ['vivos', 'vivid'], ['vivas', 'vivid'],
]);

// Multi-word & single-word action, pose, preposition, time, and quote connectors (longest-first).
const CONNECTOR_SPECS = [
  // Quoted text triggers
  ['que diga', 'displaying exact legible text'],
  ['que dice', 'displaying exact legible text'],
  ['con el texto', 'with exact legible text'],
  ['con el titulo', 'titled with exact legible text'],
  ['con la palabra', 'displaying the exact word'],
  ['con la frase', 'displaying the exact phrase'],

  // Time & weather clauses
  ['al amanecer', 'at sunrise'],
  ['en el amanecer', 'at sunrise'],
  ['al atardecer', 'at golden sunset'],
  ['en el atardecer', 'at golden sunset'],
  ['puesta de sol', 'at sunset'],
  ['al anochecer', 'at twilight dusk'],
  ['de noche', 'at night'],
  ['en la noche', 'at night'],
  ['por la noche', 'at night'],
  ['de dia', 'in bright daylight'],
  ['bajo la lluvia', 'in the rain'],
  ['con lluvia', 'in the rain'],
  ['bajo el agua', 'underwater'],
  ['bajo las estrellas', 'under a starry sky'],
  ['en el espacio exterior', 'in outer space'],
  ['en el espacio', 'in outer space'],
  ['mirando a la camara', 'looking directly at the camera'],
  ['mirando a camara', 'looking directly at the camera'],
  ['de cuerpo entero', 'in a full-body shot'],
  ['en primer plano', 'in the foreground'],
  ['al fondo', 'in the background'],
  ['en el centro', 'in the center'],

  // Multi-word spatial prepositions
  ['encima de', 'on top of'],
  ['por encima de', 'high above'],
  ['debajo de', 'underneath'],
  ['dentro de', 'inside'],
  ['en el interior de', 'inside'],
  ['fuera de', 'outside'],
  ['delante de', 'in front of'],
  ['frente a', 'in front of'],
  ['enfrente de', 'in front of'],
  ['detras de', 'behind'],
  ['al lado de', 'next to'],
  ['junto a', 'next to'],
  ['cerca de', 'near'],
  ['alrededor de', 'around'],
  ['a la izquierda de', 'to the left of'],
  ['a la derecha de', 'to the right of'],
  ['vestido de', 'dressed in'],
  ['vestida de', 'dressed in'],
  ['vestidos de', 'dressed in'],
  ['vestidas de', 'dressed in'],
  ['acompanado de', 'accompanied by'],

  // Actions / gerunds / poses
  ['volando sobre', 'flying above'],
  ['flotando sobre', 'floating above'],
  ['saltando sobre', 'jumping over'],
  ['caminando por', 'walking along'],
  ['corriendo por', 'running through'],
  ['nadando en', 'swimming in'],
  ['sentado en', 'sitting on'],
  ['sentada en', 'sitting on'],
  ['sentados en', 'sitting on'],
  ['apoyado en', 'resting against'],
  ['apoyada en', 'resting against'],
  ['volando', 'flying'],
  ['corriendo', 'running'],
  ['saltando', 'jumping'],
  ['nadando', 'swimming'],
  ['caminando', 'walking'],
  ['paseando', 'strolling'],
  ['sentado', 'sitting'],
  ['sentada', 'sitting'],
  ['sentados', 'sitting'],
  ['sentadas', 'sitting'],
  ['acostado', 'lying down'],
  ['acostada', 'lying down'],
  ['echado', 'lying down'],
  ['durmiendo', 'sleeping'],
  ['de pie', 'standing'],
  ['parado', 'standing'],
  ['jugando', 'playing'],
  ['leyendo', 'reading'],
  ['escribiendo', 'writing'],
  ['pintando', 'painting'],
  ['tocando', 'playing'],
  ['bailando', 'dancing'],
  ['cantando', 'singing'],
  ['tomando', 'drinking'],
  ['bebiendo', 'drinking'],
  ['comiendo', 'eating'],
  ['cocinando', 'cooking'],
  ['montando', 'riding'],
  ['cabalgando', 'riding'],
  ['conduciendo', 'driving'],
  ['manejando', 'driving'],
  ['flotando', 'floating'],
  ['mirando', 'looking at'],
  ['observando', 'watching'],
  ['sosteniendo', 'holding'],
  ['sujetando', 'holding'],
  ['llevando', 'carrying'],
  ['usando', 'wearing'],
  ['vistiendo', 'wearing'],
  ['brillando', 'glowing'],
  ['sonriendo', 'smiling'],
  ['trabajando', 'working'],
  ['explorando', 'exploring'],
  ['cruzando', 'crossing'],
  ['descansando', 'resting'],
  ['lloviendo', 'in the rain'],
  ['nevando', 'in falling snow'],

  // Single-word prepositions & conjunctions
  ['con', '__WITH__'],
  ['sobre', 'on top of'],
  ['bajo', 'under'],
  ['entre', 'between'],
  ['hacia', 'toward'],
  ['contra', 'against'],
  ['para', 'for'],
  ['por', 'through'],
  ['desde', 'from'],
  ['hasta', 'up to'],
  ['como', 'as'],
  ['en', '__IN_ON__'],
  ['del', 'of the'],
  ['al', 'to the'],
  ['de', 'of'],
  ['y', 'and'],
  ['e', 'and'],
  ['o', 'or'],
  ['pero', 'but'],
  ['ahora', 'now'],
];

// Build fast lookup structures at module load (`<1ms` once).
const NOUN_PHRASE_LOOKUP = [];
for (const [forms, sg, pl, surfaceClass] of NOUN_ENTRIES) {
  for (let i = 0; i < forms.length; i += 1) {
    const normForm = normalizeTokenKey(forms[i]);
    const isPluralForm = normForm !== normalizeTokenKey(forms[0]) && /s$/.test(normForm) && !/gafas|lentes|anteojos|paraguas|arcoiris/.test(normForm);
    NOUN_PHRASE_LOOKUP.push({
      words: normForm.split(' '),
      sg,
      pl,
      surfaceClass,
      plural: isPluralForm,
    });
  }
}
NOUN_PHRASE_LOOKUP.sort((a, b) => b.words.length - a.words.length);

const COLOR_PHRASE_LOOKUP = [];
for (const spec of COLOR_SPECS) {
  for (const phrase of spec.phrases) {
    const normPhrase = normalizeTokenKey(phrase);
    COLOR_PHRASE_LOOKUP.push({
      words: normPhrase.split(' '),
      rawPhrase: normPhrase,
      spec,
      explicitColorCue: /^(?:de color|en color|color|tono)\b/.test(normPhrase),
    });
  }
}
COLOR_PHRASE_LOOKUP.sort((a, b) => b.words.length - a.words.length);

const MATERIAL_PHRASE_LOOKUP = [];
for (const spec of MATERIAL_SPECS) {
  for (const phrase of spec.phrases) {
    MATERIAL_PHRASE_LOOKUP.push({
      words: normalizeTokenKey(phrase).split(' '),
      spec,
    });
  }
}
MATERIAL_PHRASE_LOOKUP.sort((a, b) => b.words.length - a.words.length);

const CONNECTOR_LOOKUP = CONNECTOR_SPECS
  .map(([es, en]) => ({ words: normalizeTokenKey(es).split(' '), en }))
  .sort((a, b) => b.words.length - a.words.length);

const WEARABLE_OBJECTS = new Set([
  'sunglasses', 'glasses', 'hat', 'hats', 'crown', 'crowns', 'scarf', 'scarves',
  'tailored suit', 'tailored suits', 'dress', 'dresses', 'jacket', 'jackets',
  'necktie', 'neckties', 'collar', 'collars', 'sneaker', 'sneakers', 'backpack', 'backpacks',
  'spacesuit', 'spacesuits',
]);

const ON_SURFACE_PLACES = new Set([
  'sandy beach', 'sandy beaches', 'table', 'tables', 'chair', 'chairs', 'sofa', 'sofas',
  'bed', 'beds', 'wall', 'walls', 'bridge', 'bridges', 'street', 'streets', 'moon', 'mountain', 'mountains',
]);

const UNCOUNTABLE_OR_PLURAL_INVARIANT = new Set([
  'sunglasses', 'glasses', 'coffee', 'tea', 'snow', 'ice cream', 'artisan bread', 'outer space',
]);

// Common English words so mixed or pure-English prompts aren't misclassified as untranslated Spanish.
const COMMON_ENGLISH_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'without', 'by', 'for', 'from', 'to', 'into',
  'over', 'above', 'under', 'below', 'inside', 'outside', 'behind', 'near', 'between', 'around',
  'and', 'or', 'but', 'wearing', 'holding', 'flying', 'running', 'sitting', 'standing', 'walking',
  'swimming', 'sleeping', 'playing', 'drinking', 'eating', 'riding', 'floating', 'looking', 'smiling',
  'bright', 'vivid', 'soft', 'dark', 'light', 'pastel', 'deep', 'rich', 'warm', 'cool', 'golden',
  'sunset', 'sunrise', 'night', 'daylight', 'rain', 'beach', 'forest', 'city', 'street', 'mountain',
  'ocean', 'sky', 'space', 'studio', 'portrait', 'photo', 'realistic', 'photorealistic', 'cute',
  'small', 'large', 'giant', 'tiny', 'fluffy', 'crystal', 'glass', 'wooden', 'metal', 'gold', 'silver',
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'distinct', 'uninhabited',
  'empty', 'setting', 'clean', 'unlabelled', 'text-free', 'surfaces', 'clear', 'cloudless', 'isolated',
  'plain', 'neutral', 'backdrop', 'bare', 'unobstructed', 'eyes', 'bareheaded', 'open', 'treeless',
  'terrain', 'full-bleed', 'borderless', 'edge',
]);

const SPANISH_SIGNAL_RE = /\b(?:un|una|unos|unas|el|la|los|las|del|al|con|sin|sobre|bajo|entre|frente|detras|encima|debajo|dentro|perro|gato|elefante|leon|tigre|oso|caballo|pinguino|pajaro|mariposa|ciudad|playa|bosque|montana|calle|cielo|noche|atardecer|amanecer|celeste|azul|rojo|roja|verde|amarillo|rosado|morado|dorado|plateado|blanco|blanca|negro|negra|gris|cristal|madera|fuego|hielo|corriendo|volando|sentado|tomando|mirando|quiero|portada|cartel|letrero|foto|imagen)\b/i;

function matchWordsAt(normTokens, pos, patternWords) {
  if (pos + patternWords.length > normTokens.length) return false;
  for (let k = 0; k < patternWords.length; k += 1) {
    if (normTokens[pos + k] !== patternWords[k]) return false;
  }
  return true;
}

function fixEnglishIndefiniteArticle(phrase) {
  return phrase.replace(/\ba\s+([aeiou8])/gi, (m, v) => `${m[0] === 'A' ? 'An' : 'an'} ${v}`);
}

function capitalizeFirst(text) {
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * Build a 100% positive surface/coat/plumage/material lock for the primary
 * subject so CLIP-L & T5-XXL render non-natural colors & surreal materials
 * across the entire subject without ever naming unwanted natural colors.
 */
function buildPositiveSubjectSurfaceLock(np) {
  if (!np || !np.noun) return '';
  const { noun, color, material } = np;

  // Surreal or explicit material (`de cristal azul`, `de hielo`, `de oro`, `de origami`, etc.)
  if (material && (noun.surfaceClass === 'furred' || noun.surfaceClass === 'hide' || noun.surfaceClass === 'feathered' || noun.surfaceClass === 'scaled' || color)) {
    const colorPrefix = color ? `${color.pre} ` : '';
    return `sculpted entirely from ${colorPrefix}${material.surface} across its entire body, head, and surface`;
  }

  if (!color) return '';
  // Apply full-coat / full-surface lock whenever a creature has a non-natural color
  // OR the user explicitly wrote `"de color ..."` / `"color ..."`.
  const needsExplicitCoatLock = Boolean(color.nonNatural || color.explicitColorCue);
  if (!needsExplicitCoatLock) return '';

  if (noun.surfaceClass === 'furred') {
    return `with a ${color.coatTone} fur coat covering its entire head, ears, body, legs, and tail, uniform vibrant ${color.hueLabel} coloration`;
  }
  if (noun.surfaceClass === 'hide') {
    return `with ${color.coatTone} skin and hide covering its entire head, ears, body, and legs, uniform vibrant ${color.hueLabel} coloration`;
  }
  if (noun.surfaceClass === 'feathered') {
    return `with ${color.coatTone} plumage and feathers covering its entire head, wings, body, and tail, uniform vibrant ${color.hueLabel} coloration`;
  }
  if (noun.surfaceClass === 'scaled') {
    return `with ${color.coatTone} scales and body surface covering its entire head, body, and limbs, uniform vibrant ${color.hueLabel} coloration`;
  }
  if (noun.surfaceClass === 'plant' || noun.surfaceClass === 'object' || noun.surfaceClass === 'vehicle') {
    return `with a uniform ${color.coatTone} exterior surface`;
  }
  return '';
}

function renderNounPhraseEnglish(np, { isPrimarySubject = false, afterWith = false, subjectIsPlural = false } = {}) {
  const isPlural = Boolean(np.plural || (afterWith && subjectIsPlural && WEARABLE_OBJECTS.has(np.noun.sg)));
  const headWord = isPlural ? np.noun.pl : np.noun.sg;
  const invariant = UNCOUNTABLE_OR_PLURAL_INVARIANT.has(headWord);

  let det = np.det || '';
  if (det === 'a' && (isPlural || invariant)) {
    det = '';
  }

  const preMods = [...np.preAdjs];
  if (np.color) preMods.push(np.color.pre);
  if (np.material) preMods.push(np.material.adj);
  for (const adj of np.postAdjs) {
    if (!preMods.includes(adj)) preMods.push(adj);
  }

  const hexBadge = (np.color && np.color.hex && (isPrimarySubject || np.color.nonNatural))
    ? `(${np.color.hex})`
    : '';
  const surfaceLock = isPrimarySubject ? buildPositiveSubjectSurfaceLock(np) : '';

  const coreParts = [det, ...preMods, headWord, hexBadge, surfaceLock].filter(Boolean);
  return fixEnglishIndefiniteArticle(collapseSpaces(coreParts.join(' ')));
}

/**
 * Tier-1 (`<1ms` deterministic, zero network) Compositional ES→EN Visual Scene Compiler.
 */
function compileEnglishVisualSceneOffline(rawPrompt, { inheritedSubjectColor = null } = {}) {
  const cleanedWrapper = stripCreationWrapper(rawPrompt);
  if (!cleanedWrapper) {
    return {
      englishScene: '',
      coverage: 1,
      untranslatedTokens: [],
      hasSpanish: false,
      hasStrongLiteralTrait: false,
      primarySubject: null,
    };
  }

  const { shielded, quotes } = shieldQuotedLiterals(cleanedWrapper);
  const forbidsPeople = /\b(?:sin\s+(?:ningun[oa]?\s+)?(?:personas?|gente|humanos?|peatones|multitud)|without\s+(?:any\s+)?people|no\s+people)\b/i.test(shielded);
  const { text: positiveText, rewrote: rewroteNegation } = rewriteNegationsPositively(shielded);
  const normFull = stripDiacritics(positiveText).toLowerCase();
  const hasSpanish = SPANISH_SIGNAL_RE.test(normFull) || rewroteNegation;

  // Split into word + punctuation tokens while preserving `__Q0__` placeholders and `#HEX`.
  const rawTokens = positiveText.match(/__Q\d+__|#[0-9A-Fa-f]{3,6}\b|[\p{L}\p{N}][\p{L}\p{N}'-]*|[,.;:!?]/gu) || [];
  const normTokens = rawTokens.map((t) => normalizeTokenKey(t));

  const outFragments = [];
  const untranslatedTokens = [];
  let totalContentTokens = 0;
  let translatedContentTokens = 0;
  let primarySubject = null;
  let hasStrongLiteralTrait = Boolean(rewroteNegation || quotes.length > 0);
  let pendingRelation = null; // '__WITH__' | '__IN_ON__' | null

  let i = 0;
  while (i < rawTokens.length) {
    const rawTok = rawTokens[i];
    const normTok = normTokens[i];

    // 1. Punctuation passthrough
    if (/^[,.;:!?]$/.test(rawTok)) {
      pendingRelation = null;
      if (outFragments.length > 0 && rawTok === ',') {
        outFragments[outFragments.length - 1] = `${outFragments[outFragments.length - 1]},`;
      }
      i += 1;
      continue;
    }

    // 2. Quoted text placeholder passthrough
    if (/^__q\d+__$/i.test(rawTok)) {
      pendingRelation = null;
      outFragments.push(rawTok.toUpperCase());
      i += 1;
      continue;
    }

    // 3. Try parsing a Noun Phrase: `[Det/Count?] + [PreAdj*] + [HeadNoun] + [Material | Color | PostAdj]*`
    let cursor = i;
    let detInfo = null;
    if (EXACT_COUNT_MAP.has(normTokens[cursor])) {
      detInfo = EXACT_COUNT_MAP.get(normTokens[cursor]);
      cursor += 1;
    }

    const preAdjs = [];
    while (cursor < normTokens.length && ADJECTIVE_MAP.has(normTokens[cursor])) {
      // Only treat as pre-adjective if a known head noun immediately follows!
      const nextHasNoun = NOUN_PHRASE_LOOKUP.some((entry) => matchWordsAt(normTokens, cursor + 1, entry.words));
      if (!nextHasNoun) break;
      preAdjs.push(ADJECTIVE_MAP.get(normTokens[cursor]));
      cursor += 1;
    }

    let matchedNoun = null;
    for (const entry of NOUN_PHRASE_LOOKUP) {
      if (matchWordsAt(normTokens, cursor, entry.words)) {
        matchedNoun = entry;
        cursor += entry.words.length;
        break;
      }
    }

    if (matchedNoun) {
      const np = {
        det: detInfo ? detInfo.det : '',
        plural: Boolean((detInfo && detInfo.plural) || matchedNoun.plural),
        exactCount: detInfo ? detInfo.exactCount : null,
        preAdjs,
        noun: matchedNoun,
        color: null,
        material: null,
        postAdjs: [],
      };
      if (np.exactCount && np.exactCount >= 2) hasStrongLiteralTrait = true;

      // Consume any post-nominal materials (`de cristal`), colors (`celeste`, `#HEX`), and adjectives (`gigante`, `costera`)!
      let keepScanningMods = true;
      while (keepScanningMods && cursor < normTokens.length) {
        keepScanningMods = false;

        // 3a. Material modifier (`de cristal`, `de hielo`, `de madera`, ...)
        if (!np.material) {
          for (const mat of MATERIAL_PHRASE_LOOKUP) {
            if (matchWordsAt(normTokens, cursor, mat.words)) {
              np.material = mat.spec;
              hasStrongLiteralTrait = true;
              cursor += mat.words.length;
              keepScanningMods = true;
              break;
            }
          }
          if (keepScanningMods) continue;
        }

        // 3b. Explicit `#HEX` color modifier
        if (!np.color && /^#[0-9a-f]{3,6}$/i.test(rawTokens[cursor])) {
          const hex = rawTokens[cursor].toUpperCase();
          np.color = {
            id: `hex_${hex.slice(1).toLowerCase()}`,
            pre: `exact ${hex}-colored`,
            coatTone: `vivid ${hex}`,
            hueLabel: hex,
            hex,
            nonNatural: true,
            explicitColorCue: true,
          };
          hasStrongLiteralTrait = true;
          cursor += 1;
          keepScanningMods = true;
          continue;
        }

        // 3c. Named color modifier (`celeste`, `de color celeste`, `azul`, `rosado`, ...)
        if (!np.color) {
          for (const col of COLOR_PHRASE_LOOKUP) {
            if (matchWordsAt(normTokens, cursor, col.words)) {
              np.color = { ...col.spec, explicitColorCue: col.explicitColorCue };
              if (col.spec.nonNatural || col.explicitColorCue) hasStrongLiteralTrait = true;
              cursor += col.words.length;
              keepScanningMods = true;
              break;
            }
          }
          if (keepScanningMods) continue;
        }

        // 3d. Post-nominal descriptive adjective (`costera`, `gigante`, `realista`, ...)
        if (ADJECTIVE_MAP.has(normTokens[cursor])) {
          np.postAdjs.push(ADJECTIVE_MAP.get(normTokens[cursor]));
          cursor += 1;
          keepScanningMods = true;
        }
      }

      const isPrimary = !primarySubject;
      if (isPrimary) {
        if (!np.color && inheritedSubjectColor && inheritedSubjectColor.id) {
          const matchedSpec = COLOR_SPECS.find((c) => c.id === inheritedSubjectColor.id);
          if (matchedSpec) {
            np.color = { ...matchedSpec, explicitColorCue: true };
            hasStrongLiteralTrait = true;
          } else if (inheritedSubjectColor.hex) {
            np.color = {
              id: inheritedSubjectColor.id,
              pre: inheritedSubjectColor.en || `vivid ${inheritedSubjectColor.hex}`,
              coatTone: inheritedSubjectColor.en || `vivid ${inheritedSubjectColor.hex}`,
              hueLabel: inheritedSubjectColor.hex,
              hex: inheritedSubjectColor.hex,
              nonNatural: Boolean(inheritedSubjectColor.nonNatural),
              explicitColorCue: true,
            };
            hasStrongLiteralTrait = true;
          }
        }
        primarySubject = np;
      }

      // Resolve context-sensitive preposition before this noun phrase (`con` -> `wearing` for wearables, `en` -> `on` vs `in`).
      if (pendingRelation === '__WITH__') {
        const verb = WEARABLE_OBJECTS.has(matchedNoun.sg) ? 'wearing' : 'with';
        outFragments.push(verb);
      } else if (pendingRelation === '__IN_ON__') {
        const prep = ON_SURFACE_PLACES.has(matchedNoun.sg) ? 'on' : 'in';
        outFragments.push(prep);
      }
      const wasAfterWith = pendingRelation === '__WITH__';
      pendingRelation = null;

      outFragments.push(renderNounPhraseEnglish(np, {
        isPrimarySubject: isPrimary,
        afterWith: wasAfterWith,
        subjectIsPlural: Boolean(primarySubject && primarySubject.plural),
      }));

      const consumedCount = cursor - i;
      totalContentTokens += consumedCount;
      translatedContentTokens += consumedCount;
      i = cursor;
      continue;
    }

    // 4. Multi-word or single-word connectors, actions, poses, time, and spatial prepositions
    let matchedConnector = null;
    for (const conn of CONNECTOR_LOOKUP) {
      if (matchWordsAt(normTokens, i, conn.words)) {
        matchedConnector = conn;
        break;
      }
    }
    if (matchedConnector) {
      if (matchedConnector.en === '__WITH__' || matchedConnector.en === '__IN_ON__') {
        pendingRelation = matchedConnector.en;
      } else {
        pendingRelation = null;
        outFragments.push(matchedConnector.en);
      }
      totalContentTokens += matchedConnector.words.length;
      translatedContentTokens += matchedConnector.words.length;
      i += matchedConnector.words.length;
      continue;
    }

    // Flush any pending deferred preposition if the next token wasn't a known lexicon noun
    if (pendingRelation === '__WITH__') {
      outFragments.push('with');
      pendingRelation = null;
    } else if (pendingRelation === '__IN_ON__') {
      outFragments.push('in');
      pendingRelation = null;
    }

    // 5. Standalone Color Expression (e.g. follow-up `"ahora en celeste"` / `"de color verde esmeralda"`)
    let matchedStandaloneColor = null;
    for (const col of COLOR_PHRASE_LOOKUP) {
      if (col.spec.ambiguousNounForms && col.spec.ambiguousNounForms.has(col.rawPhrase)) continue;
      if (matchWordsAt(normTokens, i, col.words)) {
        matchedStandaloneColor = col;
        break;
      }
    }
    if (matchedStandaloneColor) {
      const c = matchedStandaloneColor.spec;
      if (c.nonNatural || matchedStandaloneColor.explicitColorCue) hasStrongLiteralTrait = true;
      outFragments.push(`${c.pre}${c.hex ? ` (${c.hex})` : ''}`);
      totalContentTokens += matchedStandaloneColor.words.length;
      translatedContentTokens += matchedStandaloneColor.words.length;
      i += matchedStandaloneColor.words.length;
      continue;
    }

    // 6. Standalone Material (`de cristal`) or Adjective (`minimalista`) or Determiner (`dos`)
    let matchedStandaloneMat = null;
    for (const mat of MATERIAL_PHRASE_LOOKUP) {
      if (matchWordsAt(normTokens, i, mat.words)) {
        matchedStandaloneMat = mat;
        break;
      }
    }
    if (matchedStandaloneMat) {
      hasStrongLiteralTrait = true;
      outFragments.push(`made of ${matchedStandaloneMat.spec.surface}`);
      totalContentTokens += matchedStandaloneMat.words.length;
      translatedContentTokens += matchedStandaloneMat.words.length;
      i += matchedStandaloneMat.words.length;
      continue;
    }

    if (ADJECTIVE_MAP.has(normTok)) {
      outFragments.push(ADJECTIVE_MAP.get(normTok));
      totalContentTokens += 1;
      translatedContentTokens += 1;
      i += 1;
      continue;
    }

    if (EXACT_COUNT_MAP.has(normTok)) {
      const d = EXACT_COUNT_MAP.get(normTok);
      if (d.exactCount && d.exactCount >= 2) hasStrongLiteralTrait = true;
      if (d.det) outFragments.push(d.det);
      totalContentTokens += 1;
      translatedContentTokens += 1;
      i += 1;
      continue;
    }

    // 7. Proper Nouns (e.g. `Lima`, `París`, `Machu Picchu`, `Tokio`, brand names) & English words
    const isProperCapitalized = i > 0 && /^[A-ZÁÉÍÓÚÑ]/.test(rawTok);
    const isKnownEnglish = COMMON_ENGLISH_WORDS.has(normTok) || /^\d+$/.test(normTok);
    totalContentTokens += 1;
    if (isProperCapitalized || isKnownEnglish) {
      translatedContentTokens += 1;
      outFragments.push(rawTok);
    } else {
      untranslatedTokens.push(rawTok);
      outFragments.push(rawTok);
    }
    i += 1;
  }

  const coverage = totalContentTokens > 0
    ? Number((translatedContentTokens / totalContentTokens).toFixed(3))
    : 1;

  const sanitizedShielded = sanitizeCompiledScene(capitalizeFirst(collapseSpaces(outFragments.join(' '))));
  const englishScene = restoreQuotedLiterals(sanitizedShielded, quotes);

  return {
    englishScene,
    coverage,
    untranslatedTokens,
    hasSpanish,
    hasStrongLiteralTrait,
    forbidsPeople,
    primarySubject,
    quotes,
  };
}

// ── Tier-2 Bounded Fast Literal LLM Translator (Open-Vocabulary Fallback) ─

const LITERAL_SCENE_TRANSLATOR_SYSTEM_PROMPT = [
  'You translate user image prompts into ONE concise, 100% literal English visual description (maximum 45 words) for an image diffusion encoder.',
  'STRICT RULES:',
  '1) Preserve EVERY subject, exact color, exact count, material, clothing/accessory, pose, action, spatial relation, setting, and lighting.',
  '2) Keep any placeholder like __Q0__ or quoted text 100% verbatim without translating it.',
  '3) If an animal, bird, creature, or object has an unusual color (e.g., sky-blue dog, pink elephant, green cat), state the color positively on its fur coat, plumage, skin, scales, or surface (e.g., "A vivid sky-blue dog (#7DD3FC) with a bright sky-blue fur coat covering its entire head, body, and legs"). NEVER mention unwanted colors (never write "not brown" or "not gray").',
  '4) Convert "sin X" / "without X" into positive visual states (e.g., "in an uninhabited empty setting").',
  '5) Do NOT invent extra objects, dark chiaroscuro lighting, camera lenses, artist names, or commentary. Output ONLY the English visual sentence.',
].join(' ');

async function runBoundedLiteralTranslation(shieldedPrompt, {
  env = process.env,
  timeoutMs = DEFAULT_TRANSLATION_TIMEOUT_MS,
  translateComplete = null,
  signal = null,
} = {}) {
  let timer = null;
  try {
    const invokeTranslator = async () => {
      if (typeof translateComplete === 'function') {
        return translateComplete({
          prompt: shieldedPrompt,
          systemPrompt: LITERAL_SCENE_TRANSLATOR_SYSTEM_PROMPT,
        });
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
            max_tokens: 140,
            messages: [
              { role: 'system', content: LITERAL_SCENE_TRANSLATOR_SYSTEM_PROMPT },
              { role: 'user', content: shieldedPrompt },
            ],
          }, signal ? { signal } : undefined);
          const content = completion?.choices?.[0]?.message?.content || '';
          if (content && content.trim()) return content;
        } catch {
          // Try next configured fast provider before deterministic Tier-1 fallback.
        }
      }
      return '';
    };

    const timeoutSentinel = Symbol('prompt_fidelity_translate_timeout');
    const rawResult = await Promise.race([
      invokeTranslator(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutSentinel), Math.max(200, timeoutMs));
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (rawResult === timeoutSentinel || typeof rawResult !== 'string' || !rawResult.trim()) {
      return '';
    }
    return rawResult.trim();
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Compile the high-attention `Exact scene specification:` block for `directImagePrompt`.
 *
 * - Emits immediately after the user's core subject phrase (at Tokens 4–35 of CLIP-L!)
 *    whenever the prompt contains Spanish phrasing OR strong literal constraints
 *   (non-natural creature color, surreal material, exact count >= 2, positive negation).
 * - Uses Tier 1 (`<1ms` deterministic) when lexical coverage >= 0.85, and seamlessly
 *   upgrades open-vocabulary Spanish prompts via Tier 2 (`<=1200ms` bounded fail-open).
 */
async function compilePromptFidelitySpec(rawPrompt, {
  env = process.env,
  timeoutMs = DEFAULT_TRANSLATION_TIMEOUT_MS,
  translateComplete = null,
  allowLiveTranslation = !IS_TEST_RUNTIME,
  inheritedSubjectColor = null,
  signal = null,
} = {}) {
  const tier1 = compileEnglishVisualSceneOffline(rawPrompt, { inheritedSubjectColor });
  if (!tier1.englishScene) {
    return {
      clause: '',
      englishScene: '',
      source: 'none',
      coverage: 1,
      hasSpanish: false,
      hasStrongLiteralTrait: false,
    };
  }

  // Plain English prompts without surreal colors, exact counts, or negations
  // are already native to CLIP-L/T5 — avoid redundant repetition.
  if (!tier1.hasSpanish && !tier1.hasStrongLiteralTrait) {
    return {
      clause: '',
      englishScene: '',
      source: 'native-en',
      coverage: tier1.coverage,
      hasSpanish: false,
      hasStrongLiteralTrait: false,
    };
  }

  let finalScene = tier1.englishScene;
  let source = 'offline-compiler';

  const needsOpenVocabUpgrade = Boolean(
    tier1.hasSpanish
    && tier1.untranslatedTokens.length > 0
    && tier1.coverage < 0.85
    && (
      typeof translateComplete === 'function'
      || (allowLiveTranslation && visionRuntimeCandidates(env).length > 0)
    )
  );

  if (needsOpenVocabUpgrade) {
    const cleaned = stripCreationWrapper(rawPrompt);
    const { shielded, quotes } = shieldQuotedLiterals(cleaned);
    const llmTranslated = await runBoundedLiteralTranslation(shielded, {
      env,
      timeoutMs,
      translateComplete,
      signal,
    });
    if (llmTranslated) {
      const sanitizedLlm = sanitizeCompiledScene(llmTranslated);
      const restored = restoreQuotedLiterals(sanitizedLlm, quotes);
      if (restored) {
        // If Tier 1 also built a positive non-natural coat/material lock that the LLM didn't include, preserve the `#HEX` anchor!
        const missingHex = tier1.primarySubject?.color?.hex && !restored.includes(tier1.primarySubject.color.hex)
          ? ` (${tier1.primarySubject.color.hex})`
          : '';
        finalScene = missingHex
          ? `${restored.replace(/[.!?]$/, '')}${missingHex}.`
          : restored;
        source = 'llm-literal';
      }
    }
  }

  return {
    clause: `Exact scene specification: ${finalScene}`,
    englishScene: finalScene,
    source,
    coverage: tier1.coverage,
    hasSpanish: tier1.hasSpanish,
    hasStrongLiteralTrait: tier1.hasStrongLiteralTrait,
    forbidsPeople: Boolean(tier1.forbidsPeople),
  };
}

/**
 * Compact positive English edit-delta translation for `directImageEditPrompt`
 * when a Spanish edit instruction specifies non-natural colors, surreal materials,
 * exact counts, or positive negations.
 */
function compileEditFidelityClause(rawInstruction) {
  const tier1 = compileEnglishVisualSceneOffline(rawInstruction);
  if (!tier1.englishScene || (!tier1.hasSpanish && !tier1.hasStrongLiteralTrait)) {
    return '';
  }
  if (!tier1.hasStrongLiteralTrait) return '';
  return `Exact edit target: ${tier1.englishScene}`;
}

module.exports = {
  compilePromptFidelitySpec,
  compileEnglishVisualSceneOffline,
  compileEditFidelityClause,
  stripCreationWrapper,
  shieldQuotedLiterals,
  restoreQuotedLiterals,
  rewriteNegationsPositively,
};
