'use strict';

/**
 * mime-sniffer — magic-byte based MIME type detection. Pairs with the
 * upload security policy already in the repo and the file processor:
 * the client-declared Content-Type / extension is untrusted; this
 * confirms the file is actually what it claims to be before we send
 * its bytes to a parser.
 *
 * Coverage is intentionally narrow — the formats sira's pipeline
 * already accepts (PDF, common images, audio/video, ZIP-family,
 * plain text). Returns null when no signature matches; callers
 * should treat null + an audacious extension as suspicious.
 *
 * Public API:
 *   sniff(input)               input: Buffer | Uint8Array
 *     → { mime, ext, confidence } | null
 *   isMatch(input, mime)       → boolean
 *   SIGNATURES export          → array of { mime, ext, magic, mask?, offset? }
 */

const SIGNATURES = [
  // Images
  { mime: 'image/png',     ext: 'png',  magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg',    ext: 'jpg',  magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif',     ext: 'gif',  magic: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { mime: 'image/webp',    ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
  { mime: 'image/bmp',     ext: 'bmp',  magic: [0x42, 0x4D] },
  // Documents
  { mime: 'application/pdf',                  ext: 'pdf',  magic: [0x25, 0x50, 0x44, 0x46, 0x2D] }, // %PDF-
  { mime: 'application/zip',                  ext: 'zip',  magic: [0x50, 0x4B, 0x03, 0x04] },
  { mime: 'application/zip',                  ext: 'zip',  magic: [0x50, 0x4B, 0x05, 0x06] }, // empty zip
  { mime: 'application/zip',                  ext: 'zip',  magic: [0x50, 0x4B, 0x07, 0x08] },
  { mime: 'application/x-7z-compressed',      ext: '7z',   magic: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] },
  { mime: 'application/x-rar-compressed',     ext: 'rar',  magic: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07] },
  { mime: 'application/gzip',                 ext: 'gz',   magic: [0x1F, 0x8B, 0x08] },
  // Media
  { mime: 'audio/mpeg',    ext: 'mp3',  magic: [0x49, 0x44, 0x33] }, // ID3
  { mime: 'audio/mpeg',    ext: 'mp3',  magic: [0xFF, 0xFB] },
  { mime: 'audio/wav',     ext: 'wav',  magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45] },
  { mime: 'video/mp4',     ext: 'mp4',  magic: [null, null, null, null, 0x66, 0x74, 0x79, 0x70] }, // ftyp at offset 4
  // Text-ish (markup-only sniffing; UTF-8 BOM & XML)
  { mime: 'application/xml',     ext: 'xml',  magic: [0x3C, 0x3F, 0x78, 0x6D, 0x6C] }, // <?xml
];

function matchesSignature(buf, sig, offset = 0) {
  for (let i = 0; i < sig.magic.length; i++) {
    const expected = sig.magic[i];
    if (expected === null) continue;
    if (buf[offset + i] !== expected) return false;
  }
  return true;
}

function sniff(input) {
  let buf;
  if (Buffer.isBuffer(input)) buf = input;
  else if (input instanceof Uint8Array) buf = Buffer.from(input);
  else if (typeof input === 'string') buf = Buffer.from(input, 'utf8');
  else return null;
  if (buf.length === 0) return null;

  // BOM / textual JSON heuristic — not a strict magic, kept last.
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { mime: 'text/plain; charset=utf-8', ext: 'txt', confidence: 0.5 };
  }

  for (const sig of SIGNATURES) {
    if (buf.length < sig.magic.length) continue;
    if (matchesSignature(buf, sig)) {
      return { mime: sig.mime, ext: sig.ext, confidence: 1 };
    }
  }
  // Try JSON heuristically: the first non-whitespace char is { or [.
  for (let i = 0; i < Math.min(64, buf.length); i++) {
    const c = buf[i];
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) continue;
    if (c === 0x7B /* { */ || c === 0x5B /* [ */) {
      return { mime: 'application/json', ext: 'json', confidence: 0.6 };
    }
    break;
  }
  return null;
}

function isMatch(input, mime) {
  const r = sniff(input);
  return Boolean(r && r.mime === mime);
}

module.exports = {
  sniff,
  isMatch,
  SIGNATURES,
};
