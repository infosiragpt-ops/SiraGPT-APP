'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, readJsonSafe } = require('../../utils/atomic-json-write');

const STORE_DIR = process.env.REFRESH_TOKEN_STORE_DIR
  || path.join(process.cwd(), 'uploads', 'auth-refresh-tokens');
const FAMILY_TTL_MS = Number.parseInt(process.env.REFRESH_TOKEN_FAMILY_TTL_MS || `${30 * 24 * 60 * 60 * 1000}`, 10);

function enabled() {
  return process.env.SIRAGPT_REFRESH_TOKEN_ROTATION === '1';
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
  writeJsonAtomicSync(familyPath(familyId), row, { pretty: true, ensureDir: true });
  return row;
}

function loadFamily(familyId) {
  const file = familyPath(familyId);
  const row = readJsonSafe(file, null);
  if (!row) return null;
  if (Date.now() - Number(row.updatedAt || row.createdAt || 0) > FAMILY_TTL_MS) {
    try { fs.unlinkSync(file); } catch {}
    return null;
  }
  return row;
}

function rotateFamily(familyId) {
  const row = loadFamily(familyId);
  if (!row || row.revoked) return { ok: false, reason: 'invalid_family' };
  row.version = Number(row.version || 0) + 1;
  row.updatedAt = Date.now();
  writeJsonAtomicSync(familyPath(familyId), row, { pretty: true });
  return { ok: true, family: row };
}

function revokeFamily(familyId) {
  const row = loadFamily(familyId);
  if (!row) return false;
  row.revoked = true;
  row.updatedAt = Date.now();
  writeJsonAtomicSync(familyPath(familyId), row, { pretty: true });
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
