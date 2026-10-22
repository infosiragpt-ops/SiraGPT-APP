'use strict';

/**
 * Helpers shared by the deterministic document-*.js analyzers.
 */

/** Display name of an attached file in analyzer output. */
function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

/** Strings pass through unchanged; anything else becomes ''. */
function safeText(v) { return typeof v === 'string' ? v : ''; }

module.exports = { safeFileName, safeText };
