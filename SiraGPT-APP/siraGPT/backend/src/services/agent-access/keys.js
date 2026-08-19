/**
 * agent-access/keys — agent API key store + pairing approvals.
 *
 * Problem: /api/agent/run is JWT-authenticated, which is correct for
 * interactive sessions. But a user might want to wire the agent into
 * external tools (a CRON on their own machine, a Zapier-like pipeline,
 * a CLI they wrote) that can't roundtrip a web login. Sira handles this
 * with a pairing flow: an unknown
 * sender is held until the owner approves via a code.
 *
 * Adapted to siraGPT's HTTP API:
 *
 *   1. Owners mint named API keys with limited scope (mode, allow/deny,
 *      skillIds). Secret is shown ONCE.
 *   2. Policy modes (env AGENT_DM_POLICY):
 *        closed  — API keys disabled; JWT only.
 *        pairing — first call from an unseen principal (hash of IP+UA)
 *                  returns 428 with a pairing code; owner must approve.
 *        open    — API keys work immediately, no pairing needed.
 *   3. All key operations live in a JSON file (no Prisma migration),
 *      mirroring the scheduler's persistence choice.
 *
 * Secrets are never stored in plaintext — only bcrypt-like hash. The
 * hash is SHA-256 with per-record salt (sufficient for API keys; we
 * don't need slow KDFs because keys are 24-byte random, not user
 * passwords).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'agent-keys.json');

const KEY_PREFIX = 'sira_ag_';
const SECRET_BYTES = 24;
const SALT_BYTES = 12;

// ─── Persistence ──────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(KEYS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) || [];
  } catch (err) {
    // Corrupt file handling mirrors the scheduler: move aside,
    // start clean, log loudly.
    const bak = `${KEYS_FILE}.corrupt.${Date.now()}`;
    try { fs.renameSync(KEYS_FILE, bak); } catch { /* best effort */ }
    console.error(`[agent-keys] file corrupt, moved to ${bak}:`, err.message);
    return [];
  }
}

function saveAll(rows) {
  ensureDir();
  const tmp = `${KEYS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, KEYS_FILE);
}

// ─── Hash helpers ─────────────────────────────────────────────────────────

function hashSecret(secret, salt) {
  return crypto.createHash('sha256').update(`${salt}:${secret}`).digest('hex');
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── ID + secret generation ───────────────────────────────────────────────

function genId() {
  return `agk_${crypto.randomBytes(6).toString('hex')}`;
}
function genSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}
function genSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}
function genPairCode() {
  // 8-char uppercase alphanum. Easy to read out over the phone if a
  // future integration needs that; plenty of entropy (~47 bits) for
  // a short-lived pairing handshake.
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, b => alpha[b % alpha.length]).join('');
}

function principalHash(ip, userAgent) {
  return crypto.createHash('sha256').update(`${ip || ''}|${userAgent || ''}`).digest('hex').slice(0, 16);
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

/**
 * Create a new API key for userId. Returns the full secret exactly
 * once — callers must show it to the user and never persist it.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.label — human-readable identifier
 * @param {object} [opts.scope] — { mode, allow, deny, skillIds, maxCalls }
 * @returns {{ id, secret, label, scope, createdAt }}
 */
function createKey({ userId, label, scope = {} }) {
  if (!userId) throw new Error('createKey: userId required');
  if (!label || typeof label !== 'string') throw new Error('createKey: label required');

  const id = genId();
  const secret = genSecret();
  const salt = genSalt();
  const row = {
    id,
    userId,
    label: label.slice(0, 80),
    scope: {
      mode: scope.mode || 'sandbox',
      allow: scope.allow || null,
      deny: scope.deny || null,
      skillIds: scope.skillIds || null,
      maxCalls: scope.maxCalls || null,
    },
    secretHash: hashSecret(secret, salt),
    salt,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    usageCount: 0,
    pairings: [], // [{ principalHash, approvedAt, ip, ua }]
    pendingPair: null, // { code, principalHash, requestedAt, ip, ua }
  };
  const rows = loadAll();
  rows.push(row);
  saveAll(rows);
  return {
    id, label: row.label, scope: row.scope, createdAt: row.createdAt,
    // Returned once — the caller must display to the user.
    secret: `${KEY_PREFIX}${id}.${secret}`,
  };
}

function listKeys(userId) {
  return loadAll()
    .filter(k => k.userId === userId)
    .map(k => ({
      id: k.id, label: k.label, scope: k.scope,
      createdAt: k.createdAt, revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt, usageCount: k.usageCount,
      pairedPrincipals: k.pairings.length,
      hasPendingPair: !!k.pendingPair,
    }));
}

function revokeKey({ userId, id }) {
  const rows = loadAll();
  const row = rows.find(k => k.id === id && k.userId === userId);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.revokedAt) return { ok: false, reason: 'already revoked' };
  row.revokedAt = new Date().toISOString();
  saveAll(rows);
  return { ok: true };
}

function approvePairing({ userId, id, code }) {
  const rows = loadAll();
  const row = rows.find(k => k.id === id && k.userId === userId);
  if (!row) return { ok: false, reason: 'not found' };
  if (!row.pendingPair) return { ok: false, reason: 'no pending pairing' };
  if (row.pendingPair.code !== code) return { ok: false, reason: 'bad code' };
  row.pairings.push({
    principalHash: row.pendingPair.principalHash,
    approvedAt: new Date().toISOString(),
    ip: row.pendingPair.ip,
    ua: row.pendingPair.ua,
  });
  row.pendingPair = null;
  saveAll(rows);
  return { ok: true };
}

function revokePairing({ userId, id, principalHash: ph }) {
  const rows = loadAll();
  const row = rows.find(k => k.id === id && k.userId === userId);
  if (!row) return { ok: false, reason: 'not found' };
  const before = row.pairings.length;
  row.pairings = row.pairings.filter(p => p.principalHash !== ph);
  if (row.pairings.length === before) return { ok: false, reason: 'principal not paired' };
  saveAll(rows);
  return { ok: true };
}

// ─── Authentication ───────────────────────────────────────────────────────

function parsePresentedKey(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  if (!token.startsWith(KEY_PREFIX)) return null;
  const body = token.slice(KEY_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot === -1) return null;
  return { id: body.slice(0, dot), secret: body.slice(dot + 1) };
}

/**
 * Resolve a presented token into a live key row, or null.
 *
 * @returns {{ row: object, policy: 'open'|'pairing'|'closed', principalHash, paired: boolean, shouldPair: boolean, pendingCode?: string } | null}
 */
function authenticate({ authHeader, ip, userAgent }) {
  const policy = (process.env.AGENT_DM_POLICY || 'pairing').toLowerCase();
  if (policy === 'closed') return { code: 'closed' };

  const presented = parsePresentedKey(authHeader);
  if (!presented) return null;

  const rows = loadAll();
  const row = rows.find(k => k.id === presented.id);
  if (!row) return { code: 'unknown_key' };
  if (row.revokedAt) return { code: 'revoked' };

  const candidate = hashSecret(presented.secret, row.salt);
  if (!constantTimeEquals(candidate, row.secretHash)) return { code: 'bad_secret' };

  const ph = principalHash(ip, userAgent);
  const paired = row.pairings.some(p => p.principalHash === ph);

  // Open mode: always accept.
  if (policy === 'open') {
    return finishAuth(row, ph, paired);
  }

  // Pairing mode: if already paired, accept. Otherwise start or
  // continue a pending pairing and return a 428-signal.
  if (!paired) {
    if (!row.pendingPair || row.pendingPair.principalHash !== ph) {
      row.pendingPair = {
        code: genPairCode(),
        principalHash: ph,
        requestedAt: new Date().toISOString(),
        ip: ip || null,
        ua: userAgent || null,
      };
      saveAll(rows);
    }
    return {
      code: 'pair_required',
      row,
      principalHash: ph,
      pendingCode: row.pendingPair.code,
    };
  }
  return finishAuth(row, ph, true);
}

function finishAuth(row, ph, paired) {
  const rows = loadAll();
  const live = rows.find(k => k.id === row.id);
  if (live) {
    live.lastUsedAt = new Date().toISOString();
    live.usageCount = (live.usageCount || 0) + 1;
    saveAll(rows);
  }
  return {
    code: 'ok',
    row: live || row,
    principalHash: ph,
    paired,
  };
}

function listPendingPair({ userId, id }) {
  const rows = loadAll();
  const row = rows.find(k => k.id === id && k.userId === userId);
  if (!row) return null;
  return row.pendingPair
    ? { code: row.pendingPair.code, ip: row.pendingPair.ip, ua: row.pendingPair.ua, requestedAt: row.pendingPair.requestedAt }
    : null;
}

module.exports = {
  createKey, listKeys, revokeKey,
  approvePairing, revokePairing, listPendingPair,
  authenticate, parsePresentedKey, principalHash,
  hashSecret, genPairCode,
  _paths: { DATA_DIR, KEYS_FILE },
  KEY_PREFIX,
};
