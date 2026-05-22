'use strict';

/**
 * Tests for cycle 19 deliverables:
 *   - backend/src/schemas/*       — Zod schemas for auth/chats/files/payments
 *   - backend/src/middleware/validate.js
 *   - backend/src/services/ai/response-validator.js
 *
 * Style matches the rest of the suite (node --test).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RegisterRequestSchema,
  LoginRequestSchema,
  AuthResponseSchema,
} = require('../src/schemas/auth');
const {
  CreateChatRequestSchema,
  MessageResponseSchema,
} = require('../src/schemas/chats');
const {
  FileUploadResponseSchema,
} = require('../src/schemas/files');
const {
  CreatePaymentRequestSchema,
} = require('../src/schemas/payments');
const {
  validateBody,
  validateQuery,
  buildValidationPayload,
  formatExpressValidatorErrors,
} = require('../src/middleware/validate');
const {
  aiGenerateRequestSchema,
} = require('../src/schemas');
const responseValidator = require('../src/services/ai/response-validator');
const { z } = require('zod');

// ---------- minimal express req/res/next stub --------------------------

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
  return res;
}

// ---------- auth schemas ----------------------------------------------

test('RegisterRequestSchema accepts valid payload', () => {
  const r = RegisterRequestSchema.safeParse({
    name: 'Alice',
    email: 'alice@example.com',
    password: 'secret123',
  });
  assert.equal(r.success, true);
});

test('RegisterRequestSchema rejects weak password with i18n code', () => {
  const r = RegisterRequestSchema.safeParse({
    name: 'A',
    email: 'not-an-email',
    password: 'short',
  });
  assert.equal(r.success, false);
  const codes = r.error.issues.map((i) => i.message);
  // i18n-style codes flow through unchanged
  assert.ok(codes.some((c) => c.startsWith('auth.email.') || c.startsWith('auth.password.') || c.startsWith('auth.name.')));
});

test('LoginRequestSchema accepts legacy short password (login is lenient)', () => {
  const r = LoginRequestSchema.safeParse({ email: 'x@y.com', password: 'a' });
  assert.equal(r.success, true);
});

test('AuthResponseSchema accepts API shape', () => {
  const r = AuthResponseSchema.safeParse({
    user: { id: 1, email: 'a@b.com', name: 'A' },
    token: 'jwt.token.here',
  });
  assert.equal(r.success, true);
});

// ---------- chat / file / payment schemas -----------------------------

test('CreateChatRequestSchema requires title + model', () => {
  const ok = CreateChatRequestSchema.safeParse({ title: 'hi', model: 'gpt-4o' });
  assert.equal(ok.success, true);
  const bad = CreateChatRequestSchema.safeParse({ title: '', model: '' });
  assert.equal(bad.success, false);
});

test('MessageResponseSchema validates basic message', () => {
  const r = MessageResponseSchema.safeParse({
    id: 'm1', chatId: 'c1', role: 'assistant', content: 'hi',
  });
  assert.equal(r.success, true);
});

test('FileUploadResponseSchema accepts files array', () => {
  const r = FileUploadResponseSchema.safeParse({
    files: [{ id: 1, name: 'a.pdf', size: 100 }],
  });
  assert.equal(r.success, true);
});

test('CreatePaymentRequestSchema rejects bad provider', () => {
  const r = CreatePaymentRequestSchema.safeParse({
    plan: 'PRO', provider: 'bitcoin',
  });
  assert.equal(r.success, false);
});

test('CreatePaymentRequestSchema uppercases currency', () => {
  const r = CreatePaymentRequestSchema.safeParse({
    plan: 'PRO', provider: 'stripe', amount: 10, currency: 'usd',
  });
  assert.equal(r.success, true);
  assert.equal(r.data.currency, 'USD');
});

test('aiGenerateRequestSchema rejects oversized inline file content before decoding', () => {
  const oversizedBase64 = 'A'.repeat((10 * 1024 * 1024) + 8);
  const r = aiGenerateRequestSchema.safeParse({
    messages: [{ role: 'user', content: 'summarize this inline file' }],
    files: [{
      name: 'large.txt',
      mimeType: 'text/plain',
      content: oversizedBase64,
    }],
  });

  assert.equal(r.success, false);
  assert.ok(r.error.issues.some((issue) => issue.message === 'files.content.too_large'));
});

test('aiGenerateRequestSchema rejects malformed inline file MIME before parsing', () => {
  const r = aiGenerateRequestSchema.safeParse({
    messages: [{ role: 'user', content: 'inspect this inline file' }],
    files: [{
      name: 'payload.bin',
      mimeType: 'text/plain; charset=utf-8',
      content: 'aGVsbG8=',
    }],
  });

  assert.equal(r.success, false);
  assert.ok(r.error.issues.some((issue) => issue.message === 'files.mimeType.invalid'));
});

// ---------- validation middleware -------------------------------------

test('validateBody passes with valid payload', () => {
  const mw = validateBody(LoginRequestSchema, { codePrefix: 'auth' });
  const req = { body: { email: 'a@b.com', password: 'pw' } };
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('validateBody returns 400 with structured errors on invalid input', () => {
  const mw = validateBody(LoginRequestSchema, { codePrefix: 'auth' });
  const req = { body: { email: 'nope', password: '' } };
  const res = fakeRes();
  mw(req, res, () => assert.fail('next should NOT be called'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(Array.isArray(res.body.validation));
  assert.ok(res.body.validation.length >= 1);
  // Each entry has field + code
  for (const v of res.body.validation) {
    assert.ok(typeof v.field === 'string');
    assert.ok(typeof v.code === 'string');
  }
});

test('validateQuery coerces and runs', () => {
  const schema = z.object({ page: z.coerce.number().int().min(1) }).strict();
  const mw = validateQuery(schema);
  const req = { query: { page: '3' } };
  const res = fakeRes();
  let ok = false;
  mw(req, res, () => { ok = true; });
  assert.equal(ok, true);
  assert.equal(req.query.page, 3);
});

test('formatExpressValidatorErrors mirrors envelope', () => {
  const out = formatExpressValidatorErrors(
    [{ path: 'email', msg: 'auth.email.invalid', value: 'x' }],
    { codePrefix: 'auth' },
  );
  assert.equal(out.error, 'Validation failed');
  assert.equal(out.validation[0].field, 'email');
  assert.equal(out.validation[0].code, 'auth.email.invalid');
});

test('buildValidationPayload synthesizes code when message is not dotted', () => {
  const s = z.object({ n: z.number() }).strict();
  const r = s.safeParse({ n: 'oops' });
  assert.equal(r.success, false);
  const payload = buildValidationPayload(r.error, 'auth');
  assert.ok(payload.validation[0].code.startsWith('auth.n.'));
});

// ---------- AI response validator -------------------------------------

const AiShape = z.object({
  topic: z.string(),
  score: z.number().min(0).max(1),
});

test('response-validator extracts plain JSON', () => {
  const r = responseValidator.validate('{"topic":"x","score":0.5}', AiShape);
  assert.equal(r.ok, true);
  assert.equal(r.data.topic, 'x');
});

test('response-validator extracts fenced JSON', () => {
  const raw = 'Sure!\n```json\n{"topic":"x","score":0.1}\n```\nLet me know.';
  const r = responseValidator.validate(raw, AiShape);
  assert.equal(r.ok, true);
  assert.equal(r.data.score, 0.1);
});

test('response-validator falls back to balanced-brace extraction', () => {
  const raw = 'here it is: {"topic":"x","score":0.9} cheers';
  const r = responseValidator.validate(raw, AiShape);
  assert.equal(r.ok, true);
});

test('response-validator surfaces no_json when nothing parses', () => {
  const r = responseValidator.validate('no json at all', AiShape);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'no_json');
});

test('response-validator surfaces schema_error with details', () => {
  const r = responseValidator.validate('{"topic":"x","score":5}', AiShape);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'schema_error');
  assert.ok(Array.isArray(r.error.details));
  assert.ok(r.error.details.some((d) => d.path === 'score'));
});

test('response-validator bad_schema when caller passes garbage', () => {
  const r = responseValidator.validate('{"a":1}', null);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'bad_schema');
});

test('retryPrompt mentions schema violations', () => {
  const r = responseValidator.validate('{"topic":"x","score":5}', AiShape);
  const prompt = responseValidator.retryPrompt('Return JSON about topics.', r.error);
  assert.ok(prompt.includes('schema violations'));
  assert.ok(prompt.includes('score'));
});

// ---------- generator script smoke -----------------------------------

test('generate-api-types module exports work', () => {
  const gen = require('../scripts/generate-api-types');
  assert.equal(typeof gen.jsonSchemaToTs, 'function');
  assert.equal(gen.typeNameFor('LoginRequestSchema'), 'LoginRequest');
  assert.equal(gen.typeNameFor('PlainName'), 'PlainName');
});

test('generate-api-types converts a small schema', () => {
  const gen = require('../scripts/generate-api-types');
  const ts = gen.jsonSchemaToTs({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'number' } },
  });
  assert.ok(ts.includes('a: string;'));
  assert.ok(ts.includes('b?: number;'));
});
