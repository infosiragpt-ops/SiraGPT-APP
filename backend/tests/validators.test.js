'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { isEmail, isUrl, isUuid, isIso8601, isDate, isE164 } = require('../src/utils/validators');

describe('isEmail', () => {
  test('valid examples', () => {
    for (const e of ['a@b.co', 'first.last@example.com', 'tag+filter@example.io']) {
      assert.equal(isEmail(e), true, e);
    }
  });
  test('invalid examples', () => {
    for (const e of ['', 'no-at-sign', 'a@b', 'a@b.', 'a..b@c.com', '.a@b.com', 'a.@b.com']) {
      assert.equal(isEmail(e), false, e);
    }
  });
  test('rejects > 254 chars', () => {
    assert.equal(isEmail('a'.repeat(255) + '@x.co'), false);
  });
  test('non-string → false', () => {
    assert.equal(isEmail(null), false);
  });
});

describe('isUrl', () => {
  test('http(s) URLs valid by default', () => {
    assert.equal(isUrl('https://x.com/path'), true);
    assert.equal(isUrl('http://x.com'), true);
  });
  test('rejects ftp by default', () => {
    assert.equal(isUrl('ftp://x.com'), false);
  });
  test('custom protocols', () => {
    assert.equal(isUrl('ftp://x.com', { protocols: ['ftp:'] }), true);
  });
  test('relative when requireProtocol=false', () => {
    assert.equal(isUrl('/api/users', { requireProtocol: false }), true);
  });
  test('garbage rejected', () => {
    assert.equal(isUrl('not a url'), false);
    assert.equal(isUrl(null), false);
  });
});

describe('isUuid', () => {
  const v4 = 'a3bb189e-8bf9-4eaf-9c3a-4a09a55b3e0e';
  const v1 = 'd9b2d63d-a233-1b35-9c8b-bda44d76f6c9';
  const nil = '00000000-0000-0000-0000-000000000000';

  test('any version when no opt', () => {
    assert.equal(isUuid(v4), true);
    assert.equal(isUuid(v1), true);
  });
  test('specific version', () => {
    assert.equal(isUuid(v4, { version: 4 }), true);
    assert.equal(isUuid(v1, { version: 4 }), false);
  });
  test('nil UUID accepted only with no version filter', () => {
    assert.equal(isUuid(nil), true);
    assert.equal(isUuid(nil, { version: 4 }), false);
  });
  test('rejects garbage', () => {
    assert.equal(isUuid('not-a-uuid'), false);
    assert.equal(isUuid(''), false);
    assert.equal(isUuid(null), false);
  });
});

describe('isIso8601', () => {
  test('date-only', () => {
    assert.equal(isIso8601('2026-05-09'), true);
  });
  test('date-time with Z', () => {
    assert.equal(isIso8601('2026-05-09T12:34:56Z'), true);
  });
  test('date-time with offset', () => {
    assert.equal(isIso8601('2026-05-09T12:34:56+02:00'), true);
  });
  test('rejects garbage', () => {
    assert.equal(isIso8601('not iso'), false);
    assert.equal(isIso8601('2026/05/09'), false);
    assert.equal(isIso8601(''), false);
  });
});

describe('isDate', () => {
  test('valid yyyy-mm-dd', () => {
    assert.equal(isDate('2026-05-09'), true);
  });
  test('rejects bad month/day', () => {
    assert.equal(isDate('2026-13-01'), false);
    assert.equal(isDate('2026-02-30'), false);
  });
  test('rejects wrong format', () => {
    assert.equal(isDate('2026/05/09'), false);
    assert.equal(isDate(''), false);
  });
});

describe('isE164', () => {
  test('valid', () => {
    assert.equal(isE164('+12025550100'), true);
    assert.equal(isE164('+5215555555555'), true);
  });
  test('rejects malformed', () => {
    assert.equal(isE164('12025550100'), false);   // missing +
    assert.equal(isE164('+0123456789'), false);   // can't start with 0
    assert.equal(isE164('+'), false);              // empty after +
    assert.equal(isE164(null), false);
  });
});
