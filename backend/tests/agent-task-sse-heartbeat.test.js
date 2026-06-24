'use strict';

const { test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * SSE heartbeat hardening for the queued/local agent-task stream.
 *
 * Symptom this guards against: a "búscame 2 artículos científicos" turn sat
 * on "Analizando solicitud · 0 pasos · 0 herramientas" and then failed with
 * "El asistente no envió actualizaciones por 90 s." — the client's idle
 * watchdog (lib/agent-task-service.ts, 90s) fired because the worker's long
 * planning / first-LLM-call phase produced no SSE bytes the client received.
 *
 * The fix makes streamTaskEvents emit a real `data:` heartbeat frame (not
 * just a bare `: keep-alive` comment, which edge proxies buffer/drop) at a
 * sub-90s interval. The client reducer ignores unknown `heartbeat` events,
 * and its idle timer resets on every received chunk.
 */

let storeDir;
let router;

before(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-hb-'));
  process.env.AGENT_TASK_STORE_DIR = storeDir;
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
    on() { return this; },
  };
}

function mockReq() {
  return { on() { return this; } };
}

test('streamTaskEvents emits a data: heartbeat frame at a sub-90s interval', () => {
  const { streamTaskEvents, ACTIVE_AGENT_TASKS } = router.INTERNAL;
  const taskId = 'hb-task-1';
  const userId = 'hb-user-1';
  process.env.AGENT_TASK_SSE_HEARTBEAT_MS = '5000';

  ACTIVE_AGENT_TASKS.set(taskId, {
    taskId,
    userId,
    status: 'running',
    events: [{ type: 'queue_status', status: 'running', seq: 1, id: `${taskId}:1` }],
    lastEventSeq: 1,
    updatedAt: new Date().toISOString(),
  });

  const req = mockReq();
  const res = mockRes();

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    streamTaskEvents(req, res, taskId, userId);

    // The initial synchronous flush streams the queued event as a real
    // data: frame — proves functional events flow before any heartbeat.
    assert.ok(res.writes.join('').includes('queue_status'), 'initial flush should emit queue_status');

    // Before the heartbeat interval elapses, no heartbeat frame yet.
    mock.timers.tick(1000);
    assert.ok(!res.writes.join('').includes('"type":"heartbeat"'), 'no heartbeat before its interval');

    // Cross the 5s heartbeat boundary.
    mock.timers.tick(5000);
    const joined = res.writes.join('');
    assert.match(joined, /data: \{"type":"heartbeat"/, 'must emit a data: heartbeat frame that survives edge proxies');
    assert.match(joined, /: keep-alive/, 'should also keep the legacy comment heartbeat for raw sockets');
  } finally {
    mock.timers.reset();
    ACTIVE_AGENT_TASKS.delete(taskId);
    delete process.env.AGENT_TASK_SSE_HEARTBEAT_MS;
  }
});

test('heartbeat stops once the client disconnects (no write after close)', () => {
  const { streamTaskEvents, ACTIVE_AGENT_TASKS } = router.INTERNAL;
  const taskId = 'hb-task-2';
  const userId = 'hb-user-2';
  process.env.AGENT_TASK_SSE_HEARTBEAT_MS = '5000';

  ACTIVE_AGENT_TASKS.set(taskId, {
    taskId,
    userId,
    status: 'running',
    events: [{ type: 'queue_status', status: 'running', seq: 1, id: `${taskId}:1` }],
    lastEventSeq: 1,
    updatedAt: new Date().toISOString(),
  });

  const req = mockReq();
  const res = mockRes();

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    streamTaskEvents(req, res, taskId, userId);
    // Simulate the socket being torn down.
    res.writableEnded = true;
    res.destroyed = true;
    const countBefore = res.writes.length;
    mock.timers.tick(12000);
    assert.equal(res.writes.length, countBefore, 'no heartbeat writes after the socket is closed');
  } finally {
    mock.timers.reset();
    ACTIVE_AGENT_TASKS.delete(taskId);
    delete process.env.AGENT_TASK_SSE_HEARTBEAT_MS;
  }
});
