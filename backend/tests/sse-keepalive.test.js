'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createSseKeepalive } = require('../src/services/ai-product-os/sse-keepalive');

function later(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('createSseKeepalive — construction', () => {
  test('rejects missing write fn', () => {
    assert.throws(() => createSseKeepalive({}), TypeError);
  });

  test('exposes config in snapshot', () => {
    const k = createSseKeepalive({ write: () => {}, intervalMs: 5000, comment: 'hb' });
    const s = k.snapshot();
    assert.equal(s.intervalMs, 5000);
    assert.equal(s.comment, 'hb');
    assert.equal(s.heartbeatCount, 0);
    k.close();
  });
});

describe('createSseKeepalive — heartbeat fires', () => {
  test('after intervalMs of inactivity, heartbeat is sent', async () => {
    const writes = [];
    const k = createSseKeepalive({
      write: (s) => writes.push(s),
      intervalMs: 30,
    });
    await later(80);
    assert.ok(writes.length >= 1);
    assert.match(writes[0], /^: ping\n\n$/);
    k.close();
  });

  test('uses custom comment', async () => {
    const writes = [];
    const k = createSseKeepalive({
      write: (s) => writes.push(s),
      intervalMs: 20,
      comment: 'sira-ping',
    });
    await later(50);
    assert.match(writes[0], /^: sira-ping\n\n$/);
    k.close();
  });

  test('onHeartbeat sink fires with count', async () => {
    const events = [];
    const k = createSseKeepalive({
      write: () => {},
      intervalMs: 20,
      onHeartbeat: (e) => events.push(e),
    });
    await later(80);
    assert.ok(events.length >= 1);
    assert.equal(events[0].count, 1);
    k.close();
  });
});

describe('createSseKeepalive — noteWrite resets the timer', () => {
  test('repeated noteWrite suppresses heartbeats', async () => {
    let count = 0;
    const k = createSseKeepalive({
      write: () => count++,
      intervalMs: 40,
    });
    for (let i = 0; i < 5; i++) {
      await later(20); // < interval
      k.noteWrite();
    }
    assert.equal(count, 0, `unexpected heartbeats: ${count}`);
    k.close();
  });
});

describe('createSseKeepalive — flush', () => {
  test('flush sends a heartbeat immediately', () => {
    const writes = [];
    const k = createSseKeepalive({
      write: (s) => writes.push(s),
      intervalMs: 60_000,
    });
    k.flush();
    assert.equal(writes.length, 1);
    k.close();
  });
});

describe('createSseKeepalive — close', () => {
  test('close stops further heartbeats', async () => {
    let count = 0;
    const k = createSseKeepalive({
      write: () => count++,
      intervalMs: 20,
    });
    k.close();
    await later(80);
    assert.equal(count, 0);
  });

  test('noteWrite after close is a no-op', () => {
    const k = createSseKeepalive({ write: () => {}, intervalMs: 10 });
    k.close();
    k.noteWrite();
    assert.equal(k.snapshot().closed, true);
  });
});

describe('createSseKeepalive — error isolation', () => {
  test('throwing write surfaces via onError, scheduler keeps going', async () => {
    const errs = [];
    let attempts = 0;
    const k = createSseKeepalive({
      write: () => { attempts++; throw new Error('socket closed'); },
      intervalMs: 20,
      onError: (e) => errs.push(e.message),
    });
    await later(80);
    assert.ok(errs.length >= 1);
    assert.equal(errs[0], 'socket closed');
    assert.ok(attempts >= 1);
    k.close();
  });

  test('throwing onHeartbeat is swallowed', async () => {
    const k = createSseKeepalive({
      write: () => {},
      intervalMs: 20,
      onHeartbeat: () => { throw new Error('sink bad'); },
    });
    await later(60); // must not crash
    k.close();
  });
});
