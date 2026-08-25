'use strict';

/**
 * Resolve the git SHA of the tree that is actually running.
 *
 * A leftover GIT_COMMIT in .env from an older PR must not stamp
 * GET /api/version. Prefer `git rev-parse HEAD` when `.git` is present
 * (host PM2 at /opt/siragpt). Docker images without `.git` keep the
 * build ARG / compose value.
 *
 * Does not read, write, or print .env.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function readDeployedTreeCommit(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    if (!fs.existsSync(path.join(cwd, '.git'))) return null;
    const sha = execSync('git rev-parse HEAD', {
      cwd,
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (FULL_SHA_RE.test(sha)) return sha.toLowerCase();
  } catch (_) {
    // image / cwd without a usable git tree
  }
  return null;
}

function applyGitCommitFromDeployedTree(options = {}) {
  const env = options.env || process.env;
  const roots = [];
  if (options.root) roots.push(options.root);
  if (Array.isArray(options.roots)) roots.push(...options.roots);
  if (!options.root && !options.roots) {
    const backendDir = path.resolve(__dirname, '..', '..');
    roots.push(path.resolve(backendDir, '..'), env.SIRAGPT_APP_DIR, '/opt/siragpt');
  }
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const sha = readDeployedTreeCommit(root);
    if (sha) {
      env.GIT_COMMIT = sha;
      return sha;
    }
  }
  return null;
}

function resolveCommit(env = process.env, opts = {}) {
  const fromGit = Object.prototype.hasOwnProperty.call(opts, 'gitSha')
    ? opts.gitSha
    : readDeployedTreeCommit(opts.cwd);
  if (typeof fromGit === 'string' && FULL_SHA_RE.test(fromGit.trim())) {
    return fromGit.trim().toLowerCase();
  }

  const candidates = [
    env && env.GIT_COMMIT,
    env && env.SOURCE_COMMIT,
    env && env.COMMIT_SHA,
    env && env.VERCEL_GIT_COMMIT_SHA,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (FULL_SHA_RE.test(normalized)) return normalized.toLowerCase();
  }
  return 'unknown';
}

module.exports = {
  FULL_SHA_RE,
  readDeployedTreeCommit,
  applyGitCommitFromDeployedTree,
  resolveCommit,
};
