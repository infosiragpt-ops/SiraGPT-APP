'use strict';

/**
 * Fixes from the professional review of the PyPI vetting (#1054):
 *  - the version vetted is the version installed: chosen the way pip would
 *    (wheel for CPython 3.12 / glibc Linux, requires-python, the user's
 *    specifier) and sent to pip as an exact pin, dependencies included;
 *  - a release must be public for 7 days (hijacked releases of established
 *    projects are pulled within days);
 *  - approvals expire in 30 minutes, verdicts without adoption data are never
 *    cached, a look-alike name without data is "unavailable", not condemned;
 *  - the response body is read inside the timeout; a paginated OSV answer
 *    cannot clear a package; CWE-506 and compromised-package wording count.
 * Offline: PyPI, OSV and pypistats are a fake fetch.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vetting = require('../src/services/agent-runner/sandbox-packages/vetting');
const policyLib = require('../src/services/agent-runner/sandbox-packages/policy');
const tools = require('../src/services/agent-runner/tools');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-21T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const wheel = (dist, version, tags = 'py3-none-any', at = daysAgo(400), extra = {}) => ({
  filename: `${dist}-${version}-${tags}.whl`, 'upload-time': at, yanked: false, ...extra,
});

function fakeFetch({ files = {}, downloads = {}, osv = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.startsWith('https://pypi.org/simple/')) {
      const name = decodeURIComponent(u.slice('https://pypi.org/simple/'.length).replace(/\/$/, ''));
      if (!files[name]) return response(404, {});
      return response(200, { name, files: files[name], versions: [...new Set(files[name].map((f) => vetting.wheelVersion(f.filename)).filter(Boolean))] });
    }
    if (u === 'https://api.osv.dev/v1/query') {
      const q = JSON.parse(init.body);
      const handler = osv[q.package.name];
      return response(200, typeof handler === 'function' ? handler(q) : (handler || {}));
    }
    if (u.startsWith('https://pypistats.org/api/packages/')) {
      const name = decodeURIComponent(u.split('/')[5]);
      return name in downloads ? response(200, { data: { last_month: downloads[name] } }) : response(429, {});
    }
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls };
}

const vet = (name, net, opts = {}) => vetting.vetPackage(name, { fetchImpl: net.fetchImpl, now: NOW, arch: 'x86_64', ...opts });

test('the release chosen is one pip can install on the sandbox (CPython 3.12, glibc Linux x86_64)', async () => {
  const files = {
    numlib: [
      wheel('numlib', '1.0.0', 'cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64'),
      // Newer, but only for macOS / Windows / Python 3.13 / musl / a newer glibc.
      wheel('numlib', '2.0.0', 'cp312-cp312-macosx_11_0_arm64'),
      wheel('numlib', '2.0.0', 'cp312-cp312-win_amd64'),
      wheel('numlib', '2.0.0', 'cp313-cp313-manylinux_2_17_x86_64'),
      wheel('numlib', '2.0.0', 'cp312-cp312-musllinux_1_1_x86_64'),
      wheel('numlib', '2.0.0', 'cp312-cp312-manylinux_2_40_x86_64'),
      // Pure-python but requires a newer Python.
      wheel('numlib', '1.5.0', 'py3-none-any', daysAgo(300), { 'requires-python': '>=3.13' }),
    ],
  };
  const net = fakeFetch({ files, downloads: { numlib: 900_000 } });
  const verdict = await vet('numlib', net);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.evidence.version, '1.0.0');
  assert.equal(verdict.pin, 'numlib==1.0.0');
  assert.equal(net.calls.find((c) => c.url.includes('osv')).body.version, '1.0.0', 'OSV is asked about the version that will be installed');
  assert.equal(vetting.wheelCompatible('x-1-cp311-abi3-manylinux2014_x86_64.whl', 'x86_64'), true, 'abi3 from an older CPython works on 3.12');
  assert.equal(vetting.wheelCompatible('x-1-cp311-cp311-manylinux2014_x86_64.whl', 'x86_64'), false);
  assert.equal(vetting.wheelCompatible('x-1-py2.py3-none-any.whl', 'x86_64'), true);
  assert.equal(vetting.wheelCompatible('x-1-py2-none-any.whl', 'x86_64'), false);
  const none = await vet('numlib', fakeFetch({ files: { numlib: [files.numlib[1]] }, downloads: { numlib: 900_000 } }));
  assert.equal(none.reason, 'no_wheels');
  assert.match(none.detail, /Python 3\.12 on Linux x86_64/);
});

test('ranges and pins are honoured exactly; a yanked pin or a pin that does not exist is refused', async () => {
  const files = {
    lib: [
      wheel('lib', '1.0.0'), wheel('lib', '1.4.2'), wheel('lib', '2.0.0'),
      wheel('lib', '1.9.0', 'py3-none-any', daysAgo(200), { yanked: true }),
      wheel('lib', '2.1.0rc1'),
    ],
  };
  const net = () => fakeFetch({ files, downloads: { lib: 50_000 } });
  assert.equal((await vet('lib', net())).evidence.version, '2.0.0', 'stable, not the release candidate');
  assert.equal((await vet('lib', net(), { specifier: '>=1,<2' })).evidence.version, '1.4.2', 'highest inside the range (1.9.0 is yanked)');
  assert.equal((await vet('lib', net(), { specifier: '~=1.0' })).evidence.version, '1.4.2');
  assert.equal((await vet('lib', net(), { specifier: '==1.0.*' })).evidence.version, '1.0.0');
  assert.equal((await vet('lib', net(), { specifier: '==2.1.0rc1' })).evidence.version, '2.1.0rc1', 'an explicit pre-release pin is allowed');
  for (const specifier of ['==1.9.0', '==3.0', '==v1.0.0']) {
    const verdict = await vet('lib', net(), { specifier });
    assert.equal(verdict.ok, false, specifier);
    assert.equal(verdict.reason, 'version_not_found', specifier);
  }
  assert.equal(vetting.versionMatches('1.4.2', '>=1,<2,!=1.4.1'), true);
  assert.equal(vetting.versionMatches('1.4.2', 'garbage'), false, 'unparsable specifiers never match');
});

test('a release younger than 7 days is not installed: an older one is chosen, or an explicit pin is refused', async () => {
  const files = { tool: [wheel('tool', '2.0.0', 'py3-none-any', daysAgo(500)), wheel('tool', '3.0.0', 'py3-none-any', daysAgo(40)), wheel('tool', '3.1.0', 'py3-none-any', daysAgo(2))] };
  const net = () => fakeFetch({ files, downloads: { tool: 2_000_000 } });
  const verdict = await vet('tool', net());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.evidence.version, '3.0.0', 'the newest release old enough');
  const pinned = await vet('tool', net(), { specifier: '==3.1.0' });
  assert.equal(pinned.reason, 'release_too_new');
  assert.match(pinned.detail, /published 2 day\(s\) ago; releases need 7 days/);
  // A wheel added recently to an OLD release makes that release new again.
  const patched = { tool: [wheel('tool', '2.0.0', 'py3-none-any', daysAgo(500)), wheel('tool', '3.0.0', 'py3-none-any', daysAgo(40)), wheel('tool', '3.0.0', 'cp312-cp312-manylinux_2_17_x86_64', daysAgo(1))] };
  const patchedVerdict = await vet('tool', fakeFetch({ files: patched, downloads: { tool: 2_000_000 } }));
  assert.equal(patchedVerdict.evidence.version, '2.0.0', 'the re-touched 3.0.0 waits; the previous release is used');
  const onlyPatched = { tool: [wheel('tool', '3.0.0', 'py3-none-any', daysAgo(400)), wheel('tool', '3.0.0', 'cp312-cp312-manylinux_2_17_x86_64', daysAgo(1))] };
  assert.equal((await vet('tool', fakeFetch({ files: onlyPatched, downloads: { tool: 2_000_000 } }))).reason, 'release_too_new');
});

test('the installer receives exactly the vetted pins, extras kept, dependencies pinned on the retry', async () => {
  const policy = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1' });
  const verdict = (name, version) => ({ ok: true, name, reason: 'vetted', detail: '', evidence: { version, ageDays: 900, monthlyDownloads: 100_000 } });
  const installs = [];
  const sandbox = {
    driver: 'docker',
    async installPythonPackages(opts) {
      installs.push(opts);
      return installs.length === 1
        ? { ok: false, code: 'not_allowed', installed: [], notAllowed: ['interface-meta'], notFound: [], bytes: 0, durationMs: 1, detail: '' }
        : { ok: true, code: 'ok', installed: [{ name: 'formulaic', version: '1.1.0' }], notAllowed: [], notFound: [], bytes: 10, durationMs: 1, detail: '' };
    },
    async readFile() { throw new Error('ENOENT'); },
    async writeFile() {},
    async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
  };
  const vetter = { async vet(entries) { return entries.map((e) => verdict(e.name, e.name === 'formulaic' ? '1.1.0' : '1.2.0')); } };
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy, vetter } });
  const out = await executors.install_sandbox_package({ packages: ['formulaic[arrow]>=1'] });
  assert.match(out, /^Installed into the sandbox: formulaic 1\.1\.0/);
  assert.deepEqual(installs[0].requirements, ['formulaic[arrow]==1.1.0'], 'never the open range: the exact vetted release, extras kept');
  assert.deepEqual(installs[1].requirements, ['formulaic[arrow]==1.1.0', 'interface-meta==1.2.0'], 'the dependency is pinned to its vetted release');

  // When the pinned dependency conflicts with what the package needs, say so.
  const conflict = {
    ...sandbox,
    async installPythonPackages(opts) {
      installs.push(opts);
      return installs.length % 2 === 1
        ? { ok: false, code: 'not_allowed', installed: [], notAllowed: ['interface-meta'], notFound: [], bytes: 0, durationMs: 1, detail: '' }
        : { ok: false, code: 'conflict', installed: [], notAllowed: [], notFound: [], bytes: 0, durationMs: 1, detail: '' };
    },
  };
  installs.length = 0;
  const failed = await tools.makeToolExecutors(conflict, { capability: { policy, vetter } }).install_sandbox_package({ packages: ['formulaic'] });
  assert.match(failed, /dependencies only install at the vetted releases \(interface-meta==1\.2\.0\)/);
});

test('approvals expire in 30 minutes; verdicts without adoption data are never cached', async () => {
  let clock = NOW;
  const scrapyReleases = ['2.7.0', '2.8.0', '2.9.0', '2.10.0', '2.11.0'].map((v, i) => wheel('scrapy', v, 'py3-none-any', daysAgo(900 - i * 120)));
  const files = { lifelines: [wheel('lifelines', '0.30.0')], scrapy: scrapyReleases };
  const net = fakeFetch({ files, downloads: { lifelines: 1_000_000 } });
  const vetter = vetting.createVetter({ fetchImpl: net.fetchImpl, now: () => clock });
  await vetter.vet([{ name: 'lifelines' }]);
  const pypiCalls = () => net.calls.filter((c) => c.url.includes('pypi.org')).length;
  const afterFirst = pypiCalls();
  clock += 20 * 60 * 1000;
  await vetter.vet([{ name: 'lifelines' }]);
  assert.equal(pypiCalls(), afterFirst, 'cached within 30 minutes');
  clock += 15 * 60 * 1000;
  await vetter.vet([{ name: 'lifelines' }]);
  assert.equal(pypiCalls(), afterFirst + 1, 're-checked after 30 minutes');
  // pypistats is "down" for scrapy (429): a look-alike of «scapy» is neither
  // cleared nor condemned, and the verdict is not cached.
  const [first] = await vetter.vet([{ name: 'scrapy' }]);
  assert.equal(first.reason, 'vet_unavailable');
  assert.match(first.detail, /resembles «scapy»/);
  const before = pypiCalls();
  await vetter.vet([{ name: 'scrapy' }]);
  assert.equal(pypiCalls(), before + 1, 'not cached');
});

test('a stalled body times out inside the guard, and a paginated OSV answer cannot clear a package', async () => {
  const stalled = async (url, init) => {
    if (String(url).startsWith('https://pypi.org')) {
      return { status: 200, ok: true, json: () => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) };
    }
    return response(200, {});
  };
  const started = Date.now();
  const verdict = await vetting.vetPackage('lifelines', { fetchImpl: stalled, now: NOW, arch: 'x86_64' });
  assert.equal(verdict.reason, 'vet_unavailable');
  assert.ok(Date.now() - started < 15_000, 'bounded by the request timeout');

  const paginated = fakeFetch({
    files: { lifelines: [wheel('lifelines', '0.30.0')] },
    downloads: { lifelines: 1_000_000 },
    osv: { lifelines: { next_page_token: 'abc' } },
  });
  const p = await vet('lifelines', paginated);
  assert.equal(p.reason, 'vet_unavailable');
  assert.match(p.detail, /osv_paginated/);
});

test('malware advisories: CWE-506 and compromised-package wording count, ordinary vulnerability wording does not', () => {
  const mal = (vuln) => vetting.isMaliciousAdvisory({ id: 'GHSA-x', ...vuln });
  assert.equal(mal({ summary: 'Embedded Malicious Code in ctx' }), true);
  assert.equal(mal({ summary: 'ctx', details: 'The project was taken over via user account compromise and replaced with a malicious project.' }), true);
  assert.equal(mal({ summary: 'Package', database_specific: { cwe_ids: ['CWE-506'] } }), true);
  assert.equal(mal({ summary: 'An info stealer was published in release 1.2' }), true);
  assert.equal(mal({ summary: 'The maintainer account was compromised' }), true);
  for (const ordinary of [
    'Account takeover via password reset poisoning',
    'Session hijacking through a predictable token',
    'A malicious payload in a crafted file causes code execution',
    'Allows a malicious user to execute malicious code',
  ]) {
    assert.equal(mal({ summary: ordinary }), false, ordinary);
  }
});
