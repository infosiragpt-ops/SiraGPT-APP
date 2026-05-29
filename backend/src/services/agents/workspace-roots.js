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
  normalizeRoot,
  splitRootList,
};
