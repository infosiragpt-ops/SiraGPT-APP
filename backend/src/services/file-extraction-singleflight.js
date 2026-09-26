'use strict';

/**
 * One text extraction per uploaded file.
 *
 * The async upload pipeline extracts a file right after the upload responds,
 * while a chat turn that references the same file may ask for its text a few
 * seconds later. Before this registry the turn started a SECOND full
 * extraction of the same bytes (prod 2026-09-26: a 43 KB PNG was OCR'd twice
 * in parallel for ~77 s, one run racing the R2 offload into ENOENT) and the
 * turn blocked on it. Both callers now share one promise keyed by file id.
 *
 * In-process only: the backend runs as a single instance and the upload
 * pipeline runs in the same process as the generate route.
 */

const inflight = new Map();

function keyOf(fileId) {
  const key = String(fileId == null ? '' : fileId).trim();
  return key || null;
}

/**
 * Run `run()` unless an extraction for `fileId` is already in flight, in which
 * case the caller gets that same promise. Without an id there is nothing to
 * dedupe on, so `run()` executes directly.
 */
function runExtractionOnce(fileId, run) {
  const key = keyOf(fileId);
  if (!key) return Promise.resolve().then(run);
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** The in-flight extraction promise for `fileId`, or null. */
function inflightExtraction(fileId) {
  const key = keyOf(fileId);
  return key ? inflight.get(key) || null : null;
}

function __resetForTests() {
  inflight.clear();
}

module.exports = {
  runExtractionOnce,
  inflightExtraction,
  __resetForTests,
};
