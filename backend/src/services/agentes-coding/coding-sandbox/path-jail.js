'use strict';

const path = require('node:path');
const { fail } = require('./errors');

const WORKSPACE_ROOT = '/workspace';

function jailRelPath(relPath, { forList = false } = {}) {
  if (relPath == null || relPath === '') {
    if (forList) return '.';
    fail('E_PARAMS', 'Falta la ruta del archivo.');
  }
  const raw = String(relPath);
  if (raw.includes('\0') || /[\x00-\x1f]/.test(raw)) {
    fail('E_PATH_ESCAPE', 'La ruta contiene caracteres de control.');
  }
  let p = raw.trim();
  if (p === WORKSPACE_ROOT) p = '.';
  else if (p.startsWith(`${WORKSPACE_ROOT}/`)) p = p.slice(WORKSPACE_ROOT.length + 1);
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) {
    fail('E_PATH_ESCAPE');
  }
  if (p.includes('\\')) fail('E_PATH_ESCAPE');
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    fail('E_PATH_ESCAPE');
  }
  if (norm.startsWith('/')) fail('E_PATH_ESCAPE');
  return forList && (norm === '.' || norm === '') ? '.' : norm;
}

function workspaceAbs(relPath) {
  const rel = jailRelPath(relPath);
  return path.posix.join(WORKSPACE_ROOT, rel);
}

module.exports = {
  WORKSPACE_ROOT,
  jailRelPath,
  workspaceAbs,
};
