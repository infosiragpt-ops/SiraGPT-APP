'use strict';

/**
 * In-process session git store (isomorphic-git pattern: no spawn).
 * Snapshots live on the session object, jailed to /workspace files.
 */

const crypto = require('node:crypto');
const { fail } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');
const { validateBranch, validateMessage, validateSha } = require('./runner');

const MAX_CHECKPOINTS = 50;

function skipGitPath(rel) {
  return rel === '.git' || String(rel).startsWith('.git/');
}

function emptyStore() {
  return {
    initialized: false,
    branch: 'main',
    head: null,
    commits: [],
  };
}

function getStore(session) {
  if (!session.git) session.git = emptyStore();
  return session.git;
}

async function snapshotTree(sandbox, sessionId) {
  const listed = await sandbox.listFiles(sessionId, '.');
  const tree = Object.create(null);
  for (const entry of listed || []) {
    const rel = typeof entry === 'string' ? entry : entry && entry.path;
    if (!rel || skipGitPath(rel)) continue;
    const jailed = jailRelPath(rel);
    const buf = await sandbox.readFile(sessionId, jailed);
    tree[jailed] = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  }
  return tree;
}

function treeSha(tree, message, parent) {
  const hash = crypto.createHash('sha1');
  hash.update(String(parent || ''));
  hash.update('\0');
  hash.update(String(message || ''));
  hash.update('\0');
  for (const p of Object.keys(tree).sort()) {
    hash.update(p);
    hash.update('\0');
    hash.update(tree[p]);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function compareTrees(current, head) {
  const files = [];
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(head || {})]);
  for (const path of [...keys].sort()) {
    const now = current && Object.prototype.hasOwnProperty.call(current, path);
    const then = head && Object.prototype.hasOwnProperty.call(head, path);
    if (!then && now) files.push({ path, status: '??' });
    else if (then && !now) files.push({ path, status: 'D' });
    else if (then && now && current[path] !== head[path]) files.push({ path, status: 'M' });
  }
  return files;
}

function unifiedFile(path, before, after) {
  const oldText = before == null ? '' : String(before);
  const newText = after == null ? '' : String(after);
  if (oldText === newText) return '';
  const oldLines = oldText === '' && before == null ? [] : oldText.split('\n');
  const newLines = newText === '' && after == null ? [] : newText.split('\n');
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- ${before == null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after == null ? '/dev/null' : `b/${path}`}`,
    `@@ -${before == null ? 0 : 1},${oldLines.length} +${after == null ? 0 : 1},${newLines.length} @@`,
  ];
  for (const line of oldLines) lines.push(`-${line}`);
  for (const line of newLines) lines.push(`+${line}`);
  return `${lines.join('\n')}\n`;
}

function buildPatch(current, head, onlyPath) {
  const chunks = [];
  const files = [];
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(head || {})]);
  for (const path of [...keys].sort()) {
    if (onlyPath && path !== onlyPath) continue;
    const now = current && Object.prototype.hasOwnProperty.call(current, path);
    const then = head && Object.prototype.hasOwnProperty.call(head, path);
    if (now && !then) {
      files.push({ path, status: '??' });
      chunks.push(unifiedFile(path, null, current[path]));
    } else if (!now && then) {
      files.push({ path, status: 'D' });
      chunks.push(unifiedFile(path, head[path], null));
    } else if (now && then && current[path] !== head[path]) {
      files.push({ path, status: 'M' });
      chunks.push(unifiedFile(path, head[path], current[path]));
    }
  }
  return { patch: chunks.join(''), files };
}

function headTree(store) {
  if (!store.head) return Object.create(null);
  const commit = store.commits.find((c) => c.sha === store.head);
  return (commit && commit.tree) || Object.create(null);
}

function publicCommit(commit) {
  return {
    sha: commit.sha,
    message: commit.message,
    createdAt: commit.createdAt,
    filesChanged: commit.filesChanged,
    parent: commit.parent || null,
  };
}

function initStore(store, opts = {}) {
  if (store.initialized) {
    return { ok: true, initialized: true, already: true, branch: store.branch };
  }
  store.initialized = true;
  store.branch = validateBranch(opts.branch);
  return { ok: true, initialized: true, already: false, branch: store.branch };
}

async function statusStore(sandbox, sessionId, store, opts = {}) {
  const current = await snapshotTree(sandbox, sessionId);
  const files = compareTrees(current, headTree(store));
  return {
    ok: true,
    initialized: store.initialized,
    branch: store.initialized ? store.branch : null,
    clean: files.length === 0,
    files,
  };
}

async function diffStore(sandbox, sessionId, store, opts = {}) {
  const current = await snapshotTree(sandbox, sessionId);
  const only = opts.path ? jailRelPath(opts.path) : null;
  let base = headTree(store);
  if (opts.from) {
    const sha = validateSha(opts.from);
    const commit = store.commits.find((c) => c.sha === sha);
    if (!commit) fail('E_CHECKPOINT_NOT_FOUND');
    base = commit.tree;
  }
  let next = current;
  if (opts.to) {
    const sha = validateSha(opts.to);
    const commit = store.commits.find((c) => c.sha === sha);
    if (!commit) fail('E_CHECKPOINT_NOT_FOUND');
    next = commit.tree;
  }
  const { patch, files } = buildPatch(next, base, only);
  return {
    ok: true,
    initialized: store.initialized,
    patch,
    files,
  };
}

async function checkpointStore(sandbox, sessionId, store, opts = {}) {
  if (!store.initialized) initStore(store, opts);
  const message = validateMessage(opts.message);
  if (store.commits.length >= MAX_CHECKPOINTS) {
    fail('E_QUOTA', 'Tope de puntos de control de la sesión.');
  }
  const current = await snapshotTree(sandbox, sessionId);
  const files = compareTrees(current, headTree(store));
  const sha = treeSha(current, message, store.head);
  const createdAt = typeof opts.now === 'function' ? opts.now() : Date.now();
  const commit = {
    sha,
    message,
    createdAt,
    parent: store.head,
    filesChanged: files.length,
    tree: current,
  };
  store.commits.push(commit);
  store.head = sha;
  return {
    ok: true,
    checkpoint: publicCommit(commit),
  };
}

function listStore(store) {
  const checkpoints = store.commits
    .slice()
    .reverse()
    .map(publicCommit);
  return { ok: true, initialized: store.initialized, checkpoints };
}

function getStoreCheckpoint(store, sha, { withPatch = true } = {}) {
  const id = validateSha(sha);
  const commit = store.commits.find((c) => c.sha === id);
  if (!commit) fail('E_CHECKPOINT_NOT_FOUND');
  let patch = '';
  if (withPatch) {
    const parent = commit.parent
      ? store.commits.find((c) => c.sha === commit.parent)
      : null;
    patch = buildPatch(commit.tree, parent ? parent.tree : Object.create(null)).patch;
  }
  return { ok: true, checkpoint: publicCommit(commit), patch };
}

module.exports = {
  MAX_CHECKPOINTS,
  emptyStore,
  getStore,
  snapshotTree,
  compareTrees,
  buildPatch,
  initStore,
  statusStore,
  diffStore,
  checkpointStore,
  listStore,
  getStoreCheckpoint,
  publicCommit,
};
