'use strict';

const crypto = require('node:crypto');

const signalScopes = new WeakMap();
const runnerScopes = new WeakMap();
const fallbackScopes = new Map();

function normalizeWorkspacePath(path) {
  const value = String(path || '').replaceAll('\\', '/').trim();
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\0')) return null;
  const segments = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length ? segments.join('/') : null;
}

function fingerprint(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

class FileStateTracker {
  constructor() {
    this.snapshots = new Map();
  }

  markRead(path, content) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return null;
    const snapshot = {
      path: normalized,
      fingerprint: fingerprint(content),
      readAt: Date.now(),
    };
    this.snapshots.set(normalized, snapshot);
    return snapshot;
  }

  markWritten(path, content) {
    return this.markRead(path, content);
  }

  forget(path) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized) this.snapshots.delete(normalized);
  }

  checkEdit(path, currentContent) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return { ok: false, reason: 'unsafe_path' };
    const snapshot = this.snapshots.get(normalized);
    if (!snapshot) return { ok: false, reason: 'not_read', path: normalized };
    const currentFingerprint = fingerprint(currentContent);
    if (snapshot.fingerprint !== currentFingerprint) {
      return {
        ok: false,
        reason: 'changed_since_read',
        path: normalized,
        readFingerprint: snapshot.fingerprint,
        currentFingerprint,
      };
    }
    return { ok: true, path: normalized, snapshot };
  }

  clear() {
    this.snapshots.clear();
  }
}

function projectTracker(container, project) {
  const key = String(project || '');
  let tracker = container.get(key);
  if (!tracker) {
    tracker = new FileStateTracker();
    container.set(key, tracker);
  }
  return tracker;
}

function trackerForContext(ctx = {}) {
  if (ctx.fileStateTracker && typeof ctx.fileStateTracker.checkEdit === 'function') {
    return ctx.fileStateTracker;
  }
  if (ctx.signal && typeof ctx.signal === 'object') {
    let byProject = signalScopes.get(ctx.signal);
    if (!byProject) {
      byProject = new Map();
      signalScopes.set(ctx.signal, byProject);
    }
    return projectTracker(byProject, ctx.project);
  }
  if (ctx.runner && typeof ctx.runner === 'object') {
    let byProject = runnerScopes.get(ctx.runner);
    if (!byProject) {
      byProject = new Map();
      runnerScopes.set(ctx.runner, byProject);
    }
    return projectTracker(byProject, ctx.project);
  }
  return projectTracker(fallbackScopes, ctx.project);
}

function shouldEnforceFileState(ctx = {}) {
  return Boolean(
    ctx.fileStateTracker
    || ctx.signal
    || ctx.llmTurn
    || ctx.enforceFileState,
  );
}

function resetFileStateForTests() {
  fallbackScopes.clear();
}

module.exports = {
  FileStateTracker,
  fingerprint,
  normalizeWorkspacePath,
  trackerForContext,
  shouldEnforceFileState,
  resetFileStateForTests,
};
