'use strict';

// Local image edits never invoke a generation provider or charge credits.
// Bytes are immutable; comments/hiding belong to one attachment in one message.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { z } = require('zod');
const { resolveImageSource, messageFiles, MAX_IMAGE_BYTES } = require('./image-source');
const objectStorage = require('../object-storage');

const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 8192;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const idSchema = z.string().trim().min(1).max(160);
const contextSchema = z.object({ chatId: idSchema, messageId: idSchema });
const commentSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(4000),
  x: z.number().finite().min(0).max(100),
  y: z.number().finite().min(0).max(100),
}).strict();
const editSchema = contextSchema.extend({
  operation: z.enum(['annotate', 'comment', 'resize']),
  sourceImageDataUrl: z.string().max(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64).optional(),
  comments: z.array(commentSchema).max(100).optional(),
  width: z.number().int().min(1).max(MAX_DIMENSION).optional(),
  height: z.number().int().min(1).max(MAX_DIMENSION).optional(),
}).strict();

function failure(message, status = 400, code = 'E_PARAMS') {
  return Object.assign(new Error(message), { status, code });
}

function parseInput(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw failure('Los datos de la edición no son válidos.');
  return result.data;
}

function fileMatches(file, fileId) {
  return file && String(file.fileId || file.id || '') === String(fileId);
}

function validImageDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && width * height <= MAX_PIXELS;
}

function imageAspectRatio(width, height) {
  let a = width;
  let b = height;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return `${width / a}:${height / a}`;
}

async function readPixels(buffer, pngOnly = false) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES
    || (pngOnly && !buffer.subarray(0, 8).equals(PNG_SIGNATURE))) {
    throw failure('La imagen debe ser un PNG válido de hasta 20 MB.');
  }
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const metadata = await image.metadata();
    if ((pngOnly && metadata.format !== 'png') || (metadata.pages || 1) > 1
      || !validImageDimensions(metadata.width, metadata.height)) throw new Error('invalid dimensions');
    // Decode all pixels: a PNG header alone does not prove valid image bytes.
    const result = await image.rotate().png().toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_IMAGE_BYTES) throw new Error('image too large');
    return result;
  } catch {
    throw failure('No pude leer la imagen. Usa una imagen válida de hasta 20 MB y 40 megapíxeles.');
  }
}

function createImageWorkspaceService({
  prisma,
  storage = objectStorage,
  resolveSource = resolveImageSource,
  uploadsDir = path.resolve(__dirname, '../../../uploads/images'),
} = {}) {
  async function target(db, { userId, fileId, chatId, messageId }, { allowHidden = false } = {}) {
    if (!userId || !idSchema.safeParse(fileId).success) throw failure('No encontré esa imagen.', 404);
    const chat = await db.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } });
    if (!chat) throw failure('No encontré esa imagen.', 404);
    const message = await db.message.findFirst({ where: { id: messageId, chatId, deletedAt: null }, select: { id: true, files: true } });
    const files = messageFiles(message || {});
    const file = files.find((entry) => fileMatches(entry, fileId));
    if (!file || (!allowHidden && file.deletedAt)) throw failure('No encontré esa imagen.', 404);
    if (!(file.type === 'image' || /^image\//.test(file.mimeType || file.mime || file.type || ''))) {
      throw failure('El archivo seleccionado no es una imagen.');
    }
    return { message, files, file };
  }

  async function resolveOwnedSource(context) {
    const source = await resolveSource({ fileId: context.fileId }, {
      prisma, userId: context.userId, chatId: context.chatId, messageId: context.messageId, requireChatOwnership: true,
    });
    if (!source || String(source.fileId) !== String(context.fileId)) throw failure('No pude abrir esa imagen.', 404);
    return source;
  }

  async function updateAttachment(context, transform, allowHidden = false) {
    return prisma.$transaction(async (db) => {
      const current = await target(db, context, { allowHidden });
      const files = current.files.map((file) => fileMatches(file, context.fileId) ? transform(file) : file);
      const encoded = typeof current.message.files === 'string' ? JSON.stringify(files) : files;
      // Optimistic update prevents a comment/save from overwriting another
      // attachment edited concurrently in the same message.
      const updated = await db.message.updateMany({
        where: { id: current.message.id, chatId: context.chatId, deletedAt: null, files: { equals: current.message.files } },
        data: { files: encoded },
      });
      if (updated.count !== 1) throw failure('La imagen cambió mientras la guardabas. Ábrela de nuevo.', 409, 'E_CONFLICT');
      return { files, chatId: context.chatId, messageId: current.message.id };
    });
  }

  async function edit({ userId, fileId, ...body }) {
    const input = parseInput(editSchema, body);
    const context = { userId, fileId, chatId: input.chatId, messageId: input.messageId };
    await target(prisma, context);
    const source = await resolveOwnedSource(context);
    if (input.operation === 'comment') {
      if (!input.comments || new Set(input.comments.map((comment) => comment.id)).size !== input.comments.length) {
        throw failure('Indica comentarios válidos, cada uno con un identificador diferente.');
      }
      return updateAttachment(context, (entry) => ({ ...entry, comments: input.comments }));
    }

    const original = await readPixels(source.buffer);
    let edited;
    if (input.operation === 'annotate') {
      const encoded = input.sourceImageDataUrl?.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!encoded || encoded[1].length % 4 !== 0) throw failure('Las anotaciones deben enviarse como PNG.');
      edited = await readPixels(Buffer.from(encoded[1], 'base64'), true);
      if (edited.info.width !== original.info.width || edited.info.height !== original.info.height) {
        throw failure('Las anotaciones deben conservar las dimensiones de la imagen original.');
      }
    } else {
      if (!validImageDimensions(input.width, input.height)) throw failure('Indica un tamaño válido de hasta 8192 píxeles por lado y 40 megapíxeles.');
      edited = await sharp(original.data).resize(input.width, input.height, {
        fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
      }).png().toBuffer({ resolveWithObject: true });
      if (edited.data.length > MAX_IMAGE_BYTES) throw failure('La imagen resultante supera los 20 MB.');
    }

    const filename = `image-${crypto.randomUUID()}.png`;
    const localPath = path.join(uploadsDir, filename);
    const key = `uploads/images/${filename}`;
    let stored;
    try {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(localPath, edited.data, { flag: 'wx' });
      stored = await storage.persistLocalFile({ localPath, key, contentType: 'image/png' });
      return await prisma.$transaction(async (db) => {
        const latest = await target(db, context);
        const record = await db.file.create({ data: {
          userId, filename, originalName: filename, mimeType: 'image/png', size: edited.data.length, path: stored.ref,
        } });
        const parent = latest.file;
        const inherited = Object.fromEntries(['model', 'provider', 'quality', 'prompt'].filter((name) => parent[name] !== undefined).map((name) => [name, parent[name]]));
        const output = {
          ...inherited,
          type: 'image', mimeType: 'image/png', url: `/uploads/images/${filename}`, filename, fileId: record.id,
          parentFileId: fileId, rootFileId: parent.rootFileId || fileId,
          version: (Number(parent.version) || 1) + 1, operation: input.operation,
          width: edited.info.width, height: edited.info.height,
          aspectRatio: imageAspectRatio(edited.info.width, edited.info.height),
        };
        const message = await db.message.create({ data: {
          chatId: context.chatId, role: 'ASSISTANT', content: output.url, files: JSON.stringify([output]),
        } });
        await db.chat.update({ where: { id: context.chatId }, data: { updatedAt: new Date() } });
        return { files: [output], chatId: context.chatId, messageId: message.id };
      });
    } catch (error) {
      // A failed database commit must not leave an unattached local/R2 image.
      await storage.remove(stored?.ref || localPath).catch(() => {});
      await fs.unlink(localPath).catch(() => {});
      if (!stored && storage.enabled?.()) await storage.remove(`r2:${key}`).catch(() => {});
      if (error.status) throw error;
      throw failure('No pude guardar la nueva versión. La imagen original sigue disponible.', 500, 'E_PERSISTENCE');
    }
  }

  async function hide({ userId, fileId, ...body }) {
    const input = parseInput(contextSchema.strict(), body);
    const context = { userId, fileId, ...input };
    const current = await target(prisma, context, { allowHidden: true });
    // Repeating hide is harmless; avoid resolving bytes for a tombstoned asset.
    if (!current.file.deletedAt) await resolveOwnedSource(context);
    return updateAttachment(context, (file) => ({ ...file, deletedAt: file.deletedAt || new Date().toISOString() }), true);
  }

  return { edit, hide };
}

module.exports = { createImageWorkspaceService, MAX_PIXELS, MAX_DIMENSION };
