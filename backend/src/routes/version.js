'use strict';

/**
 * GET /api/version — small, public version probe.
 *
 * Returns the frontend (package.json at repo root) and backend
 * (backend/package.json) semver strings, the git commit (best-effort
 * via env var or `git rev-parse HEAD`), the boot wall-clock time
 * (ISO 8601), and the node runtime version.
 *
 * Useful for:
 *   - canary verification ("is the new container actually live?")
 *   - bug reports (operators can paste the JSON into a ticket)
 *   - dashboard widgets that want to surface "running build X"
 *
 * Everything is resolved once at module-load and cached — this
 * endpoint must be cheap enough to hit from a status page without
 * thinking about it.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const router = express.Router();

const BUILD_TIME = new Date().toISOString();
const NODE_VERSION = process.version;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveFrontendVersion() {
  // package.json lives at the repo root (one level above backend/).
  // Backend may be deployed standalone in containers, so a missing
  // file falls back to 'unknown' rather than throwing.
  const root = path.resolve(__dirname, '..', '..', '..');
  const pkg = readJson(path.join(root, 'package.json'));
  return (pkg && typeof pkg.version === 'string') ? pkg.version : 'unknown';
}

function resolveBackendVersion() {
  const pkg = readJson(path.resolve(__dirname, '..', '..', 'package.json'));
  return (pkg && typeof pkg.version === 'string') ? pkg.version : 'unknown';
}

function resolveCommit() {
  // Prefer build-injected env vars (Docker / CI). These don't require
  // .git to be present in the runtime image.
  const fromEnv = process.env.GIT_COMMIT
    || process.env.SOURCE_COMMIT
    || process.env.COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return String(fromEnv).trim().slice(0, 40);

  // Best-effort `git rev-parse` — wrapped in try/catch because the
  // production image usually doesn't ship `.git`. Short timeout so a
  // stuck git invocation can't block module load.
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  } catch (_) {
    // ignore — fall through to 'unknown'
  }
  return 'unknown';
}

const VERSION_INFO = Object.freeze({
  version: resolveFrontendVersion(),
  backend: resolveBackendVersion(),
  commit: resolveCommit(),
  buildTime: BUILD_TIME,
  node: NODE_VERSION,
});

router.get('/', (_req, res) => {
  // Long cache disabled — operators want fresh values after a hot
  // restart. ETag stays on by default so consumers can revalidate.
  res.setHeader('Cache-Control', 'no-store');
  res.json(VERSION_INFO);
});

module.exports = router;
module.exports.VERSION_INFO = VERSION_INFO;
