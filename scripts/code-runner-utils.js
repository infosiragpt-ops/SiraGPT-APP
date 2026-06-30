'use strict';

/**
 * code-runner-utils — pure helpers shared by the runner sidecar and its
 * backend tests. No Bun/Node APIs here: keep it requireable from both.
 */

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Sandbox-internal allowlist: the agent's terminal goes through the runner,
// but only via these binaries (extended deliberately, per phase).
const ALLOWED_BINS = new Set(['git', 'bun', 'bunx', 'node', 'ls', 'cat', 'wc']);
const INTERACTIVE_SCAFFOLD_RE = /^(?:create-next-app|create-vite|create-react-app|create-remix)(?:@.*)?$/i;

function commandRejectionReason(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === 'string')) return 'invalid_command';
  if (!ALLOWED_BINS.has(cmd[0])) return 'invalid_command';
  if (cmd[0] === 'bunx' && INTERACTIVE_SCAFFOLD_RE.test(cmd[1] || '')) {
    return 'interactive_scaffold_disallowed: usa write_file/edit_file sobre el starter existente en lugar de create-next-app/create-vite.';
  }
  if (cmd[0] === 'bun' && cmd[1] === 'create') {
    return 'interactive_scaffold_disallowed: usa write_file/edit_file sobre el starter existente en lugar de bun create.';
  }
  return null;
}

function sanitizeProjectId(raw) {
  const id = String(raw || '').trim();
  return PROJECT_ID_RE.test(id) ? id : null;
}

function resolveProjectRelPath(relPath) {
  const p = String(relPath || '').replaceAll('\\', '/').trim();
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function isAllowedCommand(cmd) {
  return commandRejectionReason(cmd) === null;
}

// Dirs never mirrored to the user's disk on export: generated/heavy trees the
// user re-creates locally with `npm install`/`npm run build`. Keeping them out
// makes the export a clean, small source copy and dodges the slow/fragile
// node_modules-over-a-Windows-bind-mount path entirely.
const IGNORED_EXPORT_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.turbo',
  'coverage', '.vite', '.output', '.parcel-cache', '.svelte-kit',
]);

/** True when a project-relative path lives under an ignored dir (any segment). */
function shouldIgnoreExportPath(relPath) {
  const p = String(relPath || '').replaceAll('\\', '/').trim();
  if (!p) return true;
  for (const seg of p.split('/')) {
    if (seg && IGNORED_EXPORT_DIRS.has(seg)) return true;
  }
  return false;
}

module.exports = {
  sanitizeProjectId,
  resolveProjectRelPath,
  isAllowedCommand,
  commandRejectionReason,
  ALLOWED_BINS,
  IGNORED_EXPORT_DIRS,
  shouldIgnoreExportPath,
};
