'use strict';

/**
 * Server-side counterpart of the composer preview gate.
 * A render/preview must not start until the persisted upload object
 * exists (full bytes in local disk or R2). Partial / missing objects
 * return "not ready" so the viewer stays on the loading state instead
 * of converting a truncated file or falling back to a client renderer.
 */

function isStableServerFileId(id) {
  const value = String(id || '').trim();
  if (!value) return false;
  return !/^temp(?:[-_]|$)/i.test(value);
}

function isPersistedPreviewSource({
  id,
  path,
  sizeBytes,
  objectExists,
} = {}) {
  if (!isStableServerFileId(id)) return false;
  if (!path) return false;
  if (Number.isFinite(sizeBytes) && Number(sizeBytes) <= 0) return false;
  if (objectExists === false) return false;
  return true;
}

module.exports = {
  isStableServerFileId,
  isPersistedPreviewSource,
};
