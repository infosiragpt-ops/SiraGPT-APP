'use strict';

/**
 * Shared workspace-root policy for host-level agent tools.
 *
 * Agentic repo work needs one coherent filesystem boundary across clone,
 * shell, and file-edit tools. Keeping the roots here prevents drift where
 * one tool can clone or inspect a checkout that another tool then refuses
 * to edit.
 */

const os = require('os');
const path = require('path');

function expandHome(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeRoot(rawPath) {
  const expanded = expandHome(rawPath);
  if (!expanded || expanded.includes('\0')) return '';
  return path.resolve(expanded);
}

function splitRootList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(new RegExp(`[${path.delimiter === ';' ? ';' : ':'},]`))
    .map(normalizeRoot)
    .filter(Boolean);
}

function uniqueRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots.map(normalizeRoot).filter(Boolean)) {
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

function defaultProjectsDir() {
  return normalizeRoot(process.env.SIRAGPT_PROJECTS_DIR || path.join(os.homedir(), 'Desktop', 'sira-projects'));
}

function defaultWorkspaceRoots() {
  return uniqueRoots([
    defaultProjectsDir(),
    path.join(os.homedir(), 'Desktop', 'siraGPT'),
    path.join(os.homedir(), 'Documents', 'GitHub', 'siraGPT'),
    ...splitRootList(process.env.SIRAGPT_WORKSPACE_ROOTS),
  ]);
}

function allowedWorkspaceRoots(options = {}) {
  const roots = defaultWorkspaceRoots();
  if (options.includeTmp) roots.push(normalizeRoot(os.tmpdir()));
  return uniqueRoots(roots);
}

function isPathWithinRoot(targetPath, rootPath) {
  const target = normalizeRoot(targetPath);
  const root = normalizeRoot(rootPath);
  return Boolean(target && root && (target === root || target.startsWith(root + path.sep)));
}

function isPathWithinWorkspace(targetPath, options = {}) {
  return allowedWorkspaceRoots(options).some((root) => isPathWithinRoot(targetPath, root));
}

/**
 * The running product's own source tree. Derived from this file's location
 * (this module lives at <repo>/backend/src/services/agents/) so it stays
 * correct regardless of where the checkout is, plus the known desktop paths.
 */
function selfRepoRoot() {
  return normalizeRoot(path.resolve(__dirname, '..', '..', '..', '..'));
}

/**
 * Protected roots are READABLE but NOT writable by the agent's host tools.
 * The agent must never edit / commit / push the source of the app it is
 * running inside (a prompt-injected turn could otherwise self-modify the
 * backend and `git push main` — and here .env local == prod). Override with
 * SIRAGPT_PROTECTED_ROOTS, or disable entirely with SIRAGPT_ALLOW_SELF_MODIFY=1.
 */
function protectedRoots() {
  if (process.env.SIRAGPT_ALLOW_SELF_MODIFY === '1') return [];
  return uniqueRoots([
    selfRepoRoot(),
    path.join(os.homedir(), 'Desktop', 'siraGPT'),
    path.join(os.homedir(), 'Documents', 'GitHub', 'siraGPT'),
    ...splitRootList(process.env.SIRAGPT_PROTECTED_ROOTS),
  ]);
}

function isPathProtected(targetPath) {
  return protectedRoots().some((root) => isPathWithinRoot(targetPath, root));
}

/**
 * A path is writable when it is inside an allowed workspace root AND not
 * inside a protected (product-source) root.
 */
function isPathWritable(targetPath, options = {}) {
  return isPathWithinWorkspace(targetPath, options) && !isPathProtected(targetPath);
}

function displayPath(root) {
  const normalized = normalizeRoot(root);
  const home = normalizeRoot(os.homedir());
  if (normalized === home) return '~';
  if (normalized.startsWith(home + path.sep)) return `~/${normalized.slice(home.length + 1)}`;
  return normalized;
}

function describeWorkspaceRoots(options = {}) {
  return allowedWorkspaceRoots(options).map(displayPath).join(', ');
}

module.exports = {
  allowedWorkspaceRoots,
  defaultProjectsDir,
  defaultWorkspaceRoots,
  describeWorkspaceRoots,
  expandHome,
  isPathWithinRoot,
  isPathWithinWorkspace,
  isPathProtected,
  isPathWritable,
  normalizeRoot,
  protectedRoots,
  selfRepoRoot,
  splitRootList,
};
