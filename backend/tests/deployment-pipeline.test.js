'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/services/deployments/pipeline');
const connectors = require('../src/services/deployments/provider-connectors');

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
  assert.equal(p.machineSpec('hostinger_vps').label, 'Hostinger VPS');
  assert.equal(p.machineSpec('aws').label, 'AWS target');
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

test('runPublishPipeline stops at security scan when blocking findings exist', () => {
  const dep = { id: 'depl_2', name: 'App', deploymentType: 'autoscale', machineTier: 'autoscale', geography: 'na' };
  const r = p.runPublishPipeline({ deployment: dep, seq: 0, hasFiles: true });
  assert.equal(r.finalStatus, 'failed');
  assert.equal(r.promoted, false);
  assert.equal(r.failedPhase, 'security_scan');
  assert.equal(r.phases.find((x) => x.name === 'security_scan').status, 'failed');
  assert.equal(r.phases.some((x) => x.name === 'build'), false);
  assert.equal(r.phases.some((x) => x.name === 'promote'), false);
});

test('runPublishPipeline can stop at bundle/promote provider gates', () => {
  const dep = { id: 'depl_1', name: 'App', deploymentType: 'autoscale', machineTier: 'autoscale', geography: 'na' };
  const bundle = p.runPublishPipeline({ deployment: dep, seq: 0, hasFiles: true, failPhase: 'bundle' });
  assert.equal(bundle.finalStatus, 'failed');
  assert.equal(bundle.failedPhase, 'bundle');
  assert.equal(bundle.phases.find((x) => x.name === 'bundle').status, 'failed');
  assert.equal(bundle.phases.some((x) => x.name === 'promote'), false);

  const promote = p.runPublishPipeline({ deployment: dep, seq: 0, hasFiles: true, failPhase: 'promote' });
  assert.equal(promote.finalStatus, 'failed');
  assert.equal(promote.failedPhase, 'promote');
  assert.equal(promote.phases.find((x) => x.name === 'promote').status, 'failed');
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

test('providerReadiness reports missing env without exposing values', () => {
  const ready = connectors.providerReadiness('hostinger_vps', {
    HOSTINGER_VPS_HOST: '62.72.11.231',
  });
  assert.equal(ready.configured, false);
  assert.deepEqual(ready.missingRequired, ['HOSTINGER_VPS_USER', 'HOSTINGER_VPS_SSH_PRIVATE_KEY']);
  assert.equal(ready.requiredEnv.find((row) => row.key === 'HOSTINGER_VPS_HOST').configured, true);
  assert.equal(JSON.stringify(ready).includes('62.72.11.231'), false);
});

test('AWS readiness accepts standard AWS environment variables', () => {
  const ready = connectors.providerReadiness('aws', {
    AWS_ACCESS_KEY_ID: 'AKIA_TEST',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_REGION: 'us-east-1',
  });
  assert.equal(ready.configured, true);
  assert.deepEqual(ready.missingRequired, []);
});

test('splitGoDaddyHostname derives root domain and record name', () => {
  assert.deepEqual(connectors.splitGoDaddyHostname('app.example.com'), {
    hostname: 'app.example.com',
    rootDomain: 'example.com',
    recordName: 'app',
  });
  assert.deepEqual(connectors.splitGoDaddyHostname('sira.com.pe'), {
    hostname: 'sira.com.pe',
    rootDomain: 'sira.com.pe',
    recordName: '@',
  });
});

test('buildConnectionPlan returns safe Hostinger SSH target metadata', () => {
  const plan = connectors.buildConnectionPlan({
    providerId: 'hostinger_vps',
    deployment: { id: 'depl_1', subdomain: 'siragpt', externalPort: 5050 },
    env: {
      HOSTINGER_VPS_HOST: '62.72.11.231',
      HOSTINGER_VPS_USER: 'root',
      HOSTINGER_VPS_SSH_PRIVATE_KEY: 'VERY_SECRET_BODY',
      HOSTINGER_VPS_APP_PATH: '/opt/siragpt',
    },
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.target.host, '62.72.11.231');
  assert.equal(plan.target.appPort, 5050);
  assert.equal(JSON.stringify(plan).includes('VERY_SECRET_BODY'), false);
});

test('applyGoDaddyDnsRecords no-ops when credentials are missing', async () => {
  let called = false;
  const result = await connectors.applyGoDaddyDnsRecords({
    hostname: 'app.example.com',
    records: [{ type: 'A', name: 'app.example.com', value: '1.2.3.4', ttl: 600 }],
    env: {},
    fetchImpl: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(called, false);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'missing_env');
  assert.deepEqual(result.missingRequired, ['GODADDY_API_KEY', 'GODADDY_API_SECRET']);
});

test('applyGoDaddyDnsRecords calls GoDaddy Domains API with sso-key auth', async () => {
  const calls = [];
  const result = await connectors.applyGoDaddyDnsRecords({
    hostname: 'app.example.com',
    records: [
      { type: 'A', name: 'app.example.com', value: '1.2.3.4', ttl: 600 },
      { type: 'TXT', name: 'app.example.com', value: 'replit-verify=abcd', ttl: 600 },
    ],
    env: {
      GODADDY_API_KEY: 'key',
      GODADDY_API_SECRET: 'secret',
      GODADDY_API_BASE_URL: 'https://api.ote-godaddy.com',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.ote-godaddy.com/v1/domains/example.com/records/A/app');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.Authorization, 'sso-key key:secret');
  assert.deepEqual(JSON.parse(calls[0].init.body), [{ data: '1.2.3.4', ttl: 600 }]);
});
