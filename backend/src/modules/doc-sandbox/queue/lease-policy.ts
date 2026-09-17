import type { AttemptLease, DocumentStatus, StoredDocumentJob } from './repository';

type LeaseState = Readonly<Pick<StoredDocumentJob,
  'status' | 'deletedAt' | 'fence' | 'leaseToken' | 'attempts' | 'leaseExpiresAt' | 'expiresAt'>>;
type ClaimState = Readonly<Pick<StoredDocumentJob,
  'admissionReady' | 'status' | 'deletedAt' | 'expiresAt' | 'attempts'>>;
type LeaseIdentity = Readonly<Pick<AttemptLease, 'token' | 'fence' | 'attempt'>>;

const ACTIVE: ReadonlyArray<DocumentStatus> = ['inspecting', 'planning', 'editing', 'validating'];
const NEXT: Readonly<Record<DocumentStatus, ReadonlyArray<DocumentStatus>>> = {
  queued: ['inspecting'], inspecting: ['planning'], planning: ['editing', 'validating'], awaiting_approval: [],
  editing: ['validating'], validating: [], done: [], failed: [], cancelled: [],
};

/** Pure decisions over a snapshot, not ownership or concurrency guarantees.
 * The repository must still lock/read the authoritative row and database clock
 * inside the same transaction before applying any resulting write. */
export function isDocumentLeaseCurrent(state: LeaseState, lease: LeaseIdentity, now: Date): boolean {
  return !(state.deletedAt || !ACTIVE.includes(state.status) || state.fence !== lease.fence
    || state.leaseToken !== lease.token || state.attempts !== lease.attempt || !state.leaseExpiresAt
    || state.leaseExpiresAt <= now || state.expiresAt <= now);
}

/** Only uploaded, unexpired queued work with an attempt remaining is claimable. */
export function canClaimDocumentAttempt(state: ClaimState, now: Date): boolean {
  return !(!state.admissionReady || state.status !== 'queued' || state.deletedAt
    || state.expiresAt <= now || state.attempts >= 3);
}

/** A transition is checked only after the repository has verified its lease.
 * Preserve invalid-transition precedence over a missing frozen plan. This is
 * not the separate validation/publication gate that alone may produce done. */
export function documentTransitionFailure(from: DocumentStatus, to: DocumentStatus, editPlanHash: string | null):
  'DOC_INVALID_TRANSITION' | 'DOC_VALIDATION_GATE' | null {
  if (!NEXT[from].includes(to)) return 'DOC_INVALID_TRANSITION';
  if ((to === 'editing' || to === 'validating') && !editPlanHash) return 'DOC_VALIDATION_GATE';
  return null;
}

/** Retry eligibility is supplied by the worker; a third failure is terminal. */
export function documentFailureStatus(retryable: boolean, attempts: number): 'queued' | 'failed' {
  return retryable && attempts < 3 ? 'queued' : 'failed';
}
