/**
 * Tests for services/agents/media-intent.js — the bilingual (ES/EN)
 * media-intent + spec extractor that lets the chat bar auto-activate the
 * right generation tool (image / video / audio / music) with the params
 * the user stated in natural language.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectMediaIntent,
  detectMediaIntents,
  detectImageEditIntent,
  buildMediaIntentHint,
  buildMediaIntentsHint,
  resolveVideoAspectRatio,
  _internal,
} = require('../src/services/agents/media-intent');

test('detects an image create request and maps to generate_image', () => {
  const r = detectMediaIntent('créame una imagen de un gato astronauta');
  assert.equal(r.kind, 'image');
  assert.equal(r.tool, 'generate_image');
  assert.equal(r.confidence, 'high');
  assert.equal(r.hasCreateVerb, true);
});

test('extracts image specs: orientation, quality, style', () => {
  const r = detectMediaIntent('genera una imagen vertical en alta calidad estilo realista');
  assert.equal(r.kind, 'image');
  assert.equal(r.specs.aspectRatio, 'portrait');
  assert.equal(r.specs.quality, 'hd');
  assert.match(r.specs.style, /realista/);
});

test('extracts image count from digits and Spanish word-numbers', () => {
  assert.equal(detectMediaIntent('hazme 5 imágenes de paisajes').specs.count, 5);
  assert.equal(detectMediaIntent('dame tres fotos de perros').specs.count, 3);
  // a single image must NOT set a count > 1
  assert.equal(detectMediaIntent('créame una imagen de un gato').specs.count, undefined);
});

test('detects a video request with duration, aspect ratio and style', () => {
  const r = detectMediaIntent('hazme un video de 15 segundos en formato 9:16 cinematográfico');
  assert.equal(r.kind, 'video');
  assert.equal(r.tool, 'generate_video');
  assert.equal(r.specs.durationSeconds, 15); // NOT 556 — "9:16" must not be read as a clock
  assert.equal(r.specs.aspectRatio, '9:16');
  assert.match(r.specs.style, /cinematograf/);
});

test('detects the minimal Spanish video command from the chat bar', () => {
  const r = detectMediaIntent('crea un video');
  assert.equal(r.kind, 'video');
  assert.equal(r.tool, 'generate_video');
  assert.equal(r.confidence, 'high');
  assert.equal(r.hasCreateVerb, true);
  assert.equal(r.specs.durationSeconds, 8);
  assert.equal(r.specs.aspectRatio, '16:9');
  assert.equal(r.specs.model, 'veo-fast');
});

test('keeps video learning or ideation prompts low-confidence', () => {
  assert.equal(detectMediaIntent('¿cómo crear un video?').confidence, 'low');
  assert.equal(detectMediaIntent('necesito ideas para un video').confidence, 'low');
  assert.equal(detectMediaIntent('crea un guion para un video').confidence, 'low');
});

test('video duration accepts minutes', () => {
  assert.equal(detectMediaIntent('un video de 2 minutos del producto').specs.durationSeconds, 120);
});

test('detects a song/music request with duration and genre (ES)', () => {
  const r = detectMediaIntent('genérame una canción de 3 minutos estilo lofi');
  assert.equal(r.kind, 'music');
  assert.equal(r.tool, 'generate_music');
  assert.equal(r.specs.durationSeconds, 180);
  assert.match(r.specs.genre, /lofi/);
});

test('music wins over the generic "audio" noun; video wins over "musical"', () => {
  assert.equal(detectMediaIntent('créame una canción').kind, 'music');
  assert.equal(detectMediaIntent('hazme un audio de una canción').kind, 'music');
  assert.equal(detectMediaIntent('un videoclip musical de mi banda').kind, 'video');
});

test('detects a TTS/audio (narration) request and language/voice', () => {
  const r = detectMediaIntent('necesito un audio narrando este texto en inglés con voz femenina');
  assert.equal(r.kind, 'audio');
  assert.equal(r.tool, 'generate_speech');
  assert.equal(r.specs.language, 'en');
  assert.equal(r.specs.voice, 'female');
});

test('returns no intent for non-media chat', () => {
  assert.equal(detectMediaIntent('¿cuál es la capital de Francia?').kind, null);
  assert.equal(detectMediaIntent('explícame qué es una API REST').kind, null);
  assert.equal(detectMediaIntent('').kind, null);
  assert.equal(detectMediaIntent(null).kind, null);
});

test('does not false-fire on mid-word matches', () => {
  // "videojuego" must not trigger the video tool via the "video" noun.
  assert.notEqual(detectMediaIntent('quiero programar un videojuego en unity').kind, 'video');
});

test('English create requests are detected', () => {
  assert.equal(detectMediaIntent('create an image of a sunset').kind, 'image');
  assert.equal(detectMediaIntent('make a 30 second video about dogs').kind, 'video');
  assert.equal(detectMediaIntent('generate a song about the ocean').kind, 'music');
});

test('parseDurationSeconds understands many phrasings', () => {
  const p = _internal.parseDurationSeconds;
  assert.equal(p('1:30'), 90);
  assert.equal(p('minuto y medio'), 90);
  assert.equal(p('medio minuto'), 30);
  assert.equal(p('media hora'), 1800);
  assert.equal(p('30 segundos'), 30);
  assert.equal(p('2 min y 30 seg'), 150);
  assert.equal(p('tres minutos'), 180);
  assert.equal(p('una imagen bonita'), null); // no duration stated
});

test('aspect-ratio tokens are not misread as durations', () => {
  const p = _internal.parseDurationSeconds;
  assert.equal(p('formato 9:16'), null);
  assert.equal(p('en 16:9'), null);
  assert.equal(p('video 16:9 de 1:30'), 90);
});

test('detectOrientation maps ES/EN orientation words', () => {
  const o = _internal.detectOrientation;
  assert.equal(o('quiero algo vertical para tiktok'), 'vertical');
  assert.equal(o('horizontal para youtube'), 'horizontal');
  assert.equal(o('formato cuadrado'), 'square');
  assert.equal(o('una imagen normal'), null);
});

test('resolveVideoAspectRatio maps natural language video shapes', () => {
  assert.equal(resolveVideoAspectRatio('genera un video cuadrado'), '1:1');
  assert.equal(resolveVideoAspectRatio('genera un video rectangular para youtube'), '16:9');
  assert.equal(resolveVideoAspectRatio('genera un video vertical para reels'), '9:16');
  assert.equal(resolveVideoAspectRatio('genera un video 21x9 cinematografico'), '21:9');
  assert.equal(resolveVideoAspectRatio('genera un video normal'), null);
});

test('buildMediaIntentHint produces a directive naming the tool + specs', () => {
  const hint = buildMediaIntentHint(detectMediaIntent('genérame una canción de 3 minutos estilo lofi'));
  assert.match(hint, /generate_music/);
  assert.match(hint, /180/);
  assert.match(hint, /lofi/);
  assert.match(hint, /Activación automática/);
});

test('video hint forces Veo Fast with the 8 second default', () => {
  const hint = buildMediaIntentHint(detectMediaIntent('quiero un video de un perro'));
  assert.match(hint, /generate_video/);
  assert.match(hint, /veo-fast/);
  assert.match(hint, /duration: 8/);
  assert.match(hint, /aspectRatio: "16:9"/);
});

test('buildMediaIntentHint returns empty string when there is no media intent', () => {
  assert.equal(buildMediaIntentHint(detectMediaIntent('hola, ¿cómo estás?')), '');
  assert.equal(buildMediaIntentHint(null), '');
});

test('image-count hint instructs multiple generate_image calls', () => {
  const hint = buildMediaIntentHint(detectMediaIntent('hazme 4 imágenes de gatos'));
  assert.match(hint, /generate_image/);
  assert.match(hint, /4/);
});

// ── detectMediaIntents — multi-kind detection in one message ──────────────

test('detectMediaIntents: "crea un video y una foto" activates BOTH tools', () => {
  const intents = detectMediaIntents('crea un video y una foto de un perro');
  assert.deepEqual(intents.map((i) => i.kind), ['video', 'image']);
  assert.deepEqual(intents.map((i) => i.tool), ['generate_video', 'generate_image']);
  assert.ok(intents.every((i) => i.confidence === 'high'));
});

test('detectMediaIntents: intents[0] matches the single-intent priority', () => {
  const single = detectMediaIntent('hazme un video musical con una canción épica');
  const multi = detectMediaIntents('hazme un video musical con una canción épica');
  assert.equal(multi[0].kind, single.kind);
});

test('detectMediaIntents: per-kind specs do not bleed across kinds', () => {
  const intents = detectMediaIntents('hazme un video de 15 segundos 9:16 y tres imágenes estilo anime');
  const video = intents.find((i) => i.kind === 'video');
  const image = intents.find((i) => i.kind === 'image');
  assert.equal(video.specs.durationSeconds, 15);
  assert.equal(video.specs.aspectRatio, '9:16');
  assert.equal(image.specs.count, 3);
  assert.equal(image.specs.durationSeconds, undefined);
});

test('detectMediaIntents: single kind still yields one intent; none yields []', () => {
  assert.equal(detectMediaIntents('créame una imagen de un gato').length, 1);
  assert.equal(detectMediaIntents('¿cuál es la capital de Francia?').length, 0);
  assert.equal(detectMediaIntents('').length, 0);
});

test('detectMediaIntents: "audio de una canción" stays a single music intent', () => {
  const intents = detectMediaIntents('hazme un audio de una canción');
  assert.deepEqual(intents.map((i) => i.kind), ['music']);
});

// ── Image EDIT intent (img2img) ────────────────────────────────────────────

test('edit phrasings route to edit_image', () => {
  const intents = detectMediaIntents('quítale el fondo a esta foto');
  assert.equal(intents[0].kind, 'image-edit');
  assert.equal(intents[0].tool, 'edit_image');
  assert.equal(intents[0].confidence, 'high');
  assert.equal(detectMediaIntents('edita esta imagen y cámbiale el color del cielo')[0].tool, 'edit_image');
  assert.equal(detectMediaIntents('remove the background from this photo')[0].tool, 'edit_image');
});

test('generation requests with edit-ish wording stay on generate_image', () => {
  assert.equal(detectMediaIntents('crea una imagen de un perro sin fondo')[0].tool, 'generate_image');
  assert.equal(detectMediaIntents('crea una imagen de un perro y quítale el fondo')[0].tool, 'generate_image');
});

test('an attached image lets implicit edit wording fire', () => {
  assert.equal(detectMediaIntents('mejora la calidad', { hasImageAttachment: true })[0]?.tool, 'edit_image');
  assert.equal(detectMediaIntents('mejora la calidad').length, 0);
  assert.equal(detectMediaIntents('mejora el rendimiento del código').length, 0);
});

test('detectImageEditIntent is exported and pure', () => {
  assert.equal(detectImageEditIntent('quita el fondo'), true);
  assert.equal(detectImageEditIntent('crea una imagen de un perro'), false);
  assert.equal(detectImageEditIntent(''), false);
  assert.equal(detectImageEditIntent(null), false);
});

// ── buildMediaIntentsHint — multi-tool directive ──────────────────────────

test('buildMediaIntentsHint lists every requested tool once', () => {
  const hint = buildMediaIntentsHint(detectMediaIntents('crea un video y una foto de un perro'));
  assert.match(hint, /generate_video/);
  assert.match(hint, /generate_image/);
  assert.match(hint, /PEDIDO MÚLTIPLE/);
});

test('buildMediaIntentsHint falls back to the single-intent hint', () => {
  const single = buildMediaIntentsHint(detectMediaIntents('créame una canción de 3 minutos estilo lofi'));
  assert.match(single, /generate_music/);
  assert.match(single, /Activación automática/);
  assert.doesNotMatch(single, /PEDIDO MÚLTIPLE/);
  assert.equal(buildMediaIntentsHint([]), '');
  assert.equal(buildMediaIntentsHint(null), '');
});

test('edit_image hint warns against generate_image', () => {
  const hint = buildMediaIntentsHint(detectMediaIntents('quítale el fondo a esta foto'));
  assert.match(hint, /edit_image/);
  assert.match(hint, /NO generes una imagen nueva/);
});

// ── resolveImageAspectRatio — free-text → concrete image aspect ratio ──────
const { resolveImageAspectRatio } = _internal;

test('resolveImageAspectRatio: rectangular / facebook → landscape 16:9', () => {
  assert.equal(resolveImageAspectRatio('creame una imagen de un perro rectangular para postada de facebook'), '16:9');
  assert.equal(resolveImageAspectRatio('una imagen rectangular'), '16:9');
  assert.equal(resolveImageAspectRatio('portada para mi página de facebook'), '16:9');
  assert.equal(resolveImageAspectRatio('a wide landscape banner'), '16:9');
});

test('resolveImageAspectRatio: vertical / portrait → 3:4', () => {
  assert.equal(resolveImageAspectRatio('un retrato vertical de una mujer'), '3:4');
  assert.equal(resolveImageAspectRatio('make it portrait'), '3:4');
});

test('resolveImageAspectRatio: stories / tiktok → 9:16', () => {
  assert.equal(resolveImageAspectRatio('imagen para historia de instagram'), '9:16');
  assert.equal(resolveImageAspectRatio('algo para tiktok'), '9:16');
});

test('resolveImageAspectRatio: square / logo / avatar → 1:1', () => {
  assert.equal(resolveImageAspectRatio('un logo cuadrado'), '1:1');
  assert.equal(resolveImageAspectRatio('avatar para mi perfil'), '1:1');
  assert.equal(resolveImageAspectRatio('square image'), '1:1');
});

test('resolveImageAspectRatio: explicit ratio tokens win', () => {
  assert.equal(resolveImageAspectRatio('una imagen vertical pero en 16:9'), '16:9');
  assert.equal(resolveImageAspectRatio('genera algo 9x16'), '9:16');
  assert.equal(resolveImageAspectRatio('relación 3:2 por favor'), '3:2');
});

test('resolveImageAspectRatio: no shape described → null (keep picker default)', () => {
  assert.equal(resolveImageAspectRatio('creame una imagen de un perro'), null);
  assert.equal(resolveImageAspectRatio(''), null);
  assert.equal(resolveImageAspectRatio(null), null);
});
