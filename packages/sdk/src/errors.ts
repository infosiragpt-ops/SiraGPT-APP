/**
 * Error hierarchy for the SiraGPT SDK.
 *
 * All errors thrown by `SiraGPTClient` extend `SiraGPTError`, so consumers can
 * use a single `instanceof` check or branch on `error.code`.
 */

export type SiraGPTErrorCode =
  | 'unknown'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'validation'
  | 'rate_limit'
  | 'server'
  | 'not_found'
  | 'conflict';

export interface SiraGPTErrorOptions {
  code?: SiraGPTErrorCode;
  status?: number;
  requestId?: string;
  details?: unknown;
  cause?: unknown;
}

export class SiraGPTError extends Error {
  readonly code: SiraGPTErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(message: string, opts: SiraGPTErrorOptions = {}) {
    super(message);
    this.name = 'SiraGPTError';
    this.code = opts.code ?? 'unknown';
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.details = opts.details;
    if (opts.cause !== undefined) {
      // Node 16.9+ supports Error cause
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

export class AuthError extends SiraGPTError {
  constructor(message = 'Authentication failed', opts: SiraGPTErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'auth' });
    this.name = 'AuthError';
  }
}

export class ValidationError extends SiraGPTError {
  constructor(message = 'Validation failed', opts: SiraGPTErrorOptions = {}) {
    super(message, { ...opts, code: 'validation' });
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends SiraGPTError {
  readonly retryAfterSeconds?: number;
  constructor(
    message = 'Rate limit exceeded',
    opts: SiraGPTErrorOptions & { retryAfterSeconds?: number } = {},
  ) {
    super(message, { ...opts, code: 'rate_limit' });
    this.name = 'RateLimitError';
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** Maps an HTTP response to the matching SDK error class. */
export function errorFromResponse(
  status: number,
  body: unknown,
  requestId?: string,
): SiraGPTError {
  const message =
    (body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : undefined) ??
    (body && typeof body === 'object' && 'message' in body && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : undefined) ??
    `HTTP ${status}`;

  const base: SiraGPTErrorOptions = { status, requestId, details: body };

  if (status === 401) return new AuthError(message, base);
  if (status === 403) return new SiraGPTError(message, { ...base, code: 'forbidden' });
  if (status === 404) return new SiraGPTError(message, { ...base, code: 'not_found' });
  if (status === 409) return new SiraGPTError(message, { ...base, code: 'conflict' });
  if (status === 422 || status === 400) return new ValidationError(message, base);
  if (status === 429) {
    return new RateLimitError(message, {
      ...base,
      retryAfterSeconds: extractRetryAfter(body),
    });
  }
  if (status >= 500) return new SiraGPTError(message, { ...base, code: 'server' });
  return new SiraGPTError(message, base);
}

function extractRetryAfter(body: unknown): number | undefined {
  if (body && typeof body === 'object' && 'retryAfter' in body) {
    const v = (body as { retryAfter: unknown }).retryAfter;
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined;
}
