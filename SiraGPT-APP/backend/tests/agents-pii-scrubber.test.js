/**
 * Tests for services/agents/pii-scrubber.js — regex-based PII redactor
 * used to clean preference-export JSONL before fine-tuning upload.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  scrub,
  scrubRecord,
  PATTERNS,
  AGGRESSIVE_PATTERNS,
} = require('../src/services/agents/pii-scrubber');

// ── PATTERN catalogs ────────────────────────────────────────────

describe('PATTERNS catalog', () => {
  it('has exactly 11 default patterns (catches accidental additions)', () => {
    assert.equal(PATTERNS.length, 11);
  });

  it('every pattern has { id, re, token }', () => {
    for (const p of PATTERNS) {
      assert.equal(typeof p.id, 'string');
      assert.ok(p.re instanceof RegExp);
      assert.match(p.token, /^<[A-Z_]+>$/);
    }
  });

  it('AGGRESSIVE_PATTERNS has 3 documented opt-in rules', () => {
    assert.equal(AGGRESSIVE_PATTERNS.length, 3);
  });

  it('pattern ids are unique', () => {
    const ids = PATTERNS.concat(AGGRESSIVE_PATTERNS).map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ── scrub · primitives ─────────────────────────────────────────

describe('scrub · primitives', () => {
  it('non-string input passes through unchanged', () => {
    assert.deepEqual(scrub(null), { scrubbed: null, hits: [] });
    assert.deepEqual(scrub(undefined), { scrubbed: undefined, hits: [] });
    assert.deepEqual(scrub(42), { scrubbed: 42, hits: [] });
  });

  it('empty string returns empty + no hits', () => {
    assert.deepEqual(scrub(''), { scrubbed: '', hits: [] });
  });

  it('clean text returns unchanged', () => {
    const out = scrub('Hello world, this is normal text.');
    assert.equal(out.scrubbed, 'Hello world, this is normal text.');
    assert.deepEqual(out.hits, []);
  });
});

// ── scrub · email ──────────────────────────────────────────────

describe('scrub · email', () => {
  it('redacts a single email', () => {
    const out = scrub('Reach me at alice@example.com please.');
    assert.match(out.scrubbed, /<EMAIL>/);
    assert.equal(out.scrubbed.includes('alice@example.com'), false);
    assert.deepEqual(out.hits, [{ id: 'email', count: 1 }]);
  });

  it('redacts multiple emails (counts them)', () => {
    const out = scrub('a@b.com and c@d.io and e@f.net');
    assert.equal(out.scrubbed.match(/<EMAIL>/g).length, 3);
    assert.deepEqual(out.hits, [{ id: 'email', count: 3 }]);
  });

  it('redacts plus-aliases and dot-separated locals', () => {
    const out = scrub('user.name+tag@example.co.uk');
    assert.match(out.scrubbed, /<EMAIL>/);
  });
});

// ── scrub · SSN ────────────────────────────────────────────────

describe('scrub · SSN', () => {
  it('redacts 3-2-4 dashed SSN format', () => {
    const out = scrub('SSN: 123-45-6789');
    assert.match(out.scrubbed, /<SSN>/);
    assert.equal(out.scrubbed.includes('123-45-6789'), false);
  });

  it('does NOT redact short numeric patterns', () => {
    const out = scrub('Date: 2024-12-31');
    assert.equal(out.scrubbed.includes('<SSN>'), false);
  });
});

// ── scrub · credit cards ───────────────────────────────────────

describe('scrub · credit cards', () => {
  it('redacts 4-4-4-4 card numbers', () => {
    const out = scrub('Card: 4111 1111 1111 1111');
    assert.match(out.scrubbed, /<CREDIT_CARD>/);
  });

  it('redacts contiguous 16-digit card numbers', () => {
    const out = scrub('4111111111111111 was the number');
    assert.match(out.scrubbed, /<CREDIT_CARD>/);
  });

  it('redacts cards with dashes', () => {
    const out = scrub('4111-1111-1111-1111');
    assert.match(out.scrubbed, /<CREDIT_CARD>/);
  });
});

// ── scrub · phone ──────────────────────────────────────────────

describe('scrub · phone', () => {
  it('redacts US-style phone numbers with parens', () => {
    const out = scrub('Call (555) 123-4567 anytime');
    assert.match(out.scrubbed, /<PHONE>/);
  });

  it('redacts dotted phone numbers', () => {
    const out = scrub('Phone: 555.123.4567');
    assert.match(out.scrubbed, /<PHONE>/);
  });

  it('redacts international-style with leading +', () => {
    const out = scrub('Reach +1 555-123-4567');
    assert.match(out.scrubbed, /<PHONE>/);
  });
});

// ── scrub · IPv4 ───────────────────────────────────────────────

describe('scrub · IPv4', () => {
  it('redacts IPv4 addresses', () => {
    const out = scrub('Server at 192.168.1.100 is alive');
    assert.match(out.scrubbed, /<IP>/);
    assert.equal(out.scrubbed.includes('192.168.1.100'), false);
  });

  it('redacts multiple IPs and counts them', () => {
    const out = scrub('10.0.0.1 and 172.16.0.5 both responded');
    assert.equal(out.hits.find(h => h.id === 'ipv4').count, 2);
  });
});

// ── scrub · secret keys ────────────────────────────────────────

describe('scrub · cloud + LLM keys', () => {
  it('redacts AWS access keys (AKIA*)', () => {
    const out = scrub('export KEY=AKIAIOSFODNN7EXAMPLE');
    assert.match(out.scrubbed, /<AWS_KEY>/);
  });

  it('redacts AWS temporary tokens (ASIA*)', () => {
    const out = scrub('ASIAIOSFODNN7EXAMPLE');
    assert.match(out.scrubbed, /<AWS_KEY>/);
  });

  it('redacts OpenAI sk- keys (≥20-char body)', () => {
    const out = scrub('OPENAI_KEY=sk-abcdefghij1234567890ABCDEF');
    assert.match(out.scrubbed, /<OPENAI_KEY>/);
  });

  it('redacts GitHub PATs (ghp_ + 36 chars)', () => {
    const pat = 'ghp_' + 'A'.repeat(36);
    const out = scrub(`token: ${pat}`);
    assert.match(out.scrubbed, /<GITHUB_TOKEN>/);
  });

  it('redacts Slack tokens (xoxb / xoxp / xoxa / xoxr / xoxs)', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs']) {
      const out = scrub(`token=${prefix}-A1B2-C3D4E5-FGHIJK`);
      assert.match(out.scrubbed, /<SLACK_TOKEN>/, `${prefix} not redacted`);
    }
  });

  it('redacts JWTs (three-segment eyJ...)', () => {
    const jwt = 'eyJabcdefghij.eyJklmnopqrst.qrstuvwxyz123';
    const out = scrub(`Authorization: Bearer ${jwt}`);
    assert.match(out.scrubbed, /<JWT>/);
  });

  it('redacts PEM private keys (RSA, EC, OPENSSH, generic)', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----`;
    const out = scrub(pem);
    assert.match(out.scrubbed, /<PRIVATE_KEY>/);
    assert.equal(out.scrubbed.includes('MIIEpAIBAAK'), false);
  });
});

// ── scrub · multi-rule + ordering ──────────────────────────────

describe('scrub · multi-rule', () => {
  it('handles a record with multiple PII types', () => {
    const out = scrub('Email alice@example.com, phone (555) 123-4567, IP 192.168.1.1');
    const ids = out.hits.map(h => h.id).sort();
    assert.deepEqual(ids, ['email', 'ipv4', 'phone']);
    assert.equal(out.scrubbed.match(/<EMAIL>/).length, 1);
    assert.equal(out.scrubbed.match(/<PHONE>/).length, 1);
    assert.equal(out.scrubbed.match(/<IP>/).length, 1);
  });

  it('credit card matches before phone (16-digit string)', () => {
    // The CC rule must run first to claim the 16-digit run; otherwise
    // phone regex could fragment it.
    const out = scrub('4111111111111111');
    assert.match(out.scrubbed, /<CREDIT_CARD>/);
  });
});

// ── scrub · aggressive mode ────────────────────────────────────

describe('scrub · aggressive mode', () => {
  it('aggressive mode URL_WITH_CREDS pattern (email wins on email-shaped userinfo)', () => {
    // Pinned quirk: email pattern (in PATTERNS) runs before
    // URL_WITH_CREDS (in AGGRESSIVE_PATTERNS). For a URL whose
    // user:pass@host portion looks like an email (e.g. with a
    // dot-tld host), email regex claims the substring first and
    // URL_WITH_CREDS gets nothing left to match.
    const dotHost = 'connect to https://admin:secret123@db.example.com';
    const aggDot = scrub(dotHost, { aggressive: true });
    assert.match(aggDot.scrubbed, /<EMAIL>/);

    // But for a URL whose userinfo can't pass as an email (no .tld
    // on host), URL_WITH_CREDS does fire in aggressive mode.
    const noDotHost = 'connect to https://admin:secret123@dbserver';
    const def = scrub(noDotHost);
    const agg = scrub(noDotHost, { aggressive: true });
    assert.equal(def.scrubbed.includes('<URL_WITH_CREDS>'), false);
    assert.match(agg.scrubbed, /<URL_WITH_CREDS>/);
  });

  it('aggressive mode redacts long hex strings (32+ chars)', () => {
    const hex = 'a'.repeat(64);
    const def = scrub(hex);
    const agg = scrub(hex, { aggressive: true });
    assert.equal(def.scrubbed.includes('<HEX_ID>'), false);
    assert.match(agg.scrubbed, /<HEX_ID>/);
  });

  it('aggressive mode redacts UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const def = scrub(uuid);
    const agg = scrub(uuid, { aggressive: true });
    assert.equal(def.scrubbed.includes('<UUID>'), false);
    assert.match(agg.scrubbed, /<UUID>/);
  });

  it('aggressive mode keeps default-mode behavior on top of extras', () => {
    const out = scrub('email a@b.com, uuid 550e8400-e29b-41d4-a716-446655440000', { aggressive: true });
    const ids = out.hits.map(h => h.id).sort();
    assert.ok(ids.includes('email'));
    assert.ok(ids.includes('uuid'));
  });
});

// ── scrubRecord ────────────────────────────────────────────────

describe('scrubRecord', () => {
  it('scrubs string values inside a flat object', () => {
    const out = scrubRecord({
      name: 'Alice',
      email: 'alice@example.com',
      note: 'IP 192.168.1.1',
    });
    assert.equal(out.scrubbed.name, 'Alice');
    assert.match(out.scrubbed.email, /<EMAIL>/);
    assert.match(out.scrubbed.note, /<IP>/);
  });

  it('recurses into nested objects', () => {
    const out = scrubRecord({
      user: { contact: { email: 'a@b.com' } },
    });
    assert.match(out.scrubbed.user.contact.email, /<EMAIL>/);
  });

  it('recurses into arrays', () => {
    const out = scrubRecord({
      events: ['ok', 'alice@example.com', 'fine'],
    });
    assert.equal(out.scrubbed.events[0], 'ok');
    assert.match(out.scrubbed.events[1], /<EMAIL>/);
    assert.equal(out.scrubbed.events[2], 'fine');
  });

  it('does NOT mutate the input', () => {
    const input = { email: 'a@b.com' };
    scrubRecord(input);
    assert.equal(input.email, 'a@b.com', 'input must remain unchanged');
  });

  it('aggregates hit counts across the whole structure', () => {
    const out = scrubRecord({
      a: 'one@a.com',
      b: ['two@b.com', { c: 'three@c.com' }],
    });
    const emailHit = out.hits.find(h => h.id === 'email');
    assert.equal(emailHit.count, 3);
  });

  it('handles null/undefined/primitives without throwing', () => {
    assert.deepEqual(scrubRecord(null), { scrubbed: null, hits: [] });
    assert.deepEqual(scrubRecord(undefined), { scrubbed: undefined, hits: [] });
    assert.deepEqual(scrubRecord(42), { scrubbed: 42, hits: [] });
  });

  it('passes opts (aggressive: true) through to inner scrub calls', () => {
    const out = scrubRecord({
      data: '550e8400-e29b-41d4-a716-446655440000',
    }, { aggressive: true });
    assert.match(out.scrubbed.data, /<UUID>/);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports scrub, scrubRecord, PATTERNS, AGGRESSIVE_PATTERNS', () => {
    const mod = require('../src/services/agents/pii-scrubber');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['AGGRESSIVE_PATTERNS', 'PATTERNS', 'scrub', 'scrubRecord']);
  });
});
