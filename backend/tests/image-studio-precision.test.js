'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  classifyImageIntent,
  parseCompoundEditDeltas,
  extractSpatialAnchors,
  extractPreservationExclusions,
  buildStrictEditContract,
  buildStrictGenerationContract,
} = require('../src/services/media/image-intent-planner');
const { prepareEditCanvas, finishEditCanvas } = require('../src/services/media/image-edit-canvas');
const imageEngine = require('../src/services/media/image-engine');
const { resolveEditDirective } = require('../src/services/agents/image-directive');
const {
  extractChromaticAndTraitOverrides,
  mergeOverrideChain,
  compileCumulativeVisualState,
} = require('../src/services/media/image-visual-dna');
const {
  parseRequestedVideoDurationSeconds,
  planVideoSegments,
  formatDurationLabelEs,
} = require('../src/services/video-duration-planner');

const png = (width, height, background) =>
  sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

test('image-intent-planner splits compound multi-clause edit instructions without dropping any delta', () => {
  const prompt = 'cambia el cielo a naranja y agrega un pájaro en la esquina superior derecha sin cambiar el gato';
  const deltas = parseCompoundEditDeltas(prompt);
  assert.equal(deltas.length, 2);
  assert.match(deltas[0], /cambia el cielo a naranja/i);
  assert.match(deltas[1], /agrega un pájaro/i);

  const plan = classifyImageIntent(prompt, { hasSourceImage: true, isReplyToImage: true });
  assert.equal(plan.intent, 'surgical_text_edit');
  assert.equal(plan.strictness, 'millimetric');
  assert.equal(plan.isCompoundEdit, true);
  assert.ok(plan.spatialAnchors.some((a) => a.id === 'top-right'));
  assert.ok(plan.keepInvariants.some((inv) => /gato/i.test(inv)));

  const contract = buildStrictEditContract(plan, { language: 'es' });
  assert.match(contract, /Aplica TODOS los 2 cambios pedidos/i);
  assert.match(contract, /Elementos bloqueados/i);
  assert.match(contract, /Bloqueo de precisión milimétrica/i);
});

test('image-intent-planner generates strict spatial and exclusion contract for fresh generations', () => {
  const prompt = 'Un gato azul sentado a la izquierda con texto "SIRA PRO", sin personas y sin marca de agua';
  const plan = classifyImageIntent(prompt, { hasSourceImage: false });
  assert.equal(plan.intent, 'generate_fresh');
  assert.deepEqual(plan.quotedTexts, ['SIRA PRO']);
  assert.ok(plan.spatialAnchors.some((a) => a.id === 'left'));
  const exclusions = extractPreservationExclusions(prompt);
  assert.ok(exclusions.omitElements.some((o) => /personas/i.test(o)));
  assert.ok(exclusions.omitElements.some((o) => /marca de agua/i.test(o)));

  const contract = buildStrictGenerationContract(plan);
  assert.match(contract, /left side/i);
  assert.match(contract, /personas/i);
});

test('image-directive preserves compound edits and emits millimeter mask bounds when hasMask is true', () => {
  const compound = resolveEditDirective('cambia los ojos a verde y ponle un collar dorado');
  assert.match(compound.prompt, /Aplica TODOS los cambios solicitados fielmente/i);
  assert.match(compound.prompt, /collar dorado/i);
  assert.doesNotMatch(compound.prompt, /Enfoca el cambio en los ojos/i);

  const masked = resolveEditDirective('borra el reflejo', {
    hasMask: true,
    maskBounds: { x: 20, y: 30, width: 15, height: 10 },
  });
  assert.equal(masked.scope, 'selection');
  assert.match(masked.prompt, /máscara de precisión proporcionada/i);
  assert.match(masked.prompt, /x=20%.*y=30%.*width=15%.*height=10%/i);
});

test('prepareEditCanvas computes exact normalized maskBounds for brush/freehand alpha masks', async () => {
  const original = await png(20, 10, '#102030ff');
  const mask = await sharp(await png(20, 10, '#ffffffff'))
    .composite([{ input: await png(4, 2, '#ffffffff'), left: 10, top: 5, blend: 'dest-out' }])
    .png()
    .toBuffer();

  const canvas = await prepareEditCanvas({
    imageBuffer: original,
    maskDataUrl: `data:image/png;base64,${mask.toString('base64')}`,
  });

  assert.deepEqual(canvas.maskBounds, {
    x: 50,
    y: 50,
    width: 20,
    height: 20,
    coveragePercent: 4,
  });

  const out = await finishEditCanvas(await png(20, 10, '#ffaa00ff'), canvas);
  const untouched = await sharp(out).extract({ left: 0, top: 0, width: 10, height: 5 }).raw().toBuffer();
  assert.deepEqual([...untouched.subarray(0, 4)], [16, 32, 48, 255]);
  const edited = await sharp(out).extract({ left: 10, top: 5, width: 4, height: 2 }).raw().toBuffer();
  assert.deepEqual([...edited.subarray(0, 4)], [255, 170, 0, 255]);
});

test('imageEngine.canEditImage maintains OpenRouter parity with image-model-capabilities', () => {
  assert.equal(imageEngine.canEditImage({ provider: 'openrouter', model: 'black-forest-labs/flux-1.1-pro' }), false);
  assert.equal(imageEngine.canEditImage({ provider: 'openrouter', model: 'google/gemini-3.1-flash-image-preview' }), true);
  assert.equal(imageEngine.canEditImage({ provider: 'openrouter', model: 'openai/gpt-image-2' }), true);
  assert.equal(imageEngine.canEditImage({ provider: 'openai', model: 'gpt-image-2' }), true);
});

test('image-visual-dna honors prop removal, replaces environment time slots, and scopes furniture colors off the subject', () => {
  // 1. Prop addition then removal
  const turn1 = extractChromaticAndTraitOverrides('ponle un sombrero y gafas de sol');
  const turn2 = extractChromaticAndTraitOverrides('ahora quítale el sombrero');
  const merged = mergeOverrideChain([turn1, turn2]);
  assert.equal(merged.some((o) => o.kind === 'prop' && o.id === 'hat'), false);
  assert.equal(merged.some((o) => o.kind === 'prop' && o.id === 'glasses'), true);

  // 2. Environment time slot replacement ("de noche" -> "de día")
  const night = extractChromaticAndTraitOverrides('hazlo de noche bajo la lluvia');
  const day = extractChromaticAndTraitOverrides('ahora de día');
  const mergedEnv = mergeOverrideChain([night, day]);
  assert.equal(mergedEnv.some((o) => o.kind === 'environment' && o.id === 'night'), false);
  assert.equal(mergedEnv.some((o) => o.kind === 'environment' && o.id === 'day'), true);
  assert.equal(mergedEnv.some((o) => o.kind === 'environment' && o.id === 'rain'), true);

  // 3. Furniture/object color scope must NEVER paint the primary subject
  const tableColor = extractChromaticAndTraitOverrides('cambia el color de la mesa a rojo');
  assert.equal(tableColor.length, 1);
  assert.equal(tableColor[0].scope, 'accessory');
  assert.equal(tableColor[0].targetNoun, 'mesa');

  const state = compileCumulativeVisualState({
    currentPrompt: 'cambia el color de la mesa a rojo',
    historyEntries: [{ prompt: 'un gato azul sentado junto a una mesa de madera' }],
  });
  assert.doesNotMatch(state.editEnhancementClause, /primary subject color strictly vivid red/i);
  assert.match(state.editEnhancementClause, /mesa colored/i);
});

test('video-duration-planner parses seconds, minutes, clock notation, and builds multi-segment plans', () => {
  assert.equal(parseRequestedVideoDurationSeconds('convierte esta imagen en video de 30 segundos'), 30);
  assert.equal(parseRequestedVideoDurationSeconds('haz un video de 1 minuto'), 60);
  assert.equal(parseRequestedVideoDurationSeconds('video de 2 minutos y medio'), 150);
  assert.equal(parseRequestedVideoDurationSeconds('video de 1:30 con movimiento suave'), 90);
  assert.equal(parseRequestedVideoDurationSeconds('medio minuto de animación'), 30);
  assert.equal(parseRequestedVideoDurationSeconds('anima el gato', 120), 120);

  assert.equal(formatDurationLabelEs(8), '8 s');
  assert.equal(formatDurationLabelEs(60), '1 min');
  assert.equal(formatDurationLabelEs(90), '1 min 30 s');

  const single = planVideoSegments({ targetDurationSeconds: 8, clipDurationSeconds: 8, prompt: 'El gato parpadea', isImageToVideo: true });
  assert.equal(single.isMultiSegment, false);
  assert.equal(single.segmentCount, 1);

  const oneMin = planVideoSegments({ targetDurationSeconds: 60, clipDurationSeconds: 8, prompt: 'El gato camina por la sala', isImageToVideo: true });
  assert.equal(oneMin.isMultiSegment, true);
  assert.equal(oneMin.segmentCount, 8);
  assert.equal(oneMin.plannedDurationSeconds, 64);
  assert.match(oneMin.segments[0].prompt, /Scene 1\/8 \(0s-8s\)/);
  assert.match(oneMin.segments[1].prompt, /exact last frame of scene 1/);
  assert.match(oneMin.segments[7].prompt, /closing beat/);
});
