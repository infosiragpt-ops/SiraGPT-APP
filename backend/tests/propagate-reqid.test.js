'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { AsyncLocalStorage } = require('node:async_hooks');

const {
  HEADER_NAME,
  currentRequestId,
  propagatedInit,
  propagatedFetch,
} = require('../src/utils/propagate-reqid');
const logger = require('../src/utils/logger');

describe('propagate-reqid', () => {
  test('currentRequestId returns null when no context bound', () => {
    assert.equal(currentRequestId(), null);
  });

  test('currentRequestId reads reqId from logger ALS', () => {
    logger.runWithContext({ reqId: 'abc-123' }, () => {
      assert.equal(currentRequestId(), 'abc-123');
    });
  });

  test('propagatedInit injects X-Request-ID from ALS into plain headers object', () => {
    logger.runWithContext({ reqId: 'req-xyz' }, () => {
      const init = propagatedInit({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
      assert.equal(init.headers[HEADER_NAME], 'req-xyz');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.equal(init.method, 'POST');
    });
  });

  test('propagatedInit works with no init at all', () => {
    logger.runWithContext({ reqId: 'req-bare' }, () => {
      const init = propagatedInit();
      assert.equal(init.headers[HEADER_NAME], 'req-bare');
    });
  });

  test('propagatedInit leaves init unchanged when no id available', () => {
    const init = { headers: { A: 'B' } };
    const out = propagatedInit(init);
    assert.equal(out.headers[HEADER_NAME], undefined);
  });

  test('propagatedInit never overwrites caller-supplied X-Request-ID', () => {
    logger.runWithContext({ reqId: 'ambient' }, () => {
      const init = propagatedInit({ headers: { 'X-Request-ID': 'forced' } });
      assert.equal(init.headers['X-Request-ID'], 'forced');
    });
  });

  test('propagatedInit handles Headers-like .set/.has interface', () => {
    const headers = new Map();
    headers.set = headers.set.bind(headers);
    headers.has = (k) => Map.prototype.has.call(headers, k);
    logger.runWithContext({ reqId: 'map-id' }, () => {
      const init = propagatedInit({ headers });
      assert.equal(init.headers.get('X-Request-ID'), 'map-id');
    });
  });

  test('explicit opts.requestId overrides ALS', () => {
    logger.runWithContext({ reqId: 'ambient' }, () => {
      const init = propagatedInit({}, { requestId: 'explicit' });
      assert.equal(init.headers[HEADER_NAME], 'explicit');
    });
  });

  test('propagatedFetch calls underlying fetchImpl with merged headers', async () => {
    let captured;
    const fakeFetch = (url, init) => {
      captured = { url, init };
      return Promise.resolve({ ok: true });
    };
    await logger.runWithContext({ reqId: 'fetch-id' }, async () => {
      await propagatedFetch('https://example.invalid/foo', { method: 'GET' }, fakeFetch);
    });
    assert.equal(captured.url, 'https://example.invalid/foo');
    assert.equal(captured.init.headers[HEADER_NAME], 'fetch-id');
  });

  test('propagatedFetch throws when no fetch impl available', () => {
    const saved = globalThis.fetch;
    // eslint-disable-next-line no-global-assign
    globalThis.fetch = undefined;
    try {
      assert.throws(() => propagatedFetch('https://x', {}, null), /no fetch implementation/);
    } finally {
      globalThis.fetch = saved;
    }
  });

  test('falls back to requestId / request_id ALS keys', () => {
    const altLogger = require('../src/utils/logger');
    altLogger.runWithContext({ requestId: 'alt-1' }, () => {
      assert.equal(currentRequestId(), 'alt-1');
    });
    altLogger.runWithContext({ request_id: 'alt-2' }, () => {
      assert.equal(currentRequestId(), 'alt-2');
    });
  });
});

// Avoid unused-import warning on Node ALS reference.
void AsyncLocalStorage;
