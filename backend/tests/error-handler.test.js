const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHttpError,
  globalErrorHandler,
  notFoundHandler,
  standardizeErrorResponses,
} = require('../src/middleware/error-handler');

function makeLogger(events) {
  return {
    warn(payload, message) {
      events.push({ level: 'warn', payload, message });
    },
    error(payload, message) {
      events.push({ level: 'error', payload, message });
    },
  };
}

function createReqRes({ method = 'GET', url = '/test', requestId = 'test-request-id' } = {}) {
  const events = [];
  const captured = [];
  const logger = makeLogger(events);

  const req = {
    method,
    url,
    originalUrl: url,
    headers: { 'x-request-id': requestId },
    id: requestId,
    requestId,
    log: logger,
  };
  const res = {
    statusCode: 200,
    locals: {},
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  return { req, res, events, captured, logger };
}

function installStandardizer(req, res) {
  let nextCalled = false;
  standardizeErrorResponses()(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
}

describe('common API error handling', () => {
  test('standardizes validation responses and strips rejected input values', async () => {
    const { req, res, events } = createReqRes({ requestId: 'req-validation' });
    installStandardizer(req, res);

    res.status(400).json({
      errors: [
        {
          type: 'field',
          location: 'body',
          path: 'password',
          value: 'secret-value',
          msg: 'must be at least 8 chars',
        },
      ],
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Validation failed');
    assert.equal(res.body.message, 'password: must be at least 8 chars');
    assert.equal(res.body.requestId, 'req-validation');
    assert.equal(res.body.errors[0].value, undefined);
    assert.equal(events[0].level, 'warn');
    assert.equal(events[0].message, 'http_error_response');
  });

  test('returns structured 404 responses', async () => {
    const { req, res } = createReqRes({ url: '/missing-route' });
    installStandardizer(req, res);
    notFoundHandler(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Route not found');
    assert.equal(res.body.code, 'route_not_found');
    assert.equal(res.body.requestId, 'test-request-id');
  });

  test('preserves explicit HTTP error code and details', async () => {
    const { req, res, logger, captured } = createReqRes();
    const handler = globalErrorHandler({
      logger,
      captureException(error, context) {
        captured.push({ error, context });
      },
    });
    handler(createHttpError(409, 'Resource already exists', {
      code: 'resource_conflict',
      details: { resource: 'project' },
      expose: true,
    }), req, res, () => {});

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Resource already exists');
    assert.equal(res.body.message, 'Resource already exists');
    assert.equal(res.body.code, 'resource_conflict');
    assert.deepEqual(res.body.details, { resource: 'project' });
    assert.equal(captured.length, 1);
  });

  test('masks unexpected 500 errors in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { req, res, logger } = createReqRes();
      const handler = globalErrorHandler({ logger });
      handler(new Error('database password leaked in stack'), req, res, () => {});

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, 'Internal server error');
      assert.equal(res.body.message, 'Internal server error');
      assert.equal(res.body.stack, undefined);
    } finally {
      if (previousNodeEnv == null) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});
