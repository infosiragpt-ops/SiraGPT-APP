'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateSources, assess, licenseEvidence, collectOne, collect, verify, render } = require('../../scripts/oss/catalog.cjs');
const pin = 'a'.repeat(40);
const entry = { slug: 'owner/project', category: 'sandbox', intent: 'lifecycle', target: 'backend/src/services/sandbox/' };
const sources = () => ({ schemaVersion: 1, unresolvedNames: [], entries: [{ ...entry }] });
function license(spdx = 'MIT') {
  const bytes = Buffer.from('Copyright Fixture Author\nMIT license fixture\n');
  return { path: 'LICENSE', encoding: 'base64', content: bytes.toString('base64'), sha: createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'), license: { spdx_id: spdx } };
}
async function request(endpoint) {
  if (endpoint.includes('/commits/')) return { sha: pin };
  if (endpoint.includes('/license?')) return license();
  return { full_name: 'new-owner/project', default_branch: 'release/next', archived: false };
}

test('source inventory rejects injection, duplicates and paths outside repo', () => {
  for (const slug of ['https://host/repo', '../etc', 'a/b/extra', '-R owner/repo', 'a/b?token=x', 'a/b\n']) {
    assert.throws(() => validateSources({ ...sources(), entries: [{ ...entry, slug }] }));
  }
  assert.throws(() => validateSources({ ...sources(), entries: [entry, { ...entry, slug: 'OWNER/PROJECT' }] }));
  for (const target of ['/tmp/escape', '../secret', 'x/../y']) assert.throws(() => validateSources({ ...sources(), entries: [{ ...entry, target }] }));
});

test('license evidence checks original Git blob and creates immutable URL', () => {
  const value = licenseEvidence('owner/repo', pin, license());
  assert.equal(value.url, `https://github.com/owner/repo/blob/${pin}/LICENSE`);
  assert.equal(value.sha256.length, 64);
  assert.deepEqual(value.reviewedModulePaths, []);
  assert.throws(() => licenseEvidence('owner/repo', pin, { ...license(), sha: 'b'.repeat(40) }));
  for (const p of ['../LICENSE', '/LICENSE', 'sub/../LICENSE', 'a\\LICENSE']) assert.throws(() => licenseEvidence('owner/repo', pin, { ...license(), path: p }));
  assert.throws(() => licenseEvidence('owner/repo', 'main', license()));
  assert.throws(() => licenseEvidence('owner/repo', pin, { ...license(), content: '' }));
});

test('all allowed root labels still require module review, never import approval', () => {
  for (const spdx of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'PostgreSQL']) {
    assert.equal(assess(entry, { commit: pin, licenseEvidence: { spdx } }), 'module-review-required');
  }
});

test('copyleft, mixed, exceptions and unknown labels never bypass strict allowlist', () => {
  for (const spdx of ['AGPL-3.0', 'GPL-3.0', 'LGPL-3.0', 'FSL-1.1-MIT', 'SSPL-1.0', 'Sustainable Use', 'NOASSERTION', 'UNKNOWN', '', 'MIT OR GPL-3.0', 'MIT AND Proprietary', 'Unlicense', 'Apache-2.0 WITH exception']) {
    assert.equal(assess(entry, { commit: pin, licenseEvidence: { spdx } }), 'license-review-no-copy');
  }
});

test('operator blocks and binary-only restriction win over MIT label', () => {
  const record = { commit: pin, licenseEvidence: { spdx: 'MIT' } };
  assert.equal(assess({ ...entry, category: 'blocked' }, record), 'operator-blocked');
  assert.equal(assess({ ...entry, category: 'binary-only' }, record), 'binary-review-only');
  assert.equal(assess({ ...entry, category: 'models' }, record), 'reference-only');
});

test('missing license or unresolved revision always prevents copying', () => {
  assert.equal(assess(entry, { commit: pin }), 'unverified-no-copy');
  assert.equal(assess(entry, { commit: 'main', licenseEvidence: { spdx: 'MIT' } }), 'unverified-no-copy');
});

test('collector follows canonical repo and binds license request to exact commit', async () => {
  const calls = [];
  const r = await collectOne(entry, async endpoint => { calls.push(endpoint); return request(endpoint); });
  assert.deepEqual(calls, ['repos/owner/project', 'repos/new-owner/project/commits/release%2Fnext', `repos/new-owner/project/license?ref=${pin}`]);
  assert.equal(r.canonical, 'new-owner/project');
  assert.equal(r.commit, pin);
  assert.equal(r.newSourceFilesImported, 0);
  assert.equal(r.decision, 'module-review-required');
});

test('missing repository records a blocker, not an invented SHA or license', async () => {
  const r = await collectOne(entry, async () => { throw new Error('github-http-404'); });
  assert.equal(r.commit, null);
  assert.equal(r.licenseEvidence, null);
  assert.deepEqual(r.issues, ['github-http-404']);
  assert.equal(r.decision, 'unverified-no-copy');
});

test('unexpected transport messages are redacted; auth/rate failures stop refresh', async () => {
  const r = await collectOne(entry, async () => { throw new Error('fixture-private-message'); });
  assert.equal(JSON.stringify(r).includes('fixture-private-message'), false);
  for (const code of [401, 403, 429]) await assert.rejects(collectOne(entry, async () => { throw new Error(`github-http-${code}`); }));
});

test('inventory evidence cannot omit, reorder or alter requested repositories', async () => {
  const source = sources();
  const evidence = await collect(source, request);
  assert.equal(verify(source, evidence), true);
  const changed = structuredClone(source);
  changed.entries[0].intent = 'different';
  assert.throws(() => verify(changed, evidence));
  for (const change of [e => { e.records = []; }, e => { e.records[0].slug = 'other/repo'; }, e => { e.records[0].newSourceFilesImported = 1; }, e => { e.records[0].decision = 'approved'; }, e => { e.records[0].commit = 'main'; }, e => { e.records[0].licenseEvidence.url = 'https://github.com/new-owner/project/blob/main/LICENSE'; }]) {
    const corrupted = structuredClone(evidence); change(corrupted);
    assert.throws(() => verify(source, corrupted));
  }
});

test('invalid upstream metadata or tampered license never becomes approved evidence', async () => {
  const r = await collectOne(entry, async endpoint => endpoint.includes('/license?') ? { ...license(), sha: '0'.repeat(40) } : request(endpoint));
  assert.equal(r.licenseEvidence, null);
  assert.equal(r.decision, 'unverified-no-copy');
  const invalid = await collectOne(entry, async () => ({ full_name: '../../secret', default_branch: 'main' }));
  assert.equal(invalid.canonical, null);
});

test('render is honest about imports, runtime scope and unknown repositories', async () => {
  const source = sources();
  const markdown = render(source, await collect(source, request));
  assert.match(markdown, /imports in this inventory are \*\*zero\*\*/);
  assert.match(markdown, /neither builds nor deploys Coding V2/);
  assert.match(markdown, /module-review-required/);
});

test('complete checked-in inventory and generated table stay in sync (offline CI)', () => {
  const root = path.resolve(__dirname, '../..');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'docs/oss/sources.json'), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/oss/catalog.lock.json'), 'utf8'));
  assert.equal(source.entries.length, 149);
  assert.equal(verify(source, evidence), true);
  assert.equal(fs.readFileSync(path.join(root, 'docs/oss-catalog-evidence.md'), 'utf8'), render(source, evidence));
});

test('bounded metadata collection preserves order despite asynchronous completion', async () => {
  const source = sources();
  source.entries = Array.from({ length: 9 }, (_, i) => ({ ...entry, slug: `owner/repo-${i}` }));
  let active = 0; let maximum = 0;
  const evidence = await collect(source, async endpoint => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return request(endpoint);
  });
  assert.equal(maximum, 4);
  assert.deepEqual(evidence.records.map(r => r.slug), source.entries.map(e => e.slug));
  assert.equal(verify(source, evidence), true);
});

test('offline CLI verification and rendering are reproducible without GitHub auth', () => {
  const root = path.resolve(__dirname, '../..');
  const cli = path.join(root, 'scripts/oss/catalog.cjs');
  const opts = { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 };
  assert.match(execFileSync(process.execPath, [cli, 'verify'], opts), /149 inventory records verified/);
  assert.equal(execFileSync(process.execPath, [cli, 'render'], opts), fs.readFileSync(path.join(root, 'docs/oss-catalog-evidence.md'), 'utf8'));
  assert.throws(() => execFileSync(process.execPath, [cli, 'not-a-command'], { ...opts, stdio: 'pipe' }), error => error.status === 1 && error.stderr.includes('OSS catalog command failed'));
});
