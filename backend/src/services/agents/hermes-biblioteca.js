'use strict';

/**
 * Hermes → Biblioteca deposit + skill revision ledger.
 *
 * Adapted from NousResearch/hermes-agent (MIT) curator reports
 * (`logs/curator/REPORT.md`) — not a dump of the Python module:
 *   https://github.com/NousResearch/hermes-agent
 *
 * Pattern adopted:
 *   - Skill / curator reports land as durable artifacts, not chat-only text
 *   - Owner-scoped: user B never sees user A's deposits
 *   - brand_label stays a SiraGPT product name (never a vendor / model_id)
 *   - Promote is append-only: a new hash keeps the prior revision
 *   - Restore is by content hash (native hygiene extension, not tar.gz rollback)
 */

const BRAND_LABEL = 'SiraGPT';
const MAX_BODY_CHARS = 80_000;
const SAFE_TITLE = /[^a-zA-Z0-9._-]+/g;
const HASH_RE = /^[a-f0-9]{12,64}$/;

const liveLedgers = new Map();
const hydratedUsers = new Set();

function diskPersistence() {
  return require('../cowork-disk-persistence');
}

function taskTools() {
  return require('./task-tools');
}

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function spanishError(code, params = {}) {
  const name = params.name || params.a || '';
  const hash = params.hash || '';
  const map = {
    missing_user: 'Falta el userId.',
    empty_body: 'El cuerpo no puede estar vacío.',
    body_too_large: `El cuerpo excede ${params.n || MAX_BODY_CHARS} caracteres.`,
    missing_hash: 'Falta el hash de la revisión.',
    missing_skill: 'Falta el nombre de la skill.',
    invalid_hash: 'El hash de la revisión no es válido.',
    revision_not_found: hash
      ? `No hay revisión con hash ${hash} en Biblioteca.`
      : 'No hay revisión con ese hash en Biblioteca.',
    hash_ambiguous: `El prefijo ${hash} coincide con varias revisiones.`,
    already_current: name
      ? `${name} ya está en esa revisión.`
      : 'La skill ya está en esa revisión.',
    already_promoted: name
      ? `${name} ya estaba en Biblioteca (mismo hash).`
      : 'Ya estaba en Biblioteca (mismo hash).',
    restore_ok: name
      ? `Restaurada ${name} a hash ${hash}.`
      : `Restaurada la revisión ${hash}.`,
    prior_kept: name
      ? `Se conservó la revisión previa de ${name}.`
      : 'Se conservó la revisión previa.',
    foreign_owner: 'No puedes restaurar una revisión de otro usuario.',
  };
  return map[code] || `aviso de biblioteca: ${code}`;
}

function safeFilename(title, ext = 'md') {
  const stem = String(title || 'biblioteca-artifact')
    .replace(SAFE_TITLE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'biblioteca-artifact';
  return `${stem}.${ext}`;
}

function normalizeHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  return HASH_RE.test(value) ? value : null;
}

function emptyLedger() {
  return { skills: {} };
}

function skillSlot(ledger, skillName) {
  const name = String(skillName || '').trim();
  if (!name) return null;
  if (!ledger.skills[name]) {
    ledger.skills[name] = {
      currentHash: null,
      currentAssetId: null,
      currentRevision: 0,
      revisions: [],
    };
  }
  return ledger.skills[name];
}

function ledgerFor(userId, opts = {}) {
  if (opts.store && typeof opts.store === 'object') {
    if (!opts.store[userId]) opts.store[userId] = emptyLedger();
    return opts.store[userId];
  }
  if (opts.ledger && typeof opts.ledger === 'object') return opts.ledger;
  if (!hydratedUsers.has(userId)) {
    hydratedUsers.add(userId);
    try {
      liveLedgers.set(userId, diskPersistence().loadSkillRevisions(userId));
    } catch {
      liveLedgers.set(userId, emptyLedger());
    }
  }
  if (!liveLedgers.has(userId)) liveLedgers.set(userId, emptyLedger());
  return liveLedgers.get(userId);
}

function persistLedger(userId, opts = {}) {
  if (opts.store || opts.ledger) return;
  try {
    diskPersistence().saveSkillRevisions(userId, liveLedgers.get(userId) || emptyLedger());
  } catch {
    // Persistence is best-effort; live ledger still answers this process.
  }
}

function parseProvenanceMeta(markdown) {
  const text = String(markdown || '');
  const pick = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  };
  const revisionRaw = pick('revision');
  return {
    name: pick('nombre'),
    hash: pick('hash'),
    prevHash: pick('hash_previo'),
    userId: pick('userId'),
    revision: revisionRaw && /^\d+$/.test(revisionRaw) ? Number(revisionRaw) : null,
    priorKept: /^conserva_previa:\s*s[ií]/im.test(text),
  };
}

function extractSkillBodyFromProvenance(markdown) {
  const text = String(markdown || '');
  const marked = text.match(/## Cuerpo\s*\n+([\s\S]*?)\n+Adaptado del patr[oó]n curator/);
  if (marked) return marked[1].replace(/\s+$/g, '').trim();
  const idx = text.indexOf('## Cuerpo');
  if (idx === -1) return text.trim();
  return text
    .slice(idx)
    .replace(/^## Cuerpo\s*/, '')
    .replace(/\nAdaptado del patr[oó]n curator[\s\S]*$/, '')
    .trim();
}

function flattenRevisions(ledger) {
  const rows = [];
  for (const [name, slot] of Object.entries(ledger.skills || {})) {
    for (const rev of slot.revisions || []) {
      rows.push({
        ...rev,
        skillName: name,
        current: slot.currentHash === rev.hash,
      });
    }
  }
  return rows;
}

function matchRevisionsByHash(ledger, hash) {
  const needle = normalizeHash(hash);
  if (!needle) return { ok: false, error: spanishError('invalid_hash'), matches: [] };
  const rows = flattenRevisions(ledger);
  const exact = rows.filter((row) => row.hash === needle);
  if (exact.length) return { ok: true, matches: exact, hash: needle };
  const prefixed = rows.filter((row) => row.hash && row.hash.startsWith(needle));
  if (prefixed.length > 1) {
    return { ok: false, error: spanishError('hash_ambiguous', { hash: needle }), matches: prefixed, hash: needle };
  }
  return { ok: true, matches: prefixed, hash: needle };
}

function appendRevision(slot, entry) {
  const existing = slot.revisions.find((row) => row.hash === entry.hash);
  if (existing) {
    if (entry.assetId && !existing.assetId) existing.assetId = entry.assetId;
    return existing;
  }
  const revision = entry.revision || slot.revisions.length + 1;
  const row = {
    revision,
    hash: entry.hash,
    assetId: entry.assetId || null,
    at: entry.at || Date.now(),
    prevHash: entry.prevHash || null,
    merged: entry.merged === true,
    filename: entry.filename || null,
    brand_label: entry.brand_label || BRAND_LABEL,
    stub: entry.stub === true,
  };
  slot.revisions.push(row);
  return row;
}

function pointCurrent(slot, row) {
  slot.currentHash = row.hash;
  slot.currentAssetId = row.assetId || null;
  slot.currentRevision = row.revision;
}

function seedPriorRevision(slot, { prevHash, priorAssetId }) {
  const hash = normalizeHash(prevHash);
  if (!hash) return null;
  if (slot.revisions.some((row) => row.hash === hash)) return null;
  const row = appendRevision(slot, {
    hash,
    assetId: priorAssetId || null,
    stub: !priorAssetId,
    prevHash: null,
  });
  return row;
}

function deposit({ userId, chatId, title, body, kind, save } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: spanishError('missing_user') };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: spanishError('empty_body') };
  if (text.length > MAX_BODY_CHARS) {
    return { ok: false, error: spanishError('body_too_large', { n: MAX_BODY_CHARS }) };
  }

  const filename = safeFilename(title);
  const saveArtifact = typeof save === 'function' ? save : taskTools().saveArtifact;
  const artifact = saveArtifact({
    filename,
    base64: Buffer.from(text, 'utf8').toString('base64'),
    mime: 'text/markdown',
    ownerUserId: id,
    chatId: chatId || null,
    category: 'document',
    brandLabel: BRAND_LABEL,
    kind: kind || 'document',
  });

  return {
    ok: true,
    asset_id: artifact.id,
    kind: artifact.kind || kind || 'document',
    brand_label: BRAND_LABEL,
    filename: artifact.filename,
    downloadUrl: artifact.downloadUrl,
    chatId: chatId || null,
    userId: id,
  };
}

function listForUser(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return [];
  const listArtifactsByOwner = typeof opts.list === 'function'
    ? opts.list
    : taskTools().listArtifactsByOwner;
  return listArtifactsByOwner(id, {
    categories: opts.categories || ['document'],
    max: opts.max || 200,
  });
}

function hydrateFromArtifacts(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return emptyLedger();
  const ledger = ledgerFor(id, opts);
  const items = listForUser(id, opts);
  for (const item of items) {
    const meta = parseProvenanceMeta(item.body || '');
    if (!meta.hash || !meta.name) continue;
    if (meta.userId && meta.userId !== id) continue;
    const hash = normalizeHash(meta.hash);
    if (!hash) continue;
    const slot = skillSlot(ledger, meta.name);
    appendRevision(slot, {
      revision: meta.revision || undefined,
      hash,
      assetId: item.id || item.asset_id || null,
      prevHash: meta.prevHash,
      filename: item.filename || null,
    });
    if (!slot.currentHash) pointCurrent(slot, slot.revisions[slot.revisions.length - 1]);
  }
  persistLedger(id, opts);
  return ledger;
}

function findRevision(userId, skillName, hash, opts = {}) {
  const id = normalizeUserId(userId);
  const needle = normalizeHash(hash);
  const name = String(skillName || '').trim();
  if (!id || !needle || !name) return null;
  const ledger = ledgerFor(id, opts);
  const slot = ledger.skills[name];
  if (!slot) return null;
  return (slot.revisions || []).find((row) => row.hash === needle || row.hash.startsWith(needle)) || null;
}

function listRevisions(userId, skillName, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return [];
  const ledger = ledgerFor(id, opts);
  if (opts.hydrate) hydrateFromArtifacts(id, opts);
  const name = String(skillName || '').trim();
  if (!name) {
    return flattenRevisions(ledger).sort((a, b) => a.revision - b.revision);
  }
  const slot = ledger.skills[name];
  if (!slot) return [];
  return (slot.revisions || []).map((row) => ({
    ...row,
    skillName: name,
    current: slot.currentHash === row.hash,
  }));
}

function getRevisionByHash(userId, hash, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: spanishError('missing_user') };
  const needle = normalizeHash(hash);
  if (!needle) return { ok: false, error: spanishError(hash ? 'invalid_hash' : 'missing_hash') };
  const ledger = ledgerFor(id, opts);
  if (opts.hydrate) hydrateFromArtifacts(id, opts);
  const matched = matchRevisionsByHash(ledger, needle);
  if (!matched.ok) return { ok: false, error: matched.error, matches: matched.matches };
  if (!matched.matches.length) {
    return { ok: false, error: spanishError('revision_not_found', { hash: needle }) };
  }
  const row = matched.matches[0];
  return {
    ok: true,
    userId: id,
    skillName: row.skillName,
    hash: row.hash,
    asset_id: row.assetId,
    revision: row.revision,
    current: row.current,
    brand_label: row.brand_label || BRAND_LABEL,
    revisionRow: row,
  };
}

function readRevisionBody(userId, assetId, opts = {}) {
  if (typeof opts.readBody === 'function') {
    return String(opts.readBody(assetId, userId) || '');
  }
  if (opts.body) return String(opts.body);
  const items = listForUser(userId, opts);
  const hit = items.find((item) => item.id === assetId || item.asset_id === assetId);
  if (hit && hit.body) return String(hit.body);
  if (!assetId) return '';
  try {
    const tools = taskTools();
    const local = require('./artifact-local-source');
    const meta = local.readArtifactMetadata(assetId, tools.ARTIFACT_DIR);
    if (!meta || String(meta.ownerUserId) !== String(userId)) return '';
    const filePath = local.resolveLocalArtifactPath(meta, tools.ARTIFACT_DIR, assetId);
    if (!filePath) return '';
    return require('fs').readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function depositRevision({
  userId,
  chatId,
  skillName,
  hash,
  body,
  prevHash,
  priorAssetId,
  merged,
  kind,
  save,
  store,
  ledger,
} = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: spanishError('missing_user') };
  const name = String(skillName || '').trim();
  if (!name) return { ok: false, error: spanishError('missing_skill') };
  const contentHash = normalizeHash(hash);
  if (!contentHash) return { ok: false, error: spanishError(hash ? 'invalid_hash' : 'missing_hash') };

  const opts = { store, ledger, save };
  const live = ledgerFor(id, opts);
  const slot = skillSlot(live, name);
  const already = slot.revisions.find((row) => row.hash === contentHash);
  if (already) {
    pointCurrent(slot, already);
    persistLedger(id, opts);
    return {
      ok: true,
      skipped: true,
      alreadyPromoted: true,
      asset_id: already.assetId,
      hash: already.hash,
      revision: already.revision,
      name,
      userId: id,
      brand_label: BRAND_LABEL,
      priorKept: slot.revisions.length > 1,
      revisions: listRevisions(id, name, opts),
      error: spanishError('already_promoted', { name }),
      message: spanishError('already_promoted', { name }),
    };
  }

  const seeded = seedPriorRevision(slot, { prevHash, priorAssetId });
  const priorKept = slot.revisions.length > 0 || Boolean(seeded);
  const nextRevision = slot.revisions.length + 1;

  const deposited = deposit({
    userId: id,
    chatId,
    title: `skill-promote-${name}`,
    body,
    kind: kind || 'plan',
    save,
  });
  if (!deposited.ok) return deposited;

  const row = appendRevision(slot, {
    revision: nextRevision,
    hash: contentHash,
    assetId: deposited.asset_id,
    prevHash: normalizeHash(prevHash),
    merged: merged === true,
    filename: deposited.filename,
    brand_label: BRAND_LABEL,
  });
  pointCurrent(slot, row);
  persistLedger(id, opts);

  return {
    ok: true,
    asset_id: deposited.asset_id,
    hash: contentHash,
    revision: row.revision,
    name,
    userId: id,
    brand_label: BRAND_LABEL,
    filename: deposited.filename,
    downloadUrl: deposited.downloadUrl,
    chatId: chatId || null,
    kind: deposited.kind,
    priorKept,
    prevHash: normalizeHash(prevHash),
    message: priorKept
      ? spanishError('prior_kept', { name })
      : undefined,
    revisions: listRevisions(id, name, opts),
    biblioteca: deposited,
  };
}

function restoreByHash(userId, hash, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, error: spanishError('missing_user') };
  const found = getRevisionByHash(id, hash, opts);
  if (!found.ok) return found;

  const live = ledgerFor(id, opts);
  const slot = live.skills[found.skillName];
  const markdown = readRevisionBody(id, found.asset_id, opts);
  const skillBody = extractSkillBodyFromProvenance(markdown);
  const alreadyCurrent = slot && slot.currentHash === found.hash;

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      userId: id,
      name: found.skillName,
      skillName: found.skillName,
      hash: found.hash,
      asset_id: found.asset_id,
      revision: found.revision,
      brand_label: BRAND_LABEL,
      skillBody,
      body: markdown,
      alreadyCurrent,
      message: spanishError('restore_ok', { name: found.skillName, hash: found.hash }),
    };
  }

  if (alreadyCurrent) {
    return {
      ok: true,
      skipped: true,
      alreadyCurrent: true,
      userId: id,
      name: found.skillName,
      skillName: found.skillName,
      hash: found.hash,
      asset_id: found.asset_id,
      revision: found.revision,
      brand_label: BRAND_LABEL,
      skillBody,
      body: markdown,
      message: spanishError('already_current', { name: found.skillName }),
    };
  }

  const row = (slot.revisions || []).find((item) => item.hash === found.hash);
  if (row) pointCurrent(slot, row);
  persistLedger(id, opts);

  return {
    ok: true,
    restored: true,
    userId: id,
    name: found.skillName,
    skillName: found.skillName,
    hash: found.hash,
    asset_id: found.asset_id,
    revision: found.revision,
    brand_label: BRAND_LABEL,
    skillBody,
    body: markdown,
    revisions: listRevisions(id, found.skillName, opts),
    message: spanishError('restore_ok', { name: found.skillName, hash: found.hash }),
  };
}

function clearUser(userId) {
  const id = normalizeUserId(userId);
  if (!id) return { cleared: false };
  liveLedgers.delete(id);
  hydratedUsers.delete(id);
  try { diskPersistence().clearSkillRevisions(id); } catch { /* best-effort */ }
  return { cleared: true };
}

function resetForTests() {
  const known = new Set([...liveLedgers.keys(), ...hydratedUsers]);
  for (const userId of known) {
    try { diskPersistence().clearSkillRevisions(userId); } catch { /* best-effort */ }
  }
  liveLedgers.clear();
  hydratedUsers.clear();
}

module.exports = {
  BRAND_LABEL,
  MAX_BODY_CHARS,
  deposit,
  depositRevision,
  listForUser,
  listRevisions,
  findRevision,
  getRevisionByHash,
  restoreByHash,
  hydrateFromArtifacts,
  parseProvenanceMeta,
  extractSkillBodyFromProvenance,
  spanishError,
  clearUser,
  resetForTests,
};
