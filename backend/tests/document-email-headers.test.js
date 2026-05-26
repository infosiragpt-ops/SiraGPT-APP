'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-email-headers');
const { extractEmailHeaders, buildEmailHeadersForFiles, renderEmailHeadersBlock, _internal } = engine;
const { maskEmail } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractEmailHeaders('').total, 0);
  assert.equal(extractEmailHeaders(null).total, 0);
});

test('maskEmail: keeps domain, masks local', () => {
  assert.equal(maskEmail('alice@example.com'), 'a***e@example.com');
  assert.equal(maskEmail('a@b.co'), 'a@b.co');
});

test('detects From header', () => {
  const r = extractEmailHeaders('From: Alice <alice@example.com>');
  assert.ok(r.entries.some((e) => e.role === 'from'));
});

test('From email is masked', () => {
  const r = extractEmailHeaders('From: alice.smith@example.com');
  for (const e of r.entries) {
    if (e.role === 'from') {
      assert.ok(!/alice\.smith/.test(e.value));
    }
  }
});

test('detects To header', () => {
  const r = extractEmailHeaders('To: bob@example.com');
  assert.ok(r.entries.some((e) => e.role === 'to'));
});

test('detects Cc header', () => {
  const r = extractEmailHeaders('Cc: charlie@example.com');
  assert.ok(r.entries.some((e) => e.role === 'cc'));
});

test('detects Subject', () => {
  const r = extractEmailHeaders('Subject: Quarterly Report Q3 2025');
  assert.ok(r.entries.some((e) => e.role === 'subject' && /Quarterly/.test(e.value)));
});

test('detects Date', () => {
  const r = extractEmailHeaders('Date: Wed, 21 Oct 2025 07:28:00 +0000');
  assert.ok(r.entries.some((e) => e.role === 'date'));
});

test('detects Message-ID', () => {
  const r = extractEmailHeaders('Message-Id: <ABCD1234@mail.example.com>');
  assert.ok(r.entries.some((e) => e.role === 'message-id'));
});

test('detects In-Reply-To', () => {
  const r = extractEmailHeaders('In-Reply-To: <previous-msg@example.com>');
  assert.ok(r.entries.some((e) => e.role === 'in-reply-to'));
});

test('detects References', () => {
  const r = extractEmailHeaders('References: <a@x.com> <b@x.com>');
  assert.ok(r.entries.some((e) => e.role === 'references'));
});

test('detects X-Mailer', () => {
  const r = extractEmailHeaders('X-Mailer: Apple Mail (2.3445.6.1)');
  assert.ok(r.entries.some((e) => e.role === 'x-mailer'));
});

test('detects List-Id (mailing list)', () => {
  const r = extractEmailHeaders('List-Id: <engineering.lists.example.com>');
  assert.ok(r.entries.some((e) => e.role === 'list-id'));
});

test('dedupes identical header+value', () => {
  const r = extractEmailHeaders('Subject: Hello\nSubject: Hello');
  assert.equal(r.entries.filter((e) => e.role === 'subject').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Subject: Email ${i}\n`;
  const r = extractEmailHeaders(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by role', () => {
  const r = extractEmailHeaders(
    'From: alice@x.com\nTo: bob@x.com\nSubject: Hello\nDate: Wed, 1 Jan 2025 00:00:00'
  );
  assert.ok(r.totals.from >= 1);
  assert.ok(r.totals.to >= 1);
  assert.ok(r.totals.subject >= 1);
});

test('buildEmailHeadersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.eml', extractedText: 'From: alice@x.com' },
    { name: 'b.eml', extractedText: 'To: bob@x.com' },
  ];
  const r = buildEmailHeadersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderEmailHeadersBlock NEVER contains full email local', () => {
  const files = [{ name: 'msg.eml', extractedText: 'From: alice.fullname@example.com' }];
  const r = buildEmailHeadersForFiles(files);
  const md = renderEmailHeadersBlock(r);
  assert.ok(!/alice\.fullname/.test(md));
});

test('renderEmailHeadersBlock empty when nothing surfaces', () => {
  assert.equal(renderEmailHeadersBlock({ perFile: [] }), '');
  assert.equal(renderEmailHeadersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildEmailHeadersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'From: alice@x.com' },
  ]);
  assert.equal(r.perFile.length, 1);
});
