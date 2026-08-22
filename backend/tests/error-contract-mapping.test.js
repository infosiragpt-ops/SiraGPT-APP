const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyKnownError,
  errorToResponse,
  globalErrorHandler,
  isClientAbortError,
  normalizeErrorBody,
} = require('../src/middleware/error-handler');
const { CircuitBreakerError } = require('../src/services/circuit-breaker');
const {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
  InternalServerError,
} = require('openai');

function makeLogger(events) {
  return {
    info(payload, message) {
      events.push({ level: 'info', payload, message });
    },
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

  return { req, res, events, logger };
}

function makeOpenAiHeaders(retryAfter) {
  const headers = new Headers();
  if (retryAfter != null) headers.set('retry-after', String(retryAfter));
  return headers;
}

describe('error contract mapping — circuit breaker', () => {
  test('CircuitBreakerError maps to 503 provider_unavailable without breaker internals in body', () => {
    const { req, res, events, logger } = createReqRes();
    const err = new CircuitBreakerError('openai:gpt-4o-secret-tier', 'OPEN', new Date(Date.now() + 30_000));
    const handler = globalErrorHandler({ logger, stdout: () => {} });
    handler(err, req, res, () => {});

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'provider_unavailable');
    assert.equal(res.body.error, 'Service unavailable');
    assert.match(res.body.message, /proveedor de IA/i);
    assert.ok(!JSON.stringify(res.body).includes('gpt-4o-secret-tier'));
    assert.ok(!JSON.stringify(res.body).includes('breakerName'));
    assert.ok(!JSON.stringify(res.body).includes('Next attempt'));
    assert.ok(!res.body.stack);
    // internals stay available to operators through the log
    assert.equal(events[0].level, 'error');
    assert.equal(events[0].payload.err.breakerName, 'openai:gpt-4o-secret-tier');
  });

  test('CircuitBreakerError surfaces Retry-After derived from nextAttemptAt', () => {
    const { req, res } = createReqRes();
    const err = new CircuitBreakerError('openai:gpt-4o', 'OPEN', new Date(Date.now() + 30_000));
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});

    assert.equal(res.statusCode, 503);
    const retryAfter = Number(res.headers['retry-after']);
    assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 30);
  });
});

describe('error contract mapping — openai SDK', () => {
  test('provider 500 InternalServerError maps to 503 ai_provider_unavailable with generic message', () => {
    const err = new InternalServerError(500, { message: 'The server had an error while processing your request' }, null, makeOpenAiHeaders());
    const classified = classifyKnownError(err);

    assert.equal(classified.overrideStatus, 503);
    assert.equal(classified.clientCode, 'ai_provider_unavailable');
    assert.ok(!classified.message.includes('The server had an error'));

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'ai_provider_unavailable');
    assert.ok(!JSON.stringify(res.body).includes('The server had an error'));
  });

  test('provider AuthenticationError never becomes 401 and hides provider message', () => {
    const err = new AuthenticationError(401, { message: 'Incorrect API key provided: sk-proj-***' }, null, makeOpenAiHeaders());
    const classified = classifyKnownError(err);

    assert.equal(classified.overrideStatus, 503);

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.notEqual(res.statusCode, 401);
    assert.equal(res.body.code, 'ai_provider_misconfigured');
    assert.ok(!JSON.stringify(res.body).includes('sk-proj'));
    assert.ok(!JSON.stringify(res.body).includes('Incorrect API key'));
  });

  test('provider RateLimitError maps to 429 rate_limited with Retry-After from provider header', () => {
    const err = new RateLimitError(429, { message: 'Rate limit reached for requests' }, null, makeOpenAiHeaders(7));
    const classified = classifyKnownError(err);
    assert.equal(classified.overrideStatus, 429);
    assert.equal(classified.clientCode, 'rate_limited');
    assert.equal(classified.retryAfterSeconds, 7);

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'rate_limited');
    assert.equal(res.headers['retry-after'], '7');
  });

  test('APIConnectionError and timeout map to 503 ai_provider_unavailable', () => {
    for (const err of [new APIConnectionError({ message: 'Connection error.' }), new APIConnectionTimeoutError()]) {
      const classified = classifyKnownError(err);
      assert.equal(classified.overrideStatus, 503);
      assert.equal(classified.clientCode, 'ai_provider_unavailable');
    }
  });

  test('plain APIError instances (openai v5 leaves name as Error) are still recognized', () => {
    const err = new APIError(502, { message: 'Bad gateway from provider' }, null, makeOpenAiHeaders());
    assert.equal(err.name, 'Error');
    const classified = classifyKnownError(err);
    assert.equal(classified.overrideStatus, 503);
    assert.equal(classified.clientCode, 'ai_provider_unavailable');
  });

  test('openai 4xx other than auth (e.g. invalid request payload) is not masked as provider outage', () => {
    const err = new APIError(400, { message: 'we could not parse the request body' }, null, makeOpenAiHeaders());
    const classified = classifyKnownError(err);
    assert.equal(classified, null);
    assert.equal(err.status, 400);

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 400);
  });
});

describe('error contract mapping — axios upstreams', () => {
  function makeAxiosError({ code, response }) {
    return {
      name: 'AxiosError',
      isAxiosError: true,
      code,
      message: `connect ${code} 10.0.0.12:8080`,
      response,
      config: {},
    };
  }

  test('network failure (ECONNREFUSED, no response) maps to 503 upstream_unavailable', () => {
    const err = makeAxiosError({ code: 'ECONNREFUSED', response: undefined });
    const classified = classifyKnownError(err);

    assert.equal(classified.overrideStatus, 503);
    assert.equal(classified.clientCode, 'upstream_unavailable');

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'upstream_unavailable');
    assert.ok(!JSON.stringify(res.body).includes('ECONNREFUSED'));
    assert.ok(!JSON.stringify(res.body).includes('10.0.0.12'));
  });

  test('upstream 5xx maps to 503 and hides upstream body text', () => {
    const err = makeAxiosError({
      code: undefined,
      response: { status: 502, data: { error: 'nginx: internal dns resolution failed' }, headers: {} },
    });
    const classified = classifyKnownError(err);
    assert.equal(classified.overrideStatus, 503);
    assert.equal(classified.clientCode, 'upstream_unavailable');

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.ok(!JSON.stringify(res.body).includes('nginx'));
  });

  test('upstream 429 maps to 429 rate_limited honoring upstream Retry-After', () => {
    const err = makeAxiosError({
      code: undefined,
      response: { status: 429, data: {}, headers: { 'retry-after': '4' } },
    });
    const classified = classifyKnownError(err);
    assert.equal(classified.overrideStatus, 429);
    assert.equal(classified.clientCode, 'rate_limited');
    assert.equal(classified.retryAfterSeconds, 4);

    const { req, res } = createReqRes();
    const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '4');
  });

  test('upstream 4xx validation responses are left untouched (no masking)', () => {
    const err = makeAxiosError({
      code: undefined,
      response: { status: 422, data: {}, headers: {} },
    });
    assert.equal(classifyKnownError(err), null);
  });
});

describe('error contract — no leaks in generic 5xx bodies', () => {
  test('unmapped 5xx never includes stack even when exposeStack is requested', () => {
    const { req } = createReqRes();
    const err = new Error('connect ECONNREFUSED db.internal:5432 at /srv/app/secret-path');
    err.stack = `${err.stack}\n    at secretModule (/srv/app/internal/keys.js:1:1)`;
    const { statusCode, body } = errorToResponse(err, req, { exposeStack: true });

    assert.equal(statusCode, 500);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('stack'));
    assert.ok(!serialized.includes('db.internal'));
    assert.ok(!serialized.includes('/srv/app'));
    assert.ok(!serialized.includes('secretModule'));
  });

  test('normalizeErrorBody masks caller-supplied messages on 5xx but keeps them on 4xx', () => {
    const masked = normalizeErrorBody(
      { error: 'boom_failed', message: 'prisma engine crashed with exit code 101' },
      { statusCode: 500, requestId: 'req-x' },
    );
    assert.equal(masked.ok, false);
    assert.equal(masked.message, 'Internal server error');
    assert.equal(masked.error, 'Internal server error');

    const kept = normalizeErrorBody(
      { error: 'invalid_request', message: 'amount must be positive' },
      { statusCode: 400, requestId: 'req-y' },
    );
    assert.equal(kept.message, 'amount must be positive');
  });

  test('generic production 500 carries only the stable generic phrase', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { req, res } = createReqRes();
      const handler = globalErrorHandler({ logger: makeLogger([]), stdout: () => {} });
      const err = new Error('AWS_SECRET_ACCESS_KEY=wifk... failed at s3.putObject');
      handler(err, req, res, () => {});

      assert.equal(res.statusCode, 500);
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes('AWS_SECRET'));
      assert.ok(!serialized.includes('s3.putObject'));
      assert.equal(res.body.stack, undefined);
    } finally {
      if (previousNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

describe('error contract — client aborts are not server errors', () => {
  function makeAbortError() {
    const err = new Error('Client disconnected');
    err.name = 'AbortError';
    return err;
  }

  test('AbortError logs at info level and sends no response', () => {
    const { req, res, events } = createReqRes();
    let nextCalled = false;
    const handler = globalErrorHandler({ logger: makeLogger(events), stdout: () => {} });
    handler(makeAbortError(), req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.body, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].level, 'info');
    assert.equal(events[0].message, 'request_client_disconnected');
    assert.equal(events[0].payload.clientDisconnected, true);
  });

  test('ABORT_ERR coded errors count as client aborts; real failures do not', () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.code = 'ABORT_ERR';
    assert.equal(isClientAbortError(abortErr), true);
    assert.equal(isClientAbortError(new Error('real boom')), false);
    assert.equal(isClientAbortError(null), false);
  });
});
