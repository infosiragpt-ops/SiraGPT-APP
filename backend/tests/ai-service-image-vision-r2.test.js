'use strict';

// Regression coverage: prepareImageForVision must resolve R2 refs
// ("r2:<key>") to real bytes instead of failing fs.existsSync and
// silently dropping the image from the vision payload.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const objectStorage = require('../src/services/object-storage');
const service = require('../src/services/ai-service');

describe('prepareImageForVision storage refs', () => {
  test('local missing file returns null without throwing', async () => {
    const out = await service.prepareImageForVision('/nonexistent/img.png', 'image/png');
    assert.equal(out, null);
  });

  test('real local file becomes a base64 data URL', async () => {
    const p = path.join(os.tmpdir(), `vision-${Date.now()}.png`);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const out = await service.prepareImageForVision(p, 'image/png');
      assert.ok(out);
      assert.equal(out.type, 'image_url');
      assert.ok(out.image_url.url.startsWith('data:image/png;base64,'));
    } finally {
      fs.unlinkSync(p);
    }
  });

  test('R2 ref resolves through a fake remote backend', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const calls = { get: 0 };
    objectStorage.__setStorageForTests({
      enabled: true,
      getObject: async () => { calls.get++; return { Body: streamOf(png), ContentLength: png.length, ContentType: 'image/png' }; },
    });
    try {
      const out = await service.prepareImageForVision('r2:uploads/u1/pic.png', 'image/png');
      assert.ok(out, 'R2-backed image must reach the vision payload');
      assert.equal(out.image_url.url.startsWith('data:image/png;base64,'), true);
      assert.equal(calls.get, 1);
    } finally {
      objectStorage.__setStorageForTests(null);
    }
  });

  test('R2 ref with unconfigured storage degrades to null', async () => {
    objectStorage.__setStorageForTests({ enabled: false });
    try {
      const out = await service.prepareImageForVision('r2:uploads/u1/pic.png', 'image/png');
      assert.equal(out, null);
    } finally {
      objectStorage.__setStorageForTests(null);
    }
  });

  // Prod 2026-09-26: the turn held "/app/uploads/<user>/<file>.png" from the
  // File row it loaded, the upload pipeline then moved the binary to R2 and
  // deleted the local copy → «Image file not found» and the model never saw
  // the (a+b)² image. The stale local path must resolve to its R2 copy.
  test('stale local upload path falls back to its R2 copy', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const heads = [];
    objectStorage.__setStorageForTests({
      enabled: true,
      head: async (key) => { heads.push(key); return { ContentLength: png.length, ContentType: 'image/png' }; },
      getObject: async () => ({ Body: streamOf(png), ContentLength: png.length, ContentType: 'image/png' }),
    });
    try {
      const stale = '/app/uploads/cmqymohac0000pd01365ua80u/files-1790464059991-7701f67fe2ce.png';
      const out = await service.prepareImageForVision(stale, 'image/png');
      assert.ok(out, 'the image must still reach the vision payload');
      assert.ok(out.image_url.url.startsWith('data:image/png;base64,'));
      assert.deepEqual(heads, ['uploads/cmqymohac0000pd01365ua80u/files-1790464059991-7701f67fe2ce.png']);
    } finally {
      objectStorage.__setStorageForTests(null);
    }
  });

  test('resolveReadableRef leaves non-upload or absent objects untouched', async () => {
    objectStorage.__setStorageForTests({
      enabled: true,
      head: async () => { throw new Error('NotFound'); },
    });
    try {
      assert.equal(await objectStorage.resolveReadableRef('/app/uploads/u1/gone.png'), '/app/uploads/u1/gone.png');
      assert.equal(await objectStorage.resolveReadableRef('/tmp/elsewhere/x.png'), '/tmp/elsewhere/x.png');
      assert.equal(await objectStorage.resolveReadableRef('r2:uploads/u1/a.png'), 'r2:uploads/u1/a.png');
      assert.equal(await objectStorage.resolveReadableRef(''), '');
    } finally {
      objectStorage.__setStorageForTests(null);
    }
  });

  test('resolveReadableRef is a no-op when R2 is off', async () => {
    objectStorage.__setStorageForTests({ enabled: false });
    try {
      assert.equal(await objectStorage.resolveReadableRef('/app/uploads/u1/gone.png'), '/app/uploads/u1/gone.png');
    } finally {
      objectStorage.__setStorageForTests(null);
    }
  });
});

function streamOf(buffer) {
  const { Readable } = require('stream');
  return Readable.from([buffer]);
}
