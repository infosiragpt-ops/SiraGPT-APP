'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-contact-info');
const { extractContactInfo, buildContactsForFiles, renderContactsBlock, _internal } = engine;
const { maskEmail, maskPhone } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractContactInfo('').total, 0);
  assert.equal(extractContactInfo(null).total, 0);
});

test('maskEmail keeps the first letter and the domain', () => {
  assert.equal(maskEmail('jane@example.com'), 'j***@example.com');
  assert.equal(maskEmail('a@example.com'), 'a@example.com');
});

test('maskPhone keeps the last 4 digits', () => {
  const masked = maskPhone('+1-555-123-7890');
  assert.match(masked, /7890$/);
  assert.ok(/\*/.test(masked));
});

test('extracts emails', () => {
  const text = 'Reach us at hello@acme.com or support@docs.acme.org.';
  const r = extractContactInfo(text);
  assert.equal(r.emails.length, 2);
  assert.ok(r.emails.some((e) => e.raw === 'hello@acme.com'));
});

test('extracts phone numbers', () => {
  const text = 'Call +1-555-123-7890 for assistance. International: +44 20 7946 0958.';
  const r = extractContactInfo(text);
  assert.ok(r.phones.length >= 1);
});

test('extracts social handles', () => {
  const text = 'Follow @acme on Twitter and linkedin.com/in/jane-doe';
  const r = extractContactInfo(text);
  assert.ok(r.socials.length >= 1);
});

test('extracts addresses', () => {
  const text = 'Office at 123 Main Street near the park.';
  const r = extractContactInfo(text);
  assert.ok(r.addresses.length >= 1);
});

test('dedupes identical contacts', () => {
  const text = 'jane@example.com jane@example.com jane@example.com';
  const r = extractContactInfo(text);
  assert.equal(r.emails.length, 1);
});

test('renders both raw and masked', () => {
  const files = [{ name: 'doc.md', extractedText: 'Email: jane@example.com Phone: +1 555 123 7890.' }];
  const r = buildContactsForFiles(files);
  const md = renderContactsBlock(r);
  assert.match(md, /^## CONTACT INFORMATION/);
  assert.match(md, /jane@example.com/);
  assert.match(md, /masked:/);
});

test('renderContactsBlock empty when nothing surfaces', () => {
  assert.equal(renderContactsBlock({ perFile: [] }), '');
  assert.equal(renderContactsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildContactsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'a@b.com' }]);
  assert.equal(r.perFile.length, 1);
});

test('caps contacts per kind per file', () => {
  let text = '';
  for (let i = 0; i < 12; i++) text += `user${i}@example.com `;
  const r = extractContactInfo(text);
  assert.ok(r.emails.length <= 6);
});

test('buildContactsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'jane@example.com' },
    { name: 'b.md', extractedText: 'john@example.org' },
  ];
  const r = buildContactsForFiles(files);
  assert.equal(r.perFile.length, 2);
});
