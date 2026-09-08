'use strict';

/**
 * 3H-BE-013 -- Hermes idea rewritten: skills that persist (user SKILL.md store).
 * 3H2-BE-019 leftover: delete + path-escape + user-scoped load.
 * No Hermes source copied. Names strictly validated; never host-shell.
 */

const fs = require('fs');
const path = require('path');

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY = 16_000;
const DEFAULT_ROOT = process.env.SIRAGPT_USER_SKILLS_DIR || '/app/data/user-skills';

function assertSkillName(name) {
  const clean = String(name || '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(clean)) {
    const err = new Error('invalid_skill_name');
    err.code = 'invalid_skill_name';
    throw err;
  }
  return clean;
}

function userRoot(userId, root = DEFAULT_ROOT) {
  const uid = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!uid) {
    const err = new Error('userId required');
    err.code = 'bad_request';
    throw err;
  }
  return path.join(root, uid);
}

function assertInsideRoot(file, root) {
  const resolved = path.resolve(file);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    const err = new Error('skill_path_escape');
    err.code = 'skill_path_escape';
    throw err;
  }
  return resolved;
}

function persistUserSkill({ userId, name, description = '', body = '', root = DEFAULT_ROOT } = {}) {
  if (!String(userId || '').trim()) throw Object.assign(new Error('userId es obligatorio'), { code: 'user_required' });
  const clean = assertSkillName(name);
  const dir = path.join(userRoot(userId, root), clean);
  assertInsideRoot(dir, userRoot(userId, root));
  fs.mkdirSync(dir, { recursive: true });
  const descRaw = String(description || '');
  const textRaw = String(body || '');
  // 3H15 leftover: oversized skill body/description fail-closed (never silent slice).
  if (descRaw.length > 160) throw Object.assign(new Error('payload_too_long'), { code: 'payload_too_long' });
  if (textRaw.length > MAX_BODY) throw Object.assign(new Error('payload_too_long'), { code: 'payload_too_long' });
  const desc = descRaw;
  const text = textRaw;
  const md = `---\nname: ${clean}\ndescription: ${desc}\n---\n${text}\n`;
  const file = path.join(dir, 'SKILL.md');
  assertInsideRoot(file, userRoot(userId, root));
  fs.writeFileSync(file, md, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, name: clean, persisted: true, userId: String(userId) };
}

function listPersistedSkills({ userId, root = DEFAULT_ROOT } = {}) {
  if (!String(userId || '').trim()) return [];
  const dir = userRoot(userId, root);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SKILL_NAME_RE.test(e.name)) continue;
    out.push({ name: e.name, userId: String(userId), persisted: true });
  }
  return out;
}

function loadPersistedSkill({ userId, name, root = DEFAULT_ROOT } = {}) {
  if (!String(userId || '').trim()) return null;
  const clean = assertSkillName(name);
  const file = path.join(userRoot(userId, root), clean, 'SKILL.md');
  assertInsideRoot(file, userRoot(userId, root));
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ok: true, name: clean, body: raw.slice(0, MAX_BODY), persisted: true, userId: String(userId) };
  } catch {
    return { ok: false, error: 'skill_not_found', name: clean };
  }
}

function deletePersistedSkill({ userId, name, root = DEFAULT_ROOT } = {}) {
  if (!String(userId || '').trim()) return { deleted: false, error: 'user_required' };
  const clean = assertSkillName(name);
  const dir = path.join(userRoot(userId, root), clean);
  assertInsideRoot(dir, userRoot(userId, root));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, name: clean, deleted: true, userId: String(userId) };
  } catch {
    return { ok: false, error: 'skill_delete_failed', name: clean };
  }
}


function searchPersistedSkills({ userId, query, limit = 8, root = DEFAULT_ROOT } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const q = String(query || '').trim().toLowerCase().slice(0, 200);
  if (!q) return [];
  const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 8);
  const listed = listPersistedSkills({ userId: uid, root });
  const scored = [];
  for (const item of listed) {
    const loaded = loadPersistedSkill({ userId: uid, name: item.name, root });
    if (!loaded || !loaded.ok) continue;
    const hay = (item.name + ' ' + (loaded.body || '')).toLowerCase().slice(0, 8000);
    let score = 0;
    for (const t of terms) {
      let idx = 0;
      while ((idx = hay.indexOf(t, idx)) !== -1) { score += 1; idx += t.length; }
    }
    if (score > 0) scored.push({ name: item.name, userId: uid, score, persisted: true });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, Math.min(40, Number(limit) || 8)));
}

module.exports = {
  searchPersistedSkills,
  SKILL_NAME_RE,
  persistUserSkill,
  listPersistedSkills,
  loadPersistedSkill,
  deletePersistedSkill,
  assertSkillName,
  assertInsideRoot,
};
