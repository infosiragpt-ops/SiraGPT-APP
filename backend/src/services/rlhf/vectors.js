'use strict';

/**
 * Float32 embedding codecs + similarity helpers for the RLHF flywheel.
 * Embeddings are stored as little-endian BYTEA so the same bytes round-trip
 * through Prisma without depending on pgvector dimension matching.
 */

const crypto = require('node:crypto');

function asBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array) {
    return encodeF32(value);
  }
  return null;
}

function encodeF32(arr) {
  if (!arr || arr.length == null || arr.length === 0) return null;
  const buf = Buffer.allocUnsafe(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(Number(arr[i]) || 0, i * 4);
  return buf;
}

function decodeF32(buf) {
  const bytes = asBuffer(buf);
  if (!bytes || bytes.length < 4) return null;
  const n = Math.floor(bytes.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

function toFloat32(vec) {
  if (!vec) return null;
  if (vec instanceof Float32Array) return vec;
  if (Buffer.isBuffer(vec) || ArrayBuffer.isView(vec) && !(vec instanceof Float32Array)) {
    const decoded = decodeF32(vec);
    if (decoded) return decoded;
  }
  if (Array.isArray(vec) || vec instanceof Float64Array) {
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = Number(vec[i]) || 0;
    return out;
  }
  return null;
}

function cosine(a, b) {
  const x = toFloat32(a);
  const y = toFloat32(b);
  if (!x || !y) return 0;
  const len = Math.min(x.length, y.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = x[i];
    const bv = y[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function hashPrompt(text) {
  const norm = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function clampText(value, max) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value); } catch { return String(value); }
  })();
  return s.length <= max ? s : s.slice(0, max);
}

module.exports = {
  asBuffer,
  encodeF32,
  decodeF32,
  toFloat32,
  cosine,
  hashPrompt,
  newId,
  clampText,
};
