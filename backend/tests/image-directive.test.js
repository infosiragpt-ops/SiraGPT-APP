/**
 * Tests for services/agents/image-directive.js — the deterministic parser
 * that turns spoken image requests ("dame una imagen vertical",
 * "en la imagen cambia el cielo…") into concrete generation / edit
 * directives, including typo tolerance and selection scoping.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const directive = require('../src/services/agents/image-directive');

// ── Frames ────────────────────────────────────────────────────────────────

test('detectImageFrame: vertical → 3:4 portrait', () => {
  assert.deepEqual(directive.detectImageFrame('dame una imagen vertical de un perro'), {
    frame: '3:4',
    orientation: 'portrait',
  });
});

test('detectImageFrame: typo-tolerant horizontal ("orisailntal") → 16:9', () => {
  assert.deepEqual(directive.detectImageFrame('hazme una imagen orisailntal para la portada'), {
    frame: '16:9',
    orientation: 'landscape',
  });
});

test('detectImageFrame: explicit ratio tokens win over shape words', () => {
  assert.equal(directive.detectImageFrame('una imagen vertical pero en 16:9').frame, '16:9');
  assert.equal(directive.detectImageFrame('genera algo 9x16').frame, '9:16');
});

test('detectImageFrame: stories / logos map to their frames', () => {
  assert.equal(directive.detectImageFrame('imagen para historia de instagram').frame, '9:16');
  assert.equal(directive.detectImageFrame('un logo cuadrado').frame, '1:1');
});

test('detectImageFrame: no shape described → null', () => {
  assert.equal(directive.detectImageFrame('creame una imagen de un perro'), null);
  assert.equal(directive.detectImageFrame(''), null);
});

// ── Quality / count / style / type ────────────────────────────────────────

test('detectImageQuality understands ES quality words', () => {
  assert.equal(directive.detectImageQuality('en alta calidad'), '2K');
  assert.equal(directive.detectImageQuality('calidad 4k por favor'), '4K');
  assert.equal(directive.detectImageQuality('un perro'), null);
});

test('detectImageCount covers digits, words, pairs and "varias"', () => {
  assert.equal(directive.detectImageCount('hazme 5 imágenes de paisajes'), 5);
  assert.equal(directive.detectImageCount('dame tres fotos de perros'), 3);
  assert.equal(directive.detectImageCount('un par de imágenes'), 2);
  assert.equal(directive.detectImageCount('hazme varias imágenes de gatos'), 3);
  assert.equal(directive.detectImageCount('créame una imagen de un gato'), null);
});

test('detectImageStyle + detectImageType', () => {
  assert.equal(directive.detectImageStyle('estilo realista'), 'realistic');
  assert.deepEqual(directive.detectImageType('un logo para mi marca'), {
    type: 'logo',
    descriptor: 'minimal logo design, vector style, centered, no background clutter',
  });
});

// ── Command stripping ─────────────────────────────────────────────────────

test('stripImageCommand removes the spoken wrapper but keeps the subject', () => {
  assert.equal(
    directive.stripImageCommand('dma euna imagen vertical de un perro'),
    'vertical de un perro'
  );
  assert.equal(
    directive.stripImageCommand('Por favor, créame una foto de un gato astronauta'),
    'un gato astronauta'
  );
});

// ── Generation resolver ───────────────────────────────────────────────────

test('resolveGenerationDirective: spoken frame fills the gap, explicit args win', () => {
  const spoken = directive.resolveGenerationDirective('dma euna imagen orisailntal de un perro para la portada', {});
  assert.equal(spoken.frame, '16:9');
  assert.equal(spoken.aspectRatio, 'wide');
  assert.match(spoken.prompt, /Image framing requirement/);

  const explicit = directive.resolveGenerationDirective('una imagen vertical de un perro', { aspectRatio: 'square' });
  assert.equal(explicit.aspectRatio, 'square');
  assert.equal(explicit.frame, '3:4');
});

test('resolveGenerationDirective: spoken count and style are extracted', () => {
  const r = directive.resolveGenerationDirective('dame 3 imágenes estilo anime de gatos', {});
  assert.equal(r.count, 3);
  assert.equal(r.style, 'anime');
});

// ── Edit parsing ──────────────────────────────────────────────────────────

test('parseImageEdit: "en la imagen cambia el cielo…" targets the sky', () => {
  const r = directive.parseImageEdit('en la imagen cambia el cielo a un atardecer naranja');
  assert.equal(r.operation, 'change');
  assert.match(r.target, /cielo/);
  assert.match(r.replacement, /atardecer/);
});

test('parseImageEdit: "solo los ojos" scopes to the target only', () => {
  const r = directive.parseImageEdit('cambia solo los ojos a color verde');
  assert.match(r.target, /ojos/);
  assert.equal(r.scope, 'target-only');
});

test('parseImageEdit: background removal is detected', () => {
  const r = directive.parseImageEdit('quítale el fondo a esta foto');
  assert.equal(r.operation, 'remove-background');
});

// ── Selection normalisation ───────────────────────────────────────────────

test('normalizeImageSelection: fractions become 0..100 boxes', () => {
  const r = directive.normalizeImageSelection({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.selection, { kind: 'box', x: 25, y: 25, width: 50, height: 50 });
});

test('normalizeImageSelection: {0,0,1,1} reads as the full frame', () => {
  const r = directive.normalizeImageSelection({ x: 0, y: 0, width: 1, height: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.selection, { kind: 'box', x: 0, y: 0, width: 100, height: 100 });
});

test('normalizeImageSelection: named regions, labels and bad boxes', () => {
  assert.equal(directive.normalizeImageSelection('center').selection.label, 'center');
  assert.equal(directive.normalizeImageSelection({ kind: 'label', label: 'el cielo' }).selection.label, 'el cielo');
  assert.equal(directive.normalizeImageSelection({ x: 80, y: 80, width: 50, height: 50 }).ok, false);
});

// ── Edit resolver ─────────────────────────────────────────────────────────

test('resolveEditDirective scopes the provider prompt and preserves the rest', () => {
  const r = directive.resolveEditDirective('cambia solo los ojos a color verde', {});
  assert.match(r.prompt, /ojos/);
  assert.match(r.prompt, /conserva el resto de la imagen exactamente igual/);
  assert.equal(r.scope, 'target-only');
});

test('resolveEditDirective honours an explicit selection box', () => {
  const r = directive.resolveEditDirective('cambia el cielo', {
    selection: { x: 0, y: 0, width: 100, height: 40 },
  });
  assert.equal(r.scope, 'selection');
  assert.match(r.prompt, /x=0, y=0, width=100, height=40/);
  assert.match(r.prompt, /fuera de esa región/);
});
