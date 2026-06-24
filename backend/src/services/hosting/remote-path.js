'use strict';

/**
 * Validate/normalise a remote deploy directory. Blocks empty paths and `..`
 * traversal; collapses duplicate slashes; keeps it POSIX (remote hosts are *nix).
 */
function normalizeRemoteDir(input) {
  const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
  if (!raw) {
    const e = new Error('Remote path is required');
    e.status = 400;
    e.code = 'invalid_remote_path';
    throw e;
  }
  if (raw.split('/').some((seg) => seg === '..')) {
    const e = new Error('Remote path must not contain ".."');
    e.status = 400;
    e.code = 'invalid_remote_path';
    throw e;
  }
  // collapse repeated slashes, strip trailing slash (keep leading)
  const cleaned = raw.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return cleaned;
}

module.exports = { normalizeRemoteDir };
