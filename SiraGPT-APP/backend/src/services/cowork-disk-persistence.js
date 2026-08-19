'use strict';

const fs = require('fs');
const path = require('path');

const STORE_ROOT = process.env.SIRAGPT_COWORK_STORE_DIR
  || path.join(process.cwd(), 'uploads', 'cowork-store');

function ensureDir(subdir) {
  const dir = path.join(STORE_ROOT, subdir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userPath(subdir, userId) {
  const safe = String(userId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  return path.join(ensureDir(subdir), `${safe || 'anonymous'}.json`);
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0));
  fs.renameSync(tmp, filePath);
}

function loadMemoryEntries(userId) {
  const row = loadJson(userPath('memory', userId), { entries: [] });
  return Array.isArray(row.entries) ? row.entries : [];
}

function saveMemoryEntries(userId, entries) {
  saveJson(userPath('memory', userId), {
    userId: String(userId),
    updatedAt: Date.now(),
    entries: Array.isArray(entries) ? entries : [],
  });
}

function loadMemoryDocument(userId) {
  return loadJson(userPath('memory-doc', userId), null);
}

function saveMemoryDocument(userId, doc) {
  saveJson(userPath('memory-doc', userId), {
    userId: String(userId),
    updatedAt: Date.now(),
    ...(doc && typeof doc === 'object' ? doc : {}),
  });
}

function loadSessions(userId) {
  const row = loadJson(userPath('sessions', userId), { sessions: [] });
  return Array.isArray(row.sessions) ? row.sessions : [];
}

function saveSessions(userId, sessions) {
  saveJson(userPath('sessions', userId), {
    userId: String(userId),
    updatedAt: Date.now(),
    sessions: Array.isArray(sessions) ? sessions : [],
  });
}

module.exports = {
  STORE_ROOT,
  loadMemoryEntries,
  saveMemoryEntries,
  loadMemoryDocument,
  saveMemoryDocument,
  loadSessions,
  saveSessions,
};
