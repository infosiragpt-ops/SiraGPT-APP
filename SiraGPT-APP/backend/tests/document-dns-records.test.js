'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-dns-records');
const { extractDnsRecords, buildDnsRecordsForFiles, renderDnsRecordsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractDnsRecords('').total, 0);
  assert.equal(extractDnsRecords(null).total, 0);
});

test('detects zone-file A record', () => {
  const r = extractDnsRecords('example.com. 3600 IN A 1.2.3.4');
  assert.ok(r.entries.some((e) => e.type === 'A' && e.kind === 'zone'));
});

test('detects AAAA IPv6 record', () => {
  const r = extractDnsRecords('host.example.com. 300 IN AAAA 2001:db8::1');
  assert.ok(r.entries.some((e) => e.type === 'AAAA'));
});

test('detects CNAME record', () => {
  const r = extractDnsRecords('www.example.com. 300 IN CNAME example.com.');
  assert.ok(r.entries.some((e) => e.type === 'CNAME'));
});

test('detects MX record', () => {
  const r = extractDnsRecords('example.com. 3600 IN MX 10 mail.example.com.');
  assert.ok(r.entries.some((e) => e.type === 'MX'));
});

test('detects TXT record', () => {
  const r = extractDnsRecords('example.com. 300 IN TXT "v=spf1 -all"');
  assert.ok(r.entries.some((e) => e.type === 'TXT'));
});

test('detects SRV record', () => {
  const r = extractDnsRecords('_sip._tcp.example.com. 300 IN SRV 0 5 5060 host.example.com.');
  assert.ok(r.entries.some((e) => e.type === 'SRV'));
});

test('detects CAA record', () => {
  const r = extractDnsRecords('example.com. 300 IN CAA 0 issue "letsencrypt.org"');
  assert.ok(r.entries.some((e) => e.type === 'CAA'));
});

test('detects prose "Add an A record"', () => {
  const r = extractDnsRecords('Add an A record for the new host.');
  assert.ok(r.entries.some((e) => e.kind === 'prose'));
});

test('detects "create a CNAME record"', () => {
  const r = extractDnsRecords('Please create a CNAME record');
  assert.ok(r.entries.some((e) => e.type === 'CNAME' && e.kind === 'prose'));
});

test('dedupes identical zone lines', () => {
  const r = extractDnsRecords(
    'example.com. 3600 IN A 1.2.3.4\nexample.com. 3600 IN A 1.2.3.4'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `host${i}.example.com. 300 IN A 10.0.0.${i + 1}\n`;
  const r = extractDnsRecords(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by type', () => {
  const r = extractDnsRecords(`
    example.com. 300 IN A 1.2.3.4
    example.com. 300 IN AAAA 2001:db8::1
    www.example.com. 300 IN CNAME example.com.
    example.com. 300 IN MX 10 mail.example.com.
  `);
  assert.ok(r.totals.A >= 1);
  assert.ok(r.totals.AAAA >= 1);
  assert.ok(r.totals.CNAME >= 1);
  assert.ok(r.totals.MX >= 1);
});

test('buildDnsRecordsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.zone', extractedText: 'example.com. 3600 IN A 1.2.3.4' },
    { name: 'b.zone', extractedText: 'www.example.com. 300 IN CNAME example.com.' },
  ];
  const r = buildDnsRecordsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDnsRecordsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'zone.txt', extractedText: 'example.com. 3600 IN A 1.2.3.4' }];
  const r = buildDnsRecordsForFiles(files);
  const md = renderDnsRecordsBlock(r);
  assert.match(md, /^## DNS RECORDS/);
});

test('renderDnsRecordsBlock empty when nothing surfaces', () => {
  assert.equal(renderDnsRecordsBlock({ perFile: [] }), '');
  assert.equal(renderDnsRecordsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDnsRecordsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'example.com. 3600 IN A 1.2.3.4' },
  ]);
  assert.equal(r.perFile.length, 1);
});
