'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_SCHEMA_VERSION = 'sira.runsc-sandbox-activity.v1';
const SANDBOX_REF_PATTERN = /^sb_[A-Za-z0-9_-]{32}$/;

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

class MemoryActivityStore {
  constructor(entries = []) {
    this.entries = new Map(entries);
    this.executions = new Map();
  }

  async initialize() {}
  async get(ref) { return this.entries.get(ref) ?? null; }
  async set(ref, timestamp) {
    if (!SANDBOX_REF_PATTERN.test(String(ref)) || !validTimestamp(timestamp)) throw new TypeError('invalid activity record');
    this.entries.set(ref, timestamp);
  }
  async beginExec(ref, deadlineMs) {
    if (!SANDBOX_REF_PATTERN.test(String(ref)) || !validTimestamp(deadlineMs)) throw new TypeError('invalid execution record');
    this.executions.set(ref, deadlineMs);
  }
  async endExec(ref) { this.executions.delete(ref); }
  async listExecutions() { return [...this.executions.entries()]; }
  async delete(ref) {
    this.entries.delete(ref);
    this.executions.delete(ref);
  }
}

class FileActivityStore {
  constructor({ directory }) {
    const raw = String(directory || '').trim();
    if (!raw || !path.isAbsolute(raw)) throw new TypeError('activity store directory must be absolute');
    const resolved = path.resolve(raw);
    this.directory = resolved;
    this.file = path.join(resolved, 'activity-v1.json');
    this.entries = new Map();
    this.executions = new Map();
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  withLock(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async initialize() {
    return this.withLock(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe activity store directory');
      await fs.chmod(this.directory, 0o700);
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        parsed = { schemaVersion: STORE_SCHEMA_VERSION, entries: {}, executions: {} };
      }
      if (parsed?.schemaVersion !== STORE_SCHEMA_VERSION
        || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
        throw new Error('activity store is malformed');
      }
      const records = Object.entries(parsed.entries);
      const executions = Object.entries(parsed.executions || {});
      if (records.length > 10_000
        || executions.length > 10_000
        || records.some(([ref, timestamp]) => !SANDBOX_REF_PATTERN.test(ref) || !validTimestamp(timestamp))
        || executions.some(([ref, deadline]) => !SANDBOX_REF_PATTERN.test(ref) || !validTimestamp(deadline))) {
        throw new Error('activity store contains invalid records');
      }
      this.entries = new Map(records);
      this.executions = new Map(executions);
      this.initialized = true;
      if (records.length === 0) await this.persistUnlocked();
    });
  }

  assertInitialized() {
    if (!this.initialized) throw new Error('activity store is not initialized');
  }

  async persistUnlocked() {
    const payload = `${JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      entries: Object.fromEntries([...this.entries].sort(([left], [right]) => left.localeCompare(right))),
      executions: Object.fromEntries([...this.executions].sort(([left], [right]) => left.localeCompare(right))),
    })}\n`;
    const temp = path.join(this.directory, `.activity-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, this.file);
      await fs.chmod(this.file, 0o600);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temp).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
  }

  async get(ref) {
    return this.withLock(async () => {
      this.assertInitialized();
      return this.entries.get(ref) ?? null;
    });
  }

  async set(ref, timestamp) {
    return this.withLock(async () => {
      this.assertInitialized();
      if (!SANDBOX_REF_PATTERN.test(String(ref)) || !validTimestamp(timestamp)) throw new TypeError('invalid activity record');
      this.entries.set(ref, timestamp);
      await this.persistUnlocked();
    });
  }

  async beginExec(ref, deadlineMs) {
    return this.withLock(async () => {
      this.assertInitialized();
      if (!SANDBOX_REF_PATTERN.test(String(ref)) || !validTimestamp(deadlineMs)) throw new TypeError('invalid execution record');
      this.executions.set(ref, deadlineMs);
      await this.persistUnlocked();
    });
  }

  async endExec(ref) {
    return this.withLock(async () => {
      this.assertInitialized();
      if (!this.executions.delete(ref)) return;
      await this.persistUnlocked();
    });
  }

  async listExecutions() {
    return this.withLock(async () => {
      this.assertInitialized();
      return [...this.executions.entries()];
    });
  }

  async delete(ref) {
    return this.withLock(async () => {
      this.assertInitialized();
      const changed = this.entries.delete(ref) || this.executions.delete(ref);
      if (!changed) return;
      this.executions.delete(ref);
      await this.persistUnlocked();
    });
  }
}

module.exports = {
  STORE_SCHEMA_VERSION,
  MemoryActivityStore,
  FileActivityStore,
};
