import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { DocumentSandboxConfig } from '../config';
import { EDITOR_PROMPT_VERSION } from '../agent/prompt';
import { DocSandboxRepository, DocumentRepositoryError, type StoredDocumentJob, type DurableDocumentEvent } from '../queue/repository';
import { PrivateDocumentStorage, DocumentDownloadTickets } from '../storage/private-storage';
import { documentFormatSchema, fileNameSchema, identifierSchema, type DocumentFormat } from '../types/contracts';
import { DocSandboxError, publicError } from '../types/errors';
import type { DocumentModelPolicy } from '../model-policy';

const MIME: Readonly<Record<DocumentFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
};
const admissionSchema = z.object({ instructions: z.string().trim().min(1).max(50_000),
  mode: z.literal('preserve').default('preserve'), modelTier: z.enum(['mechanical', 'academic']).default('mechanical'),
  requestedModel: z.string().trim().min(1).max(200).optional(),
  permission: z.enum(['default', 'read', 'protected', 'workspace', 'full']).default('default') }).strict();
const terminal = (job: StoredDocumentJob): boolean => ['done', 'failed', 'cancelled'].includes(job.status);
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** UTF-8 multipart filenames are decoded without replacing invalid bytes or losing accents. */
export function originalFilename(name: string): string {
  if ([...name].some((char) => char.codePointAt(0)! > 255)) return fileNameSchema.parse(name);
  const latin = Buffer.from(name, 'latin1');
  const decoded = latin.toString('utf8');
  const resolved = !decoded.includes('\uFFFD') && Buffer.from(decoded).equals(latin) ? decoded : name;
  return fileNameSchema.parse(resolved);
}
export function classifyInput(name: string, bytes: Buffer): { format: DocumentFormat; mime: string } {
  const format = documentFormatSchema.parse(name.split('.').pop()?.toLowerCase());
  // Cheap admission checks only. Full MIME/ZIP/XML checks run independently before any paid call.
  if (['docx', 'xlsx', 'pptx'].includes(format) && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new DocSandboxError('E_PARAMS', 415);
  if (format === 'pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new DocSandboxError('E_PARAMS', 415);
  return { format, mime: MIME[format] };
}
export function jobSnapshot(job: StoredDocumentJob, showCost: boolean): Record<string, unknown> {
  const usage = Object.fromEntries(Object.entries(job.usage).filter(([key, value]) =>
    (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (key === 'costExact' && typeof value === 'boolean')));
  const uncertain = job.usage.costUsd === null || job.costReservations.some((entry) => entry.actualUsd === null);
  return { id: job.id, status: job.status, mode: job.mode, modelTier: job.modelTier, attempts: job.attempts,
    admissionReady: job.admissionReady, outcome: job.outcome,
    ...(job.outcome === 'not_possible' ? { warningCode: 'E_NOT_POSSIBLE' } : {}),
    eventSeq: job.eventSeq, errorCode: job.errorCode, cleanupPending: job.cleanupPending,
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, expiresAt: job.expiresAt,
    ...(showCost ? { usage, costUsd: uncertain ? null : job.costUsd,
      costStatus: uncertain ? 'pending' : job.usage.costExact === true ? 'exact' : 'estimated' } : {}) };
}
export function publicEvent(event: DurableDocumentEvent): Record<string, unknown> {
  // Do not stream model text, filenames, code, instructions, internal keys or provider references.
  const keys = ['status', 'outcome', 'attempt', 'phase', 'level', 'passed', 'applicable', 'code', 'retryable', 'cleanupPending'];
  const payload = Object.fromEntries(Object.entries(event.payload).filter(([key, value]) => keys.includes(key) &&
    (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)))));
  return { seq: event.seq, type: /^[a-z_]{1,40}$/.test(event.type) ? event.type : 'phase', payload, createdAt: event.createdAt };
}
function owner(req: Request): string {
  const parsed = z.object({ user: z.object({ id: identifierSchema }) }).safeParse(req);
  if (!parsed.success) throw new DocSandboxError('E_FORBIDDEN', 401);
  return parsed.data.user.id;
}
function userPlan(req: Request): string {
  const parsed = z.object({ user: z.object({ plan: z.string().optional() }) }).safeParse(req);
  return parsed.success ? parsed.data.user.plan || 'FREE' : 'FREE';
}
function id(req: Request, key: string): string { return identifierSchema.parse(req.params[key]); }
const asyncRoute = (run: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { void run(req, res).catch(next); };

class BoundedMemoryStorage implements multer.StorageEngine {
  private readonly totals = new WeakMap<Request, number>();
  constructor(private readonly maxTotalBytes: number) {}
  _handleFile(req: Request, file: Express.Multer.File, callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void): void {
    const chunks: Buffer[] = []; let size = 0; let finished = false;
    const fail = (error: Error): void => { if (finished) return; finished = true; chunks.length = 0; callback(error); };
    file.stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      const total = (this.totals.get(req) ?? 0) + chunk.length; this.totals.set(req, total);
      if (total > this.maxTotalBytes) { fail(new DocSandboxError('E_PARAMS', 413)); file.stream.resume(); return; }
      size += chunk.length; chunks.push(chunk);
    });
    file.stream.once('error', fail);
    file.stream.once('limit', () => fail(new DocSandboxError('E_PARAMS', 413)));
    file.stream.once('end', () => { if (!finished) { finished = true; callback(undefined, { buffer: Buffer.concat(chunks), size }); } });
  }
  _removeFile(_req: Request, file: Express.Multer.File, callback: (error: Error | null) => void): void {
    file.buffer = Buffer.alloc(0); callback(null);
  }
}
export interface DocumentRouterDependencies {
  authenticate: RequestHandler; admissionPolicy: RequestHandler; repository: DocSandboxRepository; storage: PrivateDocumentStorage;
  tickets: DocumentDownloadTickets; config: DocumentSandboxConfig;
  isReady(): boolean;
  resolveModel: DocumentModelPolicy;
  abort(jobId: string): void;
  notice(code: string): void;
}
export function createDocumentRouter(deps: DocumentRouterDependencies): Router {
  const { repository, storage, tickets, config } = deps;
  const router = Router();
  router.use(deps.authenticate);
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
  router.get('/capabilities', asyncRoute(async (req, res) => {
    const selected = z.string().min(1).max(200).optional().parse(req.query.model);
    const modelTier = selected ? await deps.resolveModel(selected, userPlan(req)) : null;
    res.json({ enabled: true, ready: deps.isReady(), supported: modelTier !== null, modelTier,
      modes: ['preserve'], formats: documentFormatSchema.options, limits: { maxFiles: 10, maxFileBytes: config.maxFileBytes } });
  }));
  const readSnapshot = async (job: StoredDocumentJob, userId: string): Promise<Record<string, unknown>> => {
    const artifacts = (await repository.artifactsOwned(job.id, userId)).map((artifact) => ({ id: artifact.id, kind: artifact.kind,
      name: artifact.filename, mime: artifact.mime, size: artifact.size, sha256: artifact.sha256 }));
    return { ...jobSnapshot(job, config.showCost), artifacts };
  };
  router.get('/by-key/:idempotencyKey', asyncRoute(async (req, res) => {
    const key = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/).parse(req.params.idempotencyKey);
    const userId = owner(req);
    res.json(await readSnapshot(await repository.getByIdempotencyKeyOwned(key, userId), userId));
  }));
  // Bounded process admission is resource protection, not authoritative job storage.
  let uploads = 0;
  const uploadSlots = new WeakMap<Request, { claim(): void; release(): void }>();
  const uploadGate: RequestHandler = (req, res, next) => {
    // Admission middleware may have awaited SQL after the caller disconnected.
    // Do not register a slot after its close/aborted events already happened.
    if (req.aborted || res.destroyed) { next(new DocSandboxError('E_CANCELLED', 499)); return; }
    if (!deps.isReady()) { res.set('Retry-After', '30').status(503).json({ code: 'E_NOT_READY', message: 'La edición segura de documentos no está disponible; vuelve a intentarlo más tarde.' }); return; }
    if (uploads >= 2) { res.set('Retry-After', '5'); res.status(429).json({ code: 'E_QUOTA', message: 'Espera a que termine la carga actual.' }); return; }
    uploads++; let released = false; let claimed = false;
    const release = (): void => {
      if (released) return;
      uploads--; released = true; uploadSlots.delete(req);
      res.off('finish', releaseBeforeHandler); res.off('close', releaseBeforeHandler); req.off('aborted', releaseBeforeHandler);
    };
    const releaseBeforeHandler = (): void => { if (!claimed) release(); };
    uploadSlots.set(req, { claim: () => { claimed = true; }, release });
    // A closed HTTP response does not finish an outstanding Prisma await. Once
    // claimed, retain the memory/admission slot until the handler unwinds.
    res.once('finish', releaseBeforeHandler); res.once('close', releaseBeforeHandler); req.once('aborted', releaseBeforeHandler); next();
  };
  const multipart = multer({ storage: new BoundedMemoryStorage(100 * 1024 * 1024),
    limits: { fileSize: config.maxFileBytes, files: 10, fields: 5, fieldSize: 200_000, parts: 15 },
  }).array('files[]', 10);
  router.post('/', deps.admissionPolicy, uploadGate, multipart, asyncRoute(async (req, res) => {
    const userId = owner(req);
    const uploadSlot = uploadSlots.get(req);
    if (!uploadSlot) throw new DocSandboxError('E_CANCELLED', 499);
    uploadSlot.claim();
    // Subscribe before catalog/DB awaits: a disconnect must not be missed just
    // because it happens between parsing the body and storing the first object.
    const abort = new AbortController();
    let committingReady = false;
    let createdJobId: string | undefined;
    const onClose = (): void => { if (!res.writableFinished && !committingReady) abort.abort(new DocSandboxError('E_CANCELLED', 499)); };
    res.once('close', onClose);
    req.once('aborted', onClose);
    if (req.aborted || res.destroyed) onClose();
    const timeout = setTimeout(() => abort.abort(new DocSandboxError('E_TIMEOUT', 408)), 120_000);
    try {
      abort.signal.throwIfAborted();
      const params = admissionSchema.parse(req.body);
      if (params.permission === 'read' || params.permission === 'protected') throw new DocSandboxError('E_PLAN_GATE', 403);
      if (!deps.isReady()) throw new DocSandboxError('E_NOT_READY', 503);
      const requestedModel = params.requestedModel ?? config.engine.models[params.modelTier].id;
      if (await deps.resolveModel(requestedModel, userPlan(req)) !== params.modelTier) throw new DocSandboxError('E_PARAMS', 400);
      abort.signal.throwIfAborted();
      if (!deps.isReady()) throw new DocSandboxError('E_NOT_READY', 503);
      const idempotencyKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/).parse(req.get('Idempotency-Key'));
      if (!Array.isArray(req.files) || !req.files.length) throw new DocSandboxError('E_PARAMS');
      const inputs = req.files.map((file) => {
        const name = originalFilename(file.originalname); const type = classifyInput(name, file.buffer);
        return { id: randomUUID(), name, ...type, data: file.buffer, sha256: sha256(file.buffer) };
      });
      if (inputs.length > 1 && inputs.some((input) => input.format !== 'pdf')) throw new DocSandboxError('E_PARAMS', 400);
      const jobId = randomUUID(); const scope = { userId, jobId };
      const instructionBytes = Buffer.from(params.instructions);
      const instructions = storage.prepare(scope, instructionBytes);
      const objects = inputs.map((input) => storage.prepare(scope, input.data));
      const payloadHash = sha256(JSON.stringify({ ...params, inputs: inputs.map(({ name, format, sha256: hash }) => ({ name, format, sha256: hash })) }));
      const { job, created } = await repository.createJob({ id: jobId, userId, idempotencyKey, payloadHash,
        requestedModel, maxTokens: config.maxTokens,
        instructionsKey: instructions.key, modelTier: params.modelTier, ready: false,
        promptVersion: EDITOR_PROMPT_VERSION, maxCostUsd: config.maxCostUsd.toFixed(8),
        expiresAt: new Date(Date.now() + config.retentionDays * 86_400_000),
        inputs: inputs.map((input, index) => ({ id: input.id, kind: 'input', storageKey: objects[index]!.key,
          filename: input.name, mime: input.mime, size: input.data.length, sha256: input.sha256 })),
      });
      if (created) createdJobId = jobId;
      abort.signal.throwIfAborted();
      if (!created) { res.status(job.admissionReady ? 202 : 409).json({ jobId: job.id, ...jobSnapshot(job, config.showCost) }); return; }
      await storage.putPrepared(scope, instructions, instructionBytes, abort.signal);
      for (const [index, input] of inputs.entries()) await storage.putPrepared(scope, objects[index]!, input.data, abort.signal);
      abort.signal.throwIfAborted();
      // Commit boundary: if the acknowledgement is lost from this point on,
      // the durable job is recovered by idempotency key, not silently deleted.
      // Explicit Stop uses the authenticated cancellation endpoint and fencing.
      committingReady = true;
      await repository.markInputsReadyOwned(jobId, userId);
      const ready = await repository.getOwned(jobId, userId);
      res.status(202).json({ jobId, ...jobSnapshot(ready, config.showCost) });
    } catch (error) {
      // Durable tombstone revokes access immediately; reconciler owns confirmed deletion.
      if (createdJobId && !committingReady) {
        try { await repository.deleteOwned(createdJobId, userId); } catch { deps.notice('DOC_ADMISSION_CLEANUP_PENDING'); }
      }
      throw error;
    } finally { clearTimeout(timeout); res.off('close', onClose); req.off('aborted', onClose); uploadSlot.release(); }
  }));
  router.get('/:id', asyncRoute(async (req, res) => {
    const userId = owner(req); const jobId = id(req, 'id'); const job = await repository.getOwned(jobId, userId);
    res.json(await readSnapshot(job, userId));
  }));
  router.post('/:id/cancel', asyncRoute(async (req, res) => {
    const jobId = id(req, 'id'); const userId = owner(req); await repository.cancelOwned(jobId, userId); deps.abort(jobId);
    const job = await repository.getOwned(jobId, userId);
    res.json(jobSnapshot(job, config.showCost));
  }));
  router.delete('/:id', asyncRoute(async (req, res) => {
    const jobId = id(req, 'id'); await repository.deleteOwned(jobId, owner(req)); deps.abort(jobId);
    const job = await repository.getInternal(jobId);
    res.status(202).json({ id: jobId, deleted: true, cleanupPending: job.cleanupPending });
  }));
  router.get('/:id/artifacts/:artifactId', asyncRoute(async (req, res) => {
    const userId = owner(req); const jobId = id(req, 'id'); const artifactId = id(req, 'artifactId');
    const artifact = (await repository.artifactsOwned(jobId, userId)).find((entry) => entry.id === artifactId);
    if (!artifact) throw new DocSandboxError('E_NOT_FOUND', 404);
    const signature = tickets.issue(userId, jobId, artifactId);
    // "signature" is redacted by the existing URL logger. No externally accessible object URL.
    const url = `/api/docs/jobs/${jobId}/artifacts/${artifactId}/download?signature=${signature}`;
    if (req.query.download === '1') { res.redirect(302, url); return; }
    res.json({ url, expiresIn: 600 });
  }));
  router.get('/:id/artifacts/:artifactId/download', asyncRoute(async (req, res) => {
    const userId = owner(req); const jobId = id(req, 'id'); const artifactId = id(req, 'artifactId');
    tickets.verify(z.string().parse(req.query.signature), { userId, jobId, artifactId });
    const artifact = (await repository.artifactsOwned(jobId, userId)).find((entry) => entry.id === artifactId);
    if (!artifact) throw new DocSandboxError('E_NOT_FOUND', 404);
    const abort = new AbortController(); const closed = (): void => abort.abort(); res.once('close', closed);
    try {
      const bytes = await storage.get({ userId, jobId }, artifact.storageKey, artifact.sha256, abort.signal);
      const encodedFilename = encodeURIComponent(fileNameSchema.parse(artifact.filename)).replace(/['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodedFilename}`, 'Content-Length': String(bytes.length), 'Content-Security-Policy': "sandbox; default-src 'none'" });
      // Recheck the durable tombstone before every bounded chunk. Downloaded bytes cannot be revoked.
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
        abort.signal.throwIfAborted(); await repository.getOwned(jobId, userId);
        if (!res.write(bytes.subarray(offset, offset + 256 * 1024))) await new Promise<void>((resolve, reject) => {
          const done = (): void => { res.off('close', close); resolve(); };
          const close = (): void => { res.off('drain', done); reject(new DocSandboxError('E_CANCELLED')); };
          res.once('drain', done); res.once('close', close);
        });
      }
      await repository.getOwned(jobId, userId); res.end();
    } finally { res.off('close', closed); }
  }));
  const streams = new Map<string, number>();
  router.get('/:id/events', asyncRoute(async (req, res) => {
    const userId = owner(req); const jobId = id(req, 'id');
    if ((streams.get(userId) ?? 0) >= 3) throw new DocSandboxError('E_QUOTA', 429);
    let cursor = Number(req.get('Last-Event-ID') ?? req.query.after ?? '0');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DocSandboxError('E_PARAMS');
    const snapshot = await repository.getOwned(jobId, userId);
    if (cursor > snapshot.eventSeq) throw new DocSandboxError('E_CONFLICT', 409);
    streams.set(userId, (streams.get(userId) ?? 0) + 1);
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let closed = false; let timer: NodeJS.Timeout | undefined; const started = Date.now();
    const finish = (): void => { if (closed) return; closed = true; if (timer) clearTimeout(timer);
      const count = (streams.get(userId) ?? 1) - 1; if (count) streams.set(userId, count); else streams.delete(userId); res.end(); };
    res.once('close', finish);
    const poll = async (): Promise<void> => {
      try {
        const job = await repository.getOwned(jobId, userId);
        const events = await repository.listEventsOwned(jobId, userId, cursor, 200);
        for (const event of events) {
          if (closed) return;
          if (!res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(publicEvent(event))}\n\n`)) { finish(); return; }
          cursor = event.seq;
        }
        if (closed) return;
        if (terminal(job) && cursor >= job.eventSeq) { finish(); return; }
        if (Date.now() - started >= 60_000) { finish(); return; } // refresh authentication on reconnect
        if (!events.length) res.write(': heartbeat\n\n');
        timer = setTimeout(() => { void poll(); }, events.length === 200 ? 0 : 1000);
      } catch { finish(); }
    };
    res.write(`event: snapshot\ndata: ${JSON.stringify(jobSnapshot(snapshot, config.showCost))}\n\n`);
    void poll();
  }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    let safe = publicError(error);
    if (error instanceof z.ZodError || error instanceof multer.MulterError) safe = publicError(new DocSandboxError('E_PARAMS', 400));
    if (error instanceof DocumentRepositoryError) {
      const status = error.code === 'DOC_BUDGET_EXCEEDED' ? 429 : error.code === 'DOC_FORBIDDEN' ? 403 : ['DOC_NOT_FOUND', 'DOC_DELETED', 'DOC_EXPIRED'].includes(error.code) ? 404 : 409;
      safe = publicError(new DocSandboxError(status === 429 ? 'E_QUOTA' : status === 403 ? 'E_FORBIDDEN' : status === 404 ? 'E_NOT_FOUND' : 'E_CONFLICT', status));
    }
    deps.notice(safe.code);
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.status(safe.status).json({ code: safe.code, message: safe.message });
  };
  router.use(errors);
  return router;
}
