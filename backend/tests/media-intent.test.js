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

test('detects "créame un audio: Juan vende papas en el mercado" as speech, not HTML', () => {
  const r = detectMediaIntent('créame un audio: Juan vende papas en el mercado');
  assert.equal(r.kind, 'audio');
  assert.equal(r.tool, 'generate_speech');
  const hint = buildMediaIntentHint(r);
  assert.match(hint, /generate_speech/);
  assert.match(hint, /speechSynthesis|Web Speech API/);
  assert.match(hint, /PROHIBIDO/);
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

// ── Spoken image directives (typos, counts, edit targets) ─────────────────

test('image intent from "cre aun aimgen de un gato" is generate_image', () => {
  const intents = detectMediaIntents('cre aun aimgen de un gato');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'image');
  assert.equal(intents[0].tool, 'generate_image');
  assert.equal(intents[0].hasCreateVerb, true);
  assert.equal(intents[0].confidence, 'high');
});

test('image intent tolerates chat typos and resolves the exact frame', () => {
  const r = detectMediaIntent('dma euna imagen orisailntal de un perro para la portada');
  assert.equal(r.kind, 'image');
  assert.equal(r.tool, 'generate_image');
  assert.equal(r.specs.frame, '16:9');
  assert.equal(r.specs.aspectRatio, 'wide');
});

test('image intent understands "varias imágenes" as a multi-image request', () => {
  const r = detectMediaIntent('hazme varias imágenes de gatos');
  assert.equal(r.kind, 'image');
  assert.equal(r.specs.count, 3);
  assert.match(buildMediaIntentHint(r), /3/);
});

test('edit intent carries the spoken target into the hint', () => {
  const intents = detectMediaIntents('en la imagen cambia el cielo a un atardecer naranja');
  assert.equal(intents[0].tool, 'edit_image');
  assert.match(intents[0].specs.editTarget, /cielo/);
  const hint = buildMediaIntentHint(intents[0]);
  assert.match(hint, /cielo/);
  assert.match(hint, /target/);
});

// ── Typo-tolerant intent (prod 2026-09-17: «cre aun aimgen de un gato» went
// to the text model and rendered an empty vector card instead of an image) ──
test('misspelled create requests still resolve to the right media kind', () => {
  const cases = [
    ['cre aun aimgen de un gato', 'image'],
    ['crea una imgaen de un perro', 'image'],
    ['ceame una imagn de un perro', 'image'],
    ['haz una fotto de una casa', 'image'],
    ['quiero una ilustrasion de un dragon', 'image'],
    ['genera un vidio de un auto', 'video'],
    ['hazme un lgoo para mi tienda', 'image'],
  ];
  for (const [text, kind] of cases) {
    const r = detectMediaIntent(text);
    assert.equal(r.kind, kind, `${text} → ${JSON.stringify(r)}`);
    assert.equal(r.confidence, 'high', text);
  }
});

test('a drawing verb alone is an image request; questions about drawing are not', () => {
  assert.equal(detectMediaIntent('dibujame un gato').kind, 'image');
  assert.equal(detectMediaIntent('dibujame un gato').confidence, 'high');
  assert.equal(detectMediaIntent('pintame un paisaje al atardecer').kind, 'image');
  assert.equal(detectMediaIntent('como dibujo un gato paso a paso').confidence, 'low');
});

test('fuzzy repair never rewrites ordinary words into media nouns', () => {
  for (const text of ['quiero una moto roja', 'escribe una carta para mi madre', 'pon una alarma a las 8', 'crea un poema sobre gatos', 'que es una imagen raster']) {
    const r = detectMediaIntent(text);
    if (text.includes('imagen')) { assert.equal(r.confidence, 'low'); continue; }
    assert.equal(r.kind, null, `${text} → ${JSON.stringify(r)}`);
  }
});

// ── Image context: follow-ups, wider references, reference-guided creation ──

const { classifyImageRequest, isImageFollowupCandidate } = require('../src/services/agents/media-intent');

test('edit verbs reach an image named with an article ("del logo", "al logo")', () => {
  for (const phrase of ['cambia el color del logo', 'cámbiale el color al logo', 'quítale el texto de la imagen']) {
    const [intent] = detectMediaIntents(phrase);
    assert.equal(intent?.tool, 'edit_image', phrase);
    assert.equal(intent?.confidence, 'high', phrase);
  }
  // The same article inside a creation sentence keeps the generation.
  for (const phrase of [
    'crea una imagen del logo de mi empresa y cambia el fondo a azul',
    'dibuja el retrato de un rey y mejora los colores',
    'crea un poster y ponme el logo arriba',
  ]) {
    assert.equal(detectMediaIntents(phrase)[0]?.tool, 'generate_image', phrase);
    assert.equal(detectMediaIntents(phrase, { hasImageAttachment: true })[0]?.tool, 'generate_image', `${phrase} (attachment)`);
  }
});

test('"ponle …" is an edit verb again (the typo canonicaliser used to make it "ponme")', () => {
  assert.equal(detectMediaIntents('ponle este logo a la camiseta')[0]?.tool, 'edit_image');
  assert.equal(detectMediaIntents('ponle un sombrero a esta foto', { hasImageAttachment: true })[0]?.tool, 'edit_image');
  assert.equal(detectImageEditIntent('ponle este logo a la camiseta'), true);
  // An attached picture is image context too: a subject-less follow-up edits it.
  for (const phrase of ['ponle un sombrero al gato', 'hazla más oscura', 'ahora en azul', 'que sea de noche']) {
    assert.equal(detectMediaIntents(phrase, { hasImageAttachment: true })[0]?.tool, 'edit_image', phrase);
    assert.equal(detectMediaIntents(phrase, { hasImageAttachment: true })[0]?.confidence, 'high', phrase);
  }
});

test('an attached image used as a reference makes a creation request an edit', () => {
  const phrases = [
    'genera una imagen como esta pero con fondo azul',
    'crea un banner con este logo',
    'usa esta foto de referencia y hazla estilo anime',
    'genera una imagen basada en esta foto',
    'haz una ilustración a partir de esta imagen',
    'diseña un afiche con esta imagen',
    'make a poster like this',
  ];
  for (const phrase of phrases) {
    const [intent] = detectMediaIntents(phrase, { hasImageAttachment: true });
    assert.equal(intent?.tool, 'edit_image', phrase);
    assert.equal(intent?.confidence, 'high', phrase);
    assert.equal(intent?.referenceGuided, true, phrase);
    assert.equal(classifyImageRequest(phrase, { hasImageAttachment: true }).reason, 'reference-guided', phrase);
    // Without the attachment nothing is reference-guided…
    assert.notEqual(detectMediaIntents(phrase)[0]?.referenceGuided, true, `${phrase} (no attachment)`);
  }
  // …and a creation verb alone is a generation ("usa esta foto … hazla" still
  // names an existing photo with an edit verb, so it stays an edit).
  for (const phrase of phrases.filter((p) => !/\bhazla\b/.test(p))) {
    assert.equal(detectMediaIntents(phrase)[0]?.tool, 'generate_image', `${phrase} (no attachment)`);
  }
  const hint = buildMediaIntentsHint(detectMediaIntents('crea un banner con este logo', { hasImageAttachment: true }));
  assert.match(hint, /edit_image/);
  assert.match(hint, /REFERENCIA/);
  assert.match(hint, /NO uses `generate_image`/);
});

test('vision questions about an attached image are never edits', () => {
  for (const phrase of ['describe esta imagen', '¿qué ves en esta foto?', 'lee el texto de esta imagen', 'traduce esta foto', 'resume este dibujo']) {
    const intents = detectMediaIntents(phrase, { hasImageAttachment: true });
    assert.notEqual(intents[0]?.kind, 'image-edit', phrase);
    assert.notEqual(intents[0]?.confidence, 'high', phrase);
    assert.equal(detectImageEditIntent(phrase, { hasImageAttachment: true }), false, phrase);
  }
});

test('short follow-ups edit the chat\'s recent image, and only then', () => {
  const followups = [
    'ahora en azul', 'que sea de noche', 'hazla más oscura', 'la misma pero en azul', 'cámbiale el fondo a rojo',
    'mejora la calidad', 'ponle gafas', 'ahora sin fondo', 'más brillante', 'hazlo más realista', 'ponle un sombrero al gato',
    'agrégale un sombrero', 'make it darker', 'igual pero de noche',
  ];
  for (const phrase of followups) {
    const [intent] = detectMediaIntents(phrase, { hasRecentImage: true });
    assert.equal(intent?.tool, 'edit_image', phrase);
    assert.equal(intent?.confidence, 'high', phrase);
    assert.equal(isImageFollowupCandidate(phrase), true, phrase);
  }
  // No recent image → the same words are not an image request.
  for (const phrase of ['ahora en azul', 'que sea de noche', 'hazla más oscura', 'ponle gafas', 'más brillante']) {
    assert.equal(detectMediaIntents(phrase).length, 0, phrase);
  }
  // Ordinary prose after an image stays prose.
  for (const phrase of [
    'en resumen, qué opinas?', 'con eso basta, gracias', 'cambia el tono del texto', 'ahora en azul el titulo de la diapositiva',
    'que sea breve', 'ajusta el presupuesto', 'mejora el rendimiento del código', 'hazlo en python', 'ahora cuéntame un chiste', 'dame más ideas',
  ]) {
    assert.notEqual(detectMediaIntents(phrase, { hasRecentImage: true })[0]?.kind, 'image-edit', phrase);
  }
  assert.equal(isImageFollowupCandidate('crea otra imagen de una ciudad'), false);
  assert.equal(isImageFollowupCandidate('hola'), false);
});

test('classifyImageRequest is the single edit/generate/reframe decision', () => {
  assert.equal(classifyImageRequest('la misma imagen pero vertical').operation, 'reframe');
  assert.equal(classifyImageRequest('quítale el fondo').operation, 'edit');
  assert.equal(classifyImageRequest('crea una imagen de un perro y quítale el fondo').operation, 'generate');
  assert.equal(classifyImageRequest('crea otra imagen de una ciudad', { hasRecentImage: true }).operation, 'generate');
  assert.equal(classifyImageRequest('ahora en azul', { hasRecentImage: true }).operation, 'edit');
  assert.equal(classifyImageRequest('ahora en azul').operation, null);
  assert.equal(classifyImageRequest('cuéntame un chiste').operation, null);
  assert.equal(classifyImageRequest('').operation, null);
});

// ── Round 2: review findings I1–I10 ───────────────────────────────────────

test('«la misma imagen pero …» and English leads are follow-up edits of the recent image', () => {
  const { classifyImageRequest, isImageFollowupCandidate } = require('../src/services/agents/media-intent');
  for (const phrase of ['la misma imagen pero de noche', 'the same image but at night', 'esa misma foto pero en blanco y negro', 'same photo but darker',
    'now in blue', 'but darker', 'with a hat', 'in black and white', 'ahora en azul', 'agrega un sombrero al perro', 'replace the sky with a sunset',
    'convierte la foto en caricatura', 'reemplaza el cielo por un atardecer', 'add a hat', 'coloca un marco dorado']) {
    const [intent] = detectMediaIntents(phrase, { hasRecentImage: true });
    assert.equal(intent?.tool, 'edit_image', phrase);
    assert.equal(classifyImageRequest(phrase, { hasRecentImage: true }).operation, 'edit', phrase);
    assert.equal(isImageFollowupCandidate(phrase), true, phrase);
  }
  // «crea otra imagen …» is still a new generation even after an image.
  assert.equal(classifyImageRequest('crea otra imagen de una ciudad', { hasRecentImage: true }).operation, 'generate');
  assert.equal(classifyImageRequest('crea una imagen de un perro sin fondo', { hasRecentImage: true }).operation, 'generate');
});

test('a document deliverable named before the picture is never an image request', () => {
  const { classifyImageRequest, isImageFollowupCandidate } = require('../src/services/agents/media-intent');
  for (const phrase of ['crea una ppt con esta imagen de fondo', 'cambia el fondo de la diapositiva a azul', 'genera un pptx usando este logo',
    'crea un documento word con esta imagen', 'ponle esta foto al excel', 'cambia el color del título de la lámina', 'ahora en azul el titulo de la diapositiva']) {
    assert.equal(classifyImageRequest(phrase, { hasImageAttachment: true }).operation, null, phrase);
    assert.equal(classifyImageRequest(phrase, { hasRecentImage: true }).operation, null, phrase);
    assert.equal(detectImageEditIntent(phrase, { hasImageAttachment: true, hasRecentImage: true }), false, phrase);
    assert.equal(isImageFollowupCandidate(phrase), false, phrase);
  }
  // The picture named FIRST keeps the image as the object.
  assert.equal(classifyImageRequest('quita el fondo de esta imagen para el informe', { hasImageAttachment: true }).operation, 'edit');
  assert.equal(_internal.documentDeliverableVeto('crea una ppt con esta imagen de fondo'), true);
  assert.equal(_internal.documentDeliverableVeto('quita el fondo de esta imagen para la presentacion'), false);
  assert.equal(_internal.documentDeliverableVeto('quita el fondo'), false);
});

test('«crea una versión anime de esta foto» after a generated image edits it; looking at a picture never edits', () => {
  const { classifyImageRequest, isImageFollowupCandidate } = require('../src/services/agents/media-intent');
  for (const phrase of ['crea una versión anime de esta foto', 'genera una imagen como esta pero de noche', 'haz un poster con esta imagen']) {
    assert.equal(classifyImageRequest(phrase, { hasRecentImage: true }).operation, 'edit', phrase);
    assert.equal(isImageFollowupCandidate(phrase), true, phrase);
  }
  // Without the demonstrative pointing at the chat's picture it is a generation.
  assert.equal(classifyImageRequest('crea una imagen anime de un gato', { hasRecentImage: true }).operation, 'generate');
  for (const phrase of ['dale un vistazo a esta imagen', 'échale un ojo a esta foto', 'take a look at this picture']) {
    assert.equal(detectImageEditIntent(phrase, { hasImageAttachment: true }), false, phrase);
    assert.notEqual(detectMediaIntents(phrase, { hasImageAttachment: true })[0]?.kind, 'image-edit', phrase);
  }
});

test('only the «que sea …» continuation waives the question penalty', () => {
  assert.equal(detectMediaIntents('que sea de noche', { hasRecentImage: true })[0]?.confidence, 'high');
  assert.equal(detectMediaIntents('¿cómo quito el fondo en gimp?', { hasRecentImage: true }).length, 0);
  const howTo = detectMediaIntents('¿cómo le cambio el fondo a esta foto?', { hasImageAttachment: true })[0];
  assert.notEqual(howTo?.confidence, 'high');
});

test('isImageMediaRequest / isImageAttachment are the shared gates for route and loop', () => {
  const { isImageMediaRequest, isImageAttachment } = require('../src/services/agents/media-intent');
  assert.equal(isImageMediaRequest('crea un banner con este logo'), true);
  assert.equal(isImageMediaRequest('crea una imagen de un gato'), true);
  assert.equal(isImageMediaRequest('genera un alt text para esta imagen'), false);
  assert.equal(isImageMediaRequest('describe esta imagen'), false);
  assert.equal(isImageMediaRequest(''), false);
  assert.equal(isImageAttachment({ mimeType: 'image/png' }), true);
  assert.equal(isImageAttachment({ type: 'image/jpeg' }), true);
  assert.equal(isImageAttachment({ contentType: 'image/webp' }), true);
  assert.equal(isImageAttachment({ attachmentKind: 'image', mimeType: 'application/octet-stream' }), true);
  assert.equal(isImageAttachment({ mimeType: 'application/pdf' }), false);
  assert.equal(isImageAttachment(null), false);
  // One noun list for both image references; the creation verbs are shared with image-directive.
  assert.match('cambia el color de la captura', _internal.ANY_IMAGE_REF);
  assert.match('edit the screenshot', _internal.ANY_IMAGE_REF);
  assert.ok(typeof _internal.CREATE_VERB_SOURCE === 'string' && _internal.CREATE_VERB_SOURCE.includes('gener'));
});
