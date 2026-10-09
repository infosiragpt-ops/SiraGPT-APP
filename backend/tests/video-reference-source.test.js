'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { resolveVideoReferenceImages } = require('../src/services/media/video-reference-source');
const directory = fs.mkdtemp(path.join(os.tmpdir(), 'video-reference-'));
after(async () => fs.rm(await directory, { recursive: true, force: true }));

async function fixture() {
  const png = await sharp({ create: { width: 16, height: 10, channels: 3, background: '#bb1122' } }).png().toBuffer();
  const filePath = path.join(await directory, 'source.png');
  await fs.writeFile(filePath, png);
  const prisma = { file: { findFirst: async ({ where }) => {
    assert.equal(where.userId, 'owner');
    assert.equal(where.deletedAt, null);
    return where.filename === 'source.png' ? { id: 'file', path: filePath, mimeType: 'image/png' } : null;
  } } };
  return { png, prisma, userId: 'owner' };
}

test('protected image uploads resolve owned bytes and keep actual pixels for video', async () => {
  const ctx = await fixture();
  const references = await resolveVideoReferenceImages(['https://siragpt.example/uploads/owner/source.png'], ctx);
  assert.equal(references.length, 1);
  assert.equal(references[0].mimeType, 'image/png');
  const metadata = await sharp(references[0].buffer).metadata();
  assert.equal(metadata.width, 16); assert.equal(metadata.height, 10);
  assert.deepEqual(await sharp(references[0].buffer).raw().toBuffer(), await sharp(ctx.png).raw().toBuffer());
});

test('missing/unowned reference aborts the complete set instead of skipping it', async () => {
  await assert.rejects(resolveVideoReferenceImages(['/uploads/owner/source.png', '/uploads/other/private.png'], await fixture()), (err) => {
    assert.equal(err.code, 'E_PARAMS'); assert.equal(err.status, 422);
    assert.match(err.message, /referencia 2/); return true;
  });
});

test('claimed PNG MIME is verified by full image decode', async () => {
  await assert.rejects(resolveVideoReferenceImages(['data:image/png;base64,aGVsbG8='], { userId: 'owner' }), { code: 'E_PARAMS' });
});

test('data references preserve ordering and become decodable PNG images', async () => {
  const ctx = await fixture();
  const result = await resolveVideoReferenceImages([`data:image/png;base64,${ctx.png.toString('base64')}`], { userId: 'owner' });
  assert.equal((await sharp(result[0].buffer).metadata()).format, 'png');
});
