'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_DIR = process.env.REFRESH_TOKEN_STORE_DIR
  || path.join(process.cwd(), 'uploads', 'auth-refresh-tokens');
const FAMILY_TTL_MS = Number.parseInt(process.env.REFRESH_TOKEN_FAMILY_TTL_MS || `${30 * 24 * 60 * 60 * 1000}`, 10);

function enabled() {
  return process.env.SIRAGPT_REFRESH_TOKEN_ROTATION === '1';
}

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function familyPath(familyId) {
  const safe = String(familyId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  return path.join(STORE_DIR, `${safe}.json`);
}

function createFamily(userId) {
  const familyId = `rf_${crypto.randomBytes(12).toString('hex')}`;
  const row = {
    familyId,
    userId: String(userId),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revoked: false,
  };
  ensureDir();
  fs.writeFileSync(familyPath(familyId), JSON.stringify(row));
  return row;
}

function loadFamily(familyId) {
  const file = familyPath(familyId);
  if (!fs.existsSync(file)) return null;
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - Number(row.updatedAt || row.createdAt || 0) > FAMILY_TTL_MS) {
      fs.unlinkSync(file);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

function rotateFamily(familyId) {
  const row = loadFamily(familyId);
  if (!row || row.revoked) return { ok: false, reason: 'invalid_family' };
  row.version = Number(row.version || 0) + 1;
  row.updatedAt = Date.now();
  fs.writeFileSync(familyPath(familyId), JSON.stringify(row));
  return { ok: true, family: row };
}

function revokeFamily(familyId) {
  const row = loadFamily(familyId);
  if (!row) return false;
  row.revoked = true;
  row.updatedAt = Date.now();
  fs.writeFileSync(familyPath(familyId), JSON.stringify(row));
  return true;
}

function issueRefreshPayload(userId) {
  if (!enabled()) return null;
  const family = createFamily(userId);
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    refreshToken: token,
    familyId: family.familyId,
    version: family.version,
  };
}

function validateRefresh(familyId, version) {
  if (!enabled()) return { ok: true, legacy: true };
  const row = loadFamily(familyId);
  if (!row || row.revoked) return { ok: false, reason: 'revoked_or_missing' };
  if (Number(version) !== Number(row.version)) {
    revokeFamily(familyId);
    return { ok: false, reason: 'reuse_detected' };
  }
  const rotated = rotateFamily(familyId);
  return rotated.ok ? { ok: true, family: rotated.family } : { ok: false, reason: 'rotate_failed' };
}

module.exports = {
  enabled,
  createFamily,
  loadFamily,
  rotateFamily,
  revokeFamily,
  issueRefreshPayload,
  validateRefresh,
};
