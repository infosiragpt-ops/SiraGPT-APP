'use strict';

/**
 * Store in-memory de jobs + eventos SSE. El worker y las rutas
 * GET /stream /artifact leen de aquí. TTL corto: los artefactos
 * viven 15 min (URL firmada).
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

const STAGES = Object.freeze([
  'unpack', 'map', 'edit', 'validate', 'render', 'verify', 'done', 'error',
]);

const jobs = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(200);

function nowIso() {
  return new Date().toISOString();
}

function createJobId() {
  return `doc_${crypto.randomBytes(12).toString('hex')}`;
}

function createJob({ userId, instructions, sourceName, templateName } = {}) {
  const id = createJobId();
  const job = {
    id,
    userId: userId || null,
    status: 'queued',
    instructions: String(instructions || '').slice(0, 8000),
    sourceName: sourceName || 'source.docx',
    templateName: templateName || 'template.docx',
    events: [],
    artifact: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(String(id || '')) || null;
}

function appendEvent(jobId, type, payload = {}) {
  const job = getJob(jobId);
  if (!job) return null;
  const seq = job.events.length;
  const event = {
    id: seq,
    type: STAGES.includes(type) ? type : type,
    jobId,
    ts: nowIso(),
    ...payload,
  };
  job.events.push(event);
  job.updatedAt = event.ts;
  if (type === 'done') job.status = 'done';
  else if (type === 'error') job.status = 'error';
  else job.status = 'running';
  bus.emit(`job:${jobId}`, event);
  bus.emit('event', event);
  return event;
}

function setArtifact(jobId, artifact) {
  const job = getJob(jobId);
  if (!job) return null;
  job.artifact = artifact;
  job.updatedAt = nowIso();
  return job;
}

function setError(jobId, message) {
  const job = getJob(jobId);
  if (!job) return null;
  job.error = String(message || 'doc-engine failed').slice(0, 2000);
  job.status = 'error';
  job.updatedAt = nowIso();
  return job;
}

function subscribe(jobId, listener) {
  const ev = `job:${jobId}`;
  bus.on(ev, listener);
  return () => bus.off(ev, listener);
}

function listJobs() {
  return [...jobs.values()];
}

function resetStore() {
  jobs.clear();
}

module.exports = {
  STAGES,
  createJob,
  createJobId,
  getJob,
  appendEvent,
  setArtifact,
  setError,
  subscribe,
  listJobs,
  resetStore,
  bus,
};
