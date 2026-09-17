'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { prepareEditCanvas, finishEditCanvas, canvasSize } = require('../src/services/media/image-edit-canvas');
const png = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

test('reframe expands to the exact requested ratio and retains every original pixel', async () => {
  const original = await png(8, 4, '#d02070ff');
  const canvas = await prepareEditCanvas({ imageBuffer: original, operation: 'reframe', aspectRatio: '3:4' });
  assert.equal(canvas.width / canvas.height, 3 / 4);
  assert.ok(canvas.width >= 8 && canvas.height >= 4);
  const output = await finishEditCanvas(await png(6, 9, '#1040ffff'), canvas);
  const left = Math.floor((canvas.width - 8) / 2); const top = Math.floor((canvas.height - 4) / 2);
  const kept = await sharp(output).extract({ left, top, width: 8, height: 4 }).raw().toBuffer();
  assert.deepEqual(kept, await sharp(original).raw().toBuffer());
  const firstPixel = (await sharp(output).raw().toBuffer()).subarray(0, 4);
  assert.deepEqual([...firstPixel], [16, 64, 255, 255]);
});

test('region edits cannot change any pixel outside the selected box', async () => {
  const original = await png(4, 4, '#ff0000ff');
  const canvas = await prepareEditCanvas({ imageBuffer: original, selection: { x: 0, y: 0, width: 50, height: 50 } });
  const out = await finishEditCanvas(await png(4, 4, '#0000ffff'), canvas);
  const pixels = await sharp(out).raw().toBuffer();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const expected = x < 2 && y < 2 ? [0, 0, 255, 255] : [255, 0, 0, 255];
    assert.deepEqual([...pixels.subarray((y * 4 + x) * 4, (y * 4 + x + 1) * 4)], expected);
  }
  assert.equal((await sharp(canvas.maskBuffer).metadata()).hasAlpha, true);
});

test('real PNG masks use transparency for edits and preserve opaque areas', async () => {
  const original = await png(4, 4, '#20d060ff');
  const mask = await sharp(await png(4, 4, '#ffffffff')).composite([{ input: await png(2, 2, '#ffffffff'), left: 1, top: 1, blend: 'dest-out' }]).png().toBuffer();
  const canvas = await prepareEditCanvas({ imageBuffer: original, maskDataUrl: `data:image/png;base64,${mask.toString('base64')}` });
  const out = await finishEditCanvas(await png(4, 4, '#000000ff'), canvas);
  assert.deepEqual(await sharp(out).extract({ left: 1, top: 1, width: 2, height: 2 }).raw().toBuffer(), await sharp(await png(2, 2, '#000000ff')).raw().toBuffer());
  assert.deepEqual(await sharp(out).extract({ left: 0, top: 0, width: 1, height: 4 }).raw().toBuffer(), await sharp(original).extract({ left: 0, top: 0, width: 1, height: 4 }).raw().toBuffer());
});

test('invalid masks, empty masks and excessive canvases fail before generation', async () => {
  const original = await png(4, 4, '#ff0000ff');
  for (const mask of [await png(2, 2, '#00000000'), await png(4, 4, '#ffffffff')]) {
    await assert.rejects(prepareEditCanvas({ imageBuffer: original, maskDataUrl: `data:image/png;base64,${mask.toString('base64')}` }), { code: 'E_PARAMS' });
  }
  await assert.rejects(prepareEditCanvas({ imageBuffer: original, selection: { x: 110, y: 0, width: 10, height: 10 } }), { code: 'E_PARAMS' });
  assert.throws(() => canvasSize(10000, 10000, '9:16'), { code: 'E_PARAMS' });
});
