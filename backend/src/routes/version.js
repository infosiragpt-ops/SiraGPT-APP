'use strict';

/**
 * GET /api/version — small, public version probe.
 *
 * Returns the frontend (package.json at repo root) and backend
 * (backend/package.json) semver strings, the git commit (best-effort
 * via `git rev-parse HEAD` when `.git` is present, else env / build ARG), the boot wall-clock time
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
const {
  resolveCommit,
  readDeployedTreeCommit,
} = require('../utils/deployed-tree-commit');

const router = express.Router();

const BUILD_TIME = new Date().toISOString();
const NODE_VERSION = process.version;

function resolveFeatureFlags() {
  // Comma-separated list in NEXT_PUBLIC_FEATURE_FLAGS — surfaces enabled
  // client-side feature flags to the status page / debug widget so
  // operators can confirm which flags are live on a given build without
  // poking at the frontend bundle. Empty / missing → [].
  const raw = process.env.NEXT_PUBLIC_FEATURE_FLAGS;
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveFrontendVersion() {
  const fromEnv = process.env.SIRAGPT_VERSION;
  if (fromEnv) {
    const normalized = String(fromEnv).trim();
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) return normalized;
  }

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

const VERSION_INFO = Object.freeze({
  version: resolveFrontendVersion(),
  backend: resolveBackendVersion(),
  commit: resolveCommit(process.env, {
    cwd: path.resolve(__dirname, '..', '..', '..'),
  }),
  buildTime: BUILD_TIME,
  node: NODE_VERSION,
  featureFlags: Object.freeze(resolveFeatureFlags()),
});

router.get('/', (_req, res) => {
  // Long cache disabled — operators want fresh values after a hot
  // restart. ETag stays on by default so consumers can revalidate.
  res.setHeader('Cache-Control', 'no-store');
  res.json(VERSION_INFO);
});

module.exports = router;
module.exports.VERSION_INFO = VERSION_INFO;
module.exports.resolveCommit = resolveCommit;
module.exports.readDeployedTreeCommit = readDeployedTreeCommit;
