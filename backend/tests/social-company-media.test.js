'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mediaPrompt,
  prepareMediaForPost,
} = require('../src/services/social-company/media');

test('media preparation generates one normalized image for CEO autopilot content', async () => {
  let receivedSpec = null;
  let receivedRaw = null;
  const result = await prepareMediaForPost({
    post: {
      config: {
        generateImage: true,
        mediaBrief: 'Equipo profesional revisando métricas en una oficina luminosa.',
      },
    },
    imageGenerator: async (spec) => {
      receivedSpec = spec;
      return {
        ok: true,
        provider: 'openai',
        model: 'gpt-image-2',
        images: [{ b64: Buffer.from('raw-image').toString('base64'), mime: 'image/png' }],
      };
    },
    transformImage: async (buffer) => {
      receivedRaw = buffer;
      return { buffer: Buffer.from('normalized-image'), mime: 'image/jpeg' };
    },
  });

  assert.equal(receivedSpec.aspectRatio, '1:1');
  assert.equal(receivedSpec.n, 1);
  assert.equal(receivedRaw.toString(), 'raw-image');
  assert.equal(result.media.buffer.toString(), 'normalized-image');
  assert.equal(result.media.mime, 'image/jpeg');
  assert.equal(result.media.generated, true);
  assert.equal(result.metadata.status, 'generated');
  assert.equal(result.metadata.provider, 'openai');
});

test('media preparation fails soft so text publication can continue', async () => {
  const result = await prepareMediaForPost({
    post: {
      config: {
        generateImage: true,
        mediaBrief: 'Imagen editorial profesional.',
      },
    },
    imageGenerator: async () => ({
      ok: false,
      code: 'NO_PROVIDER',
      error: 'No image provider configured',
    }),
  });

  assert.equal(result.media, null);
  assert.equal(result.metadata.status, 'failed');
  assert.equal(result.metadata.code, 'NO_PROVIDER');
});

test('media generation is opt-in and ignores a brief without the explicit flag', () => {
  assert.equal(mediaPrompt({ config: { mediaBrief: 'No generar todavía.' } }), '');
  assert.equal(
    mediaPrompt({ config: { mediaBrief: 'Generar.', generateImage: true } }),
    'Generar.',
  );
});
