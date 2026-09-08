'use strict';

/**
 * Hermes-style skill hygiene — native SiraGPT rewrite.
 *
 * Adapted from NousResearch/hermes-agent (MIT) curator consolidation
 * (website/docs/user-guide/features/curator.md): detect near-duplicates,
 * propose merge/archive, never delete, land durable reports in Biblioteca.
 * Not a dump of the Python curator.
 *
 * Isolation: every read/write is keyed by userId. FS and Biblioteca I/O
 * are injectable so tests never need a paid LLM or a real disk.
 */

const crypto = require('crypto');
const path = require('path');

const skillManage = require('../agent-runner/skills/manage');
const biblioteca = require('./hermes-biblioteca');

const MAX_USER_SKILLS = skillManage.MAX_USER_SKILLS || 40;
const MAX_SKILL_CHARS = skillManage.MAX_SKILL_CHARS || 16_000;
const MEMORY_CHAR_LIMIT = 2200;
const WRITE_LIMIT = 8;
const WRITE_WINDOW_MS = 60_000;
const PROMOTE_MIN_USES = 3;
const MAX_PROMOTES_PER_RUN = 3;
const BRAND_LABEL = 'SiraGPT';

const writeLog = new Map();

const PII_OR_SECRET = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b(?:sk|pk|rk|ghp|gho|xox[bp]|Bearer)[-_ ]?[A-Za-z0-9._-]{12,}\b/i,
  /\bBEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY\b/,
  /\b(?:contrase\u00f1a|password|api[_\s-]?key|secret|token|tarjeta|cvv)\b/i,
];

function nowMs(opts = {}) {
  const n = Number(opts.now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function resolveFs(opts = {}) {
  return opts.fs || require('fs');
}

function resolveSkillsHome(skillsHome, env = process.env) {
  return skillsHome
    || env.SIRAGPT_AGENT_SKILLS_HOME
    || path.join(require('os').tmpdir(), 'siragpt-user-skills');
}

function skillMdPath(skillsHome, userId, name) {
  return path.join(skillsHome, userId, name, 'SKILL.md');
}

function normalizeSkillBody(raw) {
  return `${String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()}\n`;
}

function stripFrontmatter(raw) {
  const text = String(raw || '');
  const match = text.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  return match ? text.slice(match[0].length) : text;
}

function hashSkillBody(raw, cryptoImpl = crypto) {
  return cryptoImpl.createHash('sha256')
    .update(normalizeSkillBody(raw), 'utf8')
    .digest('hex');
}

function hashPlaybook(raw, cryptoImpl = crypto) {
  return hashSkillBody(stripFrontmatter(raw), cryptoImpl);
}

function canonicalSkillName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/-(?:copy|dup|clone|v\d+|\d+)$/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function spanishMessage(code, params = {}) {
  const a = params.a || params.keep || params.name || '';
  const b = params.b || (Array.isArray(params.others) ? params.others.join(', ') : '');
  const map = {
    duplicate_hash: `Duplicado por hash: ${a} y ${b} son idénticos.`,
    duplicate_body: `Duplicado de playbook: ${a} y ${b} tienen el mismo cuerpo.`,
    duplicate_name: `Duplicado por nombre: ${a} y ${b} son variantes del mismo nombre.`,
    propose_merge: `Propuesta: conservar ${params.keep || a}, archivar ${params.others ? params.others.join(', ') : b}.`,
    propose_archive: `Propuesta: archivar ${a} (duplicado exacto).`,
    promoted: `Promovido a Biblioteca: ${a} (con procedencia).`,
    candidate_promote: `Candidato a promover: ${a} (alta señal).`,
    merged_conflict: `Conflicto fusionado en Biblioteca: ${a}.`,
    already_promoted: `${a} ya estaba en Biblioteca (mismo hash).`,
    rate_limited: `Escritura limitada: espera ${params.seconds || 0}s (tope de escrituras).`,
    skill_cap: `Tope de skills alcanzado (${params.n || 0}/${params.max || MAX_USER_SKILLS}).`,
    body_too_large: `Cuerpo excede el tope de ${params.n || MAX_SKILL_CHARS} caracteres.`,
    memory_cap: `Tope de memoria alcanzado (${params.used || 0}/${params.limit || MEMORY_CHAR_LIMIT}).`,
    missing_user: 'Falta el userId.',
    secret_blocked: `No se promovió ${a}: parece un secreto o dato sensible.`,
    builtin_skip: 'Las skills integradas no se tocan.',
    low_signal: `${a} no alcanza la señal mínima para promover.`,
    dry_run: 'Simulación: no se movió ningún archivo.',
  };
  return map[code] || `aviso de higiene: ${code}`;
}

function looksLikeSecret(text) {
  const value = String(text || '');
  return PII_OR_SECRET.some((re) => re.test(value));
}

function readSkillRaw(userId, name, opts = {}) {
  if (typeof opts.readSkill === 'function') {
    return String(opts.readSkill(name, userId) || '');
  }
  const fsImpl = resolveFs(opts);
  const home = resolveSkillsHome(opts.skillsHome, opts.env);
  const filePath = skillMdPath(home, userId, name);
  try {
    return String(fsImpl.readFileSync(filePath, 'utf8') || '');
  } catch {
    return '';
  }
}

function fingerprintSkill(skill, opts = {}) {
  const raw = skill.body != null ? String(skill.body) : readSkillRaw(opts.userId, skill.name, opts);
  const body = stripFrontmatter(raw);
  return {
    name: skill.name,
    description: skill.description || '',
    source: skill.source || 'user',
    pinned: skill.pinned === true,
    status: skill.status || 'active',
    uses: Number(skill.uses) || 0,
    lastUsedAt: Number(skill.lastUsedAt) || 0,
    raw,
    body,
    bytes: raw.length,
    contentHash: hashSkillBody(raw, opts.crypto),
    bodyHash: hashPlaybook(raw, opts.crypto),
    canonicalName: canonicalSkillName(skill.name),
  };
}

function fingerprintSkills(skills, opts = {}) {
  return (Array.isArray(skills) ? skills : []).map((skill) => fingerprintSkill(skill, opts));
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].filter(([, rows]) => rows.length > 1);
}

function pickKeeper(rows) {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.uses !== b.uses) return b.uses - a.uses;
    if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    return String(a.name).localeCompare(String(b.name));
  })[0];
}

function detectDuplicates(skills, opts = {}) {
  const prints = Array.isArray(skills) && skills[0] && skills[0].contentHash
    ? skills
    : fingerprintSkills(skills, opts);
  const userPrints = prints.filter((row) => row.source !== 'builtin');
  const readable = userPrints.filter((row) => String(row.raw || row.body || '').trim());
  const duplicates = [];

  for (const [hash, rows] of groupBy(readable, (row) => row.contentHash)) {
    duplicates.push({
      kind: 'hash',
      hash,
      names: rows.map((row) => row.name),
      rows,
      message: spanishMessage('duplicate_hash', { a: rows[0].name, b: rows.slice(1).map((r) => r.name).join(', ') }),
    });
  }

  const seenHashPairs = new Set(duplicates.flatMap((d) => d.names).map((n) => `hash:${n}`));
  for (const [hash, rows] of groupBy(readable, (row) => row.bodyHash)) {
    const alreadyExact = rows.every((row) => seenHashPairs.has(`hash:${row.name}`));
    if (alreadyExact) continue;
    const distinctContent = new Set(rows.map((row) => row.contentHash));
    if (distinctContent.size === 1) continue;
    duplicates.push({
      kind: 'body',
      hash,
      names: rows.map((row) => row.name),
      rows,
      message: spanishMessage('duplicate_body', { a: rows[0].name, b: rows.slice(1).map((r) => r.name).join(', ') }),
    });
  }

  for (const [canonical, rows] of groupBy(readable, (row) => row.canonicalName)) {
    const hashes = new Set(rows.map((row) => row.contentHash));
    if (hashes.size <= 1 && rows.every((row) => duplicates.some((d) => d.names.includes(row.name)))) {
      continue;
    }
    if (rows.length < 2) continue;
    if (hashes.size === 1) continue;
    duplicates.push({
      kind: 'name',
      canonicalName: canonical,
      names: rows.map((row) => row.name),
      rows,
      message: spanishMessage('duplicate_name', { a: rows[0].name, b: rows.slice(1).map((r) => r.name).join(', ') }),
    });
  }

  return { fingerprints: prints, duplicates };
}

function proposeMerge(group) {
  const rows = group.rows || [];
  if (rows.length < 2) {
    return { ok: false, proposals: [], messages: [] };
  }
  const keeper = pickKeeper(rows);
  const losers = rows.filter((row) => row.name !== keeper.name);
  const archivable = losers.filter((row) => !row.pinned && row.source !== 'builtin' && row.status !== 'pinned');
  const exact = group.kind === 'hash';
  const proposal = {
    keep: keeper.name,
    archive: archivable.map((row) => row.name),
    skipped: losers.filter((row) => !archivable.includes(row)).map((row) => row.name),
    kind: group.kind,
    hash: group.hash || null,
    exact,
    reason: exact ? 'exact_hash' : group.kind === 'body' ? 'same_playbook' : 'name_variant',
    message: spanishMessage('propose_merge', {
      keep: keeper.name,
      others: archivable.map((row) => row.name),
    }),
    archiveMessages: archivable.map((row) => spanishMessage('propose_archive', { a: row.name })),
  };
  return { ok: true, keeper, proposal, messages: [proposal.message, ...proposal.archiveMessages] };
}

function proposeHygiene(skills, opts = {}) {
  const { fingerprints, duplicates } = detectDuplicates(skills, opts);
  const mergeProposals = [];
  const messages = [];
  for (const group of duplicates) {
    const proposed = proposeMerge(group);
    if (proposed.ok) {
      mergeProposals.push(proposed.proposal);
      messages.push(group.message, ...proposed.messages);
    }
  }
  return { fingerprints, duplicates, mergeProposals, messages };
}

function checkCaps({ skillCount, bodyChars, memoryUsed } = {}, opts = {}) {
  const skillCap = Number(opts.skillCap) > 0 ? Number(opts.skillCap) : MAX_USER_SKILLS;
  const skillChars = Number(opts.skillChars) > 0 ? Number(opts.skillChars) : MAX_SKILL_CHARS;
  const memoryLimit = Number(opts.memoryLimit) > 0 ? Number(opts.memoryLimit) : MEMORY_CHAR_LIMIT;
  const n = Number(skillCount) || 0;
  const body = Number(bodyChars) || 0;
  const used = Number(memoryUsed) || 0;
  const issues = [];
  if (n >= skillCap) {
    issues.push({
      code: 'skill_cap',
      message: spanishMessage('skill_cap', { n, max: skillCap }),
    });
  }
  if (body > skillChars) {
    issues.push({
      code: 'body_too_large',
      message: spanishMessage('body_too_large', { n: skillChars }),
    });
  }
  if (used >= memoryLimit) {
    issues.push({
      code: 'memory_cap',
      message: spanishMessage('memory_cap', { used, limit: memoryLimit }),
    });
  }
  return {
    ok: issues.length === 0,
    skillCap,
    skillChars,
    memoryLimit,
    skillCount: n,
    bodyChars: body,
    memoryUsed: used,
    overSkillCap: n >= skillCap,
    overBodyCap: body > skillChars,
    overMemoryCap: used >= memoryLimit,
    issues,
    messages: issues.map((issue) => issue.message),
  };
}

function allowWrite(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { allowed: false, message: spanishMessage('missing_user') };
  }
  const now = nowMs(opts);
  const limit = Number(opts.writeLimit) > 0 ? Number(opts.writeLimit) : WRITE_LIMIT;
  const windowMs = Number(opts.writeWindowMs) > 0 ? Number(opts.writeWindowMs) : WRITE_WINDOW_MS;
  const stamps = (writeLog.get(id) || []).filter((ts) => now - ts < windowMs);
  if (stamps.length >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - stamps[0]));
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      message: spanishMessage('rate_limited', { seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }),
    };
  }
  stamps.push(now);
  writeLog.set(id, stamps);
  return { allowed: true, remaining: limit - stamps.length, retryAfterMs: 0 };
}

function peekWrite(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { remaining: 0 };
  const now = nowMs(opts);
  const limit = Number(opts.writeLimit) > 0 ? Number(opts.writeLimit) : WRITE_LIMIT;
  const windowMs = Number(opts.writeWindowMs) > 0 ? Number(opts.writeWindowMs) : WRITE_WINDOW_MS;
  const stamps = (writeLog.get(id) || []).filter((ts) => now - ts < windowMs);
  return { remaining: Math.max(0, limit - stamps.length), used: stamps.length, limit };
}

function isHighSignal(row, opts = {}) {
  const minUses = Number(opts.minUses) > 0 ? Number(opts.minUses) : PROMOTE_MIN_USES;
  if (row.status === 'archived') return false;
  if (row.pinned && row.uses >= 1) return true;
  return row.uses >= minUses;
}

function findPromoteCandidates(fingerprints, opts = {}) {
  return fingerprints.filter((row) => {
    if (row.source === 'builtin') return false;
    if (!isHighSignal(row, opts)) return false;
    if (looksLikeSecret(row.raw || row.body)) return false;
    if ((row.raw || row.body || '').length > (opts.skillChars || MAX_SKILL_CHARS)) return false;
    return true;
  });
}

function renderProvenance({ skill, userId, hash, prevHash, merged }) {
  const lines = [
    '# Skill promovida',
    '',
    `nombre: ${skill.name}`,
    'procedencia: skill de usuario',
    `userId: ${userId}`,
    `hash: ${hash}`,
    `usos: ${skill.uses || 0}`,
    `ultima_vez: ${skill.lastUsedAt || 0}`,
    `marca: ${BRAND_LABEL}`,
  ];
  if (merged && prevHash) {
    lines.push(`hash_previo: ${prevHash}`);
    lines.push('fusion: conflicto de nombre con hash distinto');
  }
  lines.push('', '## Cuerpo', '', String(skill.body || skill.raw || '').trim(), '');
  lines.push('Adaptado del patrón curator de Hermes Agent (MIT). Sin código upstream.');
  return lines.join('\n');
}

function findExistingPromote(list, skillName, hash) {
  const needle = `skill-promote-${skillName}`.toLowerCase();
  const items = Array.isArray(list) ? list : [];
  return items.filter((item) => {
    const filename = String(item.filename || item.title || '').toLowerCase();
    const body = String(item.body || '');
    return filename.includes(needle) || filename.includes(String(skillName).toLowerCase())
      || (hash && body.includes(hash));
  });
}

function promoteSkill(userId, skill, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, message: spanishMessage('missing_user') };
  const print = skill.contentHash ? skill : fingerprintSkill(skill, { ...opts, userId: id });
  if (print.source === 'builtin') {
    return { ok: false, skipped: true, message: spanishMessage('builtin_skip') };
  }
  if (!isHighSignal(print, opts) && opts.requireHighSignal !== false) {
    return { ok: false, skipped: true, message: spanishMessage('low_signal', { a: print.name }) };
  }
  if (looksLikeSecret(print.raw || print.body)) {
    return { ok: false, skipped: true, message: spanishMessage('secret_blocked', { a: print.name }) };
  }
  const caps = checkCaps({
    skillCount: opts.skillCount,
    bodyChars: print.bytes || (print.raw || print.body || '').length,
    memoryUsed: opts.memoryUsed,
  }, opts);
  if (caps.overBodyCap) {
    return { ok: false, message: caps.messages.find((m) => m.includes('Cuerpo')) || caps.messages[0] };
  }

  const promotedState = opts.promotedState && typeof opts.promotedState === 'object'
    ? opts.promotedState
    : {};
  const prior = promotedState[print.name];
  if (prior && prior.hash === print.contentHash) {
    return {
      ok: true,
      skipped: true,
      alreadyPromoted: true,
      asset_id: prior.assetId || null,
      hash: print.contentHash,
      message: spanishMessage('already_promoted', { a: print.name }),
    };
  }

  const existingList = typeof opts.list === 'function'
    ? opts.list(id)
    : (opts.existing || []);
  const matches = findExistingPromote(existingList, print.name, print.contentHash);
  const sameHash = matches.some((item) => String(item.body || '').includes(print.contentHash)
    || (prior && prior.hash === print.contentHash));
  if (sameHash) {
    return {
      ok: true,
      skipped: true,
      alreadyPromoted: true,
      asset_id: (matches[0] && matches[0].id) || (prior && prior.assetId) || null,
      hash: print.contentHash,
      message: spanishMessage('already_promoted', { a: print.name }),
    };
  }

  const merged = Boolean(prior && prior.hash && prior.hash !== print.contentHash)
    || matches.length > 0;
  const body = renderProvenance({
    skill: print,
    userId: id,
    hash: print.contentHash,
    prevHash: prior ? prior.hash : null,
    merged,
  });
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      name: print.name,
      hash: print.contentHash,
      merged,
      message: spanishMessage(merged ? 'merged_conflict' : 'promoted', { a: print.name }),
      body,
    };
  }

  const gate = allowWrite(id, opts);
  if (!gate.allowed) {
    return { ok: false, rateLimited: true, message: gate.message, retryAfterMs: gate.retryAfterMs };
  }

  const deposit = biblioteca.deposit({
    userId: id,
    chatId: opts.chatId || null,
    title: `skill-promote-${print.name}`,
    body,
    kind: 'plan',
    save: opts.save,
  });
  if (!deposit.ok) {
    return { ok: false, message: deposit.error || 'no se pudo depositar', deposit };
  }

  let memoryNote = null;
  if (opts.remember !== false && typeof (opts.curatedMemory && opts.curatedMemory.add) === 'function') {
    const note = `Skill promovida: ${print.name} (${print.contentHash.slice(0, 12)})`;
    const used = Number(opts.memoryUsed) || 0;
    if (used + note.length + 3 > (opts.memoryLimit || MEMORY_CHAR_LIMIT)) {
      memoryNote = { ok: false, message: spanishMessage('memory_cap', { used, limit: opts.memoryLimit || MEMORY_CHAR_LIMIT }) };
    } else {
      memoryNote = opts.curatedMemory.add(id, { target: 'memory', content: note });
    }
  }

  return {
    ok: true,
    name: print.name,
    hash: print.contentHash,
    merged,
    asset_id: deposit.asset_id,
    brand_label: deposit.brand_label || BRAND_LABEL,
    userId: id,
    message: spanishMessage(merged ? 'merged_conflict' : 'promoted', { a: print.name }),
    biblioteca: deposit,
    memoryNote,
    provenance: {
      source: 'user-skill',
      skillName: print.name,
      contentHash: print.contentHash,
      uses: print.uses,
      lastUsedAt: print.lastUsedAt,
      userId: id,
      prevHash: prior ? prior.hash : null,
      merged,
    },
  };
}

function inspectHygiene(userId, skills, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { ok: false, message: spanishMessage('missing_user') };
  }
  const hygiene = proposeHygiene(skills, { ...opts, userId: id });
  const promoteCandidates = findPromoteCandidates(hygiene.fingerprints, opts);
  const caps = checkCaps({
    skillCount: hygiene.fingerprints.filter((row) => row.source !== 'builtin').length,
    memoryUsed: opts.memoryUsed,
  }, opts);
  const writes = peekWrite(id, opts);
  return {
    ok: true,
    userId: id,
    fingerprints: hygiene.fingerprints,
    duplicates: hygiene.duplicates,
    mergeProposals: hygiene.mergeProposals,
    promoteCandidates: promoteCandidates.map((row) => ({
      name: row.name,
      hash: row.contentHash,
      uses: row.uses,
      pinned: row.pinned,
      reason: row.pinned ? 'pinned' : 'high_uses',
    })),
    messages: [
      ...hygiene.messages,
      ...caps.messages,
      ...promoteCandidates.map((row) => spanishMessage('candidate_promote', { a: row.name })),
    ],
    caps,
    writes,
  };
}

function resetForTests() {
  writeLog.clear();
}

module.exports = {
  MAX_USER_SKILLS,
  MAX_SKILL_CHARS,
  MEMORY_CHAR_LIMIT,
  WRITE_LIMIT,
  WRITE_WINDOW_MS,
  PROMOTE_MIN_USES,
  MAX_PROMOTES_PER_RUN,
  BRAND_LABEL,
  normalizeSkillBody,
  hashSkillBody,
  hashPlaybook,
  canonicalSkillName,
  spanishMessage,
  looksLikeSecret,
  fingerprintSkill,
  fingerprintSkills,
  detectDuplicates,
  proposeMerge,
  proposeHygiene,
  checkCaps,
  allowWrite,
  peekWrite,
  isHighSignal,
  findPromoteCandidates,
  renderProvenance,
  promoteSkill,
  inspectHygiene,
  resetForTests,
};
