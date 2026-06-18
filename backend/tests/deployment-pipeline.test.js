'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/services/deployments/pipeline');

test('generateShortHash is deterministic, 8 chars, seq-sensitive', () => {
  assert.equal(p.generateShortHash('depl_1', 0), p.generateShortHash('depl_1', 0));
  assert.equal(p.generateShortHash('depl_1', 0).length, 8);
  assert.notEqual(p.generateShortHash('depl_1', 0), p.generateShortHash('depl_1', 1));
  assert.match(p.generateShortHash('depl_1', 0), /^[0-9a-f]{8}$/);
});

test('slugifySubdomain strips diacritics + unsafe chars, adds stable suffix', () => {
  const a = p.slugifySubdomain('Mi App Probada áéí!!', 'depl_abc');
  assert.match(a, /^mi-app-probada-aei-[a-z0-9]{1,4}$/);
  assert.equal(a, p.slugifySubdomain('Mi App Probada áéí!!', 'depl_abc')); // deterministic
  assert.equal(p.slugifySubdomain('', 'depl_abc').startsWith('app-'), true);
});

test('machineSpec maps reserved VM tiers to label + resources', () => {
  const s = p.machineSpec('reserved_vm', '2vcpu_8gb');
  assert.equal(s.label, 'Reserved VM (Dedicated 2 vCPU / 8 GiB RAM)');
  assert.equal(s.cpu, 2);
  assert.equal(s.memoryMb, 8192);
  assert.equal(s.monthlyUsd, 80);
  assert.equal(p.machineSpec('static').label, 'Static (CDN)');
  assert.equal(p.machineSpec('autoscale').label, 'Autoscale');
});

test('defaultDomain mirrors the published Replit subdomain shape', () => {
  assert.equal(p.defaultDomain('my-app'), 'https://my-app.replit.app');
});

test('runPublishPipeline returns the 5 phases and promotes when files exist', () => {
  const dep = { id: 'depl_1', name: 'App', deploymentType: 'autoscale', machineTier: 'autoscale', geography: 'na' };
  const r = p.runPublishPipeline({ deployment: dep, seq: 0, hasFiles: true });
  assert.deepEqual(r.phases.map((x) => x.name), p.PUBLISH_PHASES);
  assert.equal(r.finalStatus, 'running');
  assert.equal(r.promoted, true);
  assert.ok(r.logs.length > 0);
  assert.match(r.shortHash, /^[0-9a-f]{8}$/);
});

test('runPublishPipeline fails the build with no files (no promote/bundle)', () => {
  const dep = { id: 'depl_1', name: 'App', deploymentType: 'autoscale', machineTier: 'autoscale', geography: 'na' };
  const r = p.runPublishPipeline({ deployment: dep, seq: 1, hasFiles: false });
  assert.equal(r.finalStatus, 'failed');
  assert.equal(r.promoted, false);
  assert.equal(r.phases.find((x) => x.name === 'build').status, 'failed');
  assert.equal(r.phases.some((x) => x.name === 'promote'), false);
});

test('dnsRecordsFor returns A + permanent TXT verify record', () => {
  const recs = p.dnsRecordsFor('www.example.com', 'depl_1');
  assert.equal(recs[0].type, 'A');
  assert.match(recs[0].value, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(recs[1].type, 'TXT');
  assert.match(recs[1].value, /^replit-verify=/);
});

test('parseLogEntries classifies source (System/User) and error level', () => {
  const text = '[provision] booting\nGET / 200\n[security] 1 issue found\nprisma:error connection refused';
  const entries = p.parseLogEntries(text, 0);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].source, 'System');
  assert.equal(entries[1].source, 'User');
  assert.equal(entries[3].level, 'error'); // "refused"
  assert.ok(entries.every((e) => typeof e.ts === 'string'));
});

test('securityScanReport is deterministic and passes without critical findings', () => {
  const a = p.securityScanReport('seed-1');
  assert.deepEqual(a, p.securityScanReport('seed-1'));
  assert.ok(['passed', 'failed'].includes(a.status));
  assert.ok(Array.isArray(a.findings));
});
