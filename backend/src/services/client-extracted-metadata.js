'use strict';

/**
 * Metadata of a media file whose audio the BROWSER extracted before the
 * upload (lib/media/client-audio-extract.ts): the composer sends a small
 * Opus/AAC audio file instead of the original video and tells the server
 * what it stands for. Validated here (pure, never throws) so a crafted body
 * cannot write arbitrary JSON into DocumentAnalysis.metadata.clientExtracted.
 *
 * Shape: { tier: 'opus' | 'copy', sourceName, sourceSize, sourceType,
 * codec, durationSeconds }. Anything else → null (the upload is treated as
 * an ordinary file).
 */

const TIERS = new Set(['opus', 'copy']);
const MAX_NAME = 255;
const MAX_TYPE = 100;
const MAX_CODEC = 32;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024 * 1024 * 1024; // 10 TiB: anything larger is garbage
const MAX_DURATION_SECONDS = 7 * 24 * 3600;

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finiteOrNull(value, { min = 0, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return integer ? Math.round(n) : n;
}

/** Parse the metadata as a client sent it (object or JSON string). */
function parseClientExtracted(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > 4096) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  return normalizeClientExtracted(value);
}

/** The validated record, or null when the shape is not one the browser produces. */
function normalizeClientExtracted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tier = String(value.tier || '').trim().toLowerCase();
  if (!TIERS.has(tier)) return null;
  const sourceName = cleanText(value.sourceName, MAX_NAME);
  const sourceSize = finiteOrNull(value.sourceSize, { min: 0, max: MAX_SOURCE_BYTES, integer: true });
  if (!sourceName || sourceSize === null) return null;
  const codec = cleanText(value.codec, MAX_CODEC).toLowerCase() || null;
  return {
    tier,
    sourceName,
    sourceSize,
    sourceType: cleanText(value.sourceType, MAX_TYPE).toLowerCase() || null,
    codec: codec && /^[a-z0-9.-]+$/.test(codec) ? codec : null,
    durationSeconds: finiteOrNull(value.durationSeconds, { min: 0, max: MAX_DURATION_SECONDS }),
  };
}

/**
 * A multipart upload carries one JSON map { "<file name>": metadata } for
 * the files of the request. Returns a Map by file name (only valid entries).
 */
function parseClientExtractedMap(raw) {
  const out = new Map();
  if (raw === undefined || raw === null || raw === '') return out;
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > 64 * 1024) return out;
    try { value = JSON.parse(raw); } catch { return out; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [name, meta] of Object.entries(value).slice(0, 500)) {
    const normalized = normalizeClientExtracted(meta);
    const key = cleanText(name, MAX_NAME);
    if (normalized && key) out.set(key, normalized);
  }
  return out;
}

module.exports = {
  normalizeClientExtracted,
  parseClientExtracted,
  parseClientExtractedMap,
};
