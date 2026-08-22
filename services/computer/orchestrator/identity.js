'use strict';

/**
 * Deterministic per-member identity for the agent-computer desktop.
 *
 * One SiraGPT user → one session UUID + one container name + one volume.
 * Department agents are work surfaces on that desktop, not isolation keys.
 */

const crypto = require('crypto');

/** Fixed namespace so sessionIdForUser(userId) is stable across orchestrator restarts. */
const SIRA_COMPUTER_NS = '8f3c2a10-5e6b-51d4-9c2a-1b7e0d4a9f21';

class UserIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserIdError';
    this.status = 400;
    this.code = 'invalid_user_id';
  }
}

function normalizeUserId(userId) {
  const id = String(userId == null ? '' : userId).trim();
  if (!id) throw new UserIdError('userId is required');
  if (id.length > 128) throw new UserIdError('userId is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new UserIdError('userId contains unsupported characters');
  }
  return id;
}

function hashUser(userId) {
  return crypto.createHash('sha256').update(normalizeUserId(userId)).digest('hex').slice(0, 16);
}

function uuidV5(name, namespaceUuid = SIRA_COMPUTER_NS) {
  const ns = Buffer.from(String(namespaceUuid).replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error('namespace must be a UUID');
  const hash = crypto.createHash('sha1').update(ns).update(String(name)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sessionIdForUser(userId) {
  return uuidV5(normalizeUserId(userId));
}

function containerNameForUser(userId, prefix) {
  return `${prefix}u${hashUser(userId)}`;
}

function volumeNameForUser(userId) {
  return `sira-acomp-ws-${hashUser(userId)}`;
}

module.exports = {
  SIRA_COMPUTER_NS,
  UserIdError,
  normalizeUserId,
  hashUser,
  uuidV5,
  sessionIdForUser,
  containerNameForUser,
  volumeNameForUser,
};
