'use strict';

// Which attached picture is the canvas and which is material when a turn
// carries several images and nobody pinned one: names, pixels, the words.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { rankEditInputs, describeInputRoles, imageMetrics, isCompositionRequest, hasExplicitOrder, _internal } = require('../src/services/media/image-canvas-selection');

test('file names decide: the logo is material, the photo is the canvas, whatever the upload order', () => {
  const byName = rankEditInputs({ instruction: 'ponle este logo a la foto', images: [{ id: 'a', name: 'logo.png' }, { id: 'b', name: 'foto.jpg' }] });
  assert.equal(byName.canvasId, 'b');
  assert.deepEqual(byName.order, ['b', 'a']);
  assert.deepEqual(byName.roles, { b: 'canvas', a: 'material' });
  assert.equal(byName.changed, true);
  assert.equal(byName.confidence, 'high');
  assert.equal(byName.reason, 'name:material');
  // Already in the right order: nothing changes.
  const kept = rankEditInputs({ instruction: 'ponlo arriba a la derecha', images: [{ id: 'a', name: 'IMG_0042.jpg' }, { id: 'b', name: 'marca-de-agua.png' }] });
  assert.equal(kept.canvasId, 'a');
  assert.equal(kept.changed, false);
  // Three inputs: one canvas, two materials, materials keep their order.
  const three = rankEditInputs({ instruction: 'ponle el logo y la firma', images: [{ id: 'l', name: 'Logo Empresa.PNG' }, { id: 'f', name: 'foto-equipo.jpg' }, { id: 's', name: 'firma.png' }] });
  assert.deepEqual(three.order, ['f', 'l', 's']);
  // Plural and accented names count too.
  assert.equal(rankEditInputs({ instruction: 'ponlos', images: [{ id: 'a', name: 'logos.png' }, { id: 'b', name: 'IMG_2.jpg' }] }).canvasId, 'b');
  assert.equal(rankEditInputs({ instruction: 'ponlos', images: [{ id: 'a', name: 'Sellos oficiales.png' }, { id: 'b', name: 'Fotografía.jpeg' }] }).canvasId, 'b');
  for (const name of ['logo.png', 'logos.png', 'isotipo.svg', 'sello_oficial.png', 'watermark.png', 'qr.png', 'brand-icon.png', 'firmas.png']) assert.match(_internal.fold(name), _internal.MATERIAL_NAME_RE, name);
  for (const name of ['foto.jpg', 'fotos.jpg', 'IMG_1234.HEIC', 'DSC00012.JPG', 'WhatsApp Image 2026-10-11.jpeg', 'producto.png', 'camiseta.jpg']) assert.match(_internal.fold(name), _internal.CANVAS_NAME_RE, name);
});

test('pixels decide when names say nothing: a small transparent PNG is material; size alone never reorders', () => {
  const second = rankEditInputs({ instruction: 'ponle este logo', images: [
    { id: 'a', name: 'a.png', width: 2000, height: 1500 },
    { id: 'b', name: 'b.png', width: 400, height: 400, transparent: true },
  ] });
  assert.equal(second.canvasId, 'a');
  assert.equal(second.changed, false);
  assert.equal(second.confidence, 'high');
  const first = rankEditInputs({ instruction: 'ponle este logo', images: [
    { id: 'a', name: 'a.png', width: 400, height: 400, transparent: true },
    { id: 'b', name: 'b.png', width: 2000, height: 1500 },
  ] });
  assert.equal(first.canvasId, 'b');
  assert.equal(first.changed, true);
  assert.match(first.reason, /alpha/);
  // A transparent image that is NOT small is still material, with less certainty.
  const bigAlpha = rankEditInputs({ instruction: 'edita', images: [{ id: 'a', name: 'a.png', width: 2000, height: 2000, transparent: true }, { id: 'b', name: 'b.jpg', width: 2000, height: 2000 }] });
  assert.equal(bigAlpha.canvasId, 'b');
  assert.equal(bigAlpha.confidence, 'medium');
  // Size alone is no evidence: two photos keep the user's order.
  for (const images of [
    [{ id: 'a', name: 'x1.jpg', width: 300, height: 300 }, { id: 'b', name: 'x2.jpg', width: 3000, height: 2000 }],
    [{ id: 'a', name: 'IMG_2031.jpg', width: 1080, height: 1440 }, { id: 'b', name: 'paisaje.jpg', width: 3840, height: 2160 }],
    [{ id: 'a', name: 'Captura de pantalla.png', width: 1080, height: 1080 }, { id: 'b', name: 'IMG_0001.jpg', width: 4000, height: 3000 }],
  ]) {
    const kept = rankEditInputs({ instruction: 'cambia el fondo de esta foto por este paisaje', images });
    assert.deepEqual(kept.order, ['a', 'b']);
    assert.equal(kept.reason, 'upload-order');
    assert.equal(kept.confidence, 'low');
    assert.equal(kept.changed, false);
  }
});

test('the words decide the direction: editing the logo keeps the logo as canvas; placing it makes the photo the canvas', () => {
  const edits = rankEditInputs({ instruction: 'haz que este logo tenga los colores de esta foto', images: [{ id: 'l', name: 'logo.png', width: 800, height: 800 }, { id: 'f', name: 'foto.jpg', width: 4000, height: 3000 }] });
  assert.equal(edits.canvasId, 'l');
  assert.equal(edits.changed, false);
  assert.match(edits.reason, /^instruction:edits-material/);
  const recolour = rankEditInputs({ instruction: 'cambia el color del logo', images: [{ id: 'f', name: 'foto.jpg' }, { id: 'l', name: 'logo.png' }] });
  assert.equal(recolour.canvasId, 'l');
  assert.equal(recolour.changed, true);
  for (const instruction of ['ponle este logo a la foto', 'el logo debe quedar centrado en la foto', 'agrega el logo arriba a la derecha', 'put this logo on the photo']) {
    const placed = rankEditInputs({ instruction, images: [{ id: 'l', name: 'logo.png' }, { id: 'f', name: 'foto.jpg' }] });
    assert.equal(placed.canvasId, 'f', instruction);
  }
});

test('the user\'s own order, a composition, two logos or no evidence keep the upload order; a single image is the canvas', () => {
  const explicit = rankEditInputs({ instruction: 'quita el fondo de la primera imagen', images: [{ id: 'a', name: 'logo.png' }, { id: 'b', name: 'foto.jpg' }] });
  assert.deepEqual([explicit.order, explicit.reason, explicit.changed], [['a', 'b'], 'explicit-order', false]);
  assert.equal(hasExplicitOrder('pon la segunda sobre la primera'), true);
  assert.equal(hasExplicitOrder('ponle este logo a la foto'), false);
  const collage = rankEditInputs({ instruction: 'haz un collage con estas dos imágenes', images: [{ id: 'a', name: 'logo.png' }, { id: 'b', name: 'foto.jpg' }] });
  assert.deepEqual([collage.order, collage.reason], [['a', 'b'], 'composition']);
  for (const text of ['combina estas dos fotos en una sola', 'únelas lado a lado', 'merge these two photos', 'pon la cara de la segunda en la primera', 'face swap']) assert.equal(isCompositionRequest(text) || hasExplicitOrder(text), true, text);
  assert.equal(isCompositionRequest('ponle este logo a la foto'), false);
  const logos = rankEditInputs({ instruction: 'ponle este logo', images: [{ id: 'a', name: 'logo1.png' }, { id: 'b', name: 'logo2.png' }] });
  assert.deepEqual([logos.order, logos.reason, logos.confidence], [['a', 'b'], 'all-material', 'low']);
  const tie = rankEditInputs({ instruction: 'edita', images: [{ id: 'a', name: 'a.jpg', width: 1000, height: 1000 }, { id: 'b', name: 'b.jpg', width: 1000, height: 1000 }] });
  assert.deepEqual([tie.order, tie.reason, tie.confidence, tie.changed], [['a', 'b'], 'upload-order', 'low', false]);
  const single = rankEditInputs({ instruction: 'x', images: [{ id: 'only', name: 'logo.png' }] });
  assert.deepEqual(single, { canvasId: 'only', referenceIds: [], order: ['only'], roles: { only: 'canvas' }, reason: 'single', confidence: 'high', changed: false });
  assert.equal(rankEditInputs({ images: [] }).canvasId, null);
  assert.equal(rankEditInputs().canvasId, null);
});

test('describeInputRoles names the canvas and the material for the editor, never an internal id or a URL', () => {
  const es = describeInputRoles([{ record: { originalName: 'foto.jpg' } }, { record: { filename: 'logo.png' } }], { language: 'es' });
  assert.match(es, /La imagen 1 \(«foto\.jpg»\) es el lienzo que se edita; la imagen 2 \(«logo\.png»\) es material/);
  assert.match(es, /nunca redibujes el lienzo/);
  const en = describeInputRoles([{ record: { originalName: 'photo.jpg' } }, { record: { originalName: 'logo.png' } }, { record: { originalName: 'sign.png' } }], { language: 'en' });
  assert.match(en, /Input image 1 \(«photo\.jpg»\) is the canvas to edit; input image 2 \(«logo\.png»\) and input image 3 \(«sign\.png»\) are material/);
  assert.equal(describeInputRoles([{ source: 'one.png' }]), '');
  assert.equal(describeInputRoles([]), '');
  // Artifacts, data URLs and remote URLs get a neutral label; a path or a
  // query string never reaches the prompt.
  const neutral = describeInputRoles([{ source: 'artifact:3fa9c2d1e0aa' }, { source: 'https://cdn.example.com/a/b/c.jpg?X-Amz-Signature=abc' }, { source: 'data-url' }], { language: 'es' });
  assert.match(neutral, /«imagen 1».*«imagen 2».*«imagen 3»/);
  assert.doesNotMatch(neutral, /artifact|cdn\.example|X-Amz|data-url/);
  assert.equal(_internal.displayNameOf({ record: { originalName: 'uploads/u1/Foto final (2).jpeg' } }, 0), 'Foto final (2).jpeg');
  assert.equal(_internal.displayNameOf({ record: { originalName: 'x'.repeat(120) + '.png' } }, 1), 'imagen 2');
  assert.equal(_internal.displayNameOf({ record: { originalName: 'logo.png?token=1' } }, 1, 'en'), 'logo.png');
});

test('imageMetrics reads real pixels (transparency included, on a thumbnail) and tolerates junk', async () => {
  const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const opaqueWithAlphaChannel = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
  const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const large = await sharp({ create: { width: 1800, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const t = await imageMetrics(transparent);
  assert.equal(t.transparent, true);
  assert.equal(t.area, 64 * 64);
  const o = await imageMetrics(opaqueWithAlphaChannel);
  assert.equal(o.transparent, false, 'an alpha channel that is fully opaque is not transparency');
  const p = await imageMetrics(photo);
  assert.deepEqual([p.width, p.height, p.transparent], [640, 480, false]);
  const l = await imageMetrics(large);
  assert.deepEqual([l.width, l.height, l.transparent], [1800, 1200, true]);
  assert.deepEqual(await imageMetrics(Buffer.from('nope')), { width: null, height: null, area: null, transparent: false, bytes: 4 });
  assert.equal((await imageMetrics(null)).bytes, 0);
});
