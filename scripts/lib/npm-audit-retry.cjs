'use strict';

// Retries ONLY transient npm-audit transport failures: the registry's audit
// endpoint timing out, the process being interrupted, or npm answering with an
// error object / no JSON. A real finding — a valid report whose advisories the
// gate blocks — is deterministic and is never retried, so the gate stays hard.
const TRANSIENT_AUDIT_FAILURE = /failed or was interrupted|produced no JSON|produced invalid JSON|failed to parse npm audit JSON|Unsupported or failed npm audit report|failed without reporting findings/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function isTransientAuditError(error) {
  return TRANSIENT_AUDIT_FAILURE.test(String((error && error.message) || ''));
}

function auditTimeoutMs(env = process.env) {
  const value = Number(env.SIRAGPT_NPM_AUDIT_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 10000 ? Math.min(value, 600000) : 120000;
}

function runWithAuditRetries(fn, {
  attempts = Number(process.env.SIRAGPT_NPM_AUDIT_ATTEMPTS) || 3,
  delaysMs = [5000, 15000],
  sleep = sleepSync,
  log = (message) => console.error(message),
  label = 'npm-audit',
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransientAuditError(error)) throw error;
      const wait = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      log(`[${label}] transient npm audit failure (${error.message}); retry ${attempt + 1}/${attempts} in ${Math.round(wait / 1000)}s`);
      sleep(wait);
    }
  }
}

module.exports = { TRANSIENT_AUDIT_FAILURE, auditTimeoutMs, isTransientAuditError, runWithAuditRetries, sleepSync };
