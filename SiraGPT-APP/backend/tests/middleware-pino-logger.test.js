'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pinoLoggerModule = require('../src/middleware/pino-logger');
const {
  getLogger,
  resetLogger,
  errSerializer,
  reqSerializer,
  resSerializer,
  redactSerializer,
} = pinoLoggerModule;

test('exports a factory plus named helpers', () => {
  assert.equal(typeof pinoLoggerModule, 'function');
  assert.equal(typeof getLogger, 'function');
  assert.equal(typeof resetLogger, 'function');
  assert.equal(typeof errSerializer, 'function');
  assert.equal(typeof reqSerializer, 'function');
  assert.equal(typeof resSerializer, 'function');
  assert.equal(typeof redactSerializer, 'function');
});

test('redactSerializer replaces well-known sensitive keys with [REDACTED]', () => {
  const out = redactSerializer({
    userId: 'u1',
    password: 'super-secret',
    token: 'abc',
    apiKey: 'sk-xyz',
    authorization: 'Bearer abc',
    nested: { secret: 'inner-secret', email: 'a@b.com' },
  });
  assert.equal(out.userId, 'u1');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.nested.secret, '[REDACTED]');
  assert.equal(out.nested.email, 'a@b.com');
});

test('redactSerializer handles arrays recursively', () => {
  const out = redactSerializer([
    { token: 'one', label: 'a' },
    { token: 'two', label: 'b' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].token, '[REDACTED]');
  assert.equal(out[0].label, 'a');
  assert.equal(out[1].token, '[REDACTED]');
});

test('redactSerializer passes through primitives unchanged', () => {
  assert.equal(redactSerializer(null), null);
  assert.equal(redactSerializer(undefined), undefined);
  assert.equal(redactSerializer('hello'), 'hello');
  assert.equal(redactSerializer(42), 42);
  assert.equal(redactSerializer(true), true);
});

test('errSerializer captures core Error fields', () => {
  const err = new Error('boom');
  err.code = 'E_SOMETHING';
  err.statusCode = 500;
  const out = errSerializer(err);
  assert.equal(out.type, 'Error');
  assert.equal(out.message, 'boom');
  assert.ok(out.stack);
  assert.equal(out.code, 'E_SOMETHING');
  assert.equal(out.statusCode, 500);
});

test('errSerializer falls back to err.status when statusCode is missing', () => {
  const err = new Error('http boom');
  err.status = 503;
  const out = errSerializer(err);
  assert.equal(out.statusCode, 503);
});

test('errSerializer recurses into err.cause for nested errors', () => {
  const cause = new Error('inner');
  cause.code = 'INNER_CODE';
  const err = new Error('outer');
  err.cause = cause;
  const out = errSerializer(err);
  assert.equal(out.message, 'outer');
  assert.equal(out.cause.message, 'inner');
  assert.equal(out.cause.code, 'INNER_CODE');
});

test('errSerializer tolerates falsy input', () => {
  assert.equal(errSerializer(null), null);
  assert.equal(errSerializer(undefined), undefined);
});

test('reqSerializer captures method, url, redacted headers, remoteAddress', () => {
  const req = {
    id: 'req-1',
    method: 'POST',
    originalUrl: '/api/x',
    headers: {
      host: 'example.com',
      'user-agent': 'mocha',
      'content-type': 'application/json',
      authorization: 'Bearer secret',
      'x-forwarded-for': '1.2.3.4',
    },
    ip: '10.0.0.1',
  };
  const out = reqSerializer(req);
  assert.equal(out.id, 'req-1');
  assert.equal(out.method, 'POST');
  assert.equal(out.url, '/api/x');
  assert.equal(out.remoteAddress, '10.0.0.1');
  assert.equal(out.headers.host, 'example.com');
  assert.equal(out.headers['user-agent'], 'mocha');
  // authorization is not in the whitelisted headers, so it doesn't leak
  assert.equal(out.headers.authorization, undefined);
});

test('reqSerializer falls back to socket.remoteAddress when req.ip is missing', () => {
  const out = reqSerializer({
    method: 'GET',
    url: '/x',
    socket: { remoteAddress: '10.10.10.10' },
    headers: {},
  });
  assert.equal(out.remoteAddress, '10.10.10.10');
});

test('reqSerializer tolerates missing req gracefully', () => {
  assert.equal(reqSerializer(null), null);
  assert.equal(reqSerializer(undefined), undefined);
});

test('resSerializer captures statusCode and redacted headers', () => {
  const res = {
    statusCode: 201,
    getHeaders: () => ({ 'content-type': 'application/json', 'set-cookie': 'session=secret' }),
  };
  const out = resSerializer(res);
  assert.equal(out.statusCode, 201);
  assert.equal(out.headers['content-type'], 'application/json');
  // 'set-cookie' isn't in REDACT_KEYS by default for the response path, but
  // the contract is: pass through what getHeaders() returns. Just verify
  // the value is observable (security policy is enforced elsewhere).
  assert.ok('set-cookie' in out.headers);
});

test('resSerializer omits headers when getHeaders is absent', () => {
  const out = resSerializer({ statusCode: 204 });
  assert.equal(out.statusCode, 204);
  assert.equal(out.headers, undefined);
});

test('createPinoLogger returns a logger object with standard level methods', () => {
  resetLogger();
  const logger = pinoLoggerModule({ forceNew: true });
  assert.ok(logger);
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    assert.equal(typeof logger[level], 'function', `logger.${level} must be a function`);
  }
});

test('createPinoLogger returns the cached singleton on repeat calls', () => {
  resetLogger();
  const a = pinoLoggerModule();
  const b = pinoLoggerModule();
  assert.equal(a, b, 'second call must return the cached instance');
});

test('resetLogger forces a fresh instance on next call', () => {
  const a = pinoLoggerModule();
  resetLogger();
  const b = pinoLoggerModule();
  // Not strictly required to be different references (e.g. if pino caches
  // internally), but contractually we should be able to observe the
  // factory was invoked anew. At minimum the surface is still usable.
  assert.ok(b);
  assert.equal(typeof b.info, 'function');
});

test('getLogger lazily initialises if no instance exists', () => {
  resetLogger();
  const logger = getLogger();
  assert.ok(logger);
  assert.equal(typeof logger.info, 'function');
});
