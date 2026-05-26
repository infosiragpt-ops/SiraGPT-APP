'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { validateZod } = require('../src/middleware/validate-zod');
const { createZodValidator, formatIssues } = require('../src/middleware/zod-validator');

function makeRes() {
  const state = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { state.statusCode = code; return this; },
    setHeader(key, value) { state.headers[key.toLowerCase()] = value; return this; },
    json(body) { state.body = body; return this; },
  };
  return { res, state };
}

function makeNext() {
  const calls = [];
  const next = (err) => { calls.push(err === undefined ? '__pass__' : err); };
  return { next, calls };
}

test('validateZod returns hardened validation envelope on invalid body', () => {
  const middleware = validateZod(z.object({ email: z.string().email() }));
  const req = { body: { email: 'bad' }, requestId: 'req_validate_zod_1' };
  const { res, state } = makeRes();
  const { next, calls } = makeNext();

  middleware(req, res, next);

  assert.equal(state.statusCode, 400);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.equal(state.body.ok, false);
  assert.equal(state.body.code, 'validation_failed');
  assert.equal(state.body.requestId, 'req_validate_zod_1');
  assert.equal(state.body.validation[0].field, 'email');
  assert.equal(calls.length, 0);
});

test('validateZod forwards non-Zod errors', () => {
  const boom = new Error('boom');
  const middleware = validateZod({ parse: () => { throw boom; } });
  const req = { body: {} };
  const { res, state } = makeRes();
  const { next, calls } = makeNext();

  middleware(req, res, next);

  assert.equal(state.statusCode, 200);
  assert.equal(state.body, null);
  assert.equal(calls[0], boom);
});

test('createZodValidator body validator returns requestId and secure headers', () => {
  const validator = createZodValidator().body(z.object({ count: z.number() }));
  const req = { body: { count: 'nope' }, requestId: 'req_zod_validator_1' };
  const { res, state } = makeRes();
  const { next, calls } = makeNext();

  validator(req, res, next);

  assert.equal(state.statusCode, 400);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.equal(state.body.ok, false);
  assert.equal(state.body.error, 'validation_error');
  assert.equal(state.body.code, 'validation_failed');
  assert.equal(state.body.requestId, 'req_zod_validator_1');
  assert.equal(state.body.details[0].path, 'count');
  assert.equal(calls.length, 0);
});

test('formatIssues tolerates missing issue arrays', () => {
  assert.deepEqual(formatIssues(null), []);
  assert.deepEqual(formatIssues({ issues: null }), []);
});
