'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  findPII,
  mask,
  maskObject,
  ALL_TYPES,
  MASK_TOKENS,
  _internals,
} = require('../src/utils/pii-mask');

describe('pii-mask — findPII', () => {
  test('detects email addresses', () => {
    const text = 'Contact me at alice.bob@example.com for details.';
    const hits = findPII(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'email');
    assert.equal(hits[0].original, 'alice.bob@example.com');
    assert.equal(hits[0].start, 'Contact me at '.length);
  });

  test('detects multiple types in one string', () => {
    const text = 'Email me at a@b.com or call +14155552671. SSN 123-45-6789.';
    const types = findPII(text).map((h) => h.type).sort();
    assert.deepEqual(types, ['email', 'phone', 'ssn']);
  });

  test('validates credit cards with Luhn', () => {
    // 4111 1111 1111 1111 is a known Luhn-valid test PAN.
    const valid = '4111 1111 1111 1111';
    // Change last digit to break Luhn.
    const invalid = '4111 1111 1111 1112';
    assert.equal(findPII(`card ${valid} here`).filter((h) => h.type === 'credit_card').length, 1);
    assert.equal(findPII(`card ${invalid} here`).filter((h) => h.type === 'credit_card').length, 0);
  });

  test('validates IBAN with mod-97', () => {
    // GB82 WEST 1234 5698 7654 32 — canonical IBAN sample, valid.
    const validIban = 'GB82 WEST 1234 5698 7654 32';
    const hits = findPII(`account ${validIban}`);
    assert.ok(hits.find((h) => h.type === 'iban'), 'expected iban match');
  });

  test('rejects invalid SSN prefixes', () => {
    // Bad SSN inputs should not be classified as SSN. They may still
    // match the broader phone-number regex (3-2-4 digit groups with
    // dashes look like a phone) — what we care about here is the SSN
    // detector specifically.
    const ssnTypes = (s) => findPII(s).filter((h) => h.type === 'ssn');
    assert.equal(ssnTypes('000-12-3456').length, 0);
    assert.equal(ssnTypes('666-12-3456').length, 0);
    assert.equal(ssnTypes('900-12-3456').length, 0);
    assert.equal(ssnTypes('123-00-4567').length, 0);
    assert.equal(ssnTypes('123-45-0000').length, 0);
    assert.equal(ssnTypes('123-45-6789').length, 1);
  });

  test('detects IPv4 and IPv6', () => {
    const text = 'server 192.168.1.10 and fallback 2001:db8::1';
    const types = findPII(text).map((h) => h.type).sort();
    assert.ok(types.includes('ipv4'));
    assert.ok(types.includes('ipv6'));
  });

  test('rejects non-IP dotted numbers above 255', () => {
    assert.equal(findPII('999.999.999.999').filter((h) => h.type === 'ipv4').length, 0);
  });

  test('detects US ZIP and ZIP+4', () => {
    const hits = findPII('ship to 94103-1234');
    assert.ok(hits.find((h) => h.type === 'zip_us' && h.original === '94103-1234'));
  });

  test('resolves overlapping ranges (email beats embedded numbers)', () => {
    const text = 'user1234567@example.com';
    const hits = findPII(text);
    // Should produce a single email match, no phone overlap.
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'email');
  });

  test('honours policy filter (only detect emails)', () => {
    const text = 'a@b.com and +14155552671 and 4111 1111 1111 1111';
    const hits = findPII(text, { policy: ['email'] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].type, 'email');
  });

  test('returns [] on non-string input', () => {
    assert.deepEqual(findPII(null), []);
    assert.deepEqual(findPII(undefined), []);
    assert.deepEqual(findPII(123), []);
    assert.deepEqual(findPII(''), []);
  });

  test('ALL_TYPES is the canonical type list', () => {
    assert.ok(Array.isArray(ALL_TYPES));
    assert.ok(ALL_TYPES.includes('email'));
    assert.ok(ALL_TYPES.includes('ipv6'));
  });
});

describe('pii-mask — mask', () => {
  test('replaces email with <EMAIL>', () => {
    const out = mask('write me at a@b.com please');
    assert.equal(out, 'write me at <EMAIL> please');
  });

  test('replaces multiple PII spans', () => {
    const out = mask('a@b.com and 123-45-6789');
    assert.equal(out, '<EMAIL> and <SSN>');
  });

  test('returns original text when no PII present', () => {
    const original = 'no PII here at all';
    assert.equal(mask(original), original);
  });

  test('non-overlapping replacements preserve order', () => {
    const out = mask('ssn 123-45-6789, ip 10.0.0.1, email z@z.co');
    assert.equal(out, 'ssn <SSN>, ip <IP>, email <EMAIL>');
  });

  test('returns input unchanged on non-string', () => {
    assert.equal(mask(null), null);
    assert.equal(mask(''), '');
  });

  test('custom tokens override defaults', () => {
    const out = mask('a@b.com', { tokens: { email: '[REDACTED-EMAIL]' } });
    assert.equal(out, '[REDACTED-EMAIL]');
  });

  test('policy can disable specific types', () => {
    const text = 'a@b.com 123-45-6789';
    const out = mask(text, { policy: ['ssn'] });
    assert.equal(out, 'a@b.com <SSN>');
  });

  test('MASK_TOKENS exposes default tokens', () => {
    assert.equal(MASK_TOKENS.email, '<EMAIL>');
    assert.equal(MASK_TOKENS.credit_card, '<CREDIT_CARD>');
  });
});

describe('pii-mask — maskObject', () => {
  test('recursively masks string fields', () => {
    const input = {
      message: 'email a@b.com',
      nested: { phone: '+14155552671 call me' },
      list: ['ssn 123-45-6789', 42],
    };
    const out = maskObject(input);
    assert.equal(out.message, 'email <EMAIL>');
    assert.match(out.nested.phone, /<PHONE>/);
    assert.equal(out.list[0], 'ssn <SSN>');
    assert.equal(out.list[1], 42);
  });

  test('survives circular references', () => {
    const o = { name: 'a@b.com' };
    o.self = o;
    const out = maskObject(o);
    assert.equal(out.name, '<EMAIL>');
  });

  test('passes through primitives', () => {
    assert.equal(maskObject(null), null);
    assert.equal(maskObject(42), 42);
    assert.equal(maskObject(true), true);
  });
});

describe('pii-mask — validator internals', () => {
  test('luhnValid', () => {
    assert.equal(_internals.luhnValid('4111111111111111'), true);
    assert.equal(_internals.luhnValid('4111111111111112'), false);
    assert.equal(_internals.luhnValid('1'), false);
  });
  test('ssnValid rejects bad prefixes', () => {
    assert.equal(_internals.ssnValid('000-12-3456'), false);
    assert.equal(_internals.ssnValid('123-45-6789'), true);
  });
  test('ibanValid mod-97 check', () => {
    assert.equal(_internals.ibanValid('GB82WEST12345698765432'), true);
    assert.equal(_internals.ibanValid('GB82WEST12345698765433'), false);
  });
  test('phoneValid demands separators or leading +', () => {
    assert.equal(_internals.phoneValid('1234567'), false);
    assert.equal(_internals.phoneValid('+1234567'), true);
    assert.equal(_internals.phoneValid('123-456-7890'), true);
  });
});
