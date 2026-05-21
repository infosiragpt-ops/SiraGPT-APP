const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { HEADER, getRequestId, requestIdMiddleware } = require('../src/middleware/request-id');
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
});
