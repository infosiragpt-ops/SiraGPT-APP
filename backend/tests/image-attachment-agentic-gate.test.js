'use strict';

// Image turns with an edit / reference intent must enter the agentic loop
// (only edit_image delivers the pixels); vision Q&A stays on the plain stream.
// Source-text contract over routes/ai.js plus a unit check of the predicate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');

test('the image gate admits edit / reference turns through __imageMediaTurn', () => {
  assert.match(ai, /const __imageMediaTurn = hasImages && \(\(\) => \{/);
  assert.match(ai, /&& \(!hasImages \|\| __imageMediaTurn \|\| Boolean\(verifiedCodingWorkspace\) \|\| documentEditRequested \|\| createDocRequested\)/);
});

test('the first OR-group of __agenticWillRun is untouched', () => {
  assert.match(ai, /\(shouldRunAgentic \|\| __rlcdLane\.forced === true \|\| \(req\._rlcdMedia && req\._rlcdMedia\.force === true\) \|\| documentEditRequested \|\| createDocRequested\)/);
});

test('an image-only edit turn vetoes the Office document runner', () => {
  assert.match(ai, /if \(createDocRequested && __imageMediaTurn && !\(processedFiles \|\| \[\]\)\.some\(\(f\) => f && !isImageMime\(f\.mimeType \|\| f\.type\)\)\) \{\s*createDocRequested = false;\s*generateLog\.info\('routing\.image_turn_veto', \{ gate: 'agent_runner' \}\);/);
});

test('the turn-policy images_attached reason excludes image media turns', () => {
  assert.match(ai, /\(\(hasImages && !documentEditRequested && !__imageMediaTurn\)\s*\? 'images_attached'/);
});

test('the RLCD media decision sees the image attachment', () => {
  assert.match(ai, /rlcd\.decideMediaIntent\(\{[\s\S]{0,400}?hasImageAttachment: \(typeof processedFiles !== 'undefined' && Array\.isArray\(processedFiles\)\)/);
});

test('the predicate admits edit / reference intents and rejects vision Q&A', () => {
  const mediaIntent = require('../src/services/agents/media-intent');
  const imageMediaTurn = (prompt) => mediaIntent.detectMediaIntents(prompt, { hasImageAttachment: true })
    .some((i) => i && (i.kind === 'image-edit' || (i.tool === 'generate_image' && i.confidence === 'high')));
  for (const prompt of ['quítale el fondo', 'hazla vertical', 'mejora la calidad', 'genera una imagen como esta pero con fondo azul', 'crea un banner con este logo']) {
    assert.equal(imageMediaTurn(prompt), true, prompt);
  }
  for (const prompt of ['describe esta imagen', '¿qué ves en esta foto?', 'lee el texto de esta imagen', 'traduce esta foto']) {
    assert.equal(imageMediaTurn(prompt), false, prompt);
  }
});
