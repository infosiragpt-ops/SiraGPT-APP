'use strict';

/**
 * Project code-workspace snapshot (Slice C).
 *
 * Distinct from Project.files (knowledge/RAG attachments). This stores the
 * /code editor virtual FS for a server Project so Cmd+S and open can round-trip
 * across browsers for the owner — without claiming knowledge File rows are code.
 *
 * Caps are intentionally conservative for a single JSON column.
 */

const CODE_WORKSPACE_VERSION = 1;
const MAX_FILES = 200;
const MAX_PATH_LEN = 512;
const MAX_CONTENT_CHARS = 200_000; // per file
const MAX_TOTAL_CHARS = 1_500_000; // all file contents combined
const MAX_OPEN_TABS = 50;

const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+\- /()[\]]+$/;

/**
 * @typedef {{ content: string, language?: string, updatedAt?: number }} CodeWorkspaceFile
 * @typedef {{
 *   v: number,
 *   files: Record<string, CodeWorkspaceFile>,
 *   openTabs?: string[],
 *   activePath?: string | null,
 *   updatedAt?: string | null,
 * }} CodeWorkspaceSnapshot
 */

/**
 * Normalize and validate an inbound snapshot. Throws Error with .status
 * when the payload is invalid or exceeds caps.
 *
 * @param {unknown} raw
 * @returns {CodeWorkspaceSnapshot}
 */
function normalizeCodeWorkspaceSnapshot(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(400, 'Invalid code workspace payload');
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const filesIn = input.files;
  if (filesIn == null || typeof filesIn !== 'object' || Array.isArray(filesIn)) {
    throw httpError(400, 'code workspace files must be an object map');
  }

  const entries = Object.entries(/** @type {Record<string, unknown>} */ (filesIn));
  if (entries.length > MAX_FILES) {
    throw httpError(413, `Too many files (max ${MAX_FILES})`);
  }

  /** @type {Record<string, CodeWorkspaceFile>} */
  const files = {};
  let totalChars = 0;

  for (const [rawPath, rawFile] of entries) {
    const path = normalizePath(rawPath);
    if (!path) throw httpError(400, `Invalid file path: ${String(rawPath).slice(0, 80)}`);
    if (path.length > MAX_PATH_LEN) throw httpError(400, `Path too long: ${path.slice(0, 80)}`);
    if (!PATH_RE.test(path)) throw httpError(400, `Path not allowed: ${path.slice(0, 80)}`);

    let content = '';
    let language = languageForPath(path);
    let updatedAt = Date.now();

    if (typeof rawFile === 'string') {
      content = rawFile;
    } else if (rawFile && typeof rawFile === 'object' && !Array.isArray(rawFile)) {
      const f = /** @type {Record<string, unknown>} */ (rawFile);
      if (typeof f.content !== 'string') throw httpError(400, `File content must be a string: ${path}`);
      content = f.content;
      if (typeof f.language === 'string' && f.language.trim()) language = f.language.slice(0, 64);
      if (typeof f.updatedAt === 'number' && Number.isFinite(f.updatedAt)) updatedAt = f.updatedAt;
    } else {
      throw httpError(400, `Invalid file entry: ${path}`);
    }

    if (content.length > MAX_CONTENT_CHARS) {
      throw httpError(413, `File too large: ${path} (max ${MAX_CONTENT_CHARS} chars)`);
    }
    totalChars += content.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      throw httpError(413, `Workspace too large (max ${MAX_TOTAL_CHARS} chars total)`);
    }

    files[path] = { content, language, updatedAt };
  }

  const openTabsRaw = Array.isArray(input.openTabs) ? input.openTabs : [];
  const openTabs = [];
  for (const t of openTabsRaw.slice(0, MAX_OPEN_TABS)) {
    if (typeof t !== 'string') continue;
    const cleaned = normalizePath(t);
    if (cleaned && files[cleaned] && !openTabs.includes(cleaned)) openTabs.push(cleaned);
  }

  let activePath = null;
  if (typeof input.activePath === 'string' && input.activePath) {
    const cleaned = normalizePath(input.activePath);
    if (cleaned && files[cleaned]) activePath = cleaned;
  }
  if (!activePath && openTabs[0]) activePath = openTabs[0];
  if (!activePath) {
    const first = Object.keys(files).sort()[0];
    activePath = first || null;
  }

  return {
    v: CODE_WORKSPACE_VERSION,
    files,
    openTabs,
    activePath,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Coerce a stored JSON value into a safe snapshot (or empty).
 * Never throws — corrupt rows become empty workspaces.
 *
 * @param {unknown} stored
 * @returns {CodeWorkspaceSnapshot}
 */
function readStoredCodeWorkspace(stored) {
  if (stored == null) {
    return emptySnapshot();
  }
  try {
    return normalizeCodeWorkspaceSnapshot(stored);
  } catch {
    return emptySnapshot();
  }
}

function emptySnapshot() {
  return {
    v: CODE_WORKSPACE_VERSION,
    files: {},
    openTabs: [],
    activePath: null,
    updatedAt: null,
  };
}

function normalizePath(path) {
  if (typeof path !== 'string') return '';
  let p = path.replace(/\\/g, '/').trim();
  // Absolute paths and Windows drive letters are never allowed in the editor FS.
  if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) return '';
  p = p.replace(/^(\.\/)+/, '');
  p = p.replace(/\/{2,}/g, '/');
  if (!p || p === '.' || p.includes('\0')) return '';
  const parts = p.split('/').filter((seg) => seg && seg !== '.');
  if (parts.some((seg) => seg === '..')) return '';
  return parts.join('/');
}

function languageForPath(path) {
  const lower = path.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const map = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    mdx: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    htm: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    env: 'dotenv',
    txt: 'plaintext',
  };
  return map[ext] || 'plaintext';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function fileCount(snapshot) {
  return snapshot && snapshot.files ? Object.keys(snapshot.files).length : 0;
}

module.exports = {
  CODE_WORKSPACE_VERSION,
  MAX_FILES,
  MAX_PATH_LEN,
  MAX_CONTENT_CHARS,
  MAX_TOTAL_CHARS,
  MAX_OPEN_TABS,
  normalizeCodeWorkspaceSnapshot,
  readStoredCodeWorkspace,
  emptySnapshot,
  normalizePath,
  languageForPath,
  fileCount,
};
