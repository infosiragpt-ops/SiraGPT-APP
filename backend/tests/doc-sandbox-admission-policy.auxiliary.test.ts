import test from 'node:test';
import assert from 'node:assert/strict';
const { createDocumentAdmissionPolicy } = require('../src/services/doc-sandbox-admission-policy');

// Auxiliary policy regressions retain the existing simulated DB/HTTP inputs.
// They run in CI but are NOT part of SPEC §10.2 SDK-only unit coverage.
async function admissionPolicyResult(dbUser: unknown, fail = false) {
  return new Promise<{ status: number; body?: unknown; user?: unknown }>(resolve => {
    const req = { user: { id: 'quota-user', plan: 'PRO', apiUsage: 0, monthlyLimit: 1000 }, aborted: false };
    let status = 200;
    const res = { destroyed: false, set: () => res, status: (value: number) => { status = value; return res; },
      json: (body: unknown) => { resolve({ status, body }); return res; } };
    createDocumentAdmissionPolicy({ user: { findUnique: async () => {
      if (fail) throw new Error('private SQL and account details'); return dbUser;
    } }, apiUsage: { count: async () => 3 } })(req, res, () => resolve({ status, user: req.user }));
  });
}
const quotaUser = { id: 'quota-user', deletedAt: null, plan: 'PRO', isSuperAdmin: false, apiUsage: 0n, monthlyLimit: 1000n };
test('document admission rechecks current quota before parser instead of trusting stale authenticated counters', async () => {
  const result = await admissionPolicyResult({ ...quotaUser, apiUsage: 1000n });
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { code: 'E_QUOTA', message: 'Se agotó la cuota de tu plan.' });
});
test('document quota fails closed for missing/deleted accounts, DB failure and malformed limits', async () => {
  assert.equal((await admissionPolicyResult(null)).status, 403);
  assert.equal((await admissionPolicyResult({ ...quotaUser, deletedAt: new Date() })).status, 403);
  const failed = await admissionPolicyResult(null, true);
  assert.equal(failed.status, 503);
  assert.ok(!JSON.stringify(failed.body).includes('private SQL'));
  assert.equal((await admissionPolicyResult({ ...quotaUser, monthlyLimit: 'unknown' })).status, 503);
});
test('document admission preserves explicit staff exemption and refreshes plan used by model eligibility', async () => {
  assert.equal((await admissionPolicyResult({ ...quotaUser, plan: 'FREE', isSuperAdmin: true, apiUsage: 2000n })).status, 200);
  const result = await admissionPolicyResult({ ...quotaUser, plan: 'PRO_MAX' });
  assert.equal(result.status, 200);
  assert.equal((result.user as { plan: string }).plan, 'PRO_MAX');
});
