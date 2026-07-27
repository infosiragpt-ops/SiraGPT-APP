'use strict';

/**
 * Durable Codex session artifacts.
 *
 * Transcripts are newline-delimited JSON under .sira/sessions and are bounded
 * by both entry count and UTF-8 bytes. Snapshots are separate, replaceable
 * artifacts so boot recovery can decide whether an interrupted loop is safe to
 * resume without replaying an unbounded transcript.
 */

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_RECORD_BYTES = 64_000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 256_000;
const DEFAULT_CAS_RETRIES = 12;
const processSessionLocks = new Map();
const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

class CodexSessionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CodexSessionError';
    this.code = code;
    this.details = details;
  }
}

function normalizeLimit(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function requireSessionId(raw, label = 'sessionId') {
  const value = String(raw || '').trim();
  if (!SESSION_ID_RE.test(value)) {
    throw new CodexSessionError('invalid_session_id', `${label} is invalid`);
  }
  return value;
}

function artifactPaths(sessionId) {
  const id = requireSessionId(sessionId);
  const stem = `.sira/sessions/${id}`;
  return {
    transcript: `${stem}.jsonl`,
    snapshot: `${stem}.snapshot.json`,
  };
}

function isMissingArtifact(error) {
  return Boolean(
    error
    && (
      error.code === 'ENOENT'
      || error.code === 'file_not_found'
      || error.status === 404
      || error.body?.error === 'file_not_found'
    )
  );
}

function createRunnerArtifactStore(runner) {
  if (!runner || typeof runner.readFile !== 'function' || typeof runner.writeFiles !== 'function') {
    throw new TypeError('runner.readFile and runner.writeFiles are required');
  }
  return {
    async readText(projectId, artifactPath) {
      const out = await runner.readFile(projectId, artifactPath);
      return String(out?.content || '');
    },
    async writeText(projectId, artifactPath, content) {
      const out = await runner.writeFiles(projectId, [{ path: artifactPath, content }]);
      if (
        (out && out.ok === false)
        || (Number.isFinite(Number(out?.written)) && Number(out.written) < 1)
      ) {
        throw new Error(out?.error || 'artifact_write_failed');
      }
      return out;
    },
  };
}

function statePath(artifactPath) {
  const match = /^\.sira\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})(\.jsonl|\.snapshot\.json)$/.exec(
    String(artifactPath || ''),
  );
  if (!match) throw new CodexSessionError('invalid_session_artifact_path', 'session artifact path is invalid');
  return {
    sessionId: requireSessionId(match[1]),
    field: match[2] === '.jsonl' ? 'transcript' : 'snapshot',
  };
}

function stateText(row, field) {
  if (!row) {
    const error = new Error('session state not found');
    error.code = 'ENOENT';
    throw error;
  }
  if (field === 'transcript') {
    return encodeJsonLines(Array.isArray(row.transcript) ? row.transcript : []);
  }
  return row.snapshot == null ? '' : `${JSON.stringify(row.snapshot)}\n`;
}

function parseStateText(field, content) {
  if (field === 'transcript') {
    const parsed = parseJsonLines(content);
    if (parsed.malformed) throw new CodexSessionError('invalid_transcript_state', 'transcript state contains malformed records');
    return parsed.entries;
  }
  if (!String(content || '').trim()) return null;
  try {
    const parsed = JSON.parse(String(content));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('snapshot must be an object');
    return parsed;
  } catch {
    throw new CodexSessionError('invalid_snapshot_state', 'snapshot state contains invalid JSON');
  }
}

function createPrismaSessionStore(db = defaultPrisma, { maxRetries = DEFAULT_CAS_RETRIES } = {}) {
  if (!db?.codexSessionState) throw new TypeError('db.codexSessionState is required');
  const attempts = normalizeLimit(maxRetries, DEFAULT_CAS_RETRIES, 2, 50);

  async function find(projectId, sessionId) {
    return db.codexSessionState.findUnique({
      where: { projectId_sessionId: { projectId: String(projectId), sessionId } },
    });
  }

  async function mutate(projectId, artifactPath, updater) {
    const key = statePath(artifactPath);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row = await find(projectId, key.sessionId);
      const current = row ? stateText(row, key.field) : '';
      const nextText = await updater(current);
      const nextValue = parseStateText(key.field, nextText);
      if (!row) {
        try {
          const created = await db.codexSessionState.create({
            data: {
              projectId: String(projectId),
              sessionId: key.sessionId,
              transcript: key.field === 'transcript' ? nextValue : [],
              snapshot: key.field === 'snapshot' ? nextValue : null,
              revision: 1,
            },
          });
          return { ok: true, revision: created.revision, written: 1 };
        } catch (error) {
          if (error?.code === 'P2002') continue;
          throw error;
        }
      }
      const updated = await db.codexSessionState.updateMany({
        where: { id: row.id, revision: row.revision },
        data: {
          [key.field]: nextValue,
          revision: { increment: 1 },
        },
      });
      if (updated?.count === 1) return { ok: true, revision: row.revision + 1, written: 1 };
    }
    throw new CodexSessionError('session_write_conflict', 'session state changed too many times; retry the operation');
  }

  return {
    kind: 'control-plane-postgres',
    async readText(projectId, artifactPath) {
      const key = statePath(artifactPath);
      return stateText(await find(projectId, key.sessionId), key.field);
    },
    writeText(projectId, artifactPath, content) {
      return mutate(projectId, artifactPath, async () => String(content || ''));
    },
    mutateText: mutate,
    deleteText(projectId, artifactPath) {
      return mutate(projectId, artifactPath, async () => '');
    },
  };
}

async function ensureSessionArtifactsIgnored(runner, projectId) {
  if (!runner || typeof runner.readFile !== 'function' || typeof runner.writeFiles !== 'function') return false;
  const excludePath = '.git/info/exclude';
  const rule = '.sira/sessions/';
  let current = '';
  try {
    const out = await runner.readFile(projectId, excludePath);
    current = String(out?.content || '');
  } catch {
    // git init normally creates this file. A missing one is safe to create
    // through the runner's no-follow filesystem API.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === rule)) return true;

  const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
  const out = await runner.writeFiles(projectId, [{
    path: excludePath,
    content: `${prefix}${rule}\n`,
  }]);
  if (out?.ok === false || (Number.isFinite(Number(out?.written)) && Number(out.written) < 1)) return false;

  try {
    const verified = await runner.readFile(projectId, excludePath);
    return String(verified?.content || '').split(/\r?\n/).some((line) => line.trim() === rule);
  } catch {
    return false;
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function cloneJson(value, code = 'invalid_record') {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CodexSessionError(code, 'value is not JSON serializable');
  }
  if (encoded === undefined) throw new CodexSessionError(code, 'value is not JSON serializable');
  return { encoded, value: JSON.parse(encoded) };
}

function parseJsonLines(text) {
  const entries = [];
  let malformed = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && Number.isSafeInteger(parsed.seq) && parsed.seq > 0) {
        entries.push(parsed);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  return { entries, malformed };
}

function encodeJsonLines(entries) {
  return entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '';
}

function boundTranscript(entries, { maxEntries, maxBytes }) {
  const bounded = entries.slice(-maxEntries);
  while (bounded.length > 1 && byteLength(encodeJsonLines(bounded)) > maxBytes) bounded.shift();
  const encoded = encodeJsonLines(bounded);
  if (byteLength(encoded) > maxBytes) {
    throw new CodexSessionError('transcript_limit_exceeded', 'single transcript record exceeds the session byte limit');
  }
  return { entries: bounded, encoded };
}

function snapshotIsResumable(snapshot) {
  return Boolean(
    snapshot
    && snapshot.version === 1
    && SESSION_ID_RE.test(String(snapshot.sessionId || ''))
    && Number.isSafeInteger(snapshot.cursorSeq)
    && snapshot.cursorSeq >= 0
    && (
      (snapshot.loopState && typeof snapshot.loopState === 'object')
      || typeof snapshot.checkpointSha === 'string'
    )
  );
}

function createSessionService({
  runner,
  db = defaultPrisma,
  store = db?.codexSessionState
    ? createPrismaSessionStore(db)
    : (runner ? createRunnerArtifactStore(runner) : null),
  clock = () => new Date(),
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
} = {}) {
  if (!store || typeof store.readText !== 'function' || typeof store.writeText !== 'function') {
    throw new TypeError('artifact store with readText/writeText is required');
  }

  const limits = Object.freeze({
    maxEntries: normalizeLimit(maxEntries, DEFAULT_MAX_ENTRIES, 10, 10_000),
    maxBytes: normalizeLimit(maxBytes, DEFAULT_MAX_BYTES, 4_096, 10_000_000),
    maxRecordBytes: normalizeLimit(maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 512, 1_000_000),
    maxSnapshotBytes: normalizeLimit(maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES, 1_024, 2_000_000),
  });
  async function readOptional(projectId, artifactPath) {
    try {
      return await store.readText(projectId, artifactPath);
    } catch (error) {
      if (isMissingArtifact(error)) return '';
      throw error;
    }
  }

  async function withSessionLock(projectId, sessionId, operation) {
    const key = `${projectId}:${sessionId}`;
    const previous = processSessionLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    processSessionLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (processSessionLocks.get(key) === current) processSessionLocks.delete(key);
    }
  }

  async function readTranscript({ projectId, sessionId, afterSeq = 0, limit = limits.maxEntries } = {}) {
    const id = requireSessionId(sessionId);
    const path = artifactPaths(id).transcript;
    const parsed = parseJsonLines(await readOptional(projectId, path));
    const boundedLimit = normalizeLimit(limit, limits.maxEntries, 1, limits.maxEntries);
    const entries = parsed.entries
      .filter((entry) => entry.seq > Math.max(0, Number(afterSeq) || 0))
      .slice(-boundedLimit);
    return {
      sessionId: id,
      entries,
      malformed: parsed.malformed,
      firstSeq: entries[0]?.seq || null,
      lastSeq: entries[entries.length - 1]?.seq || null,
    };
  }

  async function appendTranscript({ projectId, sessionId, entry } = {}) {
    const id = requireSessionId(sessionId);
    return withSessionLock(projectId, id, async () => {
      const cloned = cloneJson(entry, 'invalid_transcript_record');
      if (!cloned.value || typeof cloned.value !== 'object' || Array.isArray(cloned.value)) {
        throw new CodexSessionError('invalid_transcript_record', 'transcript entry must be an object');
      }
      const safeEntry = require('../../utils/log-redaction').redactPayloadDeep(cloned.value, {
        maxDepth: 20,
        maxArrayItems: 1_000,
      });
      const path = artifactPaths(id).transcript;
      let appended = null;
      const update = async (current) => {
        const parsed = parseJsonLines(current);
        const seq = (parsed.entries[parsed.entries.length - 1]?.seq || 0) + 1;
        const record = {
          ...safeEntry,
          seq,
          createdAt: safeEntry.createdAt || clock().toISOString(),
        };
        const encodedRecord = JSON.stringify(record);
        if (byteLength(encodedRecord) > limits.maxRecordBytes) {
          throw new CodexSessionError('transcript_record_too_large', 'transcript record exceeds the byte limit');
        }
        const bounded = boundTranscript([...parsed.entries, record], limits);
        appended = {
          record,
          retained: bounded.entries.length,
          truncated: bounded.entries.length < parsed.entries.length + 1,
        };
        return bounded.encoded;
      };
      if (typeof store.mutateText === 'function') {
        await store.mutateText(projectId, path, update);
      } else {
        await store.writeText(projectId, path, await update(await readOptional(projectId, path)));
      }
      return appended;
    });
  }

  async function readSnapshot({ projectId, sessionId } = {}) {
    const id = requireSessionId(sessionId);
    const raw = await readOptional(projectId, artifactPaths(id).snapshot);
    if (!raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async function saveSnapshot({
    projectId,
    sessionId,
    cursorSeq = 0,
    checkpointSha = null,
    checkpointId = null,
    loopState = null,
    metadata = null,
  } = {}) {
    const id = requireSessionId(sessionId);
    if (!Number.isSafeInteger(cursorSeq) || cursorSeq < 0) {
      throw new CodexSessionError('invalid_snapshot_cursor', 'cursorSeq must be a non-negative integer');
    }
    const snapshot = {
      version: 1,
      projectId: String(projectId || ''),
      sessionId: id,
      cursorSeq,
      checkpointSha: checkpointSha || null,
      checkpointId: checkpointId || null,
      loopState: loopState || null,
      metadata: metadata || null,
      updatedAt: clock().toISOString(),
    };
    const safeSnapshot = require('../../utils/log-redaction').redactPayloadDeep(snapshot, {
      maxDepth: 20,
      maxArrayItems: 1_000,
    });
    const cloned = cloneJson(safeSnapshot, 'invalid_snapshot');
    const encoded = `${cloned.encoded}\n`;
    if (byteLength(encoded) > limits.maxSnapshotBytes) {
      throw new CodexSessionError('snapshot_too_large', 'session snapshot exceeds the byte limit');
    }
    await store.writeText(projectId, artifactPaths(id).snapshot, encoded);
    return cloned.value;
  }

  async function clearSnapshot({ projectId, sessionId } = {}) {
    const id = requireSessionId(sessionId);
    if (typeof store.deleteText === 'function') {
      await store.deleteText(projectId, artifactPaths(id).snapshot);
    } else {
      await store.writeText(projectId, artifactPaths(id).snapshot, '');
    }
  }

  async function hasResumableSnapshot(args = {}) {
    return snapshotIsResumable(await readSnapshot(args));
  }

  async function forkSession({
    projectId,
    sourceSessionId,
    targetSessionId,
    atSeq = Number.MAX_SAFE_INTEGER,
  } = {}) {
    const sourceId = requireSessionId(sourceSessionId, 'sourceSessionId');
    const targetId = requireSessionId(targetSessionId, 'targetSessionId');
    if (sourceId === targetId) {
      throw new CodexSessionError('same_session', 'source and target sessions must differ');
    }
    const cursor = Number.isSafeInteger(atSeq) && atSeq >= 0 ? atSeq : Number.MAX_SAFE_INTEGER;
    return withSessionLock(projectId, targetId, async () => {
      const source = await readTranscript({ projectId, sessionId: sourceId });
      const entries = source.entries.filter((entry) => entry.seq <= cursor);
      const bounded = boundTranscript(entries, limits);
      await store.writeText(projectId, artifactPaths(targetId).transcript, bounded.encoded);

      const sourceSnapshot = await readSnapshot({ projectId, sessionId: sourceId });
      let snapshot = null;
      if (sourceSnapshot && sourceSnapshot.cursorSeq <= cursor) {
        const sourceMetadata = sourceSnapshot.metadata
          && typeof sourceSnapshot.metadata === 'object'
          && !Array.isArray(sourceSnapshot.metadata)
          ? sourceSnapshot.metadata
          : {};
        snapshot = await saveSnapshot({
          projectId,
          sessionId: targetId,
          cursorSeq: sourceSnapshot.cursorSeq,
          checkpointSha: sourceSnapshot.checkpointSha,
          checkpointId: sourceSnapshot.checkpointId,
          loopState: sourceSnapshot.loopState,
          metadata: {
            ...sourceMetadata,
            forkedFrom: sourceId,
            forkedAtSeq: cursor,
          },
        });
      }
      return {
        ok: true,
        sourceSessionId: sourceId,
        sessionId: targetId,
        entries: bounded.entries.length,
        lastSeq: bounded.entries[bounded.entries.length - 1]?.seq || null,
        snapshot,
      };
    });
  }

  async function rewindSession({
    projectId,
    sessionId,
    toSeq,
    checkpointId = null,
    checkpointSha = null,
    restoreCheckpoint,
    undoCheckpointRestore,
  } = {}) {
    const id = requireSessionId(sessionId);
    if (!Number.isSafeInteger(toSeq) || toSeq < 0) {
      throw new CodexSessionError('invalid_rewind_cursor', 'toSeq must be a non-negative integer');
    }
    return withSessionLock(projectId, id, async () => {
      let restore = null;
      const path = artifactPaths(id).transcript;
      const snapshotPath = artifactPaths(id).snapshot;
      const originalTranscript = await readOptional(projectId, path);
      const originalSnapshot = await readOptional(projectId, snapshotPath);
      if (checkpointId || checkpointSha) {
        if (typeof restoreCheckpoint !== 'function') {
          throw new CodexSessionError('checkpoint_restore_required', 'restoreCheckpoint is required for checkpoint rewind');
        }
        restore = await restoreCheckpoint({
          projectId,
          sessionId: id,
          checkpointId,
          checkpointSha,
        });
        if (!restore || restore.ok !== true) {
          throw new CodexSessionError('checkpoint_restore_failed', 'checkpoint restore failed', restore || null);
        }
      }

      const parsed = parseJsonLines(originalTranscript);
      const entries = parsed.entries.filter((entry) => entry.seq <= toSeq);
      const bounded = boundTranscript(entries, limits);
      try {
        await store.writeText(projectId, path, bounded.encoded);
        const snapshot = originalSnapshot.trim() ? JSON.parse(originalSnapshot) : null;
        if (snapshot && snapshot.cursorSeq > toSeq) {
          await clearSnapshot({ projectId, sessionId: id });
        }
      } catch (error) {
        await store.writeText(projectId, path, originalTranscript).catch(() => {});
        await store.writeText(projectId, snapshotPath, originalSnapshot).catch(() => {});
        if (restore && typeof undoCheckpointRestore === 'function') {
          await undoCheckpointRestore(restore).catch(() => {});
        }
        throw error;
      }
      return {
        ok: true,
        sessionId: id,
        toSeq,
        entries: bounded.entries.length,
        lastSeq: bounded.entries[bounded.entries.length - 1]?.seq || null,
        restore,
      };
    });
  }

  async function continueSession({ projectId, sessionId, afterSeq = null, limit } = {}) {
    const id = requireSessionId(sessionId);
    const snapshot = await readSnapshot({ projectId, sessionId: id });
    const cursor = afterSeq == null
      ? (Number.isSafeInteger(snapshot?.cursorSeq) ? snapshot.cursorSeq : 0)
      : Math.max(0, Number(afterSeq) || 0);
    const transcript = await readTranscript({
      projectId,
      sessionId: id,
      afterSeq: cursor,
      limit,
    });
    return {
      ok: true,
      sessionId: id,
      resumable: snapshotIsResumable(snapshot),
      snapshot,
      cursorSeq: cursor,
      tail: transcript.entries,
      malformed: transcript.malformed,
    };
  }

  return {
    appendTranscript,
    readTranscript,
    saveSnapshot,
    readSnapshot,
    clearSnapshot,
    hasResumableSnapshot,
    forkSession,
    rewindSession,
    continueSession,
    limits,
  };
}

module.exports = {
  createSessionService,
  createRunnerArtifactStore,
  createPrismaSessionStore,
  ensureSessionArtifactsIgnored,
  artifactPaths,
  parseJsonLines,
  snapshotIsResumable,
  requireSessionId,
  CodexSessionError,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
};
