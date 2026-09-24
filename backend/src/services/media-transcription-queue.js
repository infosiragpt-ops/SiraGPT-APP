'use strict';

// File rows are the durable source of truth. Redis carries only references,
// never audio bytes or transcripts; restarting a web process loses no work.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');

const QUEUE_NAME = 'siragpt-media-transcription';
const ATTEMPTS = 3;
const CONCURRENCY = 2;
// One job may be a 10-hour lecture on CPU whisper. The budget covers the
// whole recording; checkpoints make any interruption resumable.
const PROCESS_TIMEOUT_MS = positiveMs(process.env.SIRAGPT_MEDIA_PROCESS_TIMEOUT_MS, 12 * 60 * 60 * 1000);
// Every deploy recreates the backend and stalls the running job. Long jobs
// must survive many of those (they resume from checkpoints), so the stalled
// ceiling is far above BullMQ's default instead of failing on the 3rd deploy.
const MAX_STALLED_COUNT = 20;
const PROGRESS_WRITE_INTERVAL_MS = 3000;
const CHECKPOINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PENDING_STAGES = ['uploaded', 'validating', 'extracting'];

function positiveMs(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function checkpointRoot(env = process.env) {
  // Inside the persistent uploads volume (survives container recreation).
  // Dot-directories are never served by the /uploads static handler.
  return env.MEDIA_TRANSCRIPTION_CHECKPOINT_DIR
    || path.join(path.resolve(env.UPLOAD_DIR || 'uploads'), '.transcription-checkpoints');
}

/**
 * Per-file segment store. Each finished segment is one small JSON file
 * written atomically, so a crash mid-write never corrupts earlier segments.
 * `meta` (segment length + count) must match or the entry is ignored.
 */
function createDiskCheckpoint(dir) {
  const fileFor = index => path.join(dir, `seg-${String(index).padStart(5, '0')}.json`);
  return {
    dir,
    async load(index, meta) {
      const raw = await fs.promises.readFile(fileFor(index), 'utf8').catch(() => null);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved?.meta?.segmentSeconds !== meta?.segmentSeconds || saved?.meta?.total !== meta?.total) return null;
      return saved.part || null;
    },
    async save(index, meta, part) {
      await fs.promises.mkdir(dir, { recursive: true });
      const target = fileFor(index);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ meta, part, savedAt: new Date().toISOString() }));
      await fs.promises.rename(tmp, target);
    },
    clear: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

function checkpointFor(row, root = checkpointRoot()) {
  return createDiskCheckpoint(path.join(root, `${jobIdFor(row.id, row.userId)}-${Number(row.size) || 0}`));
}

async function sweepStaleCheckpoints({ root = checkpointRoot(), now = Date.now(), maxAgeMs = CHECKPOINT_MAX_AGE_MS } = {}) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^media-[a-f0-9]{64}-\d+$/.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > maxAgeMs) {
      await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return { removed };
}

/**
 * Turns transcriber events into the compact progress object stored on the
 * BullMQ job (and read by /api/files/processing-status). ETA uses only
 * segments transcribed in this run, so resumed checkpoints don't skew it.
 */
function createProgressTracker({ publish, now = () => Date.now(), intervalMs = PROGRESS_WRITE_INTERVAL_MS }) {
  let lastWrite = 0;
  let lastKey = '';
  const durations = [];
  let lastSegmentAt = 0;
  const startedAt = now();
  return (event = {}) => {
    const total = Math.max(0, Number(event.total) || 0);
    const completed = Math.min(total, Math.max(0, Number(event.completed) || 0));
    const at = now();
    if (event.stage === 'segments') lastSegmentAt = at;
    if (event.stage === 'transcribe') {
      const took = at - lastSegmentAt;
      // A checkpointed segment is replayed in milliseconds; only real work counts.
      if (lastSegmentAt && took > 1000) durations.push(took);
      if (durations.length > 8) durations.shift();
      lastSegmentAt = at;
    }
    const percent = event.stage === 'preparing' ? 1
      : event.stage === 'segments' ? 2
        : event.stage === 'transcribe' && total ? Math.min(99, Math.max(2, Math.round(2 + (97 * completed) / total))) : null;
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const progress = {
      stage: event.stage === 'preparing' ? 'preparing' : 'transcribing',
      completed, total, percent,
      durationSeconds: Math.round(Number(event.durationSeconds) || 0),
      etaSeconds: avg && total > completed ? Math.round((avg * (total - completed)) / 1000) : null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(at).toISOString(),
    };
    const key = `${progress.stage}:${completed}:${total}`;
    if (key === lastKey && at - lastWrite < intervalMs) return;
    lastKey = key;
    lastWrite = at;
    try { void Promise.resolve(publish(progress)).catch(() => {}); } catch (_) { /* best-effort */ }
  };
}

function isMediaFile(file) {
  const mime = String(file?.mimeType || file?.mimetype || '').toLowerCase().split(';')[0].trim();
  if (mime && mime !== 'application/octet-stream' && mime !== 'application/ogg' && !/^(audio|video)\//.test(mime)) return false;
  return require('./audio-transcriber').isAudioMedia(mime, file?.originalName || file?.originalname || '');
}

function hasTranscript(file) {
  const text = String(file?.extractedText || '').trim();
  return file?.processingStage !== 'failed' && !!text && !/^Media file .*transcription unavailable\./i.test(text)
    && !/^File .*uploaded successfully\. Content type:/i.test(text)
    && !require('./rag-audio-placeholder-filter').isAudioTranscriptionPlaceholder(text)
    && !/Estado:\s*(?:No se detect[oó] voz|El archivo supera el tama[nñ]o m[aá]ximo)\./i.test(text);
}

function jobIdFor(fileId, userId) {
  return `media-${crypto.createHash('sha256').update(`${userId}\0${fileId}`).digest('hex')}`;
}

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function publicFailureMessage(err) {
  switch (err?.code) {
    case 'no_speech': return 'No se detectó voz en este archivo.';
    case 'file_empty': return 'Este archivo está vacío.';
    case 'file_unavailable': case 'ENOENT': return 'No se pudo recuperar el archivo. Vuelve a subirlo.';
    case 'audio_decode_failed': case 'invalid_media': return 'No se pudo leer el audio. Comprueba que el archivo no esté dañado.';
    case 'media_timeout': return 'La transcripción superó el tiempo permitido. Puedes reintentar este archivo.';
    default: return 'No se pudo transcribir este archivo. Puedes reintentarlo sin volver a subir los demás.';
  }
}

function isTransientMediaError(err) {
  if (/^(no_speech|file_empty|file_unavailable|audio_decode_failed|unsupported_media|invalid_media|media_not_found|media_owner_required)$/i.test(String(err?.code || ''))) return false;
  if (typeof err?.retryable === 'boolean') return err.retryable;
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429 || status === 408 || status >= 500 && status <= 599) return true;
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|P1001|P1002|P1008|P1017|P2024|P2034|media_timeout|media_shutdown|transcription_timeout|provider_timeout|local_unavailable)$/i.test(String(err?.code || ''))) return true;
  return /rate.?limit|temporar(?:y|ily)|service unavailable|socket hang up|fetch failed|timed? out|timeout|\b429\b|\b50[234]\b/i.test(String(err?.message || ''));
}

// Unlike an unbounded toLocalTemp download, this stream is abortable and its
// scratch directory is removed on every exit, including a failed R2 download.
async function materializeMedia(ref, { signal, storage = require('./object-storage') } = {}) {
  if (!storage.isRemote(ref)) return { path: ref, cleanup: async () => {} };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sira-media-'));
  const target = path.join(dir, `source${path.extname(storage.keyFromRef(ref))}`);
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true });
  try {
    signal?.throwIfAborted();
    const { stream } = await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => storage.readStream(ref)).then(result => {
        if (signal?.aborted) { result.stream.destroy(); reject(signal.reason); }
        else resolve(result);
      }, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
    await pipeline(stream, fs.createWriteStream(target), { signal });
    return { path: target, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function validateMedia(local, row) {
  const { fileTypeFromFile } = await import('file-type');
  const detected = await fileTypeFromFile(local.path);
  const { validateUploadPolicy } = require('./upload-security-policy');
  const policy = validateUploadPolicy({ originalName: row.originalName, declaredMime: row.mimeType,
    detectedMime: detected?.mime || row.mimeType, detectionSource: detected ? 'magic-bytes' : 'fallback', size: row.size });
  if (!policy.ok) throw failure(policy.code || 'invalid_media', policy.message || 'Archivo multimedia no válido.');
  if (!isMediaFile({ ...row, mimeType: policy.mimeType || row.mimeType })) throw failure('unsupported_media', 'El archivo no contiene audio o vídeo compatible.');
  return policy.mimeType || row.mimeType;
}

async function offloadMedia(row, { signal } = {}) {
  const storage = require('./object-storage');
  if (storage.isRemote(row.path) || !storage.enabled()) return row.path;
  const stored = await storage.persistLocalFileStream({ localPath: row.path,
    key: storage.uploadKey(row.userId, row.filename || path.basename(row.path)),
    contentType: row.mimeType, metadata: { fileId: row.id }, signal });
  return stored.ref;
}

async function configureMediaQueue(queue) {
  // BullMQ's worker concurrency is per web process. The queue-wide cap keeps
  // multiple replicas from simultaneously decoding/transcribing 50 files.
  await queue.setGlobalConcurrency(CONCURRENCY);
}

function createMediaTranscriptionService({ prisma, getQueue, processFile, materialize = materializeMedia,
  validate = validateMedia, offload = offloadMedia, timeoutMs = PROCESS_TIMEOUT_MS, now = () => Date.now(),
  createCheckpoint = row => checkpointFor(row) }) {
  const activeControllers = new Set();
  const loadOwned = async (fileId, userId) => {
    if (!fileId || !userId) throw failure('media_owner_required', 'Falta el archivo o su propietario.');
    const row = await prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!row || row.userId !== userId || row.deletedAt) throw failure('media_not_found', 'Archivo no disponible.');
    if (!isMediaFile(row)) throw failure('unsupported_media', 'El archivo no es un audio o vídeo.');
    return row;
  };
  const writeOwned = async (fileId, userId, data) => {
    const result = await prisma.file.updateMany({ where: { id: fileId, userId, deletedAt: null }, data });
    if (result.count !== 1) throw failure('media_not_found', 'Archivo no disponible.');
  };
  const stage = (fileId, userId, value, error = null) => writeOwned(fileId, userId, {
    processingStage: value, processingStageAt: new Date(now()), processingError: error,
  });

  async function enqueueMediaTranscription({ fileId, userId, retry = false }) {
    if (!fileId || !userId) throw failure('media_owner_required', 'Falta el archivo o su propietario.');
    const row = await loadOwned(fileId, userId);
    if (hasTranscript(row)) {
      if (row.processingStage !== 'ready') await stage(fileId, userId, 'ready');
      return { id: fileId, queued: false, stage: 'ready' };
    }
    if (row.processingStage === 'failed' && !retry) return { id: fileId, queued: false, stage: 'failed' };
    const queue = getQueue(); // Must throw honestly if durable Redis is absent.
    const jobId = jobIdFor(fileId, userId);
    const previous = await queue.getJob(jobId);
    if (previous) {
      const state = await previous.getState();
      if (state === 'failed') {
        if (!retry) {
          await stage(fileId, userId, 'failed', 'La transcripción se interrumpió. Puedes reintentar este archivo.');
          return { id: fileId, queued: false, stage: 'failed' };
        }
        await writeOwned(fileId, userId, { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: null, extractedText: null });
        await previous.retry('failed', { resetAttemptsMade: true });
        return { id: fileId, queued: true, stage: 'uploaded' };
      }
      if (state !== 'completed' && state !== 'unknown') return { id: fileId, queued: true, stage: row.processingStage || 'uploaded' };
      // A completed queue job without persisted text is not a success. This
      // also permits recovery after a deployment of an older, broken worker.
      await previous.remove();
    }
    await writeOwned(fileId, userId, { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: null,
      ...(row.processingStage === 'failed' ? { extractedText: null } : {}) });
    await queue.add('transcribe', { fileId, userId }, { jobId, attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86400, count: 5000 }, removeOnFail: { age: 604800, count: 10000 } });
    return { id: fileId, queued: true, stage: 'uploaded' };
  }

  async function processMediaJob(job, token) {
    const { fileId, userId } = job.data || {};
    let local;
    let checkpoint = null;
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(failure('media_timeout', 'La transcripción superó el tiempo permitido.')), timeoutMs);
    timer.unref?.();
    try {
      const row = await loadOwned(fileId, userId);
      if (hasTranscript(row)) {
        await stage(fileId, userId, 'ready');
        return { id: fileId, cached: true, stage: 'ready' };
      }
      await stage(fileId, userId, 'extracting');
      checkpoint = createCheckpoint(row);
      local = await materialize(row.path, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const mimeType = await validate(local, row);
      const onProgress = createProgressTracker({ publish: progress => job.updateProgress?.(progress) });
      const result = await processFile({ path: local.path, mimetype: mimeType, originalname: row.originalName, size: row.size },
        { signal: controller.signal, onProgress, checkpoint });
      controller.signal.throwIfAborted();
      const transcript = result?.transcription?.transcript ?? result?.extractedText;
      if (!result?.success || !hasTranscript({ extractedText: transcript })) {
        const err = failure(result?.code || 'transcription_failed', result?.error || 'No se detectó una transcripción legible en este archivo.');
        if (result?.status) err.status = result.status;
        if (typeof result?.retryable === 'boolean') err.retryable = result.retryable;
        throw err;
      }
      // Text + terminal stage are one DB write. A crash before this write
      // leaves the job recoverable; after it, a replay is a cache hit.
      await writeOwned(fileId, userId, { extractedText: transcript, processingStage: 'ready',
        processingStageAt: new Date(now()), processingError: null });
      await checkpoint?.clear?.().catch(() => {});
      // Offload is optional enrichment after durable text is ready. Local
      // uploads live on the existing persistent volume if R2 is unavailable.
      // Never erase the local copy before updating the owner-scoped DB ref.
      try {
        const ref = await offload(row, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
        if (ref && ref !== row.path) await writeOwned(fileId, userId, { path: ref });
      } catch (_) { /* completed transcript and original local binary remain valid */ }
      return { id: fileId, stage: 'ready', characters: transcript.length };
    } catch (caught) {
      const err = controller.signal.aborted ? controller.signal.reason : caught;
      // A deploy/restart is not a failed attempt: park the job for a few
      // seconds without spending one of its retries. It resumes from its
      // checkpoints on the next worker, however many deploys happen.
      if (err?.code === 'media_shutdown' && token && typeof job.moveToDelayed === 'function') {
        let parked = false;
        try {
          await job.moveToDelayed(now() + 5000, token);
          parked = true;
        } catch (_) { /* connection already gone: the stalled checker recovers it */ }
        if (parked) {
          await stage(fileId, userId, 'uploaded').catch(() => {});
          const { DelayedError } = require('bullmq');
          throw new DelayedError();
        }
      }
      const transient = isTransientMediaError(err);
      const willRetry = transient && Number(job.attemptsMade || 0) + 1 < Number(job.opts?.attempts || ATTEMPTS);
      if (!transient) job.discard?.();
      // A deleted/foreign file must never be resurrected or mutated.
      if (err.code !== 'media_not_found' && err.code !== 'media_owner_required') {
        await stage(fileId, userId, willRetry ? 'uploaded' : 'failed',
          willRetry ? null : publicFailureMessage(err));
      }
      throw err;
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
      await local?.cleanup().catch(() => {});
    }
  }

  async function reconcilePendingMedia() {
    // Keyset pagination visits every pending row without holding all uploaded
    // files in RAM. The grace period avoids racing an HTTP validation write.
    let cursor;
    let recovered = 0;
    do {
      const rows = await prisma.file.findMany({ where: { deletedAt: null, processingStage: { in: PENDING_STAGES },
        OR: [{ processingStageAt: { lt: new Date(now() - 120000) } }, { processingStageAt: null }] },
      orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!rows.length) break;
      for (const row of rows) {
        if (!isMediaFile(row)) continue;
        await enqueueMediaTranscription({ fileId: row.id, userId: row.userId });
        recovered++;
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < 100) break;
    } while (true);
    return { recovered };
  }

  // Live progress of the durable job, for the composer chip. Owner-scoped by
  // construction (job id hashes userId + fileId). Never throws: a missing
  // Redis simply means "no progress to show", not a failed status read.
  async function readMediaProgress({ fileIds = [], userId, timeoutMs: readTimeoutMs = 1500 } = {}) {
    const out = {};
    if (!userId || !fileIds.length) return out;
    let queue;
    try { queue = getQueue(); } catch { return out; }
    const read = Promise.all(fileIds.map(async (fileId) => {
      try {
        const job = await queue.getJob(jobIdFor(fileId, userId));
        const progress = job?.progress;
        if (progress && typeof progress === 'object' && !Array.isArray(progress)) out[fileId] = progress;
      } catch { /* progress is optional */ }
    }));
    await Promise.race([read, new Promise(resolve => { const t = setTimeout(resolve, readTimeoutMs); t.unref?.(); })]);
    return out;
  }

  return { enqueueMediaTranscription, processMediaJob, reconcilePendingMedia, readMediaProgress,
    abortActive: () => {
      const count = activeControllers.size;
      for (const controller of activeControllers) controller.abort(failure('media_shutdown', 'La transcripción se reanudará después del reinicio.'));
      return count;
    },
  };
}

let queue, queueConnection, worker, workerConnection, service, recoveryTimer, recovering = false;
function getMediaQueue() {
  if (queue) return queue;
  const { Queue } = require('bullmq');
  const redis = require('./agents/agent-task-queue');
  if (!process.env.REDIS_URL) throw failure('media_queue_unavailable', 'La cola de transcripción no está disponible. El archivo permanece guardado.');
  queueConnection = redis.createRedisConnection({ label: 'media-transcription-producer', maxRetriesPerRequest: 1,
    enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000 });
  queue = new Queue(QUEUE_NAME, { connection: queueConnection, ...redis.getBullMQRuntimeOptions() });
  queue.on('error', err => console.warn('[media-transcription-queue]', err?.code || 'queue_error'));
  return queue;
}
function getService() {
  if (!service) service = createMediaTranscriptionService({ prisma: require('../config/database'), getQueue: getMediaQueue,
    processFile: (...args) => require('./fileProcessor').processFile(...args) });
  return service;
}
function startMediaTranscriptionWorker() {
  if (worker) return worker;
  if (!process.env.REDIS_URL) {
    console.warn('[media-transcription-queue] worker unavailable: Redis not configured');
    return null;
  }
  const { Worker } = require('bullmq');
  const redis = require('./agents/agent-task-queue');
  workerConnection = redis.createRedisConnection({ label: 'media-transcription-worker' });
  worker = new Worker(QUEUE_NAME, (job, token) => getService().processMediaJob(job, token), {
    connection: workerConnection, ...redis.getBullMQRuntimeOptions(), concurrency: CONCURRENCY,
    lockDuration: 300000, stalledInterval: 60000, maxStalledCount: MAX_STALLED_COUNT, autorun: false,
  });
  let starting = false;
  const ensureRunning = async () => {
    if (starting || !worker || worker.isRunning()) return;
    starting = true;
    const currentWorker = worker;
    try {
      await configureMediaQueue(getMediaQueue());
      if (worker === currentWorker) void currentWorker.run().catch(err => console.warn('[media-transcription-worker] run interrupted', err?.code || 'worker_error'));
    } catch (err) { console.warn('[media-transcription-worker] waiting for durable queue', err?.code || 'queue_error'); }
    finally { starting = false; }
  };
  worker.on('error', err => console.warn('[media-transcription-worker]', err?.code || 'worker_error'));
  // A worker killed repeatedly can exhaust BullMQ's stalled limit without
  // entering our catch block. Persist that terminal state, never leave a chip
  // displaying "extracting" forever. Ownership/deletion are still checked.
  worker.on('failed', (job, err) => {
    if (!job) return;
    void job.getState().then(async state => {
      if (state !== 'failed') return;
      const prisma = require('../config/database');
      const row = await prisma.file.findFirst({ where: { id: job.data.fileId, userId: job.data.userId, deletedAt: null } });
      if (!row || hasTranscript(row)) return;
      await prisma.file.updateMany({ where: { id: row.id, userId: row.userId, deletedAt: null }, data: {
        processingStage: 'failed', processingStageAt: new Date(), processingError: publicFailureMessage(err),
      } });
    }).catch(() => console.warn('[media-transcription-worker] failed state persistence pending recovery'));
  });
  const reconcile = async () => {
    if (recovering) return;
    recovering = true;
    try { await getService().reconcilePendingMedia(); }
    catch (err) { console.warn('[media-transcription-queue] reconciliation unavailable', err?.code || 'recovery_error'); }
    finally { recovering = false; }
  };
  worker.on('ready', () => { void ensureRunning(); void reconcile(); void sweepStaleCheckpoints().catch(() => {}); });
  recoveryTimer = setInterval(() => { void ensureRunning(); void reconcile(); }, 60000);
  recoveryTimer.unref?.();
  return worker;
}

async function closeMediaTranscriptionQueue() {
  clearInterval(recoveryTimer);
  recoveryTimer = null;
  // Give aborted jobs a moment to park themselves (moveToDelayed) before
  // the connection is force-closed; they resume from checkpoints.
  if (service?.abortActive()) await new Promise(resolve => setTimeout(resolve, 1500));
  const previous = { worker, queue, workerConnection, queueConnection };
  worker = queue = workerConnection = queueConnection = null;
  // Force-close the worker connection at shutdown. Its active jobs become
  // stalled and are recovered, rather than blocking deploy for two hours.
  await previous.worker?.close(true);
  await previous.queue?.close();
  previous.workerConnection?.disconnect();
  previous.queueConnection?.disconnect();
}

module.exports = {
  isMediaFile, hasTranscript, jobIdFor, isTransientMediaError, materializeMedia, configureMediaQueue, createMediaTranscriptionService,
  createDiskCheckpoint, checkpointFor, checkpointRoot, sweepStaleCheckpoints, createProgressTracker,
  readMediaProgress: payload => getService().readMediaProgress(payload),
  enqueueMediaTranscription: payload => getService().enqueueMediaTranscription(payload),
  reconcilePendingMedia: () => getService().reconcilePendingMedia(),
  startMediaTranscriptionWorker, closeMediaTranscriptionQueue,
  QUEUE_NAME, CONCURRENCY, ATTEMPTS, PROCESS_TIMEOUT_MS, MAX_STALLED_COUNT,
};
