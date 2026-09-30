'use strict';

const { _internal, WRITE_MAX_CONTENT_BYTES } = require('../agents/project-workspace-tools');
const EDITOR_MAX_BYTES = WRITE_MAX_CONTENT_BYTES;

function editorPath(raw) {
  if (typeof raw !== 'string' || raw.length > 500 || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const value = raw.trim().replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) return null;
  const normalized = value.split('/').filter((part) => part && part !== '.').join('/');
  return _internal.sanitizeRelPath(normalized);
}

function protectedEditorPath(path) {
  return _internal.isBlockedSecretPath(path)
    || path.split('/').some((part) => part === '.git' || part.startsWith('.sira-editor-'))
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(path.split('/').pop());
}

function editorErrorStatus(error) {
  const code = error?.body?.error || error?.code;
  if (['file_conflict', 'file_busy', 'file_read_only', 'run_in_progress', 'workspace_unavailable'].includes(code)) return 409;
  if (code === 'protected_path') return 403;
  if (code === 'binary_file') return 415;
  if (code === 'file_too_large') return 413;
  if (['file_not_found', 'project_not_found', 'worktree_not_found'].includes(code)) return 404;
  if (['invalid_request', 'unsafe_path'].includes(code)) return 400;
  return 502;
}

module.exports = { EDITOR_MAX_BYTES, editorPath, protectedEditorPath, editorErrorStatus };
