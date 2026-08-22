'use strict';

const { test, after, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockResolvedModule } = require('./http-test-utils');

// ── codex run stream: id: frames + Last-Event-ID/afterSeq dedup ────────────

function realGate() {
  const seen = new Set();
  return { shouldEmit: (s) => (typeof s !== 'number' ? true : seen.has(s) ? false : (seen.add(s), true)) };
}

const restoreAuthCodex = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1' }; next(); },
});

let scriptedEvents = [];
const restoreStore = mockResolvedModule(require.resolve('../src/services/codex/event-store'), {
  createSeqGate: realGate,
  listEvents: async (runId, { afterSeq = 0 } = {}) => scriptedEvents.filter((e) => e.seq > afterSeq),
});

let ownedRun = null;
const restoreAccess = mockResolvedModule(require.resolve('../src/services/codex/run-access'), {
  findOwnedRun: async ({ runId, userId }) => (ownedRun && ownedRun.userId === userId && ownedRun.id === runId ? ownedRun : null),
  isTerminalStatus: (s) => ['done', 'error', 'cancelled'].includes(String(s || '')),
});

const restorePubsub = mockResolvedModule(require.resolve('../src/services/codex/redis-pubsub'), {
  createRunSubscriber: async () => null,
  publishEvent: async () => false,
});

const restoreService = mockResolvedModule(require.resolve('../src/services/codex/project-service'), {
  createProject: async () => ({}), listProjects: async () => [], getProject: async () => null,
});
const restoreRunner = mockResolvedModule(require.resolve('../src/services/codex/runner-client'), {
  createRunnerClient: () => ({}), runnerDevUrl: () => 'http://localhost:5173', RunnerError: class extends Error {},
});

const codexRoutes = require('../src/routes/codex');

function codexApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/codex', codexRoutes);
  return a;
}

before(() => { process.env.CODEX_AGENT_V2 = '1'; });
after(() => {
  restoreAuthCodex(); restoreStore(); restoreAccess(); restorePubsub(); restoreService(); restoreRunner();
});

test('codex stream writes an id: frame matching envelope.seq for every event', async () => {
  ownedRun = { id: 'run-1', userId: 'u-1', status: 'done' };
  scriptedEvents = [
    { runId: 'run-1', seq: 1, ts: 't', type: 'run_status', data: { status: 'running' } },
    { runId: 'run-1', seq: 2, ts: 't', type: 'narrative_delta', data: { text: 'hola' } },
    { runId: 'run-1', seq: 3, ts: 't', type: 'run_status', data: { status: 'done' } },
  ];
  const res = await request(codexApp()).get('/api/codex/runs/run-1/stream');
  assert.equal(res.status, 200);
  const frames = String(res.text).split('\n\n').filter((f) => f.startsWith('id:'));
  assert.equal(frames.length, 3, 'each replayed event must carry an id frame');
  assert.deepEqual(frames.map((f) => f.split('\n')[0]), ['id: 1', 'id: 2', 'id: 3']);
  // data payload unchanged: still the same JSON envelope on its own data: line.
  assert.equal(frames[1].split('\n')[1], 'data: {"runId":"run-1","seq":2,"ts":"t","type":"narrative_delta","data":{"text":"hola"}}');
});

test('codex stream reconnect with Last-Event-ID semantics (?afterSeq=N) does not resend events <= N', async () => {
  ownedRun = { id: 'run-1', userId: 'u-1', status: 'done' };
  scriptedEvents = [
    { runId: 'run-1', seq: 1, ts: 't', type: 'narrative_delta', data: { text: 'a' } },
    { runId: 'run-1', seq: 2, ts: 't', type: 'narrative_delta', data: { text: 'b' } },
    { runId: 'run-1', seq: 3, ts: 't', type: 'run_status', data: { status: 'done' } },
  ];
  const first = await request(codexApp()).get('/api/codex/runs/run-1/stream');
  assert.match(String(first.text), /id: 1\ndata: .*"text":"a"/);

  const resumed = await request(codexApp()).get('/api/codex/runs/run-1/stream?afterSeq=1');
  const body = String(resumed.text);
  assert.doesNotMatch(body, /"text":"a"/, 'event already delivered must not be resent');
  assert.doesNotMatch(body, /id: 1\n/, 'no id:1 frame after resume');
  assert.match(body, /id: 2\ndata: .*"text":"b"/);
  assert.match(body, /id: 3\ndata: .*"status":"done"/);
});

// ── agent-task streamTaskEvents: in-memory replay buffer wiring ───────────

let storeDir;
let router;

before(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-sse-resume-'));
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.AGENT_RATE_LIMIT_DISABLED = '1';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
  router = require('../src/routes/agent-task');
});

after(() => {
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
});

function mockRes() {
  return {
    writes: [],
    headers: {},
    writableEnded: false,
    destroyed: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    flushHeaders() {},
    setTimeout() {},
    write(chunk) { this.writes.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    on(event, handler) {
      if (!this._handlers) this._handlers = {};
      (this._handlers[String(event)] ||= []).push(handler);
      return this;
    },
    emit(event) {
      for (const h of (this._handlers?.[String(event)] || [])) h();
      return true;
    },
  };
}

function mockReq(query = {}) {
  return {
    headers: {},
    query,
    on(event, handler) {
      if (!this._handlers) this._handlers = {};
      (this._handlers[String(event)] ||= []).push(handler);
      return this;
    },
    emit(event) {
      for (const h of (this._handlers?.[String(event)] || [])) h();
      return true;
    },
  };
}

function seedTask(taskId, userId, extra = {}) {
  router.INTERNAL.ACTIVE_AGENT_TASKS.set(taskId, {
    taskId,
    userId,
    status: extra.status || 'running',
    events: extra.events || [],
    lastEventSeq: (extra.events || []).length,
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => { /* per-test cleanup handled inline */ });

test('streamTaskEvents frames every task event with a monotonic id: and buffers it for replay', () => {
  const { streamTaskEvents, ACTIVE_AGENT_TASKS, SSE_REPLAY_REGISTRY } = router.INTERNAL;
  const taskId = 'resume-task-1';
  seedTask(taskId, 'u-1', {
    events: [
      { type: 'step_start', id: 's1', label: 'Paso 1', seq: 1 },
      { type: 'final_text', markdown: 'listo', seq: 2 },
      { type: 'done', stoppedReason: 'completed', stats: { steps: 1 }, seq: 3 },
    ],
    status: 'completed',
  });

  const req = mockReq();
  const res = mockRes();
  try {
    streamTaskEvents(req, res, taskId, 'u-1');
    const joined = res.writes.join('');
    const frames = joined.split('\n\n').filter((f) => f.startsWith('id:'));
    assert.equal(frames.length, 3, '3 task events; done already terminal so no extra close frame');
    assert.deepEqual(frames.map((f) => f.split('\n')[0]), ['id: 1', 'id: 2', 'id: 3']);
    // Envelope JSON unchanged — id only added as a separate SSE field.
    assert.match(frames[1], /data: \{"type":"final_text","markdown":"listo","seq":2\}/);
    assert.ok(res.writableEnded, 'terminal status closes the stream cleanly');
    // Buffer holds what was sent so a dropped client can resume.
    const buf = SSE_REPLAY_REGISTRY.getStream(`agent-task:${taskId}`);
    assert.ok(buf, 'replay buffer entry still exists for the task');
    assert.equal(buf.snapshot().totalAppended >= 3, true);
  } finally {
    SSE_REPLAY_REGISTRY.gc();
    ACTIVE_AGENT_TASKS.delete(taskId);
  }
});

test('reconnect with Last-Event-ID replays only buffered events past the cursor and skips live duplicates', () => {
  const { streamTaskEvents, ACTIVE_AGENT_TASKS, SSE_REPLAY_REGISTRY } = router.INTERNAL;
  const taskId = 'resume-task-2';

  seedTask(taskId, 'u-1', {
    events: [
      { type: 'queue_status', status: 'running', seq: 1 },
      { type: 'step_start', id: 's1', label: 'Paso 1', seq: 2 },
      { type: 'final_text', markdown: 'resultado', seq: 3 },
      { type: 'done', stoppedReason: 'completed', stats: {}, seq: 4 },
    ],
    status: 'running',
  });

  const registry = SSE_REPLAY_REGISTRY;
  const key = `agent-task:${taskId}`;
  const buf = registry.openStream(key);
  const i1 = buf.append({ data: JSON.stringify({ type: 'queue_status', status: 'running', seq: 1 }) });
  buf.append({ data: JSON.stringify({ type: 'step_start', id: 's1', label: 'Paso 1', seq: 2 }) });
  const lastEventId = i1; // client saw only the first frame before dropping

  const req = mockReq();
  req.headers['last-event-id'] = String(lastEventId);
  const res = mockRes();
  try {
    streamTaskEvents(req, res, taskId, 'u-1');

    const joined = res.writes.join('');
    // Replay phase: everything AFTER the cursor comes from the buffer…
    assert.match(joined, /id: 2\ndata: \{"type":"step_start"/);
    assert.doesNotMatch(joined, /id: 1\n/, 'frame the client already saw is never resent');
    // …then the live poller continues and does NOT duplicate seq <= lastSeq.
    const stepStartFrames = joined.split('\n\n').filter((f) => f.includes('"type":"step_start"'));
    assert.equal(stepStartFrames.length, 1, 'step_start delivered exactly once across replay+live');
    assert.match(joined, /"type":"done"/, 'terminal done still reaches the client');
    // The snapshot is mid-run ('running') so the socket stays open for live
    // updates — resume must NOT close a still-running generation.
    assert.equal(res.writableEnded, false, 'live stream stays open after replay');
    assert.ok(!registry.getStream(key)?.isClosed?.(), 'buffer stays open while streaming live');
  } finally {
    registry.closeStream(key);
    ACTIVE_AGENT_TASKS.delete(taskId);
  }
});

test('a finished task replays from buffer and closes cleanly with the terminal event', () => {
  const { streamTaskEvents, ACTIVE_AGENT_TASKS, SSE_REPLAY_REGISTRY } = router.INTERNAL;
  const taskId = 'resume-task-3';
  const key = `agent-task:${taskId}`;
  const registry = SSE_REPLAY_REGISTRY;
  const buf = registry.openStream(key);
  buf.append({ data: JSON.stringify({ type: 'queue_status', status: 'running', seq: 1 }) });
  buf.append({ data: JSON.stringify({ type: 'final_text', markdown: 'hecho', seq: 2 }) });
  buf.append({ data: JSON.stringify({ type: 'done', stoppedReason: 'completed', stats: {} }) });

  seedTask(taskId, 'u-1', { events: [], status: 'completed' });

  const req = mockReq();
  req.query.lastEventId = '0';
  const res = mockRes();
  try {
    streamTaskEvents(req, res, taskId, 'u-1');
    const joined = res.writes.join('');
    assert.match(joined, /id: 2\ndata: [^\n]*"type":"final_text","markdown":"hecho"/);
    assert.match(joined, /"type":"done"/);
    assert.ok(res.writableEnded, 'finished task closes the stream after replay');
  } finally {
    registry.closeStream(key);
    ACTIVE_AGENT_TASKS.delete(taskId);
  }
});

test('cleanup on socket close tears down the buffer entry without breaking heartbeat timers', () => {
  const { streamTaskEvents, ACTIVE_AGENT_TASKS, SSE_REPLAY_REGISTRY } = router.INTERNAL;
  const taskId = 'resume-task-4';
  seedTask(taskId, 'u-1', { events: [], status: 'running' });

  process.env.AGENT_TASK_SSE_HEARTBEAT_MS = '5000';
  const { mock: nodeMock } = require('node:test');
  nodeMock.timers.enable({ apis: ['setInterval'] });
  const req = mockReq();
  const res = mockRes();
  try {
    streamTaskEvents(req, res, taskId, 'u-1');
    const key = `agent-task:${taskId}`;
    assert.ok(SSE_REPLAY_REGISTRY.getStream(key), 'buffer open while connected');

    // Heartbeat keeps flowing while connected.
    nodeMock.timers.tick(6000);
    assert.match(res.writes.join('').slice(-200), /"type":"heartbeat"/);

    // Client drops mid-generation → close handler runs cleanup.
    res.emit('close');
    assert.ok(res.writableEnded, 'connection ended on close');
    const snap = SSE_REPLAY_REGISTRY.getStream(key)?.snapshot();
    assert.ok(!snap || snap.closed, 'buffer closed after client disconnect (gc can reclaim it)');
    assert.equal(SSE_REPLAY_REGISTRY.snapshot().open, 0, 'no open buffers leak');

    const writesAfterClose = res.writes.length;
    nodeMock.timers.tick(12000);
    assert.equal(res.writes.length, writesAfterClose, 'heartbeat stops writing after close');
  } finally {
    nodeMock.timers.reset();
    delete process.env.AGENT_TASK_SSE_HEARTBEAT_MS;
    SSE_REPLAY_REGISTRY.closeStream(`agent-task:${taskId}`);
    SSE_REPLAY_REGISTRY.gc();
    ACTIVE_AGENT_TASKS.delete(taskId);
  }
});
