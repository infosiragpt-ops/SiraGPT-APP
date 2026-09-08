export class DocumentRepositoryError extends Error {
  constructor(readonly code: 'DOC_NOT_FOUND' | 'DOC_FORBIDDEN' | 'DOC_DELETED' | 'DOC_EXPIRED' | 'DOC_CONFLICT' | 'DOC_STALE_LEASE' | 'DOC_INVALID_TRANSITION' | 'DOC_VALIDATION_GATE' | 'DOC_INVALID_INPUT' | 'DOC_BUDGET_EXCEEDED' | 'DOC_CLEANUP_PENDING') {
    super(code); this.name = 'DocumentRepositoryError';
  }
}
