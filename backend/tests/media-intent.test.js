/**
 * Tests for services/agents/media-intent.js — the bilingual (ES/EN)
 * media-intent + spec extractor that lets the chat bar auto-activate the
 * right generation tool (image / video / audio / music) with the params
 * the user stated in natural language.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectMediaIntent, buildMediaIntentHint, _internal } = require('../src/services/agents/media-intent');

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

test('buildMediaIntentHint produces a directive naming the tool + specs', () => {
  const hint = buildMediaIntentHint(detectMediaIntent('genérame una canción de 3 minutos estilo lofi'));
  assert.match(hint, /generate_music/);
  assert.match(hint, /180/);
  assert.match(hint, /lofi/);
  assert.match(hint, /Activación automática/);
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
