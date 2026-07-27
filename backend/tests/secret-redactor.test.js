'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const {
  redactErrorLike,
  redactErrorMessage,
  redactHeaders,
  redactString,
  redactUrl,
} = require('../src/utils/secret-redactor');

describe('secret-redactor', () => {
  const originalExtraHeaders = process.env.SIRAGPT_REDACT_EXTRA_HEADERS;
  const originalExtraQueryKeys = process.env.SIRAGPT_REDACT_EXTRA_QUERY_KEYS;

  afterEach(() => {
    if (originalExtraHeaders == null) delete process.env.SIRAGPT_REDACT_EXTRA_HEADERS;
    else process.env.SIRAGPT_REDACT_EXTRA_HEADERS = originalExtraHeaders;

    if (originalExtraQueryKeys == null) delete process.env.SIRAGPT_REDACT_EXTRA_QUERY_KEYS;
    else process.env.SIRAGPT_REDACT_EXTRA_QUERY_KEYS = originalExtraQueryKeys;
  });

  test('redactUrl strips userinfo and sensitive query parameters', () => {
    const redacted = redactUrl('https://user:pass@example.com/v1?access_token=secret&page=2&X-Amz-Signature=abc');

    assert.equal(redacted, 'https://example.com/v1?access_token=***&page=2&X-Amz-Signature=***');
    assert.doesNotMatch(redacted, /secret|user:pass|abc/);
  });

  test('redactString removes full database DSNs and strips cache credentials', () => {
    const redacted = redactString(
      'db=postgres://dbuser:dbpass@db.internal/app cache=redis://default:redispass@redis:6379',
    );

    assert.equal(
      redacted,
      'db=[REDACTED_DATABASE_URL] cache=redis://redis:6379',
    );
    assert.doesNotMatch(redacted, /dbuser|dbpass|db\.internal|app|redispass/);
  });

  test('redactString removes unlabeled direct and signed Prisma DSNs completely', () => {
    const redacted = redactString([
      'dial failed postgresql://project.internal/tenant_123',
      'auth failed postgres://runtime:secret@private-db.internal/app',
      'remote prisma+postgres://accelerate.invalid/?api_key=signed-secret',
    ].join(' | '));

    assert.equal((redacted.match(/\[REDACTED_DATABASE_URL\]/g) || []).length, 3);
    assert.doesNotMatch(
      redacted,
      /project\.internal|tenant_123|runtime|secret|private-db|accelerate\.invalid|signed-secret/,
    );
  });

  test('redactUrl handles relative URLs without leaking query secrets', () => {
    assert.equal(redactUrl('/api/files?api_key=secret&q=keep'), '/api/files?api_key=***&q=keep');
    assert.equal(redactUrl('files?token=secret'), '/files?token=***');
  });

  test('redactUrl truncates after redaction', () => {
    const token = 's'.repeat(1000);
    const redacted = redactUrl(`https://example.com/path?access_token=${token}&page=2`, { maxLen: 50 });

    assert.ok(redacted.length <= 51, redacted);
    assert.doesNotMatch(redacted, /ssssssss/);
    assert.match(redacted, /access_token=\*\*\*/);
  });

  test('redactUrl fails closed for unsafe or unparseable input', () => {
    assert.equal(redactUrl('not a url'), '<redacted>');
    assert.equal(redactUrl('https://example.com/\u0000?token=secret'), '<redacted>');
  });

  test('redactHeaders redacts deny-listed values and preserves trace headers', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer secret-token',
      Cookie: 'sid=abc',
      traceparent: '00-abc-def-01',
      'content-type': 'application/json',
    });

    assert.equal(redacted.Authorization, '***redacted (len=19)***');
    assert.equal(redacted.Cookie, '***redacted (len=7)***');
    assert.equal(redacted.traceparent, '00-abc-def-01');
    assert.equal(redacted['content-type'], 'application/json');
  });

  test('redactHeaders scrubs token-shaped values outside the deny list', () => {
    const redacted = redactHeaders({
      'x-debug': 'Bearer abcdefghijklmnopqrstuvwxyz123456',
    });

    assert.match(redacted['x-debug'], /\*\*\*bearer-token-redacted\*\*\*/);
    assert.doesNotMatch(redacted['x-debug'], /abcdefghijklmnopqrstuvwxyz123456/);
  });

  test('redactHeaders accepts Headers, arrays, and Maps', () => {
    const h = new Headers({ authorization: 'Bearer abcdefghijklmnop', accept: 'application/json' });
    assert.equal(redactHeaders(h).authorization, '***redacted (len=23)***');
    assert.equal(redactHeaders([['x-api-key', 'secret']])['x-api-key'], '***redacted (len=6)***');
    assert.equal(redactHeaders(new Map([['x-auth-token', 'secret']]))['x-auth-token'], '***redacted (len=6)***');
  });

  test('redactHeaders supports env-driven extensions without mutating requests', () => {
    process.env.SIRAGPT_REDACT_EXTRA_HEADERS = 'x-internal-token';
    const headers = { 'x-internal-token': 'secret', accept: 'json' };
    const redacted = redactHeaders(headers);

    assert.equal(redacted['x-internal-token'], '***redacted (len=6)***');
    assert.equal(headers['x-internal-token'], 'secret');
  });

  test('redactString scrubs common token shapes', () => {
    const input = [
      'Bearer abcdefghijklmnopqrstuvwxyz123456',
      'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkwIjoibmFtZQ.signature123',
      ['AKIA', '1234567890ABCDEF'].join(''),
      ['sk-ant-', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(''),
      ['sk-', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(''),
      ['sk_live_', 'abcdefghijklmnop'].join(''),
      ['ghp_', 'abcdefghijklmnopqrstuvwxyzABCDE'].join(''),
      ['xoxb-', '1234567890-secret'].join(''),
      ['AIza', 'abcdefghijklmnopqrstuvwxyz123456789'].join(''),
    ].join(' ');

    const redacted = redactString(input);
    assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz1234567890/);
    assert.match(redacted, /\*\*\*bearer-token-redacted\*\*\*/);
    assert.match(redacted, /\*\*\*github-token-redacted\*\*\*/);
  });

  test('redactString redacts query fragments in error messages', () => {
    const redacted = redactString('failed https://api.example.com/x?api_key=secret&page=2 with Bearer abcdefghijklmnop');

    assert.equal(redacted, 'failed https://api.example.com/x?api_key=***&page=2 with ***bearer-token-redacted***');
  });

  test('redactErrorMessage handles Error objects', () => {
    const err = new Error('upstream failed https://example.com/?token=secret&access_token=abc');
    assert.equal(redactErrorMessage(err), 'upstream failed https://example.com/?token=***&access_token=***');
  });

  test('redactErrorLike returns a sanitized serializable error shape', () => {
    const err = new Error('upstream Bearer abcdefghijklmnopqrstuvwxyz123456 failed at https://example.com/?api_key=secret');
    err.code = 'E_SECRET';
    const redacted = redactErrorLike(err);

    assert.equal(redacted.name, 'Error');
    assert.equal(redacted.code, 'E_SECRET');
    assert.match(redacted.message, /\*\*\*bearer-token-redacted\*\*\*/);
    assert.doesNotMatch(JSON.stringify(redacted), /abcdefghijklmnopqrstuvwxyz123456|api_key=secret/);
  });

  test('redactUrl supports env-driven query keys', () => {
    process.env.SIRAGPT_REDACT_EXTRA_QUERY_KEYS = 'workspace_key';
    assert.equal(redactUrl('https://example.com/?workspace_key=secret&ok=1'), 'https://example.com/?workspace_key=***&ok=1');
  });
});
