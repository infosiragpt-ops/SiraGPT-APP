'use strict';

/**
 * WorkspaceManager — computes and guards the on-disk location of a user's
 * cloned repository.
 *
 * Layout:  <projectsDir>/<userId>/<owner>-<repo>
 *   projectsDir = SIRAGPT_PROJECTS_DIR (default ~/Desktop/sira-projects)
 *
 * Every resolved path is funnelled through the shared workspace-root policy
 * (services/agents/workspace-roots.js): it must sit inside an allowed,
 * writable root AND must NOT be the product's own source tree. This reuses
 * the exact traversal/self-modify protections the agentic host tools rely on
 * instead of inventing a parallel (and weaker) check.
 */

const path = require('path');
const fs = require('fs');
const {
  defaultProjectsDir,
  isPathWritable,
  normalizeRoot,
} = require('../agents/workspace-roots');

function pathDenied(target) {
  const err = new Error('Resolved workspace path is outside the allowed, writable workspace root');
  err.status = 400;
  err.code = 'workspace_path_denied';
  err.target = target;
  return err;
}

/** Collapse anything but a safe filename charset; strip leading dots. */
function sanitizeSegment(value, fallback) {
  const v = String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return v || fallback;
}

/** Per-user base dir under the projects root. */
function userBaseDir(userId) {
  return path.join(defaultProjectsDir(), sanitizeSegment(userId, 'user'));
}

/** Absolute, validated workspace path for a (user, owner, repo) triple. */
function workspacePathFor(userId, owner, repo) {
  const dirName = `${sanitizeSegment(owner, 'owner')}-${sanitizeSegment(repo, 'repo')}`;
  const target = normalizeRoot(path.join(userBaseDir(userId), dirName));
  if (!target || !isPathWritable(target)) {
    throw pathDenied(target);
  }
  return target;
}

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function isGitRepo(targetPath) {
  try {
    return fs.existsSync(path.join(targetPath, '.git'));
  } catch {
    return false;
  }
}

/**
 * Keep build artifacts out of `git status` by appending standard ignore
 * patterns to the repo's LOCAL excludes (`.git/info/exclude`). This is
 * local-only (never committed, never shown as a change) — so running a build
 * (`npm install` → node_modules, `dist/`) doesn't flood the Git pane with
 * thousands of untracked files. Idempotent.
 */
const DEFAULT_EXCLUDES = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.turbo/',
  '.cache/',
  '.output/',
  'coverage/',
  '*.log',
  '.DS_Store',
];

function ensureLocalExcludes(targetPath, patterns = DEFAULT_EXCLUDES) {
  try {
    const infoDir = path.join(targetPath, '.git', 'info');
    if (!fs.existsSync(path.join(targetPath, '.git'))) return false;
    fs.mkdirSync(infoDir, { recursive: true });
    const excludeFile = path.join(infoDir, 'exclude');
    let current = '';
    try {
      current = fs.readFileSync(excludeFile, 'utf8');
    } catch {
      /* no exclude file yet */
    }
    const have = new Set(current.split(/\r?\n/).map((s) => s.trim()));
    const missing = patterns.filter((p) => !have.has(p));
    if (missing.length === 0) return false;
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludeFile, `${prefix}# Added by SiraGPT — build artifacts\n${missing.join('\n')}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Recursively remove a workspace — only ever inside a writable root. */
function removeWorkspace(targetPath) {
  const normalized = normalizeRoot(targetPath);
  if (!normalized || !isPathWritable(normalized)) {
    throw pathDenied(normalized);
  }
  fs.rmSync(normalized, { recursive: true, force: true });
  return true;
}

module.exports = {
  sanitizeSegment,
  userBaseDir,
  workspacePathFor,
  ensureParentDir,
  isGitRepo,
  ensureLocalExcludes,
  removeWorkspace,
};
