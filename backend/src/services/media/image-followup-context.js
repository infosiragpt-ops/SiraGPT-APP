'use strict';

// Does this chat already hold an image a short follow-up could refer to?
// Pure scan over message rows (files JSON + agent-task-state sentinel) plus
// a lazy DB variant for the composer route, which has no history in memory.

const IMAGE_FILE_RE = /^image\/(?:png|jpeg|jpg|webp|gif|avif)$/i;
const IMAGE_URL_RE = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i;
const SENTINEL_IMAGE_RE = /"(?:mime|mimeType|type)"\s*:\s*"image\/(?:png|jpeg|jpg|webp|gif|avif)"|\/api\/agent\/artifact\/[a-f0-9]{6,64}\?name=[^"\s]*\.(?:png|jpe?g|webp|gif|avif)\b/i;

function fileList(message) {
  try {
    const files = typeof message?.files === 'string' ? JSON.parse(message.files) : message?.files;
    return Array.isArray(files) ? files : [];
  } catch { return []; }
}

function isImageEntry(file) {
  if (!file || typeof file !== 'object' || file.deletedAt) return false;
  if (file.type === 'image' || file.attachmentKind === 'image') return true;
  if (IMAGE_FILE_RE.test(String(file.mimeType || file.mime || file.type || ''))) return true;
  const url = String(file.url || file.downloadUrl || file.path || '');
  return Boolean(url) && IMAGE_URL_RE.test(url) && !/\.(?:pdf|docx?|pptx?|xlsx?)/i.test(url);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('\n');
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** True when one of the latest `limit` messages carries an image (upload or generated). */
function historyHasRecentImage(messages, { limit = 12 } = {}) {
  if (!Array.isArray(messages) || !messages.length) return false;
  const recent = messages.slice(-Math.max(1, limit));
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (!message) continue;
    if (fileList(message).some(isImageEntry)) return true;
    if (SENTINEL_IMAGE_RE.test(textOf(message.content))) return true;
  }
  return false;
}

/**
 * Lazy DB variant for the composer route: one bounded read of the chat's
 * latest rows, only when the caller already decided the text looks like a
 * follow-up. Ownership is checked so a foreign chat id reveals nothing.
 */
async function chatHasRecentImage(prisma, { userId, chatId, take = 12 } = {}) {
  if (!prisma || !userId || !chatId || typeof prisma.message?.findMany !== 'function') return false;
  try {
    if (typeof prisma.chat?.findFirst === 'function') {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } });
      if (!chat) return false;
    }
    const rows = await prisma.message.findMany({
      where: { chatId, deletedAt: null },
      orderBy: { timestamp: 'desc' },
      take: Math.max(1, Math.min(50, Number(take) || 12)),
      select: { files: true, content: true },
    });
    return historyHasRecentImage(Array.isArray(rows) ? rows.slice().reverse() : [], { limit: 50 });
  } catch { return false; }
}

// ── Aspect ratio helpers ────────────────────────────────────────────────────

const KNOWN_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];

/** Nearest supported frame for real pixel dimensions (log-ratio distance). */
function nearestAspectRatio(width, height, candidates = KNOWN_RATIOS) {
  const w = Number(width); const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const target = Math.log(w / h);
  let best = null; let bestDistance = Infinity;
  for (const ratio of candidates) {
    const [rw, rh] = String(ratio).split(':').map(Number);
    if (!rw || !rh) continue;
    const distance = Math.abs(Math.log(rw / rh) - target);
    if (distance < bestDistance) { best = ratio; bestDistance = distance; }
  }
  return best;
}

/** Best-effort frame of an image buffer; null when the bytes are not an image. */
async function aspectRatioFromBuffer(buffer, candidates = KNOWN_RATIOS) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  try {
    const sharp = require('sharp');
    const metadata = await sharp(buffer, { limitInputPixels: 40 * 1024 * 1024 }).metadata();
    const rotated = metadata.orientation && metadata.orientation >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    return nearestAspectRatio(width, height, candidates);
  } catch { return null; }
}

module.exports = {
  historyHasRecentImage,
  chatHasRecentImage,
  nearestAspectRatio,
  aspectRatioFromBuffer,
  KNOWN_RATIOS,
  _internal: { isImageEntry, fileList },
};
