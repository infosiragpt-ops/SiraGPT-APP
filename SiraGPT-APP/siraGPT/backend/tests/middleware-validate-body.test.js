'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateBody, formatZodError } = require('../src/middleware/validate-body');

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

test('exports validateBody + formatZodError', () => {
  assert.equal(typeof validateBody, 'function');
  assert.equal(typeof formatZodError, 'function');
});

test('validateBody throws TypeError when schema lacks .parse()', () => {
  assert.throws(() => validateBody({}), TypeError);
  assert.throws(() => validateBody(null), TypeError);
  assert.throws(() => validateBody(undefined), TypeError);
  assert.throws(() => validateBody({ parse: 'not a function' }), TypeError);
});

test('validateBody calls next() and exposes req.validatedBody on success', () => {
  const schema = { parse: (input) => ({ ...input, normalised: true }) };
  const middleware = validateBody(schema);
  const req = { body: { name: 'alice' } };
  const { res } = makeRes();
  const { next, calls } = makeNext();

  middleware(req, res, next);

  assert.deepEqual(calls, ['__pass__'], 'next() must be called without an error');
  assert.deepEqual(req.validatedBody, { name: 'alice', normalised: true });
  assert.deepEqual(req.body, { name: 'alice' }, 'raw req.body must stay untouched for backward compat');
});

test('validateBody returns 400 with formatted error on ZodError', () => {
  const zodErrorShape = Object.assign(new Error('invalid_input'), {
    name: 'ZodError',
    errors: [
      { path: ['email'], message: 'Required', code: 'invalid_type' },
      { path: ['profile', 'age'], message: 'Expected number', code: 'invalid_type' },
    ],
  });
  const schema = { parse: () => { throw zodErrorShape; } };
  const middleware = validateBody(schema);
  const req = { body: {}, requestId: 'req_validate_body_1' };
  const { res, state } = makeRes();
  const { next, calls } = makeNext();

  middleware(req, res, next);

  assert.equal(state.statusCode, 400);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.equal(state.body.ok, false);
  assert.equal(state.body.error, 'validation_failed');
  assert.equal(state.body.message, 'Request body validation failed');
  assert.equal(state.body.requestId, 'req_validate_body_1');
  assert.equal(state.body.details.length, 2);
  assert.deepEqual(state.body.details[0], { path: 'email', message: 'Required', code: 'invalid_type' });
  assert.deepEqual(state.body.details[1], { path: 'profile.age', message: 'Expected number', code: 'invalid_type' });
  assert.equal(calls.length, 0, 'next() must NOT be called when responding with 400');
});

test('validateBody forwards non-Zod errors to next(err)', () => {
  const boom = new Error('boom');
  const schema = { parse: () => { throw boom; } };
  const middleware = validateBody(schema);
  const req = { body: {} };
  const { res, state } = makeRes();
  const { next, calls } = makeNext();

  middleware(req, res, next);

  assert.equal(state.statusCode, 200, 'must not respond with a status code for non-Zod errors');
  assert.equal(state.body, null, 'must not send any body for non-Zod errors');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], boom, 'next(err) must propagate the exact thrown error');
});

test('formatZodError flattens nested paths with dots', () => {
  const err = {
    errors: [
      { path: ['user', 'profile', 'email'], message: 'invalid email', code: 'invalid_email' },
      { path: [], message: 'top-level', code: 'custom' },
    ],
  };
  const out = formatZodError(err);
  assert.equal(out.error, 'validation_failed');
  assert.equal(out.details[0].path, 'user.profile.email');
  assert.equal(out.details[1].path, '');
});

test('validateBody is composable with multiple invocations', () => {
  const schemaA = { parse: (input) => ({ tag: 'A', ...input }) };
  const schemaB = { parse: (input) => ({ tag: 'B', ...input }) };
  const mwA = validateBody(schemaA);
  const mwB = validateBody(schemaB);
  // Independent middleware instances; one should not affect the other.
  const reqA = { body: { x: 1 } };
  const reqB = { body: { y: 2 } };
  mwA(reqA, makeRes().res, makeNext().next);
  mwB(reqB, makeRes().res, makeNext().next);
  assert.equal(reqA.validatedBody.tag, 'A');
  assert.equal(reqB.validatedBody.tag, 'B');
});
