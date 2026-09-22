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
const PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PENDING_STAGES = ['uploaded', 'validating', 'extracting'];

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
  validate = validateMedia, offload = offloadMedia, timeoutMs = PROCESS_TIMEOUT_MS, now = () => Date.now() }) {
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

  async function processMediaJob(job) {
    const { fileId, userId } = job.data || {};
    let local;
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
      local = await materialize(row.path, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const mimeType = await validate(local, row);
      const result = await processFile({ path: local.path, mimetype: mimeType, originalname: row.originalName, size: row.size }, { signal: controller.signal });
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

  return { enqueueMediaTranscription, processMediaJob, reconcilePendingMedia,
    abortActive: () => { for (const controller of activeControllers) controller.abort(failure('media_shutdown', 'La transcripción se reanudará después del reinicio.')); },
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
  worker = new Worker(QUEUE_NAME, job => getService().processMediaJob(job), {
    connection: workerConnection, ...redis.getBullMQRuntimeOptions(), concurrency: CONCURRENCY,
    lockDuration: 300000, stalledInterval: 60000, maxStalledCount: 2, autorun: false,
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
  worker.on('ready', () => { void ensureRunning(); void reconcile(); });
  recoveryTimer = setInterval(() => { void ensureRunning(); void reconcile(); }, 60000);
  recoveryTimer.unref?.();
  return worker;
}

async function closeMediaTranscriptionQueue() {
  clearInterval(recoveryTimer);
  recoveryTimer = null;
  service?.abortActive();
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
  enqueueMediaTranscription: payload => getService().enqueueMediaTranscription(payload),
  reconcilePendingMedia: () => getService().reconcilePendingMedia(),
  startMediaTranscriptionWorker, closeMediaTranscriptionQueue,
  QUEUE_NAME, CONCURRENCY, ATTEMPTS, PROCESS_TIMEOUT_MS,
};
