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
 *   - Hygiene: hash/name dedupe, merge/archive proposals, high-signal
 *     promote to Biblioteca with provenance + conflict merge
 *
 * Isolation: every read/write is keyed by userId.
 */

const fs = require('fs');
const path = require('path');

const diskPersistence = require('../cowork-disk-persistence');
const skillManage = require('../agent-runner/skills/manage');
const biblioteca = require('./hermes-biblioteca');
const hygiene = require('./hermes-skill-hygiene');
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
  return { lastRunAt: 0, skills: {}, pinned: [], promoted: {} };
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
  if (typeof opts.listSkills === 'function') {
    return (opts.listSkills(userId) || []).filter((skill) => skill.source === 'user' && !skill.readonly);
  }
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

function archiveSkill({ userId, name, skillsHome, env, dryRun, fs: fsImpl }) {
  const io = fsImpl || fs;
  const resolvedHome = resolveSkillsHome(skillsHome, env);
  const src = path.join(resolvedHome, userId, name);
  const dest = path.join(resolvedHome, userId, '.archive', name);
  if (skillManage.isBuiltin(name)) {
    return { ok: false, skipped: true, reason: 'builtin_readonly', message: hygiene.spanishMessage('builtin_skip') };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, name, dest, message: hygiene.spanishMessage('dry_run') };
  }
  if (!io.existsSync(src)) {
    return { ok: false, reason: 'not_found', name };
  }
  try {
    io.mkdirSync(path.dirname(dest), { recursive: true });
    if (io.existsSync(dest)) {
      return { ok: false, reason: 'already_archived', name };
    }
    io.renameSync(src, dest);
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

function attachBodies(userId, rows, opts = {}) {
  return rows.map((row) => {
    if (row.body != null) return row;
    return {
      ...row,
      body: hygiene.fingerprintSkill(row, { ...opts, userId }).raw,
    };
  });
}

function review(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required', message: hygiene.spanishMessage('missing_user') };
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
      body: skill.body,
    };
  });
  const withBodies = attachBodies(id, rows, opts);
  const inspected = hygiene.inspectHygiene(id, withBodies, {
    ...opts,
    userId: id,
    promotedState: state.promoted || {},
  });
  persistUser(id);
  return {
    ok: true,
    userId: id,
    skills: rows.map(({ body, ...rest }) => rest),
    stale: rows.filter((r) => r.status === 'stale'),
    archiveCandidates: rows.filter((r) => r.status === 'archived'),
    pinned: rows.filter((r) => r.status === 'pinned'),
    growth: growthCandidates(opts),
    duplicates: inspected.duplicates || [],
    mergeProposals: inspected.mergeProposals || [],
    promoteCandidates: inspected.promoteCandidates || [],
    messages: inspected.messages || [],
    caps: inspected.caps || null,
    hygiene: inspected,
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
  const messages = reviewResult.messages || [];
  if (messages.length || (reviewResult.duplicates || []).length || (reviewResult.promoteCandidates || []).length) {
    lines.push('', '## Higiene (duplicados y promoción)');
    for (const msg of messages) {
      lines.push(`- ${msg}`);
    }
    for (const proposal of reviewResult.mergeProposals || []) {
      lines.push(`- ${proposal.message}`);
    }
  }
  lines.push('', 'Adapted from Hermes Agent curator (MIT). No upstream code activated.');
  return lines.join('\n');
}

function applyMergeArchives(userId, proposals, opts = {}) {
  const archived = [];
  const messages = [];
  if (opts.hygiene === false) return { archived, messages };
  for (const proposal of proposals || []) {
    for (const name of proposal.archive || []) {
      const gate = hygiene.allowWrite(userId, opts);
      if (!gate.allowed) {
        messages.push(gate.message);
        return { archived, messages, rateLimited: true };
      }
      const moved = archiveSkill({
        userId,
        name,
        skillsHome: opts.skillsHome,
        env: opts.env,
        dryRun: opts.dryRun === true,
        fs: opts.fs,
      });
      archived.push({ ...moved, reason: proposal.reason || 'duplicate' });
      if (moved.ok) messages.push(hygiene.spanishMessage('propose_archive', { a: name }));
    }
  }
  return { archived, messages };
}

function rememberPromote(state, result) {
  if (!state.promoted) state.promoted = {};
  if (!result || !result.ok || result.skipped) return;
  state.promoted[result.name] = {
    hash: result.hash,
    assetId: result.asset_id || null,
    at: Date.now(),
    merged: result.merged === true,
    prevHash: result.provenance ? result.provenance.prevHash : null,
  };
}

function promoteHighSignal(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required', message: hygiene.spanishMessage('missing_user') };
  const reviewed = review(id, opts);
  const state = stateFor(id);
  const names = opts.skillName
    ? reviewed.promoteCandidates.filter((row) => row.name === opts.skillName)
    : reviewed.promoteCandidates;
  const promoted = [];
  const messages = [...(reviewed.messages || [])];
  const limit = Number(opts.maxPromotes) > 0 ? Number(opts.maxPromotes) : hygiene.MAX_PROMOTES_PER_RUN;
  const prints = (reviewed.hygiene && reviewed.hygiene.fingerprints) || [];
  for (const candidate of names.slice(0, limit)) {
    const print = prints.find((row) => row.name === candidate.name) || candidate;
    const out = hygiene.promoteSkill(id, print, {
      ...opts,
      userId: id,
      promotedState: state.promoted || {},
      skillCount: reviewed.skills.length,
      existing: typeof opts.list === 'function' ? opts.list(id) : [],
    });
    promoted.push(out);
    if (out.message) messages.push(out.message);
    if (out.rateLimited) break;
    rememberPromote(state, out);
  }
  persistUser(id);
  return {
    ok: true,
    userId: id,
    dryRun: opts.dryRun === true,
    promoteCandidates: reviewed.promoteCandidates,
    promoted,
    messages,
  };
}

function dedupe(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required', message: hygiene.spanishMessage('missing_user') };
  const reviewed = review(id, opts);
  const dryRun = opts.dryRun !== false;
  const applied = dryRun
    ? { archived: [], messages: [hygiene.spanishMessage('dry_run')] }
    : applyMergeArchives(id, reviewed.mergeProposals, { ...opts, dryRun: false });
  return {
    ok: true,
    userId: id,
    dryRun,
    duplicates: reviewed.duplicates,
    mergeProposals: reviewed.mergeProposals,
    archived: applied.archived,
    messages: [...(reviewed.messages || []), ...(applied.messages || [])],
    rateLimited: applied.rateLimited === true,
  };
}

function run(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: 'userId required', message: hygiene.spanishMessage('missing_user') };
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
        fs: opts.fs,
      });
      archived.push(moved);
    }
  }

  let hygieneArchived = [];
  let hygieneMessages = [];
  let rateLimited = false;
  if (opts.hygiene !== false) {
    const applied = dryRun
      ? { archived: [], messages: [] }
      : applyMergeArchives(id, result.mergeProposals, { ...opts, dryRun: false });
    hygieneArchived = applied.archived;
    hygieneMessages = applied.messages;
    rateLimited = applied.rateLimited === true;
  }

  let promoted = [];
  if (opts.promote === true && opts.hygiene !== false) {
    const promo = promoteHighSignal(id, { ...opts, dryRun });
    promoted = promo.promoted || [];
    hygieneMessages = hygieneMessages.concat(promo.messages || []);
  }

  const reportText = renderReport({
    ...result,
    messages: [...(result.messages || []), ...hygieneMessages],
  });
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
    duplicates: result.duplicates,
    mergeProposals: result.mergeProposals,
    promoteCandidates: result.promoteCandidates,
    promoted,
    hygieneArchived,
    messages: [...(result.messages || []), ...hygieneMessages],
    rateLimited,
    caps: result.caps,
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
    hygiene: {
      dedupeBy: ['hash', 'name'],
      promoteMinUses: hygiene.PROMOTE_MIN_USES,
      writeLimit: hygiene.WRITE_LIMIT,
      skillCap: hygiene.MAX_USER_SKILLS,
    },
  };
  if (!id) return base;
  const state = stateFor(id);
  return {
    ...base,
    lastRunAt: state.lastRunAt,
    trackedSkills: Object.keys(state.skills).length,
    pinned: [...state.pinned],
    promoted: Object.keys(state.promoted || {}),
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
  hygiene.resetForTests();
}

module.exports = {
  STALE_AFTER_MS,
  ARCHIVE_AFTER_MS,
  recordUse,
  pin,
  observe,
  review,
  run,
  dedupe,
  promoteHighSignal,
  archiveSkill,
  status,
  growthCandidates,
  clearUser,
  resetForTests,
};
