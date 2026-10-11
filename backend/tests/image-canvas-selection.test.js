'use strict';

// Which attached picture is the canvas and which is material when a turn
// carries several images and nobody pinned one: names, pixels, the words.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { rankEditInputs, describeInputRoles, imageMetrics, _internal } = require('../src/services/media/image-canvas-selection');

test('file names decide: the logo is material, the photo is the canvas, whatever the upload order', () => {
  const byName = rankEditInputs({ instruction: 'ponle este logo a la foto', images: [{ id: 'a', name: 'logo.png' }, { id: 'b', name: 'foto.jpg' }] });
  assert.equal(byName.canvasId, 'b');
  assert.deepEqual(byName.order, ['b', 'a']);
  assert.deepEqual(byName.roles, { b: 'canvas', a: 'material' });
  assert.equal(byName.changed, true);
  assert.equal(byName.confidence, 'high');
  // Already in the right order: nothing changes.
  const kept = rankEditInputs({ instruction: 'ponlo arriba a la derecha', images: [{ id: 'a', name: 'IMG_0042.jpg' }, { id: 'b', name: 'marca-de-agua.png' }] });
  assert.equal(kept.canvasId, 'a');
  assert.equal(kept.changed, false);
  // Three inputs: one canvas, two materials, materials keep their order.
  const three = rankEditInputs({ instruction: 'ponle el logo y la firma', images: [{ id: 'l', name: 'Logo Empresa.PNG' }, { id: 'f', name: 'foto-equipo.jpg' }, { id: 's', name: 'firma.png' }] });
  assert.deepEqual(three.order, ['f', 'l', 's']);
  for (const name of ['logo.png', 'isotipo.svg', 'sello_oficial.png', 'watermark.png', 'qr.png', 'brand-icon.png']) assert.match(_internal.fold(name), _internal.MATERIAL_NAME_RE, name);
  for (const name of ['foto.jpg', 'IMG_1234.HEIC', 'DSC00012.JPG', 'WhatsApp Image 2026-10-11.jpeg', 'producto.png', 'camiseta.jpg']) assert.match(_internal.fold(name), _internal.CANVAS_NAME_RE, name);
});

test('pixels decide when names say nothing: a small transparent PNG is material', () => {
  const second = rankEditInputs({ instruction: 'ponle este logo', images: [
    { id: 'a', name: 'a.png', width: 2000, height: 1500 },
    { id: 'b', name: 'b.png', width: 400, height: 400, transparent: true },
  ] });
  assert.equal(second.canvasId, 'a');
  assert.equal(second.changed, false);
  const first = rankEditInputs({ instruction: 'ponle este logo', images: [
    { id: 'a', name: 'a.png', width: 400, height: 400, transparent: true },
    { id: 'b', name: 'b.png', width: 2000, height: 1500 },
  ] });
  assert.equal(first.canvasId, 'b');
  assert.equal(first.changed, true);
  assert.equal(first.confidence, 'high');
  assert.match(first.reason, /alpha/);
  // Size alone is weak evidence: the order still flips, but with low confidence.
  const small = rankEditInputs({ instruction: 'edita', images: [{ id: 'a', name: 'x1.jpg', width: 300, height: 300 }, { id: 'b', name: 'x2.jpg', width: 3000, height: 2000 }] });
  assert.equal(small.canvasId, 'b');
  assert.equal(small.confidence, 'low');
});

test('no evidence keeps the upload order and says so; a single image is the canvas', () => {
  const tie = rankEditInputs({ instruction: 'combina estas dos', images: [{ id: 'a', name: 'a.jpg', width: 1000, height: 1000 }, { id: 'b', name: 'b.jpg', width: 1000, height: 1000 }] });
  assert.deepEqual(tie.order, ['a', 'b']);
  assert.equal(tie.reason, 'upload-order');
  assert.equal(tie.confidence, 'low');
  assert.equal(tie.changed, false);
  const single = rankEditInputs({ instruction: 'x', images: [{ id: 'only', name: 'logo.png' }] });
  assert.deepEqual(single, { canvasId: 'only', referenceIds: [], order: ['only'], roles: { only: 'canvas' }, reason: 'single', confidence: 'high', changed: false });
  assert.equal(rankEditInputs({ images: [] }).canvasId, null);
  assert.equal(rankEditInputs().canvasId, null);
});

test('describeInputRoles names the canvas and the material for the editor, in the request language', () => {
  const es = describeInputRoles([{ record: { originalName: 'foto.jpg' } }, { record: { filename: 'logo.png' } }], { language: 'es' });
  assert.match(es, /La imagen 1 \(«foto\.jpg»\) es el lienzo que se edita; la imagen 2 \(«logo\.png»\) es material/);
  assert.match(es, /nunca redibujes el lienzo/);
  const en = describeInputRoles([{ source: 'photo.jpg' }, { source: 'logo.png' }, { source: 'sign.png' }], { language: 'en' });
  assert.match(en, /Input image 1 \(«photo\.jpg»\) is the canvas to edit; input image 2 \(«logo\.png»\) and input image 3 \(«sign\.png»\) are material/);
  assert.equal(describeInputRoles([{ source: 'one.png' }]), '');
  assert.equal(describeInputRoles([]), '');
  // Nameless sources still get a stable label.
  assert.match(describeInputRoles([{}, {}], { language: 'es' }), /«imagen 1».*«imagen 2»/);
});

test('imageMetrics reads real pixels (transparency included) and tolerates junk', async () => {
  const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const opaqueWithAlphaChannel = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
  const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const t = await imageMetrics(transparent);
  assert.equal(t.transparent, true);
  assert.equal(t.area, 64 * 64);
  const o = await imageMetrics(opaqueWithAlphaChannel);
  assert.equal(o.transparent, false, 'an alpha channel that is fully opaque is not transparency');
  const p = await imageMetrics(photo);
  assert.deepEqual([p.width, p.height, p.transparent], [640, 480, false]);
  assert.deepEqual(await imageMetrics(Buffer.from('nope')), { width: null, height: null, area: null, transparent: false, bytes: 4 });
  assert.equal((await imageMetrics(null)).bytes, 0);
});
