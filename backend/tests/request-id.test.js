const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HEADER,
  MAX_REQUEST_ID_LENGTH,
  getRequestId,
  normalizeRequestId,
  requestIdMiddleware,
} = require('../src/middleware/request-id');
const { currentContext } = require('../src/utils/logger');

function makeRes() {
  const headers = {};
  return {
    locals: undefined,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
  };
}

describe('requestIdMiddleware', () => {
  test('pins req.id onto req.requestId, res.locals, and the response header', () => {
    const req = { id: 123, headers: {} };
    const res = makeRes();
    let nextCalled = false;

    requestIdMiddleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.requestId, '123');
    assert.deepEqual(res.locals, { requestId: '123' });
    assert.equal(res.getHeader(HEADER), '123');
  });

  test('falls back to x-request-id header when req.id is absent', () => {
    const req = { headers: { 'x-request-id': 'upstream-1' } };
    const res = makeRes();

    requestIdMiddleware(req, res, () => {});

    assert.equal(req.requestId, 'upstream-1');
    assert.equal(res.locals.requestId, 'upstream-1');
    assert.equal(res.getHeader(HEADER), 'upstream-1');
  });

  test('ignores unsafe x-request-id header values instead of echoing them', () => {
    const req = { headers: { 'x-request-id': 'bad\r\nx-owned: 1' } };
    const res = makeRes();

    assert.doesNotThrow(() => requestIdMiddleware(req, res, () => {}));
    assert.equal(req.requestId, undefined);
    assert.equal(res.locals, undefined);
    assert.equal(res.getHeader(HEADER), undefined);
  });

  test('falls back to a safe header when req.id is unsafe', () => {
    const req = { id: 'bad id with spaces', headers: { 'x-request-id': 'safe-upstream-2' } };
    const res = makeRes();

    requestIdMiddleware(req, res, () => {});

    assert.equal(req.requestId, 'safe-upstream-2');
    assert.equal(res.getHeader(HEADER), 'safe-upstream-2');
  });

  test('does not set request id fields when no id source exists', () => {
    const req = { headers: {} };
    const res = makeRes();

    requestIdMiddleware(req, res, () => {});

    assert.equal(req.requestId, undefined);
    assert.equal(res.locals, undefined);
    assert.equal(res.getHeader(HEADER), undefined);
  });

  test('binds the request id into the logger AsyncLocalStorage context', () => {
    const req = { id: 'req-als-1', headers: {} };
    const res = makeRes();
    let seen;

    requestIdMiddleware(req, res, () => {
      seen = currentContext();
    });

    assert.equal(seen.reqId, 'req-als-1');
    assert.equal(seen.requestId, 'req-als-1');
    assert.equal(seen.request_id, 'req-als-1');
    assert.equal(currentContext(), null);
  });

  test('preserves the logger context across async work scheduled downstream', async () => {
    const req = { id: 'req-als-async', headers: {} };
    const res = makeRes();
    let seen;

    await new Promise((resolve) => {
      requestIdMiddleware(req, res, () => {
        setImmediate(() => {
          seen = currentContext();
          resolve();
        });
      });
    });

    assert.equal(seen.reqId, 'req-als-async');
    assert.equal(seen.requestId, 'req-als-async');
  });
});

describe('getRequestId', () => {
  test('prefers req.requestId before req.id and raw header', () => {
    assert.equal(
      getRequestId({ requestId: 'canonical', id: 'pino', headers: { 'x-request-id': 'raw' } }),
      'canonical'
    );
  });

  test('falls back to req.id and raw x-request-id header', () => {
    assert.equal(getRequestId({ id: 321, headers: { 'x-request-id': 'raw' } }), '321');
    assert.equal(getRequestId({ headers: { 'x-request-id': 'raw' } }), 'raw');
  });

  test('returns null when the request is missing or has no id', () => {
    assert.equal(getRequestId(null), null);
    assert.equal(getRequestId({ headers: {} }), null);
  });

  test('normalizes request id candidates', () => {
    assert.equal(normalizeRequestId(' trace_123:/+=@-~. '), 'trace_123:/+=@-~.');
    assert.equal(normalizeRequestId(['first-safe', 'second-safe']), 'first-safe');
    assert.equal(normalizeRequestId('bad id'), null);
    assert.equal(normalizeRequestId('bad\r\nid'), null);
    assert.equal(normalizeRequestId('x'.repeat(MAX_REQUEST_ID_LENGTH + 1)), null);
  });

  test('getRequestId skips unsafe candidates in priority order', () => {
    assert.equal(
      getRequestId({
        requestId: 'bad id',
        id: 'safe-id',
        headers: { 'x-request-id': 'safe-header' },
      }),
      'safe-id',
    );
    assert.equal(
      getRequestId({ headers: { 'x-request-id': 'bad\r\nid' } }),
      null,
    );
  });
});
