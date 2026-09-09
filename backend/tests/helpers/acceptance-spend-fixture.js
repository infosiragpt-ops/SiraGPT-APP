'use strict';

// Shared synthetic fixtures only: importing this module registers no tests
// and never configures process.env or a live provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAcceptanceSpendGuard, isAcceptanceSpendError, MODEL,
  MAX_TOTAL_MICROS, ONE_USD_MICROS } = require('../../src/services/ai/acceptance-spend-guard');

const IDENTITY = Object.freeze({ userId: 'synthetic-user', chatId: 'synthetic-chat' });
const NOW = 1_800_000_000_000;
const request = (changes = {}) => ({ method: 'POST', body: JSON.stringify({
  model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: 'Synthetic chess test.' }], ...changes,
}) });

function fixture(t, { policyChanges = {}, ledgerChanges = {}, fsImpl = fs } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-spend-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyFile = path.join(directory, 'policy.json');
  const ledgerPath = path.join(directory, 'ledger.json');
  const policy = { version: 1, campaignId: 'synthetic-campaign', ...IDENTITY,
    expiresAt: new Date(NOW + 3_600_000).toISOString(), ledgerPath,
    maxTotalMicros: MAX_TOTAL_MICROS, reservationMicros: ONE_USD_MICROS,
    pricing: { verified: true, inputMicrosPerMillion: 300_000, outputMicrosPerMillion: 600_000,
      inputTokenCeiling: 1_048_576, outputTokenCeiling: 16_384 }, ...policyChanges };
  const ledger = { version: 1, campaignId: policy.campaignId,
    maxTotalMicros: policy.maxTotalMicros, reservationMicros: policy.reservationMicros,
    usedMicros: 0, reservations: [], ...ledgerChanges };
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  write(policyFile, policy);
  write(ledgerPath, ledger);
  return { directory, policyFile, ledgerPath, policy, ledger, write,
    read: () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8')),
    create: (options = {}) => createAcceptanceSpendGuard({ policyFile, clock: () => NOW, fsImpl, ...options }) };
}

function quota(reason) {
  return (error) => {
    assert.equal(isAcceptanceSpendError(error), true);
    assert.equal(error.code, 'E_QUOTA');
    assert.equal(error.status, 402);
    assert.equal(error.terminal, true);
    assert.equal(error.retryable, false);
    if (reason) assert.equal(error.reason, reason);
    assert.doesNotMatch(error.message, /synthetic|policy\.json|ledger\.json|api\.meta\.ai/);
    return true;
  };
}

module.exports = { fixture, IDENTITY, NOW, request, quota };
