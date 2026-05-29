'use strict';

/**
 * media-intent — deterministic, bilingual (ES/EN) detector that maps a
 * chat message to a concrete media-generation INTENT and extracts the
 * SPECS the user stated in natural language.
 *
 * Product goal: when a user types in the chat bar things like
 *   - "créame una imagen de un gato astronauta, estilo realista, vertical"
 *   - "hazme un video de 15 segundos en formato 9:16, cinematográfico"
 *   - "necesito un audio narrando este texto"
 *   - "genérame una canción de 3 minutos estilo lofi"
 * the agentic runtime should (a) load + call the RIGHT tool and (b) call
 * it with the parameters the user already gave — without the user having
 * to pick a tool manually in the UI.
 *
 * This module is PURE and dependency-free so it runs on the hot path of
 * every create-type chat turn and is unit-testable in isolation. It does
 * NOT call any model. It produces a high-confidence hint that biases the
 * agent's tool choice and pre-fills the parameters extracted from the
 * prompt. The agent still owns the final tool call, so a missed spec only
 * degrades to the tool's own default — never to a wrong deliverable.
 *
 * Design notes:
 * - Recall over precision: a missed media request means the user gets text
 *   instead of the asset they asked for, which defeats the feature. A loose
 *   match merely loads a few extra tools, which the agent ignores.
 * - Detection priority is VIDEO → MUSIC → AUDIO → IMAGE. Video wins over
 *   music so "video musical" / "videoclip" routes to the video tool; music
 *   wins over the generic "audio" noun so "audio de una canción" is a song.
 */

// ── Text normalisation (accent + case insensitive) ───────────────────────

function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // strip combining diacritics
}

// ── Media-kind lexicons (matched against the normalised text) ────────────
// Word-boundary anchored so "video" does not fire on "videojuego" and
// "foto" does not fire on "fotosintesis".

const VIDEO_NOUNS = /\b(videos?|videoclips?|clips?|reels?|cortometrajes?|animaciones?|animacion|metraje|trailer|teaser)\b/;
const MUSIC_NOUNS = /\b(canciones?|cancion|musica|music|melodi(?:a|as)|instrumental(?:es)?|soundtracks?|banda sonora|jingles?|tema musical|temas musicales|beats?|songs?|tune)\b/;
const AUDIO_NOUNS = /\b(audios?|voz|voces|narracion(?:es)?|narra|locucion(?:es)?|podcasts?|voiceover|voice over|audiolibros?|dictado|tts|speech|doblaje|voz en off)\b/;
const IMAGE_NOUNS = /\b(imagen(?:es)?|imagenes|fotos?|fotografias?|fotografia|ilustracion(?:es)?|ilustracion|dibujos?|logos?|logotipos?|posters?|afiches?|renders?|retratos?|wallpapers?|fondo de pantalla|pinturas?|stickers?|avatares?|avatar|iconos?|portadas?|images?|image|photos?|pictures?|drawings?|illustrations?|artwork)\b/;

// A create / transform verb makes the intent unambiguous. Bilingual stems.
const CREATE_VERB = /\b(cr[ée]a(?:me|r|las?|los?)?|cre[ée]me|gener(?:a|ame|ar|en?|alas?)|haz(?:me|melo|lo|los|las)?|hag(?:a|ame|amos)|elabor(?:a|ame|ar)|dibuj(?:a|ame|ar)|dise[nñ](?:a|ame|ar|o)|compon(?:e|me|er|gas)|produce|produce?me|prepar(?:a|ame)|construy(?:e|eme)|quiero|necesito|dame|ponme|pon|crea\b|make|create|generate|draw|compose|produce|design|build|render|i want|i need|give me)\b/;

// ── Word-number maps (ES + EN), common values only ───────────────────────

const WORD_NUMBERS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  noventa: 90, ciento: 100, cien: 100,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
};

const NUM_TOKEN =
  '(?:\\d+(?:[.,]\\d+)?|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|noventa|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)';

function tokenToNumber(tok) {
  if (tok == null) return null;
  const t = String(tok).trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
  return Object.prototype.hasOwnProperty.call(WORD_NUMBERS, t) ? WORD_NUMBERS[t] : null;
}

const HARD_MAX_SECONDS = 3600; // 1h ceiling — callers clamp tighter per tool.

/**
 * Parse a duration expressed in natural language into seconds.
 * Understands: "3 minutos", "30 segundos", "2 min y 30 seg", "1:30",
 * "minuto y medio", "media hora", "dos minutos", "90s".
 * @returns {number|null} seconds, or null when no duration is stated.
 */
function parseDurationSeconds(normText) {
  // Strip common aspect-ratio tokens first so "9:16" / "16:9" are NOT
  // misread as MM:SS clock durations (9:16 → 556s would be wrong).
  const t = normText.replace(/\b(?:16:9|9:16|4:3|3:4|21:9|1:1|2:1|3:2|4:5|5:4)\b/g, ' ');

  // Clock form MM:SS (e.g. "1:30", "03:00").
  const clock = t.match(/\b(\d{1,3}):([0-5]\d)\b/);
  if (clock) {
    return Math.min(parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10), HARD_MAX_SECONDS);
  }

  let total = 0;
  let found = false;

  // Idiomatic fractions.
  if (/\bminuto y medio\b/.test(normText)) { total += 90; found = true; }
  if (/\bmedio minuto\b/.test(normText)) { total += 30; found = true; }
  if (/\bmedia hora\b/.test(normText)) { total += 1800; found = true; }
  if (/\bhora y media\b/.test(normText)) { total += 5400; found = true; }

  // Hours.
  const hoursRe = new RegExp(NUM_TOKEN + '\\s*(?:horas?|hrs?)\\b', 'g');
  for (const m of t.matchAll(hoursRe)) {
    const n = tokenToNumber(m[0].replace(/\s*(?:horas?|hrs?)\b/, '').trim());
    if (n != null) { total += n * 3600; found = true; }
  }

  // Minutes.
  const minRe = new RegExp(NUM_TOKEN + '\\s*(?:minutos?|mins?)\\b', 'g');
  for (const m of t.matchAll(minRe)) {
    const n = tokenToNumber(m[0].replace(/\s*(?:minutos?|mins?)\b/, '').trim());
    if (n != null) { total += n * 60; found = true; }
  }

  // Seconds.
  const secRe = new RegExp(NUM_TOKEN + '\\s*(?:segundos?|segs?|seconds?|secs?)\\b', 'g');
  for (const m of t.matchAll(secRe)) {
    const n = tokenToNumber(m[0].replace(/\s*(?:segundos?|segs?|seconds?|secs?)\b/, '').trim());
    if (n != null) { total += n; found = true; }
  }

  if (!found || total <= 0) return null;
  return Math.min(Math.round(total), HARD_MAX_SECONDS);
}

/**
 * Detect a requested aspect ratio / orientation.
 * @returns {'vertical'|'horizontal'|'square'|null}
 */
function detectOrientation(normText) {
  if (/\b(9:16|9x16|vertical|retrato|portrait|tiktok|reels?|histori(?:a|as)|story|stories|para movil|formato movil)\b/.test(normText)) return 'vertical';
  if (/\b(16:9|16x9|horizontal|apaisad[oa]|panoramic[oa]|landscape|widescreen|para youtube)\b/.test(normText)) return 'horizontal';
  if (/\b(1:1|1x1|cuadrad[oa]|square|post de instagram)\b/.test(normText)) return 'square';
  if (/\b(4:3)\b/.test(normText)) return 'standard';
  return null;
}

const ORIENTATION_TO_IMAGE = { vertical: 'portrait', horizontal: 'wide', square: 'square', standard: 'square' };
const ORIENTATION_TO_VIDEO = { vertical: '9:16', horizontal: '16:9', square: '1:1', standard: '4:3' };

/** Count of images requested ("5 imágenes", "tres fotos"). 1..10 or null. */
function detectImageCount(normText) {
  const re = new RegExp('(' + NUM_TOKEN + ')\\s*(?:imagen(?:es)?|imagenes|fotos?|fotografias?|ilustraciones?|images?|pictures?|variaciones?|versiones?)\\b', 'g');
  let best = null;
  for (const m of normText.matchAll(re)) {
    const n = tokenToNumber(m[1]);
    if (n != null && n >= 1) best = Math.min(Math.round(n), 10);
  }
  return best;
}

/** High-quality / HD hint. */
function detectHighQuality(normText) {
  return /\b(hd|alta calidad|alta resolucion|alta definicion|4k|2k|high quality|ultra|maxima calidad|nitid[oa])\b/.test(normText);
}

// Known style / genre tokens worth surfacing verbatim into the hint.
const STYLE_TOKENS = [
  // image / video styles
  'realista', 'realistic', 'fotorrealista', 'photorealistic', 'anime', 'cartoon',
  'caricatura', 'oleo', 'oil painting', 'acuarela', 'watercolor', 'pixel art',
  'minimalista', 'minimalist', 'line art', 'sketch', 'boceto', '3d', '3d render',
  'cinematografic', 'cinematic', 'vintage', 'retro', 'ciberpunk', 'cyberpunk',
  'abstracto', 'abstract', 'acrilico', 'comic', 'claymation', 'animado', 'animated',
  // music genres / moods
  'lofi', 'lo-fi', 'rock', 'pop', 'jazz', 'clasica', 'classical', 'electronica',
  'electronic', 'reggaeton', 'rap', 'hip hop', 'hip-hop', 'trap', 'salsa', 'cumbia',
  'bachata', 'ambient', 'cinematic', 'epica', 'epic', 'relajante', 'chill',
  'instrumental', 'orquestal', 'orchestral', 'blues', 'metal', 'country', 'folk',
  'r&b', 'funk', 'house', 'techno', 'edm', 'corrido', 'mariachi', 'bolero',
];

/** Best-effort style/genre string from "estilo X" / "style X" / known tokens. */
function detectStyle(normText) {
  const explicit = normText.match(/\b(?:estilo|style|tipo|genero|genre|al estilo de|tono)\s+(?:de\s+)?([a-z0-9'&\- ]{2,40})/);
  if (explicit) {
    const cleaned = explicit[1].trim().split(/\s*(?:,|\.|;| y | con | en | para | de\b)/)[0].trim();
    if (cleaned.length >= 2) return cleaned;
  }
  // Leading boundary + optional ES inflection so stems match real forms
  // ("cinematografic" → "cinematografico", "epica" → "epicas").
  const hits = STYLE_TOKENS.filter((tok) => {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + esc + '(?:s|es|o|a|os|as|co|ca|cos|cas)?\\b').test(normText);
  });
  return hits.length ? hits.join(', ') : null;
}

const KIND_TO_TOOL = {
  image: 'generate_image',
  video: 'generate_video',
  audio: 'generate_speech',
  music: 'generate_music',
};

/**
 * Detect which media kind the user is asking the assistant to create and
 * the specs they stated.
 *
 * @param {string} text raw user message
 * @returns {{
 *   kind: 'image'|'video'|'audio'|'music'|null,
 *   tool: string|null,
 *   confidence: 'high'|'medium'|'low',
 *   hasCreateVerb: boolean,
 *   specs: object,
 *   reason: string,
 * }}
 */
function detectMediaIntent(text) {
  const empty = { kind: null, tool: null, confidence: 'low', hasCreateVerb: false, specs: {}, reason: 'no-media-noun' };
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return empty;

  const norm = normalize(raw);

  let kind = null;
  if (VIDEO_NOUNS.test(norm)) kind = 'video';
  else if (MUSIC_NOUNS.test(norm)) kind = 'music';
  else if (AUDIO_NOUNS.test(norm)) kind = 'audio';
  else if (IMAGE_NOUNS.test(norm)) kind = 'image';

  if (!kind) return empty;

  const hasCreateVerb = CREATE_VERB.test(norm);
  const durationSeconds = parseDurationSeconds(norm);
  const orientation = detectOrientation(norm);
  const style = detectStyle(norm);
  const hd = detectHighQuality(norm);

  const specs = {};
  if (kind === 'image') {
    if (orientation) specs.aspectRatio = ORIENTATION_TO_IMAGE[orientation] || 'square';
    if (hd) specs.quality = 'hd';
    const count = detectImageCount(norm);
    if (count && count > 1) specs.count = count;
    if (style) specs.style = style;
  } else if (kind === 'video') {
    if (durationSeconds) specs.durationSeconds = durationSeconds;
    if (orientation) specs.aspectRatio = ORIENTATION_TO_VIDEO[orientation] || '16:9';
    if (style) specs.style = style;
  } else if (kind === 'audio') {
    if (durationSeconds) specs.durationSeconds = durationSeconds;
    // language hint for narration
    if (/\b(en ingles|in english|english)\b/.test(norm)) specs.language = 'en';
    else if (/\b(en espanol|en castellano|spanish)\b/.test(norm)) specs.language = 'es';
    if (/\b(voz femenina|female voice|mujer|femenina)\b/.test(norm)) specs.voice = 'female';
    else if (/\b(voz masculina|male voice|hombre|masculina)\b/.test(norm)) specs.voice = 'male';
  } else if (kind === 'music') {
    if (durationSeconds) specs.durationSeconds = durationSeconds;
    if (style) specs.genre = style;
  }

  // Confidence: an explicit create verb next to a media noun is a clear
  // "do it" request; a bare media noun is weaker (could be conversational).
  let confidence = 'medium';
  if (hasCreateVerb) confidence = 'high';
  else if (/^[\s¿?]*(?:que|what|como|how|por que|why|cual|cuanto|cuando)\b/.test(norm)) confidence = 'low';

  return {
    kind,
    tool: KIND_TO_TOOL[kind],
    confidence,
    hasCreateVerb,
    specs,
    reason: hasCreateVerb ? 'create-verb+noun' : 'noun-only',
  };
}

const KIND_LABEL_ES = {
  image: 'una imagen',
  video: 'un video',
  audio: 'un audio (voz / narración)',
  music: 'música (una canción)',
};

/**
 * Render an explicit Spanish directive for the agent's system prompt so the
 * model reliably calls the right tool with the extracted specs instead of
 * answering with plain text. Returns '' when there is no media intent.
 */
function buildMediaIntentHint(intent) {
  if (!intent || !intent.kind || !intent.tool) return '';
  const lines = [];
  lines.push('[Activación automática de herramienta multimedia]');
  lines.push(`El usuario quiere que GENERES ${KIND_LABEL_ES[intent.kind]}.`);
  lines.push(`DEBES usar la herramienta \`${intent.tool}\` en este turno —sin pedir confirmación— y NO responder solo con texto.`);
  lines.push('Usa el contenido del mensaje del usuario como base del prompt/contenido y respeta estos parámetros detectados (a menos que el usuario indique algo distinto):');

  const s = intent.specs || {};
  const params = [];
  if (intent.kind === 'image') {
    if (s.aspectRatio) params.push(`- aspectRatio: "${s.aspectRatio}"`);
    if (s.quality) params.push(`- quality: "${s.quality}"`);
    if (s.style) params.push(`- style: "${s.style}"`);
    if (s.count) params.push(`- el usuario pidió ${s.count} imágenes: llama \`generate_image\` ${s.count} veces (una por imagen).`);
  } else if (intent.kind === 'video') {
    if (s.durationSeconds) params.push(`- duration: ${s.durationSeconds} (segundos; ajústalo al rango válido de la herramienta).`);
    if (s.aspectRatio) params.push(`- aspectRatio: "${s.aspectRatio}"`);
    if (s.style) params.push(`- style: "${s.style}"`);
  } else if (intent.kind === 'audio') {
    params.push('- text: el texto que el usuario quiere escuchar (extráelo del mensaje; si pidió "narra esto" usa el texto provisto o genéralo a partir del tema).');
    if (s.language) params.push(`- idioma preferido: ${s.language}`);
    if (s.voice) params.push(`- voz preferida: ${s.voice}`);
  } else if (intent.kind === 'music') {
    if (s.durationSeconds) params.push(`- durationSeconds: ${s.durationSeconds}`);
    if (s.genre) params.push(`- género/estilo: "${s.genre}"`);
    params.push('- prompt: describe la canción (tema, instrumentos, ánimo) a partir del mensaje del usuario.');
  }

  if (params.length) lines.push(...params);
  else lines.push('- (sin parámetros explícitos: infiere valores razonables del mensaje).');

  lines.push('Tras generar el recurso, finaliza con una breve descripción en español de lo que creaste.');
  return lines.join('\n');
}

module.exports = {
  detectMediaIntent,
  buildMediaIntentHint,
  // Exposed for unit testing:
  _internal: {
    normalize,
    parseDurationSeconds,
    detectOrientation,
    detectImageCount,
    detectStyle,
    detectHighQuality,
    KIND_TO_TOOL,
  },
};
