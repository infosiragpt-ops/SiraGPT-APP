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

function runPath(runId) {
  const safe = String(runId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  return path.join(STORE_DIR, `${safe}.json`);
}

function createRunId(query) {
  const hash = crypto.createHash('sha256').update(String(query || '')).digest('hex').slice(0, 12);
  return `rr_${Date.now()}_${hash}`;
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
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...run, updatedAt: Date.now() }, null, 0));
  fs.renameSync(tmp, file);
  return run;
}

function appendEvent(runId, event) {
  const run = loadRun(runId) || { id: runId, events: [], createdAt: Date.now() };
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ ...event, ts: event.ts || Date.now() });
  run.updatedAt = Date.now();
  return saveRun(run);
}

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
        pruned += 1;
      }
    } catch { /* ignore */ }
  }
  return pruned;
}

module.exports = {
  createRunId,
  loadRun,
  saveRun,
  appendEvent,
  pruneOldRuns,
  STORE_DIR,
};
