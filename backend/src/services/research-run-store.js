'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_DIR = process.env.RESEARCH_RUN_STORE_DIR
  || path.join(process.cwd(), 'uploads', 'research-runs');
const RETENTION_MS = Number.parseInt(process.env.RESEARCH_RUN_RETENTION_MS || `${24 * 60 * 60 * 1000}`, 10);

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function syncDirectory() {
  const dir = fs.openSync(STORE_DIR, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function runPath(runId) {
  const safe = String(runId || '');
  if (!/^rr_[a-zA-Z0-9_-]{1,76}$/.test(safe)) throw Object.assign(new Error('invalid_run_id'), { status: 400 });
  return path.join(STORE_DIR, `${safe}.json`);
}

function createRunId(query) {
  return `rr_${crypto.randomUUID()}`;
}

function loadRun(runId) {
  const file = runPath(runId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveRun(run) {
  if (!run?.id) return null;
  ensureDir();
  const file = runPath(run.id);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ ...run, updatedAt: Date.now() }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDirectory();
  return run;
}

function appendEvent(runId, event) {
  const run = loadRun(runId) || { id: runId, events: [], createdAt: Date.now() };
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ ...event, ts: event.ts || Date.now() });
  run.events = run.events.slice(-200);
  run.updatedAt = Date.now();
  return saveRun(run);
}

function claimRun(run) {
  ensureDir();
  const file = runPath(run.id);
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(run)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory();
    return true;
  } catch (err) { if (err.code === 'EEXIST') return false; throw err; }
}

// A separate marker prevents cancellation being overwritten by a heartbeat.
function requestCancel(runId) {
  const fd = fs.openSync(`${runPath(runId)}.cancel`, 'w', 0o600);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory();
}
function isCancelled(runId) { return fs.existsSync(`${runPath(runId)}.cancel`); }

function pruneOldRuns() {
  ensureDir();
  const now = Date.now();
  let pruned = 0;
  for (const name of fs.readdirSync(STORE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(STORE_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > RETENTION_MS) {
        fs.unlinkSync(file);
        try { fs.unlinkSync(`${file}.cancel`); } catch { /* no cancellation marker */ }
        pruned += 1;
      }
    } catch { /* ignore */ }
  }
  return pruned;
}

module.exports = {
  createRunId,
  claimRun,
  requestCancel,
  isCancelled,
  loadRun,
  saveRun,
  appendEvent,
  pruneOldRuns,
  STORE_DIR,
};
