'use strict';

/**
 * image-directive — pure, dependency-free parser that turns spoken image
 * requests into concrete generation / edit directives.
 *
 * Product goal: the user should be able to say things like
 *   - "dame una imagen vertical de un perro"
 *   - "hazme una imagen orisontal para la portada"   (typo-tolerant)
 *   - "en la imagen cambia el cielo a un atardecer naranja"
 *   - "cambia solo los ojos a color verde"
 * and the agent / image route gets: a clean visual prompt, an exact frame
 * (1:1, 3:4, 16:9, 9:16, …), quality, count, style/type and — for edits —
 * an explicit target + an optional normalized selection region.
 *
 * Everything here is deterministic (no model calls) so it runs on the hot
 * path and is fully unit-testable. A missed spec only degrades to a sane
 * default; it never invents visual content.
 */

// ── Normalisation (accent + case insensitive, typo-tolerant) ─────────────

function normalizeImageText(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .replace(/\s+/g, ' ')
    .trim();
}

// Common Spanish typos seen in chat ("dma euna imagen orisailntal").
// Word-boundary anchored so normal words are never rewritten.
const TYPO_REPLACEMENTS = [
  [/\bdma\b/g, 'dame'],
  [/\beuna\b/g, 'una'],
  [/\biamgen\b/g, 'imagen'],
  [/\bimajen\b/g, 'imagen'],
  [/\bimasgen\b/g, 'imagen'],
  [/\bimgen\b/g, 'imagen'],
  [/\boris[a-z]*ntal\b/g, 'horizontal'],
  [/\boriz[a-z]*ntal\b/g, 'horizontal'],
  [/\borizontal\w*/g, 'horizontal'],
  [/\bvertial\b/g, 'vertical'],
  [/\bvertica\b/g, 'vertical'],
  [/\bcmabia\b/g, 'cambia'],
  [/\bcanbia\b/g, 'cambia'],
  [/\bgenra\b/g, 'genera'],
  [/\bmimso\b/g, 'mismo'],
  [/\bseleciona\b/g, 'selecciona'],
  [/\bgeenracion\b/g, 'generacion'],
  [/\bimajenes\b/g, 'imagenes'],
  [/\bimagens\b/g, 'imagenes'],
  [/\bimgs?\b/g, 'imagenes'],
  [/\bfotoz\b/g, 'fotos'],
  [/\bfotografis\b/g, 'fotografias'],
  [/\bcuadarad[oa]\b/g, 'cuadrada'],
  [/\bcuadrad\b/g, 'cuadrada'],
  [/\bpostada\b/g, 'portada'],
  [/\bmuniatura\b/g, 'miniatura'],
  [/\bistagram\b/g, 'instagram'],
  [/\bfacebok\b/g, 'facebook'],
  [/\byutube\b/g, 'youtube'],
];

function canonicalizeImageTypos(normalizedText) {
  let out = ` ${String(normalizedText || '')} `;
  for (const [re, replacement] of TYPO_REPLACEMENTS) {
    out = out.replace(re, ` ${replacement} `);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function canonicalText(text) {
  return canonicalizeImageTypos(normalizeImageText(text));
}

/** Fix known chat typos inside an original-cased string (for prompts). */
function fixKnownTypos(originalText) {
  let out = String(originalText == null ? '' : originalText);
  for (const [re, replacement] of TYPO_REPLACEMENTS) {
    out = out.replace(new RegExp(re.source, 'gi'), replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ── Frames ────────────────────────────────────────────────────────────────

const IMAGE_FRAMES = {
  '1:1': { orientation: 'square', prompt: 'square 1:1 composition' },
  '2:3': { orientation: 'portrait', prompt: 'vertical 2:3 portrait composition' },
  '3:2': { orientation: 'landscape', prompt: 'horizontal 3:2 landscape composition' },
  '3:4': { orientation: 'portrait', prompt: 'vertical 3:4 portrait composition' },
  '4:3': { orientation: 'landscape', prompt: 'horizontal 4:3 composition' },
  '9:16': { orientation: 'portrait', prompt: 'story 9:16 vertical composition' },
  '16:9': { orientation: 'landscape', prompt: 'panoramic 16:9 cinematic composition' },
};

const TOOL_ORIENTATION_FOR_FRAME = {
  '1:1': 'square',
  '2:3': 'portrait',
  '3:4': 'portrait',
  '9:16': 'portrait',
  '3:2': 'wide',
  '4:3': 'wide',
  '16:9': 'wide',
};

/**
 * Frame lexicon — ONE ordered table, mirrored verbatim by the composer
 * (lib/chat/image-request-lexicon.ts) so the chip the user sees and the frame
 * the backend renders can never disagree. Tiers, first match wins:
 *   1. explicit ratio tokens              "16:9", "9x16"
 *   2. surface presets with a known ratio  story/reels → 9:16, portada de
 *                                          facebook → 16:9, pin → 2:3, A4 → 3:4…
 *   3. generic shape words                 vertical → 3:4, horizontal → 16:9,
 *                                          cuadrada → 1:1
 *   4. weak type defaults                  logo/avatar → 1:1, poster → 2:3,
 *                                          banner/portada → 16:9
 * A generic shape word therefore beats a type default ("poster horizontal"
 * → 16:9) but not a surface preset ("vertical para historia" → 9:16, which is
 * vertical anyway). Patterns run on canonicalised text (lowercase, accents
 * stripped, known typos fixed).
 */
const IMAGE_FRAME_LEXICON = [
  // ── tier 2: surface presets ──────────────────────────────────────────
  { tier: 2, frame: '9:16', id: 'story', pattern: '\\b(?:histori(?:a|as)|story|stories|reels?|tiktok|shorts?|estados? de whatsapp|whatsapp status|status de whatsapp|pantalla (?:completa )?(?:de )?(?:celular|movil|telefono)|fondo de pantalla (?:de |del |para )?(?:celular|movil|telefono|iphone|android)|wallpaper (?:de |del |para )?(?:celular|movil|telefono|iphone|android)|para (?:el )?(?:movil|celular)|formato movil|lock ?screen)\\b' },
  { tier: 2, frame: '16:9', id: 'cover-wide', pattern: '\\b(?:portadas? (?:de |para |del |de la )?(?:mi )?(?:pagina de |perfil de |canal de |grupo de )?(?:facebook|fb|linkedin|youtube|twitter|x)|(?:facebook|fb|linkedin|twitter|x) (?:cover|banner|header|portada|cabecera)|cover (?:de |para |photo (?:de |para )?)?(?:facebook|fb|linkedin|youtube|twitter)|banner (?:de |para )?(?:youtube|linkedin|twitter|x|facebook|fb|web|sitio|pagina)|cabecera (?:de |para )?(?:twitter|x|linkedin|facebook|youtube|web|pagina|blog)|miniaturas? (?:de |para )?(?:youtube|video|videos)|thumbnails? (?:de |para |for )?(?:youtube|video|videos)|youtube thumbnail|para youtube|portada (?:de |para )?(?:video|videos|blog|articulo|presentacion|diapositiva|slide)|fondo de pantalla (?:de |del |para )?(?:pc|escritorio|computadora|ordenador|laptop|monitor)|wallpaper (?:de |del |para )?(?:pc|escritorio|computadora|ordenador|laptop|monitor)|desktop wallpaper|presentacion|diapositiva|slide|pantalla (?:de )?(?:tv|television|monitor|pc)|formato (?:tv|television|cine|cinematografico|cine))\\b' },
  { tier: 2, frame: '1:1', id: 'square-surface', pattern: '\\b(?:posts? (?:de |para |cuadrad[oa]s? (?:de |para )?)?(?:instagram|ig|feed|facebook|fb|linkedin)|publicacion(?:es)? (?:de |para )?(?:instagram|ig|feed|facebook|fb|linkedin)|feed (?:de )?(?:instagram|ig)|fotos? de perfil|profile (?:picture|photo|pic)|avatar(?:es)?|pfp|icono(?:s)? de (?:app|aplicacion|apps)|app icon|favicon|portadas? (?:de |para )?(?:album|disco|cancion|playlist|spotify|podcast)|album cover)\\b' },
  { tier: 2, frame: '2:3', id: 'pin', pattern: '\\b(?:pin(?:es)? (?:de |para )?pinterest|pinterest|tarjetas? (?:de )?(?:visita|presentacion)|business cards?)\\b' },
  { tier: 2, frame: '3:4', id: 'paper-portrait', pattern: '\\b(?:(?:hoja|pagina|formato|tamano) ?(?:a4|carta|oficio|letter)(?: vertical)?|a4 vertical|carta vertical|folleto vertical|documento vertical|portrait a4)\\b' },
  { tier: 2, frame: '4:3', id: 'paper-landscape', pattern: '\\b(?:a4 horizontal|carta horizontal|hoja horizontal|pagina horizontal|formato (?:4:3|clasico)|pantalla (?:de )?(?:tablet|ipad)|ipad|tablet)\\b' },
  // ── tier 3: generic shape words ──────────────────────────────────────
  { tier: 3, frame: '1:1', id: 'square', pattern: '\\b(?:cuadrad[oa]s?|square|1 a 1|uno a uno|formato cuadrado)\\b' },
  { tier: 3, frame: '3:4', id: 'portrait', pattern: '\\b(?:vertical(?:es)?|verticalmente|retrato|portrait|mas alt[oa] que anch[oa]|de pie|en vertical|orientacion vertical|formato vertical)\\b' },
  { tier: 3, frame: '16:9', id: 'landscape', pattern: '\\b(?:horizontal(?:es)?|horizontalmente|apaisad[oa]s?|panoramic[oa]s?|landscape|widescreen|rectangular(?:es)?|mas anch[oa] que alt[oa]|en horizontal|orientacion horizontal|formato horizontal|cinematic[oa]|cinematografic[oa]|ultrawide|ancha)\\b' },
  // ── tier 4: weak type defaults ───────────────────────────────────────
  { tier: 4, frame: '1:1', id: 'square-type', pattern: '\\b(?:logos?|logotipos?|isotipos?|iconos?|icons?|stickers?|pegatinas?|emojis?|sellos?|insignias?|badges?)\\b' },
  { tier: 4, frame: '2:3', id: 'poster-type', pattern: '\\b(?:posters?|carteles?|cartel|afiches?|flyers?|volantes?|portadas? de (?:libro|novela|revista|ebook|cuento)|book covers?|tarjetas? (?:de )?(?:invitacion|cumpleanos|navidad|boda)|invitacion(?:es)?|menus? de restaurante)\\b' },
  { tier: 4, frame: '16:9', id: 'wide-type', pattern: '\\b(?:banners?|portadas?|covers?|cabeceras?|encabezados?|headers?|miniaturas?|thumbnails?|wallpapers?|fondos? de pantalla|paisajes?|panoramas?|escenas? (?:amplia|panoramica)s?)\\b' },
];

const IMAGE_FRAME_LEXICON_COMPILED = IMAGE_FRAME_LEXICON.map((entry) => ({
  ...entry,
  re: new RegExp(entry.pattern),
}));

const EXPLICIT_RATIO_COLON_RE = /\b(1:1|2:3|3:2|3:4|9:16|4:3|16:9)\b/;
const EXPLICIT_RATIO_CROSS_RE = /\b(1x1|2x3|3x2|3x4|9x16|4x3|16x9)\b/;
const EXPLICIT_RATIO_WORDS_RE = /\b(1|2|3|4|9|16)\s*(?:a|por|by|to)\s*(1|3|2|4|16|9)\b/;

/**
 * Detect an explicit frame / orientation in free text.
 * @returns {{frame: string, orientation: 'square'|'portrait'|'landscape', source: string}|null}
 */
function detectImageFrame(text) {
  const norm = canonicalText(text);
  if (!norm) return null;

  const colon = norm.match(EXPLICIT_RATIO_COLON_RE);
  if (colon) {
    const frame = colon[1];
    return { frame, orientation: IMAGE_FRAMES[frame].orientation, source: 'ratio' };
  }
  const cross = norm.match(EXPLICIT_RATIO_CROSS_RE);
  if (cross) {
    const frame = cross[1].replace('x', ':');
    return { frame, orientation: IMAGE_FRAMES[frame].orientation, source: 'ratio' };
  }
  const words = norm.match(EXPLICIT_RATIO_WORDS_RE);
  if (words) {
    const frame = `${words[1]}:${words[2]}`;
    if (IMAGE_FRAMES[frame]) return { frame, orientation: IMAGE_FRAMES[frame].orientation, source: 'ratio' };
  }

  for (const entry of IMAGE_FRAME_LEXICON_COMPILED) {
    if (entry.re.test(norm)) {
      return { frame: entry.frame, orientation: IMAGE_FRAMES[entry.frame].orientation, source: entry.id };
    }
  }

  return null;
}

// ── Quality ───────────────────────────────────────────────────────────────

function detectImageQuality(text) {
  const norm = canonicalText(text);
  if (!norm) return null;
  if (/\b(4k|ultra hd|ultra alta|calidad maxima|maxima calidad)\b/.test(norm)) return '4K';
  if (/\b(2k|hd|alta calidad|alta resolucion|alta definicion|high quality|muy nitid[oa]|super nitid[oa])\b/.test(norm)) return '2K';
  if (/\b(1k|calidad media|media calidad|standard|estandar)\b/.test(norm)) return '1K';
  if (/\b(512px|baja calidad|calidad baja|borrador|rapida|low)\b/.test(norm)) return '512px';
  return null;
}

function toolQualityFor(appQuality) {
  return appQuality === '2K' || appQuality === '4K' ? 'hd' : 'standard';
}

// ── Count ─────────────────────────────────────────────────────────────────

const COUNT_WORDS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1,
};

const IMAGE_COUNT_MAX = 5;

// Nouns that carry a count ("3 fotos", "dos logos", "cinco versiones").
const COUNT_NOUN_RE_FRAGMENT =
  '(?:imagen(?:es)?|fotos?|fotografias?|ilustracion(?:es)?|dibujos?|renders?|disenos?|propuestas?|alternativas?|version(?:es)?|variantes?|variacion(?:es)?|opcion(?:es)?|ejemplos?|muestras?|bocetos?|logos?|logotipos?|posters?|carteles?|afiches?|flyers?|banners?|miniaturas?|wallpapers?|retratos?|iconos?|stickers?|avatares?|portadas?|images?|pictures?|pics?|photos?|illustrations?|drawings?|designs?|versions?|variants?|variations?|options?|takes?|renders?|mockups?)';
// Adjectives allowed between the number and the noun ("3 nuevas fotos").
const COUNT_ADJ_RE_FRAGMENT =
  '(?:nuev[oa]s?|distint[oa]s?|diferentes|hermos[oa]s?|bonit[oa]s?|buen[oa]s?|posibles|pequen[oa]s?|grandes|otr[oa]s?|primer[oa]s?|mas|different|new|more|nice|good|possible|other|quick)';
const COUNT_NUMBER_RE_FRAGMENT =
  '(\\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten|a|an)';

const COUNT_EXPLICIT_RE = new RegExp(
  `\\b${COUNT_NUMBER_RE_FRAGMENT}\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b`,
);
// "imagenes x3", "3x", "x 3"
const COUNT_MULTIPLIER_RE = new RegExp(`\\b${COUNT_NOUN_RE_FRAGMENT}\\s*(?:x\\s*(\\d)|(\\d)\\s*x)\\b|\\b(?:x\\s*(\\d)|(\\d)\\s*x)\\s*${COUNT_NOUN_RE_FRAGMENT}\\b`);
const COUNT_SINGLE_MARKER_RE = new RegExp(
  `\\b(?:una sola|un solo|solo una|solo un|solamente una|solamente un|unicamente una|nada mas una|only one|just one|a single|one single|single)\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b|\\b${COUNT_NOUN_RE_FRAGMENT}\\s+(?:nada mas|solamente|unicamente|only)\\b`,
);
const COUNT_PAIR_RE = new RegExp(`\\b(?:un par|una pareja|a pair|a couple)(?: de| of)?\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b`);
const COUNT_HALF_DOZEN_RE = new RegExp(`\\b(?:media docena|half a dozen)(?: de| of)?\\s+${COUNT_NOUN_RE_FRAGMENT}\\b`);
const COUNT_SEVERAL_RE = new RegExp(`\\b(?:varias|varios|algunas|algunos|diferentes|distintas|distintos|multiples|several|multiple|a few|some|various)\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b`);
const COUNT_NOUN_PRESENT_RE = new RegExp(`\\b${COUNT_NOUN_RE_FRAGMENT}\\b`);

function wordToCount(token) {
  if (token == null) return null;
  const t = String(token).trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return Object.prototype.hasOwnProperty.call(COUNT_WORDS, t) ? COUNT_WORDS[t] : null;
}

function clampImageCount(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(IMAGE_COUNT_MAX, Math.max(1, Math.round(n)));
}

/**
 * How many images the user asked for, 1..5, or null when the text states no
 * quantity. Mirrored by the composer chip (lib/chat/image-request-lexicon.ts).
 *
 *   "3 imágenes", "tres fotos", "five pictures"      → 3 / 3 / 5
 *   "una imagen", "a picture", "una sola foto"        → 1  (explicit singular)
 *   "un par de imágenes"                              → 2
 *   "varias / algunas / several imágenes"             → 3
 *   "media docena", "12 imágenes"                     → 5  (picker ceiling)
 *   "la imagen del colibrí", "una imagen de 3 gatos"  → null / 1
 * Numbers only count when an image-like noun follows them, so "3 gatos" or
 * "2 horas" never turn into a quantity.
 */
function detectExplicitImageCount(text) {
  const norm = canonicalText(text);
  if (!norm || !COUNT_NOUN_PRESENT_RE.test(norm)) return null;

  const single = COUNT_SINGLE_MARKER_RE.test(norm);
  if (single) return 1;
  if (COUNT_HALF_DOZEN_RE.test(norm)) return IMAGE_COUNT_MAX;
  if (COUNT_PAIR_RE.test(norm)) return 2;

  const multiplier = norm.match(COUNT_MULTIPLIER_RE);
  if (multiplier) {
    const raw = multiplier.slice(1).find((g) => g != null);
    const n = clampImageCount(Number(raw));
    if (n) return n;
  }

  const explicit = norm.match(COUNT_EXPLICIT_RE);
  if (explicit) {
    const n = clampImageCount(wordToCount(explicit[1]));
    if (n) return n;
  }

  if (COUNT_SEVERAL_RE.test(norm)) return 3;
  return null;
}

/**
 * Legacy contract kept for the agent tools: only counts ABOVE 1 drive
 * multi-image behaviour; a singular ("una imagen") reads as "no plurality".
 */
function detectImageCount(text) {
  const n = detectExplicitImageCount(text);
  return n != null && n > 1 ? n : null;
}

// ── Style + image type ────────────────────────────────────────────────────

const STYLE_KEYWORDS = [
  ['realistic', /\b(realista|realist|fotorrealista|fotorealista|hiperrealista|photorealistic)\b/],
  ['photographic', /\b(fotografic[oa]|fotografia|photographic|photo style)\b/],
  ['anime', /\b(anime|manga|cel shaded)\b/],
  ['digital-art', /\b(arte digital|digital art|render 3d|\b3d\b|ilustracion digital)\b/],
  ['oil-painting', /\b(oleo|oil painting|pintura al oleo)\b/],
  ['line-art', /\b(line art|boceto|sketch|dibujo a lapiz|tinta)\b/],
  ['natural', /\b(natural|luz natural|estilo natural)\b/],
];

/** Map free text to one of the generate_image style keys, or null. */
function detectImageStyle(text) {
  const norm = canonicalText(text);
  if (!norm) return null;
  for (const [key, re] of STYLE_KEYWORDS) {
    if (re.test(norm)) return key;
  }
  return null;
}

const IMAGE_TYPES = [
  ['photo', /\b(foto(?:s|grafia)?s?|photograph|photo)\b/, 'photograph'],
  ['illustration', /\b(ilustracion(?:es)?|illustration)\b/, 'detailed illustration'],
  ['drawing', /\b(dibujo(?:s)?|drawing)\b/, 'clean drawing'],
  ['logo', /\b(logos?|logotipos?)\b/, 'minimal logo design, vector style, centered, no background clutter'],
  ['poster', /\b(posters?|cartel(?:es)?|flyers?|afiches?)\b/, 'poster composition with a bold layout'],
  ['portrait', /\b(retrato(?:s)?)\b/, 'portrait'],
  ['landscape', /\b(paisaje(?:s)?)\b/, 'landscape scene'],
  ['avatar', /\b(avatar(?:es)?|foto de perfil)\b/, 'centered avatar portrait'],
  ['sticker', /\b(stickers?|pegatinas?)\b/, 'die-cut sticker with a thick white outline'],
  ['wallpaper', /\b(wallpapers?|fondo de pantalla)\b/, 'wallpaper composition, no text'],
  ['cover', /\b(portada(?:s)?|cover|banner|banners|cabecera|miniatura|thumbnail)\b/, 'wide cover composition with space for a title'],
];

/** Detect the kind of visual requested (logo, poster, photo, …). */
function detectImageType(text) {
  const norm = canonicalText(text);
  if (!norm) return null;
  for (const [type, re, descriptor] of IMAGE_TYPES) {
    if (re.test(norm)) return { type, descriptor };
  }
  return null;
}

// ── Command stripping (keeps the original casing / accents) ──────────────

const COMMAND_POLITE = new Set(['por', 'favor', 'porfa', 'please']);
const COMMAND_ADDRESS = new Set(['oye', 'sira', 'siragpt']);
const COMMAND_VERBS = new Set([
  'dame', 'deme', 'crea', 'creame', 'genera', 'generame', 'haz', 'hazme',
  'disena', 'disename', 'dibuja', 'dibujame', 'quiero', 'necesito', 'pon',
  'ponme', 'prepara', 'preparame', 'elabora', 'elaborame', 'make', 'create', 'generate',
]);
const COMMAND_ARTICLES = new Set(['una', 'un', 'unas', 'unos', 'la', 'el', 'las', 'los', 'esta', 'este', 'esto']);
const COMMAND_NOUNS = new Set([
  'imagen', 'imagenes', 'foto', 'fotos', 'fotografia', 'ilustracion', 'ilustraciones',
  'dibujo', 'dibujos', 'logo', 'poster', 'image', 'images', 'photo', 'photos', 'picture',
]);
const COMMAND_PREPS = new Set(['de', 'del', 'sobre', 'acerca', 'con', 'que', 'sea', 'muestre']);

const EDIT_PREFIX_SKIPS = new Set(['en', 'de', 'sobre', 'la', 'esta', 'este', 'esto', 'esa', 'ese', 'the', 'this', 'that']);

// Compare tokens ignoring surrounding punctuation ("favor," → "favor") so
// the word alignment with the original text survives chat punctuation.
function tokenKey(word) {
  return String(word || '').replace(/^[^a-z0-9:]+|[^a-z0-9:]+$/g, '');
}

function splitWords(text) {
  return String(text || '').split(/\s+/).filter(Boolean);
}

/**
 * Remove a leading spoken command wrapper ("dame una imagen de …",
 * "por favor créame una foto …") while preserving the original casing and
 * accents of the remaining visual description.
 */
function stripImageCommand(originalText) {
  const original = String(originalText == null ? '' : originalText).trim();
  if (!original) return '';
  const canon = canonicalText(original);
  const origWords = splitWords(original);
  const canonWords = splitWords(canon).map(tokenKey);
  if (!origWords.length || origWords.length !== canonWords.length) return original;

  let i = 0;
  const take = (set) => {
    if (i < canonWords.length && set.has(canonWords[i])) {
      i += 1;
      return true;
    }
    return false;
  };

  // Optional politeness / address: "por favor", "oye sira,".
  while (take(COMMAND_POLITE) || take(COMMAND_ADDRESS)) { /* consume */ }
  // One command verb is required for this to be a wrapper.
  if (!take(COMMAND_VERBS)) return original;
  // Allow a trailing "que + verb" form ("quiero que me crees" is rare).
  if (canonWords[i] === 'que' && COMMAND_VERBS.has(canonWords[i + 1])) {
    i += 2;
  }
  take(COMMAND_ARTICLES);
  take(COMMAND_NOUNS);
  take(COMMAND_PREPS);

  if (i <= 0 || i >= origWords.length) return original;
  return origWords.slice(i).join(' ').trim() || original;
}

/** Remove a leading existing-image reference for edits ("en la imagen …"). */
function stripEditPrefix(originalText) {
  const original = String(originalText == null ? '' : originalText).trim();
  if (!original) return '';
  const canon = canonicalText(original);
  const origWords = splitWords(original);
  const canonWords = splitWords(canon).map(tokenKey);
  if (!origWords.length || origWords.length !== canonWords.length) return original;

  let i = 0;
  while (i < canonWords.length && EDIT_PREFIX_SKIPS.has(canonWords[i])) i += 1;
  if (i > 0 && i < canonWords.length && COMMAND_NOUNS.has(canonWords[i])) {
    i += 1;
    const rest = origWords.slice(i).join(' ').trim();
    return rest || original;
  }
  return original;
}

// ── Edit parsing ──────────────────────────────────────────────────────────

const EDIT_OPERATION_PATTERNS = [
  ['remove-background', /\b(quit(?:a|ale|ar|emos)|elimin(?:a|ale|ar)|borr(?:a|ale|ar)|remove|erase)\b.{0,24}\b(fondo|background)\b|\bsin fondo\b|\bbackground removal\b/],
  ['remove', /\b(quit(?:a|ale|ar|emos)|elimin(?:a|ale|ar)|borr(?:a|ale|ar)|remove|erase|delete)\b/],
  ['add', /\b(agreg(?:a|ale|ar|ame)|anad(?:e|ele|ir)|add|incluy(?:e|a)|suma(?:le)?|ponle)\b/],
  ['change', /\b(cambi(?:a|ale|ar|emos)|modific(?:a|ame|ar)|conviert(?:e|elo|ela)|transforma|haz(?:la|lo|me)?|vuelv(?:e|elo|ela)|pon|change|modify|turn into|make it)\b/],
  ['recolor', /\b(colore(?:a|ar)|pint(?:a|alo|ala|ar)|tin(?:e|ta)|recolor|colorize)\b/],
  ['restyle', /\b(estilo|style|restyle|filtros?|blanco y negro|blanco-y-negro|vintage|cinematic[oa])\b/],
  ['retouch', /\b(retoc(?:a|ame|ar)|mejor(?:a|ame|ar)|restaur(?:a|ame|ar)|retouch|enhance|improve|upscal|escal(?:a|ar)|aclar(?:a|ar)|oscurec(?:e|er)|nitidez)\b/],
  ['crop', /\b(recort(?:a|ame|ar)|encuadr(?:a|ar)|crop|reframe)\b/],
  ['rotate', /\b(volte(?:a|ar)|gir(?:a|ar)|rot(?:a|ar)|flip|rotate)\b/],
];

const WHOLE_IMAGE_TARGET = /^(la|esta|este|esto|esa|ese|aquella|the|this|that)\s+(imagen|imagenes|foto|fotos|fotografia|ilustracion|dibujo|images?|photos?|pictures?)$/;

function cleanTargetPhrase(phrase) {
  return String(phrase || '')
    .replace(/^[“"‘'(\[]+/, '')
    .replace(/[”"’'().,;:!\]?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Parse a natural-language edit into { operation, target, replacement, scope }.
 * Scope is 'target-only' when the user says "solo …" / "only …", 'target'
 * when a target was found without an exclusivity marker, and 'whole' for
 * global operations with no detectable target.
 */
function parseImageEdit(text) {
  const stripped = stripEditPrefix(text);
  const norm = canonicalText(stripped);
  if (!norm) return { operation: null, target: null, replacement: null, scope: 'whole', confidence: 'low' };

  let operation = null;
  for (const [name, re] of EDIT_OPERATION_PATTERNS) {
    if (re.test(norm)) {
      operation = name;
      break;
    }
  }
  if (!operation) return { operation: null, target: null, replacement: null, scope: 'whole', confidence: 'low' };

  const onlyScope = /\b(solo|solamente|unicamente|exclusivamente|only|just)\b/.test(norm);

  // Replacement: the phrase after a / en / por / con / to / into / with.
  let replacement = null;
  const replacementMatch = norm.match(/\b(?:a|en|por|con|como|to|into|with)\s+([a-z0-9][a-z0-9\s'&\-.,]{1,80})$/);
  if (replacementMatch && !/^(la imagen|esta foto|the image)\b/.test(replacementMatch[1])) {
    replacement = cleanTargetPhrase(replacementMatch[1]);
  }

  // Target: noun phrase right after the operation verb, up to the
  // replacement preposition or the end of the sentence. Verb stems consume
  // their inflection AND attached clitics ("quítale" → "quita"+"le",
  // "cámbiale" → "cambia"+"le", "ponle" → "pon"+"le").
  let target = null;
  const verbMatch = norm.match(/\b(quit|elimin|borr|agreg|anad|incluy|cambi|modific|convirt|transform|color|pint|retoc|mejor|restaur|recort|encuadr|volt|gir|rot|pon|haz|vuelv|aclar|oscurec|escal|remove|eras|delet|add|chang|modif|make|turn|recolor|retouch|enhanc|upscal|crop)[a-z]*\s*(solo|solamente|unicamente|only|just)?\s*([a-z0-9][a-z0-9\s'&\-]{1,60}?)(?=\s+(?:a|en|por|con|como|to|into|with|de la imagen|de esta foto)\b|$)/);
  if (verbMatch) {
    const candidate = cleanTargetPhrase(verbMatch[3] || verbMatch[2]);
    if (candidate && !WHOLE_IMAGE_TARGET.test(candidate) && candidate !== 'fondo' && candidate !== 'background') {
      target = candidate;
    } else if (operation === 'remove-background') {
      target = 'el fondo';
    }
  }

  if (operation === 'remove-background' && !target) target = 'el fondo';

  const scope = onlyScope ? 'target-only' : (target ? 'target' : 'whole');
  return {
    operation,
    target,
    replacement: replacement || null,
    scope,
    confidence: target || replacement ? 'high' : 'medium',
  };
}

// ── Selection normalisation ───────────────────────────────────────────────

const NAMED_REGIONS = {
  'top-left': { x: 0, y: 0, width: 50, height: 50 },
  'top-right': { x: 50, y: 0, width: 50, height: 50 },
  'bottom-left': { x: 0, y: 50, width: 50, height: 50 },
  'bottom-right': { x: 50, y: 50, width: 50, height: 50 },
  top: { x: 0, y: 0, width: 100, height: 50 },
  bottom: { x: 0, y: 50, width: 100, height: 50 },
  left: { x: 0, y: 0, width: 50, height: 100 },
  right: { x: 50, y: 0, width: 50, height: 100 },
  center: { x: 25, y: 25, width: 50, height: 50 },
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

function normalizeBoxNumbers(box) {
  if (!box || typeof box !== 'object') return null;
  const x = Number(box.x ?? box.left);
  const y = Number(box.y ?? box.top);
  const width = Number(box.width ?? box.w);
  const height = Number(box.height ?? box.h);
  if (![x, y, width, height].every(Number.isFinite)) return null;

  // Accept fractions (0..1) or percentages (0..100). A box is read as
  // fractions when every value fits in [0,1] and at least one value is a
  // non-integer — plus the {0,0,1,1} full-frame shorthand. Anything else
  // (e.g. {0,0,100,40}) is percentages.
  const inUnitRange = [x, y, width, height].every((n) => n >= 0 && n <= 1);
  const hasFraction = [x, y, width, height].some((n) => !Number.isInteger(n));
  const isFullFrame = x === 0 && y === 0 && width === 1 && height === 1;
  const scale = inUnitRange && (hasFraction || isFullFrame) ? 100 : 1;
  const nx = x * scale;
  const ny = y * scale;
  const nw = width * scale;
  const nh = height * scale;
  if (nx < 0 || ny < 0 || nw <= 0 || nh <= 0) return null;
  if (nx > 100 || ny > 100 || nx + nw > 100.001 || ny + nh > 100.001) return null;
  return { x: round1(nx), y: round1(ny), width: round1(nw), height: round1(nh) };
}

/**
 * Normalise a user selection into a provider-safe contract.
 * Accepts boxes (fractions or 0..100 percentages), named regions
 * ("top-left", "center", …), labels ("el cielo") and mask refs.
 * Returns { ok:true, selection } or { ok:false, error }.
 */
function normalizeImageSelection(selection) {
  if (selection == null) return { ok: false, error: 'empty selection' };
  if (typeof selection === 'string') {
    const label = selection.trim().slice(0, 80);
    if (!label) return { ok: false, error: 'empty selection label' };
    if (Object.prototype.hasOwnProperty.call(NAMED_REGIONS, label.toLowerCase())) {
      return { ok: true, selection: { kind: 'box', ...NAMED_REGIONS[label.toLowerCase()], label } };
    }
    return { ok: true, selection: { kind: 'label', label } };
  }
  if (typeof selection !== 'object') return { ok: false, error: 'unsupported selection' };

  const kind = String(selection.kind || '').toLowerCase();
  if ((!kind || kind === 'box') && (selection.x !== undefined || selection.left !== undefined || selection.box)) {
    const box = normalizeBoxNumbers(selection.box || selection);
    if (!box) return { ok: false, error: 'invalid box selection' };
    const out = { kind: 'box', ...box };
    if (typeof selection.label === 'string' && selection.label.trim()) out.label = selection.label.trim().slice(0, 80);
    return { ok: true, selection: out };
  }
  if (kind === 'region' || (!kind && typeof selection.region === 'string')) {
    const name = String(selection.region || selection.label || '').toLowerCase().trim();
    if (!Object.prototype.hasOwnProperty.call(NAMED_REGIONS, name)) return { ok: false, error: 'unknown region' };
    return { ok: true, selection: { kind: 'box', ...NAMED_REGIONS[name], label: name } };
  }
  if (kind === 'label') {
    const label = String(selection.label || '').trim().slice(0, 80);
    if (!label) return { ok: false, error: 'empty selection label' };
    return { ok: true, selection: { kind: 'label', label } };
  }
  if (kind === 'mask') {
    const ref = String(selection.ref || selection.maskId || '').trim().slice(0, 200);
    if (!ref) return { ok: false, error: 'empty mask reference' };
    return { ok: true, selection: { kind: 'mask', ref } };
  }
  return { ok: false, error: 'unsupported selection' };
}

function selectionClause(selection, language) {
  if (!selection) return '';
  const en = language === 'en';
  if (selection.kind === 'box') {
    const where = `x=${selection.x}, y=${selection.y}, width=${selection.width}, height=${selection.height} (percent 0-100, origin top-left)`;
    const what = selection.label ? ` ("${selection.label}")` : '';
    return en
      ? ` Apply the edit ONLY inside the selected region${what} at ${where}; do not modify anything outside that region.`
      : ` Aplica la edición SOLO dentro de la región seleccionada${what} en ${where}; no modifiques nada fuera de esa región.`;
  }
  if (selection.kind === 'label') {
    return en
      ? ` Apply the edit only to "${selection.label}"; keep everything else exactly the same.`
      : ` Aplica la edición solo en "${selection.label}"; conserva todo lo demás exactamente igual.`;
  }
  if (selection.kind === 'mask') {
    return en
      ? ' Apply the edit only inside the provided mask; keep everything outside the mask pixel-identical.'
      : ' Aplica la edición solo dentro de la máscara proporcionada; conserva todo lo que quede fuera píxel por píxel.';
  }
  return '';
}

function pickEditLanguage(instruction) {
  const norm = canonicalText(instruction);
  const spanish = /\b(el|la|los|las|una|para|cambia|quita|fondo|cielo|imagen|foto|haz|pon)\b/.test(norm);
  if (spanish) return 'es';
  const english = /\b(the|this|that|remove|change|background|image|photo|make)\b/.test(norm);
  return english ? 'en' : 'es';
}

// ── Public resolvers ──────────────────────────────────────────────────────

/**
 * Resolve a free-text generation request. Explicit overrides always win;
 * spoken context fills the gaps.
 */
function resolveGenerationDirective(text, overrides = {}) {
  const original = String(text == null ? '' : text).trim();
  const frame = detectImageFrame(original);
  const qualityApp = detectImageQuality(original);
  const count = detectImageCount(original);
  const styleKey = detectImageStyle(original);
  const type = detectImageType(original);
  const cleaned = fixKnownTypos(stripImageCommand(original) || original);

  const coerceOrientation = (value) => {
    const v = String(value || '').trim().toLowerCase();
    if (['square', 'wide', 'portrait'].includes(v)) return v;
    if (v === 'landscape' || v === 'horizontal') return 'wide';
    if (v === 'vertical') return 'portrait';
    if (Object.prototype.hasOwnProperty.call(TOOL_ORIENTATION_FOR_FRAME, v)) return TOOL_ORIENTATION_FOR_FRAME[v];
    return null;
  };

  const aspectRatio = coerceOrientation(overrides.aspectRatio)
    || (frame ? TOOL_ORIENTATION_FOR_FRAME[frame.frame] : null)
    || 'square';

  const qualityOverride = String(overrides.quality || '').trim();
  const quality = ['standard', 'hd'].includes(qualityOverride.toLowerCase())
    ? qualityOverride.toLowerCase()
    : toolQualityFor(qualityApp || '2K');

  const styleOverride = String(overrides.style || '').trim();
  const style = styleOverride || styleKey || 'vivid';

  const parts = [cleaned];
  if (type && !canonicalText(cleaned).includes(type.type)) parts.push(type.descriptor);
  if (frame) parts.push(`Image framing requirement: ${IMAGE_FRAMES[frame.frame].prompt}.`);
  const prompt = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || original;

  return {
    prompt,
    subject: cleaned,
    style,
    aspectRatio,
    quality,
    frame: frame ? frame.frame : null,
    orientation: frame ? frame.orientation : null,
    qualityApp,
    count: Number.isInteger(overrides.count) && overrides.count >= 1
      ? Math.min(5, overrides.count)
      : (count || 1),
    imageType: type ? type.type : null,
  };
}

/**
 * Resolve a free-text edit into a provider-safe instruction that keeps the
 * change scoped (explicit target / selection wins, spoken target otherwise).
 */
function resolveEditDirective(instruction, opts = {}) {
  const original = String(instruction == null ? '' : instruction).trim();
  const parsed = parseImageEdit(original);
  const explicitTarget = String(opts.target || '').trim();
  const target = (explicitTarget || parsed.target || '').slice(0, 120) || null;

  let selection = null;
  if (opts.selection !== undefined && opts.selection !== null) {
    const normalized = normalizeImageSelection(opts.selection);
    if (normalized.ok) selection = normalized.selection;
  }

  const language = pickEditLanguage(original);
  let prompt = original;
  if (target && parsed.operation !== 'remove-background') {
    prompt += language === 'en'
      ? ` Focus the change on ${target}; keep the rest of the image exactly the same (composition, colors, background, lighting and all other elements).`
      : ` Enfoca el cambio en ${target}; conserva el resto de la imagen exactamente igual (composición, colores, fondo, iluminación y todos los demás elementos).`;
  } else if (parsed.operation === 'remove-background') {
    prompt += language === 'en'
      ? ' Remove the background completely and keep the main subject unchanged.'
      : ' Quita el fondo por completo y conserva el sujeto principal sin cambios.';
  }
  prompt += selectionClause(selection, language);
  prompt = prompt.replace(/\s+/g, ' ').trim().slice(0, 4000) || original;

  return {
    prompt,
    instruction: original,
    operation: parsed.operation,
    target,
    replacement: parsed.replacement,
    scope: selection ? 'selection' : parsed.scope,
    selection,
    confidence: parsed.confidence,
  };
}

module.exports = {
  IMAGE_FRAMES,
  IMAGE_FRAME_LEXICON,
  IMAGE_COUNT_MAX,
  // Exposed for the composer parity test (lib/chat/image-request-lexicon.ts
  // must hold the very same tables).
  COUNT_LEXICON: Object.freeze({
    noun: COUNT_NOUN_RE_FRAGMENT,
    adjective: COUNT_ADJ_RE_FRAGMENT,
    number: COUNT_NUMBER_RE_FRAGMENT,
  }),
  TYPO_REPLACEMENTS,
  detectExplicitImageCount,
  normalizeImageText,
  canonicalizeImageTypos,
  fixKnownTypos,
  detectImageFrame,
  detectImageQuality,
  toolQualityFor,
  detectImageCount,
  detectImageStyle,
  detectImageType,
  stripImageCommand,
  stripEditPrefix,
  parseImageEdit,
  normalizeImageSelection,
  resolveGenerationDirective,
  resolveEditDirective,
};
