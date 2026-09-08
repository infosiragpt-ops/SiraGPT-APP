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
});

function streamOf(buffer) {
  const { Readable } = require('stream');
  return Readable.from([buffer]);
}
