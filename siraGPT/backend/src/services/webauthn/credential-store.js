'use strict';

/**
 * webauthn-credential-store — durable storage for the public-key
 * credentials a user has registered with their authenticator
 * (passkey, security key, platform biometric, etc.).
 *
 * Why this is a separate module:
 *   The endpoints in routes/webauthn.js need a place to read +
 *   write Credential rows: id, public-key bytes, signature
 *   counter, transports, label, registered-at. In production
 *   that's a Prisma model; for tests + local dev it's an
 *   in-memory Map. Mirrors how rate-limit-store and
 *   webauthn-challenge-store are structured — one interface,
 *   pluggable backends.
 *
 * Public store interface:
 *   - listForUser(userId) → Promise<Credential[]>
 *   - findById(credentialId) → Promise<Credential | null>
 *   - save(credential) → Promise<void>
 *   - updateCounter(credentialId, counter) → Promise<void>
 *   - delete(credentialId, userId) → Promise<boolean>
 *
 * Credential shape:
 *   {
 *     id:          base64url string returned by the authenticator;
 *                  globally unique (the spec calls this `credentialID`).
 *     userId:      Prisma User.id.
 *     publicKey:   base64url-encoded COSE public key.
 *     counter:     monotonic counter the authenticator increments
 *                  on each assertion. The verification step compares
 *                  the received counter against this stored value;
 *                  a non-increase signals a cloned credential.
 *     transports:  [] of strings ("internal", "usb", "ble", "nfc",
 *                  "hybrid"). The browser uses these as hints in
 *                  navigator.credentials.get.
 *     label:       human-friendly name ("MacBook Pro Touch ID");
 *                  optional, set by the user during registration.
 *     createdAt:   ISO date string.
 *   }
 *
 * NOT in this commit:
 *   - Prisma model. A `Credential` row in schema.prisma is the
 *     production backend; adding it requires a migration which is
 *     an operator action. The in-memory store keeps the endpoints
 *     usable in dev and tests until that lands.
 */

function nowIso() {
  return new Date().toISOString();
}

function createInMemoryCredentialStore() {
  // Two maps: by-id for findById, and userId → Set<id> for listing.
  // Both stay in sync — every save/delete updates both.
  const byId = new Map();
  const byUserId = new Map();

  function recordIndex(userId, credentialId) {
    if (!byUserId.has(userId)) byUserId.set(userId, new Set());
    byUserId.get(userId).add(credentialId);
  }

  function dropIndex(userId, credentialId) {
    const set = byUserId.get(userId);
    if (!set) return;
    set.delete(credentialId);
    if (set.size === 0) byUserId.delete(userId);
  }

  return {
    mode: 'memory',

    async listForUser(userId) {
      if (!userId) return [];
      const ids = byUserId.get(userId);
      if (!ids) return [];
      const out = [];
      for (const id of ids) {
        const cred = byId.get(id);
        if (cred) out.push(cred);
      }
      return out;
    },

    async findById(credentialId) {
      if (!credentialId) return null;
      return byId.get(credentialId) || null;
    },

    async save(credential) {
      if (!credential || !credential.id || !credential.userId) {
        throw new Error('credential must have id and userId');
      }
      const stored = {
        id: String(credential.id),
        userId: String(credential.userId),
        publicKey: String(credential.publicKey || ''),
        counter: Number.isFinite(Number(credential.counter)) ? Number(credential.counter) : 0,
        transports: Array.isArray(credential.transports) ? credential.transports.slice() : [],
        label: credential.label ? String(credential.label) : null,
        createdAt: credential.createdAt || nowIso(),
      };
      byId.set(stored.id, stored);
      recordIndex(stored.userId, stored.id);
    },

    async updateCounter(credentialId, counter) {
      const cred = byId.get(credentialId);
      if (!cred) return;
      // Spec rule: counter MUST be monotonic. Refuse a non-increase
      // (other than the legitimate 0→0 case for authenticators that
      // don't support counters at all). The endpoint upstream will
      // surface this as an error to flag a possible cloned key.
      const next = Number.isFinite(Number(counter)) ? Number(counter) : cred.counter;
      if (cred.counter > 0 && next <= cred.counter) {
        throw new Error('credential counter regressed — possible cloned authenticator');
      }
      cred.counter = next;
    },

    async delete(credentialId, userId) {
      const cred = byId.get(credentialId);
      if (!cred) return false;
      // Tenant scoping: a user can only delete THEIR OWN credentials.
      if (userId && cred.userId !== userId) return false;
      byId.delete(credentialId);
      dropIndex(cred.userId, credentialId);
      return true;
    },

    _size() { return byId.size; },
  };
}

module.exports = {
  createInMemoryCredentialStore,
};
