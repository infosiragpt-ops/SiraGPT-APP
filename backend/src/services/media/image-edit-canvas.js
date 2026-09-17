'use strict';

const sharp = require('sharp');
const { normalizeImageSelection } = require('../agents/image-directive');
const MAX_PIXELS = 40 * 1024 * 1024;
function params(message) { const error = new Error(message); error.code = 'E_PARAMS'; error.status = 400; return error; }
const read = (buffer) => sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' });

function canvasSize(width, height, ratio) {
  const [w, h] = String(ratio || '').split(':').map(Number);
  if (!w || !h || !Number.isFinite(w / h)) throw params('El formato de imagen no es válido.');
  // Whole multiples retain the EXACT target ratio, extending the canvas.
  const unit = Math.ceil(Math.max(width / w, height / h));
  const target = { width: unit * w, height: unit * h };
  if (target.width * target.height > MAX_PIXELS) throw params('El nuevo lienzo es demasiado grande. Usa una imagen de menor tamaño.');
  return target;
}

/** Transparent mask pixels are editable; opaque pixels are protected. */
async function prepareEditCanvas({ imageBuffer, operation = 'edit', aspectRatio, selection, maskDataUrl } = {}) {
  const source = await read(imageBuffer).rotate().ensureAlpha().png().toBuffer();
  const metadata = await read(source).metadata();
  const sourceWidth = metadata.width; const sourceHeight = metadata.height;
  let width = sourceWidth; let height = sourceHeight;
  let original = source; let protectedMask = null;
  if (operation === 'reframe') {
    if (selection || maskDataUrl) throw params('Cambia primero el tamaño y después edita una región.');
    ({ width, height } = canvasSize(sourceWidth, sourceHeight, aspectRatio));
    const left = Math.floor((width - sourceWidth) / 2); const top = Math.floor((height - sourceHeight) / 2);
    original = await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
      .composite([{ input: source, left, top }]).png().toBuffer();
    protectedMask = await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
      .composite([{ input: await sharp({ create: { width: sourceWidth, height: sourceHeight, channels: 4, background: '#ffffffff' } }).png().toBuffer(), left, top }]).png().toBuffer();
  } else if (maskDataUrl) {
    const match = String(maskDataUrl).match(/^data:image\/png;base64,([a-z0-9+/=]+)$/i);
    if (!match || match[1].length > 8 * 1024 * 1024) throw params('La máscara debe ser un PNG de hasta 6 MB.');
    const mask = Buffer.from(match[1], 'base64');
    const info = await read(mask).metadata();
    if (info.format !== 'png' || !info.hasAlpha || info.width !== width || info.height !== height) {
      throw params('La máscara PNG debe tener transparencia y el mismo tamaño que la imagen.');
    }
    protectedMask = await read(mask).ensureAlpha().png().toBuffer();
  } else if (selection) {
    const normalized = normalizeImageSelection(selection);
    if (!normalized.ok || normalized.selection.kind !== 'box') throw params('Selecciona una región rectangular válida para editar.');
    const box = normalized.selection;
    const left = Math.floor(box.x * width / 100); const top = Math.floor(box.y * height / 100);
    const boxWidth = Math.min(width - left, Math.max(1, Math.ceil(box.width * width / 100)));
    const boxHeight = Math.min(height - top, Math.max(1, Math.ceil(box.height * height / 100)));
    protectedMask = await sharp({ create: { width, height, channels: 4, background: '#ffffffff' } })
      .composite([{ input: await sharp({ create: { width: boxWidth, height: boxHeight, channels: 4, background: '#ffffffff' } }).png().toBuffer(), left, top, blend: 'dest-out' }]).png().toBuffer();
  }
  // Normalize masks to binary alpha so partially transparent paint strokes do
  // not leak changes into pixels the user did not include in the selection.
  if (protectedMask) {
    const rgba = await read(protectedMask).ensureAlpha().raw().toBuffer();
    let editable = false;
    for (let index = 0; index < rgba.length; index += 4) {
      const alpha = rgba[index + 3] < 128 ? 0 : 255;
      rgba[index] = 255; rgba[index + 1] = 255; rgba[index + 2] = 255; rgba[index + 3] = alpha;
      if (alpha === 0) editable = true;
    }
    if (!editable && operation !== 'reframe') throw params('La selección no contiene ninguna zona editable.');
    protectedMask = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }
  return { imageBuffer: original, mimeType: 'image/png', maskBuffer: protectedMask, width, height, sourceWidth, sourceHeight, operation };
}

/** Restore every protected pixel from the source, independent of the model. */
async function finishEditCanvas(resultBuffer, canvas) {
  if (!canvas.maskBuffer) return read(resultBuffer).resize(canvas.width, canvas.height, { fit: 'fill' }).png().toBuffer();
  const edited = await read(resultBuffer).resize(canvas.width, canvas.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const original = await read(canvas.imageBuffer).ensureAlpha().raw().toBuffer();
  const mask = await read(canvas.maskBuffer).ensureAlpha().raw().toBuffer();
  for (let index = 0; index < edited.length; index += 4) {
    if (mask[index + 3] === 255) original.copy(edited, index, index, index + 4);
  }
  return sharp(edited, { raw: { width: canvas.width, height: canvas.height, channels: 4 } }).png().toBuffer();
}

module.exports = { prepareEditCanvas, finishEditCanvas, canvasSize };
