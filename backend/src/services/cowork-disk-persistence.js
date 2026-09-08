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

function normalizePersistedNote(note) {
  if (!note) return null;
  if (typeof note === 'string') {
    const text = note.trim();
    return text ? { id: '', text, sourceCount: 0, createdAt: 0 } : null;
  }
  const text = String(note.text || '').trim();
  if (!text) return null;
  return {
    id: String(note.id || ''),
    text,
    sourceCount: Number(note.sourceCount) || 0,
    createdAt: Number(note.createdAt) || 0,
  };
}

function normalizeCuratedMetaRow(row) {
  if (!row || typeof row !== 'object') {
    return { pinned: false, createdAt: 0, updatedAt: 0 };
  }
  return {
    pinned: row.pinned === true,
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || Number(row.createdAt) || 0,
  };
}

function normalizeCuratedMeta(meta) {
  const src = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const out = { memory: {}, user: {} };
  for (const target of ['memory', 'user']) {
    const bucket = src[target] && typeof src[target] === 'object' && !Array.isArray(src[target])
      ? src[target]
      : {};
    for (const [text, row] of Object.entries(bucket)) {
      if (!text) continue;
      out[target][String(text)] = normalizeCuratedMetaRow(row);
    }
  }
  return out;
}

function loadCuratedMemory(userId) {
  const row = loadJson(userPath('curated-memory', userId), { memory: [], user: [], notes: [] });
  return {
    memory: Array.isArray(row.memory) ? row.memory.map(String) : [],
    user: Array.isArray(row.user) ? row.user.map(String) : [],
    notes: Array.isArray(row.notes)
      ? row.notes.map(normalizePersistedNote).filter(Boolean)
      : [],
    meta: normalizeCuratedMeta(row.meta),
    updatedAt: Number(row.updatedAt) || 0,
  };
}

function saveCuratedMemory(userId, stores) {
  saveJson(userPath('curated-memory', userId), {
    userId: String(userId),
    updatedAt: Date.now(),
    memory: Array.isArray(stores?.memory) ? stores.memory.map(String) : [],
    user: Array.isArray(stores?.user) ? stores.user.map(String) : [],
    notes: Array.isArray(stores?.notes)
      ? stores.notes.map(normalizePersistedNote).filter(Boolean)
      : [],
    meta: normalizeCuratedMeta(stores?.meta),
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

function emptyCuratorState() {
  return { lastRunAt: 0, skills: {}, pinned: [], promoted: {} };
}

function loadSkillCurator(userId) {
  const row = loadJson(userPath('skill-curator', userId), emptyCuratorState());
  const skills = row.skills && typeof row.skills === 'object' && !Array.isArray(row.skills)
    ? row.skills
    : {};
  const promoted = row.promoted && typeof row.promoted === 'object' && !Array.isArray(row.promoted)
    ? row.promoted
    : {};
  return {
    lastRunAt: Number(row.lastRunAt) || 0,
    skills,
    pinned: Array.isArray(row.pinned) ? row.pinned.map(String) : [],
    promoted,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

function saveSkillCurator(userId, state) {
  saveJson(userPath('skill-curator', userId), {
    userId: String(userId),
    updatedAt: Date.now(),
    lastRunAt: Number(state?.lastRunAt) || 0,
    skills: state?.skills && typeof state.skills === 'object' && !Array.isArray(state.skills)
      ? state.skills
      : {},
    pinned: Array.isArray(state?.pinned) ? state.pinned.map(String) : [],
    promoted: state?.promoted && typeof state.promoted === 'object' && !Array.isArray(state.promoted)
      ? state.promoted
      : {},
  });
}

function clearSkillCurator(userId) {
  const filePath = userPath('skill-curator', userId);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

function emptyRevisionLedger() {
  return { skills: {} };
}

function loadSkillRevisions(userId) {
  const row = loadJson(userPath('skill-revisions', userId), emptyRevisionLedger());
  const skills = row.skills && typeof row.skills === 'object' && !Array.isArray(row.skills)
    ? row.skills
    : {};
  return {
    skills,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

function saveSkillRevisions(userId, ledger) {
  saveJson(userPath('skill-revisions', userId), {
    userId: String(userId),
    updatedAt: Date.now(),
    skills: ledger?.skills && typeof ledger.skills === 'object' && !Array.isArray(ledger.skills)
      ? ledger.skills
      : {},
  });
}

function clearSkillRevisions(userId) {
  const filePath = userPath('skill-revisions', userId);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

module.exports = {
  STORE_ROOT,
  loadMemoryEntries,
  saveMemoryEntries,
  loadMemoryDocument,
  saveMemoryDocument,
  loadCuratedMemory,
  saveCuratedMemory,
  loadSessions,
  saveSessions,
  loadSkillCurator,
  saveSkillCurator,
  clearSkillCurator,
  loadSkillRevisions,
  saveSkillRevisions,
  clearSkillRevisions,
};
