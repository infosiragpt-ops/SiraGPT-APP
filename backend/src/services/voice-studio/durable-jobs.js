'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getMediaJobStore } = require('../media/job-store');
const { registerMediaRunner } = require('../media/job-worker');
const storage = require('../object-storage');
const pipelines = require('./pipelines');
const prisma = require('../../config/database');

function publicJob(row) {
  if (!row) return null;
  const { __private, ...result } = row.result || row.checkpoint?.progressResult || {};
  return {
    id: row.id, kind: row.kind.replace(/^voice\./, ''),
    status: row.status === 'completed' ? 'done' : row.status === 'unknown' ? 'failed' : row.status,
    stage: row.cancel_requested_at && ['queued', 'running'].includes(row.status) ? 'cancelando' : row.phase,
    progress: row.progress, title: row.payload.title || null, chatId: row.chat_id,
    input: row.public_input, result: Object.keys(result).length ? result : null,
    error: row.error_message || null, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}

async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

for (const [kind, runner] of [['dub', pipelines.runDubJob], ['audiobook', pipelines.runAudiobookJob]]) {
  registerMediaRunner(`voice.${kind}`, async (ctx, spec) => {
    let temporary;
    const input = { ...spec.executionInput };
    if (input.sourceRef) {
      temporary = await storage.toLocalTemp(input.sourceRef);
      input.sourcePath = temporary.path;
    }
    try {
      await pipelines.ensureOutputDirs();
      return await runner(ctx, input);
    } catch (error) {
      if (ctx.signal.reason?.code === 'E_CANCELLED') {
        const taskId = ctx.job.checkpoint?.generateTaskId || ctx.job.checkpoint?.prepTaskId;
        if (taskId) await require('../ai/voicestudio-client').cancelTask(taskId).catch(() => {});
      }
      throw error;
    } finally { await temporary?.cleanup?.().catch(() => {}); }
  });
}

function createDurableVoiceQueue({ store = getMediaJobStore(), client = prisma } = {}) {
  return {
    publicJob,
    activeCount: userId => store.count(userId, 'voice', true),
    async enqueue({ userId, chatId = null, kind, title, input = {}, executionInput, idempotencyKey }) {
      if (!executionInput || !['dub', 'audiobook'].includes(kind)) throw new Error('Durable voice execution input is required');
      const id = randomUUID();
      const privateInput = { ...executionInput };
      const fingerprint = { ...privateInput, sourcePath: undefined, sourceRef: undefined };
      if (privateInput.sourcePath) fingerprint.sourceDigest = await fileDigest(privateInput.sourcePath);
      let sourceRef;
      try {
        if (privateInput.sourcePath && storage.enabled()) {
          const ext = path.extname(privateInput.filename || '').replace(/[^a-z0-9.]/gi, '').slice(0, 8);
          sourceRef = (await storage.persistLocalFileStream({ localPath: privateInput.sourcePath, key: `uploads/private/media-inputs/${storage.sanitizeSegment(userId)}/${id}${ext}`, contentType: privateInput.mime || 'application/octet-stream' })).ref;
          privateInput.sourceRef = sourceRef;
          delete privateInput.sourcePath;
        }
        const admitted = await store.admit({ id, userId, chatId, lane: 'voice', kind: `voice.${kind}`,
          key: idempotencyKey || id, fingerprint, publicInput: input,
          payload: { title, executionInput: privateInput } });
        // A replay owns the original input, not this duplicate staged copy.
        if (!admitted.created || sourceRef) await fs.promises.unlink(executionInput.sourcePath).catch(() => {});
        return publicJob(admitted.job);
      } catch (error) {
        // Input objects are private and never exposed through the job DTO.
        if (sourceRef) await storage.remove(sourceRef).catch(() => {});
        throw error;
      }
    },
    async get(userId, id) {
      const row = await store.owned(id, userId);
      if (row?.lane === 'voice') return publicJob(row);
      const legacy = await client.voiceStudioJob.findFirst({ where: { id, userId } });
      return legacy ? require('./jobs').createJobQueue({ client }).publicJob(legacy) : null;
    },
    async getRow(userId, id) {
      const row = await store.owned(id, userId);
      if (row?.lane === 'voice') return { ...publicJob(row), result: row.result };
      return client.voiceStudioJob.findFirst({ where: { id, userId } });
    },
    async list(userId, options = {}) {
      const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
      const [fresh, previous] = await Promise.all([
        store.list(userId, 'voice', { limit }),
        client.voiceStudioJob.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit }),
      ]);
      const legacy = require('./jobs').createJobQueue({ client });
      return [...fresh.map(publicJob), ...previous.map(legacy.publicJob)]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
    },
    async cancel(userId, id) {
      const owned = await store.owned(id, userId);
      if (!owned || owned.lane !== 'voice') return null;
      return publicJob(await store.cancel(userId, id));
    },
    // Old rows have no executable input. New jobs recover via expired leases,
    // without pessimistically failing every job on boot.
    async recoverInterruptedJobs() {
      const result = await client.voiceStudioJob.updateMany({ where: { status: { in: ['queued', 'running'] } }, data: {
        status: 'failed', stage: 'interrumpido', error: 'Este trabajo anterior no pudo recuperarse después del reinicio.', finishedAt: new Date(),
      } });
      return result.count;
    },
  };
}
module.exports = { createDurableVoiceQueue, publicJob };
