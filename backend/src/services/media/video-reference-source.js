'use strict';

const sharp = require('sharp');
const { resolveImageSource, MAX_IMAGE_BYTES } = require('./image-source');

// Resolve protected uploads/artifacts by ownership, then fully decode the
// pixels before starting a paid job. An unreadable reference is never skipped.
async function resolveVideoReferenceImages(urls, context = {}) {
  const images = [];
  const signal = context.signal || AbortSignal.timeout(15000);
  let totalBytes = 0;
  for (let index = 0; index < urls.length; index += 1) {
    try {
      signal.throwIfAborted();
      const source = await resolveImageSource({ imageUrl: urls[index] }, {
        ...context,
        signal,
      });
      if (!source?.buffer?.length) throw new Error('missing source');
      const buffer = await sharp(source.buffer, { limitInputPixels: 40000000, failOn: 'error' })
        .rotate().png().toBuffer();
      signal.throwIfAborted();
      totalBytes += buffer.length;
      if (buffer.length > MAX_IMAGE_BYTES || totalBytes > 40 * 1024 * 1024) throw new Error('oversized source');
      images.push({ buffer, mimeType: 'image/png' });
    } catch {
      const error = new Error(`No se pudo leer la imagen de referencia ${index + 1}. Vuelve a adjuntarla como PNG, JPEG o WebP y comprueba que te pertenece.`);
      error.status = 422;
      error.code = 'E_PARAMS';
      throw error;
    }
  }
  return images;
}

module.exports = { resolveVideoReferenceImages };
