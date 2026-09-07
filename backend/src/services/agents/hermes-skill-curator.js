'use strict';

/**
 * Hermes skill curator — deterministic skill-library maintenance.
 *
 * Adapted from NousResearch/hermes-agent (MIT) Curator
 * (website/docs/user-guide/features/curator.md):
 *   https://github.com/NousResearch/hermes-agent
 *
 * Pattern adopted (not a dump of the Python curator):
 *   - First observation seeds last_run_at and defers mutation
 *   - Unused user skills: active → stale → archived (never deleted)
 *   - Bundled / pinned skills are off-limits
 *   - Dry-run produces the same report without moving files
 *   - Report lands in Biblioteca (owner-scoped artifact)
 *   - Growth candidates: unmapped Hermes skills rewritten as SiraGPT mappings
 *
 * Isolation: every read/write is keyed by userId.
 */

const fs = require('fs');
const path = require('path');

const diskPersistence = require('../cowork-disk-persistence');
const skillManage = require('../agent-runner/skills/manage');
const biblioteca = require('./hermes-biblioteca');
const { buildHermesIntegrationMap } = require('./hermes-playbook-bridge');

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const GROWTH_HINTS = [
  'document', 'library', 'biblioteca', 'wiki', 'pptx', 'notes',
  'artifact', 'report', 'qmd', 'siyuan',
];

const liveByUser = new Map();
const hydratedUsers = new Set();

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function nowMs(opts = {}) {
  const n = Number(opts.now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function emptyState() {
  return { lastRunAt: 0, skills: {}, pinned: [] };
}

function hydrateUser(userId) {
  if (!userId || hydratedUsers.has(userId)) return;
  hydratedUsers.add(userId);
  try {
    liveByUser.set(userId, diskPersistence.loadSkillCurator(userId));
  } catch {
    liveByUser.set(userId, emptyState());
  }
}

function stateFor(userId) {
  const id = normalizeUserId(userId);
  if (!id) return emptyState();
  hydrateUser(id);
  let state = liveByUser.get(id);
  if (!state) {
    state = emptyState();
    liveByUser.set(id, state);
  }
  return state;
}

function persistUser(userId) {
  const id = normalizeUserId(userId);
  if (!id) return;
  try {
    diskPersistence.saveSkillCurator(id, liveByUser.get(id) || emptyState());
  } catch {
    // Persistence is best-effort; live state still answers this process.
  }
}

function skillRecord(state, name) {
  if (!state.skills[name]) {
    state.skills[name] = { uses: 0, lastUsedAt: 0, firstSeenAt: 0 };
  }
  return state.skills[name];
}

function isPinned(state, name) {
  return (state.pinned || []).includes(name);
}

function recordUse(userId, skillName, opts = {}) {
  const id = normalizeUserId(userId);
  const name = String(skillName || '').trim();
  if (!id || !name) return { ok: false, error: 'userId and skillName required' };
  const state = stateFor(id);
  const rec = skillRecord(state, name);
  const ts = nowMs(opts);
  rec.uses += 1;
  rec.lastUsedAt = ts;
  if (!rec.firstSeenAt) rec.firstSeenAt = ts;
  persistUser(id);
  return { ok: true, name, uses: rec.uses, lastUsedAt: rec.lastUsedAt };
}

function pin(userId, skillName, opts = {}) {
  const id = normalizeUserId(userId);
  const name = String(skillName || '').trim();
  if (!id || !name) return { ok: false, error: 'userId and skillName required' };
  const state = stateFor(id);
  if (!state.pinned.includes(name)) state.pinned.push(name);
  persistUser(id);
  return { ok: true, name, pinned: true, now: nowMs(opts) };
}

function listUserAuthored(userId, opts = {}) {
  const catalog = skillManage.list({
    userId,
    skillsHome: opts.skillsHome,
    env: opts.env || process.env,
  });
  return catalog.filter((skill) => skill.source === 'user' && !skill.readonly);
}

function classify(rec, opts = {}) {
  const ts = nowMs(opts);
  const last = rec.lastUsedAt || rec.firstSeenAt || 0;
  const age = last ? ts - last : Number.POSITIVE_INFINITY;
  if (age >= ARCHIVE_AFTER_MS) return 'archived';
  if (age >= STALE_AFTER_MS) return 'stale';
  return 'active';
}

function growthCandidates(opts = {}) {
  const matrix = opts.matrix || buildHermesIntegrationMap(opts);
  return matrix.skills
    .filter((skill) => skill.status === 'reference-only')
    .filter((skill) => {
      const hay = `${skill.upstream} ${skill.folder} ${skill.description}`.toLowerCase();
      return GROWTH_HINTS.some((hint) => hay.includes(hint));
    })
    .slice(0, opts.limit || 8)
    .map((skill) => ({
      upstream: skill.upstream,
      folder: skill.folder,
      note: 'reference-only — rewrite as a native SiraGPT skill, do not dump upstream',
    }));
}

function resolveSkillsHome(skillsHome, env = process.env) {
  return skillsHome
    || env.SIRAGPT_AGENT_SKILLS_HOME
    || path.join(require('os').tmpdir(), 'siragpt-user-skills');
}

function archiveSkill({ userId, name, skillsHome, env, dryRun }) {
  const resolvedHome = resolveSkillsHome(skillsHome, env);
  const src = path.join(resolvedHome, userId, name);
  const dest = path.join(resolvedHome, userId, '.archive', name);
  if (skillManage.isBuiltin(name)) {
    return { ok: false, skipped: true, reason: 'builtin_readonly' };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, name, dest };
  }
  if (!fs.existsSync(src)) {
    return { ok: false, reason: 'not_found', name };
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      return { ok: false, reason: 'already_archived', name };
    }
    fs.renameSync(src, dest);
    return { ok: true, name, dest };
  } catch (err) {
    return { ok: false, reason: err.message, name };
  }
}

function observe(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required' };
  const state = stateFor(id);
  const ts = nowMs(opts);
  if (!state.lastRunAt) {
    state.lastRunAt = ts;
    persistUser(id);
    return {
      ok: true,
      deferred: true,
      reason: 'first_observation',
      lastRunAt: state.lastRunAt,
    };
  }
  return { ok: true, deferred: false, lastRunAt: state.lastRunAt };
}

function review(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required' };
  const state = stateFor(id);
  const authored = listUserAuthored(id, opts);
  const rows = authored.map((skill) => {
    const rec = skillRecord(state, skill.name);
    if (!rec.firstSeenAt) rec.firstSeenAt = nowMs(opts);
    const pinned = isPinned(state, skill.name);
    const status = pinned ? 'pinned' : classify(rec, opts);
    return {
      name: skill.name,
      description: skill.description,
      source: 'user',
      status,
      uses: rec.uses,
      lastUsedAt: rec.lastUsedAt,
      pinned,
    };
  });
  persistUser(id);
  return {
    ok: true,
    userId: id,
    skills: rows,
    stale: rows.filter((r) => r.status === 'stale'),
    archiveCandidates: rows.filter((r) => r.status === 'archived'),
    pinned: rows.filter((r) => r.status === 'pinned'),
    growth: growthCandidates(opts),
  };
}

function renderReport(reviewResult) {
  const lines = [
    '# SiraGPT skill curator',
    '',
    `User: ${reviewResult.userId}`,
    `Reviewed: ${reviewResult.skills.length} user-authored skill(s).`,
    `Stale: ${reviewResult.stale.length}. Archive candidates: ${reviewResult.archiveCandidates.length}.`,
    '',
    'Bundled skills were not touched.',
    '',
  ];
  for (const row of reviewResult.skills) {
    lines.push(`- ${row.name} [${row.status}] uses=${row.uses}`);
  }
  if (reviewResult.growth.length) {
    lines.push('', '## Growth candidates (Hermes reference-only → native rewrite)');
    for (const g of reviewResult.growth) {
      lines.push(`- ${g.upstream} (${g.folder})`);
    }
  }
  lines.push('', 'Adapted from Hermes Agent curator (MIT). No upstream code activated.');
  return lines.join('\n');
}

function run(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required' };
  const dryRun = opts.dryRun !== false;
  const observed = observe(id, opts);
  if (!observed.ok) return observed;

  if (observed.deferred && !opts.force) {
    return {
      ok: true,
      deferred: true,
      reason: 'first_observation',
      dryRun,
      archived: [],
      report: null,
    };
  }

  const result = review(id, opts);
  const archived = [];
  if (!dryRun) {
    for (const row of result.archiveCandidates) {
      if (row.pinned) continue;
      const moved = archiveSkill({
        userId: id,
        name: row.name,
        skillsHome: opts.skillsHome,
        env: opts.env,
        dryRun: false,
      });
      archived.push(moved);
    }
  }

  const reportText = renderReport(result);
  let deposit = null;
  if (opts.deposit !== false) {
    deposit = biblioteca.deposit({
      userId: id,
      chatId: opts.chatId || null,
      title: `curator-report-${id}`,
      body: reportText,
      kind: 'plan',
      save: opts.save,
    });
  }

  const state = stateFor(id);
  state.lastRunAt = nowMs(opts);
  persistUser(id);

  return {
    ok: true,
    deferred: false,
    dryRun,
    skills: result.skills,
    stale: result.stale,
    archiveCandidates: result.archiveCandidates,
    archived,
    growth: result.growth,
    report: reportText,
    biblioteca: deposit,
  };
}

function status(userId) {
  const id = normalizeUserId(userId);
  const base = {
    pattern: 'hermes-skill-curator',
    staleAfterDays: 30,
    archiveAfterDays: 90,
    neverDeletes: true,
    bundledReadonly: true,
  };
  if (!id) return base;
  const state = stateFor(id);
  return {
    ...base,
    lastRunAt: state.lastRunAt,
    trackedSkills: Object.keys(state.skills).length,
    pinned: [...state.pinned],
  };
}

function clearUser(userId) {
  const id = normalizeUserId(userId);
  if (!id) return { cleared: false };
  liveByUser.delete(id);
  hydratedUsers.delete(id);
  try { diskPersistence.clearSkillCurator(id); } catch { /* best-effort */ }
  return { cleared: true };
}

function resetForTests() {
  liveByUser.clear();
  hydratedUsers.clear();
}

module.exports = {
  STALE_AFTER_MS,
  ARCHIVE_AFTER_MS,
  recordUse,
  pin,
  observe,
  review,
  run,
  status,
  growthCandidates,
  clearUser,
  resetForTests,
};
