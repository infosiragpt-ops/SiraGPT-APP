/**
 * sse-heartbeat — pins the interval contract + auto-cancellation.
 * Real timers would make this test slow + flaky; we inject fake
 * setInterval / clearInterval and a `now` clock to exercise every
 * branch deterministically.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  startSSEHeartbeat,
  resolveInterval,
  HEARTBEAT_PAYLOAD,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} = require("../src/utils/sse-heartbeat");

function fakeRes({ writableEnded = false, destroyed = false, throwOnWrite = false } = {}) {
  const writes = [];
  const ee = new EventEmitter();
  return Object.assign(ee, {
    writableEnded,
    destroyed,
    write(chunk) {
      if (throwOnWrite) throw new Error('socket severed');
      writes.push(chunk);
      return true;
    },
    _writes: () => writes,
  });
}

function makeFakeTimers() {
  const tasks = new Map();
  let nextId = 1;
  return {
    setIntervalFn(fn, ms) {
      const id = nextId++;
      tasks.set(id, { fn, ms });
      return id;
    },
    clearIntervalFn(id) { tasks.delete(id); },
    tick(id) {
      const task = tasks.get(id);
      if (task) task.fn();
    },
    isActive(id) { return tasks.has(id); },
    activeCount() { return tasks.size; },
  };
}

describe("resolveInterval", () => {
  test("default when no override", () => {
    assert.equal(resolveInterval({}, {}), DEFAULT_INTERVAL_MS);
  });

  test("explicit option wins over env", () => {
    assert.equal(resolveInterval({ intervalMs: 5000 }, { SSE_HEARTBEAT_INTERVAL_MS: '99' }), 5000);
  });

  test("env honored when option absent", () => {
    assert.equal(resolveInterval({}, { SSE_HEARTBEAT_INTERVAL_MS: '12000' }), 12000);
  });

  test("clamps below MIN_INTERVAL_MS", () => {
    assert.equal(resolveInterval({ intervalMs: 100 }, {}), MIN_INTERVAL_MS);
  });

  test("clamps above MAX_INTERVAL_MS", () => {
    assert.equal(resolveInterval({ intervalMs: 10 * 60_000 }, {}), MAX_INTERVAL_MS);
  });

  test("non-numeric env falls back to default", () => {
    assert.equal(resolveInterval({}, { SSE_HEARTBEAT_INTERVAL_MS: 'soon' }), DEFAULT_INTERVAL_MS);
  });
});

describe("startSSEHeartbeat — emission", () => {
  test("each tick writes the keepalive payload", () => {
    const timers = makeFakeTimers();
    const res = fakeRes();
    const handle = startSSEHeartbeat(res, {
      intervalMs: 25_000,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    // Three ticks → three writes.
    timers.tick(1);
    timers.tick(1);
    timers.tick(1);
    assert.deepEqual(res._writes(), [HEARTBEAT_PAYLOAD, HEARTBEAT_PAYLOAD, HEARTBEAT_PAYLOAD]);
    handle();
  });

  test("returns a cancel() that stops further ticks", () => {
    const timers = makeFakeTimers();
    const res = fakeRes();
    const cancel = startSSEHeartbeat(res, {
      intervalMs: 1000,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    timers.tick(1);
    cancel();
    assert.equal(timers.isActive(1), false);
  });

  test("idempotent cancel — calling twice is safe", () => {
    const timers = makeFakeTimers();
    const cancel = startSSEHeartbeat(fakeRes(), {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    cancel();
    cancel(); // must not throw or double-clear
  });
});

describe("startSSEHeartbeat — auto-cancellation", () => {
  test("res.on('close') triggers cancel", () => {
    const timers = makeFakeTimers();
    const res = fakeRes();
    startSSEHeartbeat(res, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    res.emit('close');
    assert.equal(timers.isActive(1), false);
  });

  test("res.on('finish') triggers cancel", () => {
    const timers = makeFakeTimers();
    const res = fakeRes();
    startSSEHeartbeat(res, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    res.emit('finish');
    assert.equal(timers.isActive(1), false);
  });

  test("a tick after writableEnded:true cancels itself", () => {
    const timers = makeFakeTimers();
    const res = fakeRes();
    startSSEHeartbeat(res, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    res.writableEnded = true;
    timers.tick(1);
    assert.equal(timers.isActive(1), false);
    assert.deepEqual(res._writes(), []);
  });

  test("write() throwing cancels the heartbeat (socket severed)", () => {
    const timers = makeFakeTimers();
    const res = fakeRes({ throwOnWrite: true });
    startSSEHeartbeat(res, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    timers.tick(1); // throws inside, swallowed
    assert.equal(timers.isActive(1), false);
  });
});

describe("startSSEHeartbeat — shouldEmit guard", () => {
  test("shouldEmit returning false suppresses the write but keeps the timer", () => {
    const timers = makeFakeTimers();
    const res = fakeRes();
    let calls = 0;
    startSSEHeartbeat(res, {
      shouldEmit: () => { calls += 1; return false; },
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    timers.tick(1);
    timers.tick(1);
    assert.equal(calls, 2);
    assert.deepEqual(res._writes(), []);
    assert.equal(timers.isActive(1), true);
  });
});

describe("startSSEHeartbeat — defensive against bad input", () => {
  test("null res returns a noop cancel", () => {
    const cancel = startSSEHeartbeat(null);
    assert.equal(typeof cancel, 'function');
    cancel(); // must not throw
  });

  test("res without write() returns a noop cancel", () => {
    const cancel = startSSEHeartbeat({});
    assert.equal(typeof cancel, 'function');
    cancel();
  });
});
