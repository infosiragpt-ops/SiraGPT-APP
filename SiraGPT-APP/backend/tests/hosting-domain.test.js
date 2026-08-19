'use strict';

const test = require('node:test');
const assert = require('node:assert');

const domain = require('../src/services/hosting/domain');
const { friendlyError } = require('../src/services/hosting/deploy.service');

test('remotePathForDomain: main vs addon', () => {
  assert.equal(domain.remotePathForDomain('x.com', { kind: 'main', baseDir: '/public_html' }), '/public_html');
  assert.equal(domain.remotePathForDomain('shop.x.com', { kind: 'addon' }), 'domains/shop.x.com/public_html');
  assert.equal(domain.remotePathForDomain('https://X.com/', { kind: 'addon' }), 'domains/x.com/public_html');
});

test('normalizeDomain strips scheme/path', () => {
  assert.deepEqual(domain.normalizeDomain('https://Foo.com/bar'), { host: 'foo.com', url: 'https://foo.com' });
  assert.deepEqual(domain.normalizeDomain(''), { host: '', url: '' });
});

test('dnsInstructions returns nameservers + A-records when host is an IP', () => {
  const d = domain.dnsInstructions({ host: '62.72.11.231' }, 'mydomain.com');
  assert.deepEqual(d.nameservers, ['ns1.dns-parking.com', 'ns2.dns-parking.com']);
  assert.equal(d.aRecords.length, 2);
  assert.equal(d.aRecords[0].value, '62.72.11.231');
  assert.equal(d.domain, 'mydomain.com');
});

test('dnsInstructions omits A-records when host is not an IP', () => {
  const d = domain.dnsInstructions({ host: 'ftp.mydomain.com' }, 'mydomain.com');
  assert.equal(d.aRecords.length, 0);
});

test('verifyUrl: reachable + unreachable (mocked fetch)', async () => {
  const ok = await domain.verifyUrl('https://x.com', { fetchImpl: async () => ({ status: 200 }) });
  assert.equal(ok.reachable, true);
  assert.equal(ok.status, 200);

  const bad = await domain.verifyUrl('https://x.com', {
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal(bad.reachable, false);

  const invalid = await domain.verifyUrl('not-a-url');
  assert.equal(invalid.reachable, false);
});

test('friendlyError classifies common failures', () => {
  assert.match(friendlyError(new Error('Permission denied (publickey)')), /Autenticación/);
  assert.match(friendlyError(new Error('connect ETIMEDOUT')), /conectar/);
  assert.match(friendlyError(new Error('No such file')), /Ruta remota/);
});
