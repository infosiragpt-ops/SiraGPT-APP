'use strict';

// Image turns with an edit / reference intent must enter the agentic loop
// (only edit_image delivers the pixels); vision Q&A stays on the plain stream.
// Source-text contract over routes/ai.js plus a unit check of the predicate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
const stream = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');

test('the image gate admits edit / reference turns through __imageMediaTurn (one shared predicate)', () => {
  assert.match(ai, /const __imageMediaTurn = hasImages && \(\(\) => \{\s*try \{\s*return require\('\.\.\/services\/agents\/media-intent'\)\.isImageMediaRequest\(prompt\);/);
  assert.match(ai, /&& \(!hasImages \|\| __imageMediaTurn \|\| Boolean\(verifiedCodingWorkspace\) \|\| documentEditRequested \|\| createDocRequested\)/);
  // The loop gate uses the same predicate, so route and loop never disagree.
  assert.match(stream, /if \(files\.some\(isImageAttachment\)\) \{\s*try \{\s*if \(isImageMediaRequest\(text\)\) return true;/);
});

test('the first OR-group of __agenticWillRun is untouched', () => {
  assert.match(ai, /\(shouldRunAgentic \|\| __rlcdLane\.forced === true \|\| \(req\._rlcdMedia && req\._rlcdMedia\.force === true\) \|\| documentEditRequested \|\| createDocRequested\)/);
});

test('an image-only edit turn vetoes the Office document runner through the runner\'s own predicate', () => {
  assert.match(ai, /if \(createDocRequested && __imageMediaTurn && !\(processedFiles \|\| \[\]\)\.some\(\(f\) => f && !isImageMime\(f\.mimeType \|\| f\.type\)\)\s*&& \(\(\) => \{ try \{ return require\('\.\.\/services\/agent-runner'\)\.isImageMediaTurn\(prompt, \{ files: processedFiles \|\| \[\] \}\); \} catch \(_\) \{ return false; \} \}\)\(\)\) \{\s*createDocRequested = false;\s*generateLog\.info\('routing\.image_turn_veto', \{ gate: 'agent_runner' \}\);/);
  // Stream level: the veto on the runner claim follows the same predicate,
  // with the chat's latest artifact format (a prior deck keeps the runner).
  assert.match(stream, /imageEditTurn = isImageMediaTurn\(userQuery, \{\s*files: uploadedFileRefs,\s*priorArtifactFormat: priorArtifactFormat \|\| \(recentImage \? 'png' : null\),\s*\}\);/);
  assert.match(stream, /if \(runnerClaim && !imageEditTurn\) \{/);
  // The recent-image scan is short and a later document ends the image context.
  assert.match(stream, /historyHasRecentImage\(history, \{ limit: 6 \}\)/);
});

test('the turn-policy images_attached reason excludes image media turns', () => {
  assert.match(ai, /\(\(hasImages && !documentEditRequested && !__imageMediaTurn\)\s*\? 'images_attached'/);
});

test('the RLCD media decision sees the image attachment', () => {
  assert.match(ai, /rlcd\.decideMediaIntent\(\{[\s\S]{0,400}?hasImageAttachment: \(typeof processedFiles !== 'undefined' && Array\.isArray\(processedFiles\)\)/);
});

test('the predicate admits edit / reference intents and rejects vision Q&A and text deliverables about the picture', () => {
  const { isImageMediaRequest } = require('../src/services/agents/media-intent');
  for (const prompt of ['quítale el fondo', 'hazla vertical', 'mejora la calidad', 'genera una imagen como esta pero con fondo azul', 'crea un banner con este logo', 'crea una imagen de un gato']) {
    assert.equal(isImageMediaRequest(prompt), true, prompt);
  }
  for (const prompt of [
    'describe esta imagen', '¿qué ves en esta foto?', 'lee el texto de esta imagen', 'traduce esta foto',
    // A creation verb whose deliverable is TEXT about the attachment.
    'genera una descripción de esta imagen', 'hazme un resumen de esta imagen', 'haz un análisis de esta foto',
    'crea un cuento basado en esta imagen', 'crea una tabla con los datos de esta imagen', 'genera 5 ideas de post con esta imagen',
    'genera un alt text para esta imagen', 'crea un prompt para esta imagen', 'dame un título para esta imagen',
    // A document built with the picture is runner work, not an image edit.
    'crea una ppt con esta imagen de fondo', 'genera un pptx usando este logo', 'crea un documento word con esta imagen',
    'dale un vistazo a esta imagen',
  ]) {
    assert.equal(isImageMediaRequest(prompt), false, prompt);
  }
});

test('the composer fallback: a follow-up promoted to an edit without a resolvable source generates instead of failing', () => {
  assert.match(ai, /if \(operation !== 'generate' && !sourceImages\.length && hasRecentImage && !fileId && !referenceFileIds\?\.length && !editSelection && !maskDataUrl && !background\) \{\s*operation = 'generate';/);
  // The previous-image cue never demotes a viewer-chosen canvas.
  assert.match(ai, /const primaryFromHistory = Boolean\(previousImageCue\) && !requestedOperation\s*&& \(!fileId \|\| \(Array\.isArray\(referenceFileIds\) && referenceFileIds\.map\(String\)\.includes\(String\(fileId\)\)\)\);/);
  // The user's words (orientation or a framed deliverable) win over the source frame.
  assert.match(ai, /editWordedFrame = imageDirective\.detectSpokenImageFrame\(prompt\) \|\| deliverable;/);
  assert.match(ai, /if \(operation === 'edit' && sourceImage\?\.metadata\?\.aspectRatio && !editWordedFrame\)/);
  assert.match(ai, /if \(operation === 'edit' && !sourceImage\?\.metadata\?\.aspectRatio && !editWordedFrame && editCanvas\?\.sourceWidth/);
});
