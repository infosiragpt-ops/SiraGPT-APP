'use strict';

const MAX_SOCIAL_IMAGE_BYTES = 5 * 1024 * 1024;

function postConfig(post) {
  return post?.config && typeof post.config === 'object' && !Array.isArray(post.config)
    ? post.config
    : {};
}

function mediaPrompt(post) {
  const config = postConfig(post);
  if (config.generateImage !== true) return '';
  return String(config.mediaBrief || '').trim().slice(0, 2_000);
}

async function defaultTransformImage(buffer) {
  // Lazy-load native sharp bindings only when a publication actually needs media.
  // eslint-disable-next-line global-require
  const sharp = require('sharp');
  const attempts = [
    { width: 2_048, quality: 88 },
    { width: 1_600, quality: 78 },
    { width: 1_200, quality: 68 },
  ];
  let output = null;
  for (const attempt of attempts) {
    // eslint-disable-next-line no-await-in-loop
    output = await sharp(buffer)
      .rotate()
      .resize({
        width: attempt.width,
        height: attempt.width,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality, mozjpeg: true })
      .toBuffer();
    if (output.length <= MAX_SOCIAL_IMAGE_BYTES) break;
  }
  if (!output || output.length === 0 || output.length > MAX_SOCIAL_IMAGE_BYTES) {
    const error = new Error('Generated image exceeds the 5 MB social publishing limit');
    error.code = 'SOCIAL_IMAGE_TOO_LARGE';
    throw error;
  }
  return { buffer: output, mime: 'image/jpeg' };
}

async function prepareMediaForPost({
  post,
  imageGenerator = null,
  transformImage = defaultTransformImage,
} = {}) {
  const prompt = mediaPrompt(post);
  if (!prompt) {
    return {
      media: null,
      metadata: { status: 'not_requested' },
    };
  }

  try {
    // eslint-disable-next-line global-require
    const generateImage = imageGenerator
      || require('../media/image-engine').generateImage;
    const result = await generateImage({
      prompt,
      aspectRatio: '1:1',
      quality: '1K',
      n: 1,
      failover: true,
    });
    const encoded = result?.images?.[0]?.b64;
    if (!result?.ok || !encoded) {
      const error = new Error(result?.error || 'Image provider returned no image');
      error.code = result?.code || 'SOCIAL_IMAGE_GENERATION_FAILED';
      throw error;
    }
    const raw = Buffer.from(encoded, 'base64');
    if (!raw.length) {
      const error = new Error('Image provider returned an empty image');
      error.code = 'SOCIAL_IMAGE_EMPTY';
      throw error;
    }
    const normalized = await transformImage(raw, result?.images?.[0]?.mime || 'image/png');
    if (!Buffer.isBuffer(normalized?.buffer) || !normalized.buffer.length) {
      const error = new Error('Generated image normalization returned no data');
      error.code = 'SOCIAL_IMAGE_NORMALIZATION_FAILED';
      throw error;
    }
    return {
      media: {
        buffer: normalized.buffer,
        mime: normalized.mime || 'image/jpeg',
        altText: prompt.slice(0, 120),
        generated: true,
      },
      metadata: {
        status: 'generated',
        provider: result.provider || null,
        model: result.model || null,
        bytes: normalized.buffer.length,
        mime: normalized.mime || 'image/jpeg',
      },
    };
  } catch (error) {
    return {
      media: null,
      metadata: {
        status: 'failed',
        code: String(error?.code || 'SOCIAL_IMAGE_GENERATION_FAILED').slice(0, 80),
        message: String(error?.message || 'Image generation failed').slice(0, 240),
      },
    };
  }
}

module.exports = {
  MAX_SOCIAL_IMAGE_BYTES,
  mediaPrompt,
  postConfig,
  prepareMediaForPost,
  _internal: {
    defaultTransformImage,
  },
};
