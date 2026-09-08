'use strict';

/**
 * Hermes memory portability — export / import of USER profile + compacted notes.
 *
 * Native rewrite of the Hermes MEMORY.md / USER.md portability *idea*
 * (copy a bounded profile + folded notes between machines, verify bytes).
 * Not a dump of NousResearch/hermes-agent — no Python memory_tool, no
 * OpenRouter, no paid LLM on this path.
 *
 * Snapshot = { profile, notes } + sha256 checksum of the canonical payload.
 * The raw MEMORY log stays local (session-ephemeral). Writes always land
 * on the caller userId; a snapshot never selects another user's store.
 */

const crypto = require('crypto');

const curated = require('./hermes-curated-memory');
const compaction = require('./hermes-memory-compaction');
const writeGuard = require('./memory-write-guard');

const KIND = 'sira.hermes-memory-snapshot';
const SCHEMA_VERSION = 1;
const CHECKSUM_ALG = 'sha256';
const SNAPSHOT_MAX_BYTES = 64 * 1024;
const PROFILE_CHAR_LIMIT = curated.USER_CHAR_LIMIT;
const NOTES_STORE_LIMIT = compaction.NOTES_STORE_LIMIT;
const NOTE_MAX_CHARS = compaction.NOTE_MAX_CHARS;
const FACT_MAX_CHARS = writeGuard.FACT_MAX_CHARS;

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function fail(code, error, extra = {}) {
  const { status, ...rest } = extra;
  return {
    ok: false,
    success: false,
    code,
    error,
    status: status || 400,
    ...rest,
  };
}

function missingUser(action) {
  return fail('E_PARAMS', `Falta el usuario para ${action}.`);
}

function ownerFingerprint(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function normalizeProfile(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function normalizeNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map((note) => {
      if (!note) return null;
      if (typeof note === 'string') {
        const text = note.trim();
        return text ? { id: '', text, sourceCount: 0, createdAt: 0, expiresAt: 0 } : null;
      }
      const text = String(note.text || '').trim();
      if (!text) return null;
      return {
        id: String(note.id || ''),
        text,
        sourceCount: Number.isFinite(Number(note.sourceCount)) ? Number(note.sourceCount) : 0,
        createdAt: Number(note.createdAt) || 0,
        expiresAt: Number(note.expiresAt) || 0,
      };
    })
    .filter(Boolean);
}

function notesForChecksum(notes) {
  return normalizeNotes(notes).map((note) => ({
    id: note.id,
    text: note.text,
    sourceCount: note.sourceCount,
    createdAt: note.createdAt,
  }));
}

function canonicalPayload(profile, notes, fingerprint) {
  return {
    kind: KIND,
    notes: notesForChecksum(notes),
    ownerFingerprint: fingerprint,
    profile,
    version: SCHEMA_VERSION,
  };
}

function computeChecksum(profile, notes, fingerprint) {
  const digest = crypto
    .createHash(CHECKSUM_ALG)
    .update(stableSerialize(canonicalPayload(profile, notes, fingerprint)), 'utf8')
    .digest('hex');
  return `${CHECKSUM_ALG}:${digest}`;
}

function parseChecksum(raw) {
  const value = String(raw || '').trim().toLowerCase();
  const match = value.match(/^(sha256):([0-9a-f]{64})$/);
  if (!match) return null;
  return { alg: match[1], hex: match[2] };
}

function checksumsMatch(expected, actual) {
  const left = parseChecksum(expected);
  const right = parseChecksum(actual);
  if (!left || !right || left.alg !== right.alg) return false;
  const a = Buffer.from(left.hex, 'hex');
  const b = Buffer.from(right.hex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function snapshotByteLength(snapshot) {
  if (typeof snapshot === 'string') return Buffer.byteLength(snapshot, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseSnapshotInput(snapshot) {
  if (snapshot == null) {
    return fail('E_PARAMS', 'Falta el snapshot de memoria para importar.');
  }
  const bytes = snapshotByteLength(snapshot);
  if (bytes > SNAPSHOT_MAX_BYTES) {
    return fail(
      'E_PARAMS',
      `El snapshot supera el límite de ${SNAPSHOT_MAX_BYTES} bytes.`,
      { used: bytes, limit: SNAPSHOT_MAX_BYTES, status: 400 },
    );
  }
  let parsed = snapshot;
  if (typeof snapshot === 'string') {
    try {
      parsed = JSON.parse(snapshot);
    } catch {
      return fail('E_PARAMS', 'El snapshot de memoria no es JSON válido.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('E_PARAMS', 'El snapshot de memoria no es válido.');
  }
  return { ok: true, snapshot: parsed, bytes };
}

function charCount(entries) {
  if (!entries.length) return 0;
  return entries.join('\n§\n').length;
}

function notesCharCount(notes) {
  if (!notes.length) return 0;
  return notes.map((note) => note.text).join('\n').length;
}

function scanImportedText(text, label) {
  const size = writeGuard.checkFactSize(text, { maxChars: FACT_MAX_CHARS });
  if (!size.ok) return size;
  const scan = curated.scanMemoryContent(text);
  if (scan) {
    return fail(
      'E_CONTENT',
      `No se pudo importar ${label}: el contenido no es seguro para guardar.`,
    );
  }
  return { ok: true };
}

function validateImportedStores(profile, notes) {
  for (const fact of profile) {
    const scanned = scanImportedText(fact, 'un dato de perfil');
    if (!scanned.ok) return scanned;
  }
  for (const note of notes) {
    if (note.text.length > NOTE_MAX_CHARS) {
      return fail(
        'E_PARAMS',
        `Una nota compactada supera el límite de ${NOTE_MAX_CHARS} caracteres.`,
        { used: note.text.length, limit: NOTE_MAX_CHARS, status: 400 },
      );
    }
    const scanned = scanImportedText(note.text, 'una nota compactada');
    if (!scanned.ok) return scanned;
  }

  const profileUsed = charCount(profile);
  if (profileUsed > PROFILE_CHAR_LIMIT) {
    return fail(
      'E_PARAMS',
      `El perfil importado supera el límite de ${PROFILE_CHAR_LIMIT} caracteres.`,
      { used: profileUsed, limit: PROFILE_CHAR_LIMIT, status: 400 },
    );
  }

  const notesUsed = notesCharCount(notes);
  if (notesUsed > NOTES_STORE_LIMIT) {
    return fail(
      'E_PARAMS',
      `Las notas compactadas importadas superan el límite de ${NOTES_STORE_LIMIT} caracteres.`,
      { used: notesUsed, limit: NOTES_STORE_LIMIT, status: 400 },
    );
  }

  return { ok: true, profileUsed, notesUsed };
}

function resolveCallerUserId(userId, opts = {}) {
  const session = normalizeUserId(opts.sessionUserId);
  const requested = normalizeUserId(userId);
  if (session && requested && session !== requested) {
    return fail(
      'E_PARAMS',
      'No puedes exportar ni importar la memoria de otro usuario.',
    );
  }
  const id = session || requested;
  if (!id) {
    return missingUser(opts.action === 'import' ? 'importar memoria' : 'exportar memoria');
  }
  return { ok: true, userId: id };
}

function exportSnapshot(userId, opts = {}) {
  const resolved = resolveCallerUserId(userId, { ...opts, action: 'export' });
  if (!resolved.ok) return resolved;

  const session = compaction.readSession(resolved.userId);
  const profile = normalizeProfile(session.ok ? session.profile : []);
  const notes = normalizeNotes(session.ok ? session.notes : []);
  const fingerprint = ownerFingerprint(resolved.userId);
  const checksum = computeChecksum(profile, notes, fingerprint);
  const snapshot = {
    kind: KIND,
    version: SCHEMA_VERSION,
    exportedAt: Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now(),
    ownerFingerprint: fingerprint,
    profile,
    notes,
    checksum,
  };
  const bytes = snapshotByteLength(snapshot);
  if (bytes > SNAPSHOT_MAX_BYTES) {
    return fail(
      'E_PARAMS',
      `El snapshot supera el límite de ${SNAPSHOT_MAX_BYTES} bytes.`,
      { used: bytes, limit: SNAPSHOT_MAX_BYTES, status: 400 },
    );
  }

  return {
    ok: true,
    success: true,
    snapshot,
    checksum,
    bytes,
    counts: { profile: profile.length, notes: notes.length },
  };
}

function applyReplace(userId, profile, notes) {
  const rewritten = curated.rewriteTarget(userId, 'user', profile);
  if (!rewritten.ok) {
    return fail('E_PARAMS', 'No se pudo importar el perfil. Inténtalo de nuevo.');
  }
  const savedNotes = curated.setNotes(userId, notes);
  if (!savedNotes.ok) {
    return fail('E_PARAMS', 'No se pudieron importar las notas compactadas. Inténtalo de nuevo.');
  }
  if (typeof curated.invalidateSnapshots === 'function') {
    curated.invalidateSnapshots(userId);
  }
  return { ok: true };
}

function applyMerge(userId, profile, notes) {
  const live = curated.read(userId, { target: 'user' });
  const existingProfile = live.ok ? [...live.entries] : [];
  const mergedProfile = [...existingProfile];
  for (const fact of profile) {
    if (!mergedProfile.includes(fact)) mergedProfile.push(fact);
  }
  const profileUsed = charCount(mergedProfile);
  if (profileUsed > PROFILE_CHAR_LIMIT) {
    return fail(
      'E_PARAMS',
      `El perfil importado supera el límite de ${PROFILE_CHAR_LIMIT} caracteres.`,
      { used: profileUsed, limit: PROFILE_CHAR_LIMIT, status: 400 },
    );
  }

  const currentNotes = normalizeNotes(curated.listNotes(userId));
  const seen = new Set(currentNotes.map((note) => note.text));
  const mergedNotes = [...currentNotes];
  for (const note of notes) {
    if (seen.has(note.text)) continue;
    seen.add(note.text);
    mergedNotes.push(note);
  }
  const notesUsed = notesCharCount(mergedNotes);
  if (notesUsed > NOTES_STORE_LIMIT) {
    return fail(
      'E_PARAMS',
      `Las notas compactadas importadas superan el límite de ${NOTES_STORE_LIMIT} caracteres.`,
      { used: notesUsed, limit: NOTES_STORE_LIMIT, status: 400 },
    );
  }

  const rewritten = curated.rewriteTarget(userId, 'user', mergedProfile);
  if (!rewritten.ok) {
    return fail('E_PARAMS', 'No se pudo importar el perfil. Inténtalo de nuevo.');
  }
  const savedNotes = curated.setNotes(userId, mergedNotes);
  if (!savedNotes.ok) {
    return fail('E_PARAMS', 'No se pudieron importar las notas compactadas. Inténtalo de nuevo.');
  }
  if (typeof curated.invalidateSnapshots === 'function') {
    curated.invalidateSnapshots(userId);
  }
  return { ok: true };
}

function importSnapshot(userId, snapshotInput, opts = {}) {
  const resolved = resolveCallerUserId(userId, { ...opts, action: 'import' });
  if (!resolved.ok) return resolved;

  const parsed = parseSnapshotInput(snapshotInput);
  if (!parsed.ok) return parsed;
  const snapshot = parsed.snapshot;

  if (snapshot.kind != null && snapshot.kind !== KIND) {
    return fail('E_PARAMS', 'El snapshot de memoria no es válido.');
  }
  if (snapshot.version != null && Number(snapshot.version) !== SCHEMA_VERSION) {
    return fail('E_PARAMS', 'La versión del snapshot de memoria no es compatible.');
  }

  const profile = normalizeProfile(snapshot.profile);
  const notes = normalizeNotes(snapshot.notes);
  const fingerprint = String(snapshot.ownerFingerprint || '');

  if (!snapshot.checksum) {
    return fail('E_PARAMS', 'Falta el checksum del snapshot.');
  }
  const expected = computeChecksum(profile, notes, fingerprint);
  if (!checksumsMatch(snapshot.checksum, expected)) {
    return fail('E_CONTENT', 'El checksum del snapshot no coincide.');
  }

  if (opts.requireSameOwner) {
    if (!fingerprint || fingerprint !== ownerFingerprint(resolved.userId)) {
      return fail(
        'E_PARAMS',
        'No puedes importar un snapshot que pertenece a otro usuario.',
      );
    }
  }

  const validated = validateImportedStores(profile, notes);
  if (!validated.ok) return validated;

  const mode = String(opts.mode || 'replace').toLowerCase();
  const applied = mode === 'merge'
    ? applyMerge(resolved.userId, profile, notes)
    : applyReplace(resolved.userId, profile, notes);
  if (!applied.ok) return applied;

  const session = compaction.readSession(resolved.userId);
  return {
    ok: true,
    success: true,
    mode: mode === 'merge' ? 'merge' : 'replace',
    checksum: snapshot.checksum,
    bytes: parsed.bytes,
    counts: {
      profile: session.profile.length,
      notes: session.notes.length,
    },
  };
}

function status() {
  return {
    pattern: 'hermes-memory-portability',
    kind: KIND,
    version: SCHEMA_VERSION,
    checksumAlg: CHECKSUM_ALG,
    snapshotMaxBytes: SNAPSHOT_MAX_BYTES,
    profileCharLimit: PROFILE_CHAR_LIMIT,
    notesStoreLimit: NOTES_STORE_LIMIT,
    layers: ['profile', 'notes'],
  };
}

module.exports = {
  KIND,
  SCHEMA_VERSION,
  CHECKSUM_ALG,
  SNAPSHOT_MAX_BYTES,
  PROFILE_CHAR_LIMIT,
  NOTES_STORE_LIMIT,
  NOTE_MAX_CHARS,
  FACT_MAX_CHARS,
  ownerFingerprint,
  stableSerialize,
  computeChecksum,
  checksumsMatch,
  resolveCallerUserId,
  exportSnapshot,
  importSnapshot,
  status,
};
