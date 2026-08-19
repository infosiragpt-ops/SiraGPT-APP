'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, readJsonSafe } = require('../../utils/atomic-json-write');

const STORE_VERSION = 'codex-run-store-v1';

function storeDir() {
  const dir = process.env.CODEX_RUN_STORE_DIR || path.join(process.cwd(), 'uploads', 'codex-runs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
}

function fileFor(runId) {
  const clean = safeId(runId);
  if (!clean) throw new Error('codex-run-store: runId required');
  return path.join(storeDir(), `${clean}.json`);
}

function writeRun(record) {
  const runId = safeId(record.runId);
  if (!runId) throw new Error('codex-run-store: runId required');
  const now = new Date().toISOString();
  const payload = {
    version: STORE_VERSION,
    runId,
    userId: String(record.userId || ''),
    chatId: record.chatId || null,
    goal: String(record.goal || '').slice(0, 8000),
    repository: record.repository || null,
    branch: record.branch || null,
    status: record.status || 'queued',
    phase: record.phase || 'plan',
    percent: Number.isFinite(Number(record.percent)) ? Number(record.percent) : 0,
    taskId: record.taskId || null,
    prUrl: record.prUrl || null,
    ciRunId: record.ciRunId || null,
    events: Array.isArray(record.events) ? record.events.slice(-500) : [],
    error: record.error || null,
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
  writeJsonAtomicSync(fileFor(runId), payload, { pretty: true });
  return payload;
}

function readRun(runId) {
  return readJsonSafe(fileFor(runId), null);
}

function appendEvent(runId, event) {
  const row = readRun(runId);
  if (!row) return null;
  row.events = row.events || [];
  row.events.push({ ...event, at: new Date().toISOString() });
  if (row.events.length > 500) row.events = row.events.slice(-500);
  row.updatedAt = new Date().toISOString();
  writeJsonAtomicSync(fileFor(runId), row, { pretty: true });
  return row;
}

function updateRun(runId, patch = {}) {
  const row = readRun(runId);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  writeJsonAtomicSync(fileFor(runId), row, { pretty: true });
  return row;
}

module.exports = {
  STORE_VERSION,
  writeRun,
  readRun,
  appendEvent,
  updateRun,
};
