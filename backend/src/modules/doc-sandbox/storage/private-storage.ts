import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, type S3ClientConfig, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { DocSandboxError } from '../types/errors';
import { identifierSchema } from '../types/contracts';

const MAGIC = Buffer.from('SIRADOC1');
export interface StorageScope { userId: string; jobId: string }
export interface PrivateObject { key: string; sha256: string; size: number }
export interface PrivateStorageConfig { bucket: string; key: Buffer; keyId: string; maxBytes: number; previousKeys?: Readonly<Record<string, Buffer>> }
const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Scope this policy to encrypted document storage, never global SDK settings.
 * Optional checksum wrapping in the pinned SDK can swallow source stream errors.
 * GCM authentication remains mandatory and callers verify document SHA-256.
 * Upload checksum defaults remain enabled; document validation levels are unrelated. */
export function createPrivateDocumentS3Client(config: Omit<S3ClientConfig, 'maxAttempts' | 'responseChecksumValidation'>): S3Client {
  return new S3Client({ ...config, maxAttempts: 1, responseChecksumValidation: 'WHEN_REQUIRED' });
}

function transientStorageError(error: unknown): boolean {
  if (error instanceof DocSandboxError || !error || typeof error !== 'object') return false;
  if ('name' in error && (error.name === 'AbortError' || error.name === 'CanceledError')) return false;
  if ('$metadata' in error && error.$metadata && typeof error.$metadata === 'object' && 'httpStatusCode' in error.$metadata) {
    const status = error.$metadata.httpStatusCode;
    if (typeof status === 'number' && status >= 400) return [408, 429, 500, 502, 503, 504].includes(status);
  }
  return 'code' in error && typeof error.code === 'string' &&
    ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code);
}
/** Retry only idempotent operations; caller owns the single deadline for all attempts. */
async function retryStorageRead<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try { return await run(); }
    catch (error) {
      signal.throwIfAborted();
      if (attempt >= 2 || !transientStorageError(error)) throw error;
      await delay(attempt === 0 ? 100 : 250, undefined, { signal });
    }
  }
}

/** AAD binds authenticated ciphertext to its exact tenant/job/key, not just a filename. */
export function sealDocument(data: Buffer, key: Buffer, objectKey: string): Buffer {
  if (key.length !== 32) throw new DocSandboxError('E_NOT_READY', 503);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(objectKey));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}
export function openDocument(data: Buffer, key: Buffer, objectKey: string): Buffer {
  if (key.length !== 32 || data.length < 36 || !data.subarray(0, 8).equals(MAGIC)) throw new DocSandboxError('E_VALIDATION', 422);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(8, 20), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(objectKey));
    decipher.setAuthTag(data.subarray(20, 36));
    return Buffer.concat([decipher.update(data.subarray(36)), decipher.final()]);
  } catch (cause) { throw new DocSandboxError('E_VALIDATION', 422, { cause }); }
}
export function decodeStorageKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new DocSandboxError('E_NOT_READY', 503);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new DocSandboxError('E_NOT_READY', 503);
  return key;
}

/** No public URL, plaintext object or local persistent fallback is exposed. */
export class PrivateDocumentStorage {
  constructor(private readonly client: S3Client, private readonly config: PrivateStorageConfig) {
    keyIdSchema.parse(config.keyId);
    if (!config.bucket || config.key.length !== 32 || !Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) throw new DocSandboxError('E_NOT_READY', 503);
    for (const [id, key] of Object.entries(config.previousKeys ?? {})) {
      keyIdSchema.parse(id);
      if (id === config.keyId || key.length !== 32) throw new DocSandboxError('E_NOT_READY', 503);
    }
  }
  prefix(scope: StorageScope): string {
    identifierSchema.parse(scope.userId); identifierSchema.parse(scope.jobId);
    return `doc-sandbox/${scope.userId}/${scope.jobId}/`;
  }
  private checkScope(scope: StorageScope, key: string): void {
    const suffix = key.slice(this.prefix(scope).length);
    if (!key.startsWith(this.prefix(scope)) || !/^[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]+\.sealed$/.test(suffix)) throw new DocSandboxError('E_FORBIDDEN', 403);
  }
  prepare(scope: StorageScope, data: Buffer): PrivateObject {
    if (data.length > this.config.maxBytes) throw new DocSandboxError('E_PARAMS', 413);
    return { key: `${this.prefix(scope)}${this.config.keyId}/${randomUUID()}.sealed`, sha256: digest(data), size: data.length };
  }
  /** Reserve this identity in Postgres before calling putPrepared. */
  async putPrepared(scope: StorageScope, object: PrivateObject, data: Buffer, signal?: AbortSignal): Promise<void> {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    this.checkScope(scope, object.key);
    if (!object.key.startsWith(`${this.prefix(scope)}${this.config.keyId}/`) || data.length > this.config.maxBytes || data.length !== object.size || digest(data) !== object.sha256) throw new DocSandboxError('E_VALIDATION', 422);
    const body = sealDocument(data, this.config.key, object.key);
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: object.key, Body: body,
      ContentType: 'application/octet-stream', CacheControl: 'private, no-store',
      IfNoneMatch: '*', Metadata: { format: 'siradoc-aes256gcm-v1', keyid: this.config.keyId } }), { abortSignal: signal });
  }
  async get(scope: StorageScope, key: string, expectedHash?: string, signal?: AbortSignal): Promise<Buffer> {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    this.checkScope(scope, key);
    const boundedSignal = signal;
    return retryStorageRead(async () => {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: boundedSignal });
      const stream = object.Body;
      const closeBody = (): void => { if (stream && 'destroy' in stream && typeof stream.destroy === 'function') stream.destroy(); };
      // send() may resolve before the body finishes. Keep the deadline wired to
      // the body too; checking only between chunks cannot interrupt a stalled read.
      boundedSignal.addEventListener('abort', closeBody, { once: true });
      try {
        boundedSignal.throwIfAborted();
        if (!stream || (object.ContentLength ?? 0) > this.config.maxBytes + 36) throw new DocSandboxError('E_VALIDATION', 422);
        // Every retry starts from zero; partial ciphertext from a broken stream is discarded.
        const chunks: Buffer[] = []; let bytes = 0;
        if (!(Symbol.asyncIterator in stream)) throw new DocSandboxError('E_VALIDATION', 422);
        for await (const piece of stream as AsyncIterable<Uint8Array>) {
          boundedSignal.throwIfAborted();
          bytes += piece.byteLength;
          if (bytes > this.config.maxBytes + 36) throw new DocSandboxError('E_VALIDATION', 422);
          chunks.push(Buffer.from(piece));
        }
        const keyId = key.slice(this.prefix(scope).length).split('/')[0]!;
        const encryptionKey = keyId === this.config.keyId ? this.config.key : this.config.previousKeys?.[keyId];
        if (!encryptionKey) throw new DocSandboxError('E_NOT_READY', 503);
        const result = openDocument(Buffer.concat(chunks), encryptionKey, key);
        if (expectedHash && digest(result) !== expectedHash) throw new DocSandboxError('E_VALIDATION', 422);
        return result;
      } finally {
        // Release even an oversized, aborted or failed body before any retry/backoff.
        boundedSignal.removeEventListener('abort', closeBody); closeBody();
      }
    }, boundedSignal);
  }
  async remove(scope: StorageScope, key: string, signal?: AbortSignal): Promise<void> {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    this.checkScope(scope, key);
    const boundedSignal = signal;
    await retryStorageRead(() => this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: boundedSignal }), boundedSignal);
  }
  /** Reconcile a job prefix too: this covers a crash between object upload and DB registration. */
  async list(scope: StorageScope, signal?: AbortSignal): Promise<string[]> {
    signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    const boundedSignal = signal;
    return retryStorageRead(async () => {
      const keys: string[] = []; let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: this.prefix(scope),
          ContinuationToken: cursor, MaxKeys: 1000 }), { abortSignal: boundedSignal });
        for (const object of result.Contents ?? []) if (object.Key) { this.checkScope(scope, object.Key); keys.push(object.Key); }
        if (keys.length > 10_000) throw new DocSandboxError('E_CONFLICT', 409);
        cursor = result.IsTruncated ? result.NextContinuationToken : undefined;
        if (result.IsTruncated && !cursor) throw new DocSandboxError('E_PROVIDER', 502);
        if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new DocSandboxError('E_PROVIDER', 502);
        if (cursor) seen.add(cursor);
      } while (cursor);
      return keys;
    }, boundedSignal);
  }
}

const ticketSchema = z.object({ v: z.literal(1), userId: identifierSchema, jobId: identifierSchema,
  artifactId: identifierSchema, exp: z.number().int(), iat: z.number().int(), nonce: identifierSchema }).strict();
export type DownloadTicket = z.infer<typeof ticketSchema>;
export class DocumentDownloadTickets {
  private readonly signingKey: Buffer;
  constructor(master: Buffer) {
    if (master.length !== 32) throw new DocSandboxError('E_NOT_READY', 503);
    this.signingKey = Buffer.from(hkdfSync('sha256', master, Buffer.from('siragpt-doc-sandbox-v1'), Buffer.from('download-ticket'), 32));
  }
  issue(userId: string, jobId: string, artifactId: string, ttlSeconds = 600, now = Date.now()): string {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) throw new DocSandboxError('E_PARAMS');
    const iat = Math.floor(now / 1000);
    const claims = ticketSchema.parse({ v: 1, userId, jobId, artifactId, iat, exp: iat + ttlSeconds, nonce: randomUUID() });
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.signingKey).update(payload).digest('base64url')}`;
  }
  verify(token: string, expected: { userId: string; jobId: string; artifactId: string }, now = Date.now()): DownloadTicket {
    if (token.length > 2000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new DocSandboxError('E_FORBIDDEN', 403);
    const [payload, signature] = token.split('.') as [string, string];
    const expectedSignature = createHmac('sha256', this.signingKey).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expectedSignature.length || !timingSafeEqual(received, expectedSignature)) throw new DocSandboxError('E_FORBIDDEN', 403);
    let claims: DownloadTicket;
    try { claims = ticketSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); }
    catch { throw new DocSandboxError('E_FORBIDDEN', 403); }
    const current = Math.floor(now / 1000);
    if (claims.userId !== expected.userId || claims.jobId !== expected.jobId || claims.artifactId !== expected.artifactId ||
      claims.exp <= current || claims.iat > current || claims.exp - claims.iat > 600 || claims.exp <= claims.iat) throw new DocSandboxError('E_FORBIDDEN', 403);
    return claims;
  }
}
