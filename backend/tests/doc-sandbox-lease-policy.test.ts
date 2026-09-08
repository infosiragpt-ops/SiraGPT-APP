import test from 'node:test';
import assert from 'node:assert/strict';
import { canClaimDocumentAttempt, documentFailureStatus, documentTransitionFailure,
  isDocumentLeaseCurrent } from '../src/modules/doc-sandbox/queue/lease-policy';
import type { DocumentStatus } from '../src/modules/doc-sandbox/queue/repository';

// Pure lifecycle decisions over explicit domain values. These are not DB
// responses or a substitute for real locking, publication or recovery tests.
const now = new Date('2026-09-06T12:00:00.000Z');
const past = new Date(now.getTime() - 1);
const future = new Date(now.getTime() + 1);
const states: ReadonlyArray<DocumentStatus> = ['queued', 'inspecting', 'planning', 'awaiting_approval',
  'editing', 'validating', 'done', 'failed', 'cancelled'];
const identity = Object.freeze({ token: 'synthetic-lease', fence: 4, attempt: 2 });
const leaseState = (): Parameters<typeof isDocumentLeaseCurrent>[0] => ({
  status: 'inspecting', deletedAt: null, fence: 4, leaseToken: identity.token,
  attempts: 2, leaseExpiresAt: new Date(future), expiresAt: new Date(future),
});
const claimState = (): Parameters<typeof canClaimDocumentAttempt>[0] => ({
  admissionReady: true, status: 'queued', deletedAt: null, expiresAt: new Date(future), attempts: 0,
});

test('only active execution states can hold a current lease, never queued, approval or terminal work', () => {
  for (const status of states) {
    assert.equal(isDocumentLeaseCurrent({ ...leaseState(), status }, identity, now),
      ['inspecting', 'planning', 'editing', 'validating'].includes(status), status);
  }
});

test('each lease identity or revocation mismatch independently fences an otherwise live worker', () => {
  const cases: Array<[string, Partial<Parameters<typeof isDocumentLeaseCurrent>[0]>]> = [
    ['deleted job', { deletedAt: new Date(past) }],
    ['different fence', { fence: identity.fence + 1 }],
    ['different token', { leaseToken: 'synthetic-other-lease' }],
    ['revoked token', { leaseToken: null }],
    ['different attempt', { attempts: identity.attempt + 1 }],
    ['absent lease deadline', { leaseExpiresAt: null }],
  ];
  for (const [name, change] of cases) {
    assert.equal(isDocumentLeaseCurrent({ ...leaseState(), ...change }, identity, now), false, name);
  }
  assert.equal(isDocumentLeaseCurrent(leaseState(), { ...identity, token: 'forged' }, now), false);
  assert.equal(isDocumentLeaseCurrent(leaseState(), { ...identity, fence: 3 }, now), false);
  assert.equal(isDocumentLeaseCurrent(leaseState(), { ...identity, attempt: 1 }, now), false);
});

test('job expiry and lease expiry each reject at the exact authoritative-clock boundary', () => {
  for (const field of ['leaseExpiresAt', 'expiresAt'] as const) {
    for (const [deadline, accepted] of [[past, false], [now, false], [future, true]] as const) {
      assert.equal(isDocumentLeaseCurrent({ ...leaseState(), [field]: new Date(deadline) }, identity, now), accepted, field);
    }
  }
  // A later supplied DB time revokes the same immutable snapshot; no wall clock
  // or test clock override is involved in these decisions.
  assert.equal(isDocumentLeaseCurrent(leaseState(), identity, future), false);
});

test('a new worker identity cannot revive a cancelled or deleted job', () => {
  const newIdentity = { token: 'synthetic-new-lease', fence: 5, attempt: 3 };
  const advanced = { ...leaseState(), leaseToken: newIdentity.token, fence: 5, attempts: 3 };
  assert.equal(isDocumentLeaseCurrent({ ...advanced, status: 'cancelled' }, newIdentity, now), false);
  assert.equal(isDocumentLeaseCurrent({ ...advanced, deletedAt: new Date(now) }, newIdentity, now), false);
  assert.equal(isDocumentLeaseCurrent(advanced, newIdentity, now), true);
});

test('claiming requires ready queued work for every lifecycle state', () => {
  for (const status of states) {
    assert.equal(canClaimDocumentAttempt({ ...claimState(), status }, now), status === 'queued', status);
    assert.equal(canClaimDocumentAttempt({ ...claimState(), status, admissionReady: false }, now), false, status);
  }
});

test('claiming respects deletion, exact job expiry and the maximum of three total attempts', () => {
  assert.equal(canClaimDocumentAttempt({ ...claimState(), deletedAt: new Date(now) }, now), false);
  for (const [expiresAt, accepted] of [[past, false], [now, false], [future, true]] as const) {
    assert.equal(canClaimDocumentAttempt({ ...claimState(), expiresAt: new Date(expiresAt) }, now), accepted);
  }
  for (const attempts of [0, 1, 2, 3, 4]) {
    assert.equal(canClaimDocumentAttempt({ ...claimState(), attempts }, now), attempts < 3, `attempts=${attempts}`);
  }
});

test('the full transition matrix permits only the existing preserve-mode edges', () => {
  const permitted = new Set(['queued>inspecting', 'inspecting>planning', 'planning>editing',
    'planning>validating', 'editing>validating']);
  for (const from of states) for (const to of states) {
    const edge = `${from}>${to}`;
    assert.equal(documentTransitionFailure(from, to, 'a'.repeat(64)),
      permitted.has(edge) ? null : 'DOC_INVALID_TRANSITION', edge);
  }
});

test('editing and validating require a frozen plan only after the transition itself is allowed', () => {
  for (const planHash of [null, '']) {
    for (const [from, to] of [['planning', 'editing'], ['planning', 'validating'], ['editing', 'validating']] as const) {
      assert.equal(documentTransitionFailure(from, to, planHash), 'DOC_VALIDATION_GATE', `${from}>${to}`);
    }
    assert.equal(documentTransitionFailure('queued', 'inspecting', planHash), null);
    assert.equal(documentTransitionFailure('inspecting', 'planning', planHash), null);
    for (const from of ['queued', 'awaiting_approval', 'done', 'failed', 'cancelled'] as const) {
      for (const to of ['editing', 'validating'] as const) {
        assert.equal(documentTransitionFailure(from, to, planHash), 'DOC_INVALID_TRANSITION', `${from}>${to}`);
      }
    }
  }
});

test('normal transitions cannot publish done, reactivate terminal jobs or enable approval mode', () => {
  for (const from of states) {
    assert.equal(documentTransitionFailure(from, 'done', 'a'.repeat(64)), 'DOC_INVALID_TRANSITION');
    assert.equal(documentTransitionFailure(from, 'awaiting_approval', 'a'.repeat(64)), 'DOC_INVALID_TRANSITION');
  }
  for (const from of ['done', 'failed', 'cancelled', 'awaiting_approval'] as const) {
    for (const to of states) assert.equal(documentTransitionFailure(from, to, 'a'.repeat(64)), 'DOC_INVALID_TRANSITION');
  }
});

test('retry policy cannot schedule a fourth attempt or retry a failure the worker deemed terminal', () => {
  for (const attempts of [1, 2, 3, 4]) {
    assert.equal(documentFailureStatus(true, attempts), attempts < 3 ? 'queued' : 'failed');
    assert.equal(documentFailureStatus(false, attempts), 'failed');
  }
});

test('pure decisions neither mutate snapshots nor allocate or renew a lease', () => {
  const execution = Object.freeze(leaseState());
  const admission = Object.freeze(claimState());
  const before = structuredClone({ execution, admission, identity, now });
  assert.equal(isDocumentLeaseCurrent(execution, identity, now), true);
  assert.equal(canClaimDocumentAttempt(admission, now), true);
  assert.equal(documentTransitionFailure(execution.status, 'planning', null), null);
  assert.equal(documentFailureStatus(true, execution.attempts), 'queued');
  assert.deepEqual({ execution, admission, identity, now }, before);
});
