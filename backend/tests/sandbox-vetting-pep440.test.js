'use strict';

/**
 * PyPI vetting reads versions the way pip does (PEP 440, as implemented by
 * packaging 26, which modern pip vendors). Every expected value below was
 * checked against packaging; a differential run of 17 190 specifier cases,
 * 6 400 orderings, 792 wheel tags and 6 000 random cases matched exactly.
 * Each test fails without the fix:
 *  - releases were grouped by how a FILE spells the version, so a fresh
 *    «pkg-1.0.0-cp312-….whl» uploaded to an old «1.0» release (one release to
 *    PyPI and to pip) slipped past the 7-day quarantine and OSV, and spellings
 *    the parser did not know («1.0c1», «0!1.0») were invisible to both;
 *  - ordering and the exclusive rules of < and > did not follow PEP 440
 *    («<2.0» admitted 2.0rc1, «>1.0» admitted 1.0.post1, 1.0.dev1 sorted after
 *    1.0a1), «>=2.0.dev0» did not opt into pre-releases and «!=2.0rc1» did;
 *  - wildcard prefixes went through Number() («==0x10.*» matched 16.x);
 *  - a file without an upload time counted as published in 1970;
 *  - wheel tags pip rejects («cp312-cp312-any», «cp38-abi3-any») were accepted
 *    and an invalid requires-python (which pip ignores) hid a release;
 *  - ordinary vulnerability wording («an archive containing malicious
 *    symlinks», «allowing malicious updates via MITM», «an attacker with a
 *    compromised account») refused the package AND reported it as malware.
 * Offline: PyPI, OSV and pypistats are a fake fetch.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vetting = require('../src/services/agent-runner/sandbox-packages/vetting');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-22T00:00:00Z');
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
      return response(200, { name, files: files[name] });
    }
    if (u === 'https://api.osv.dev/v1/query') {
      const q = JSON.parse(init.body);
      return response(200, osv[q.package.name] || {});
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

test('a fresh file uploaded to an old release under another spelling cannot skip the quarantine', async () => {
  // «1.0» published 700 days ago; a hijacked account adds «1.0.0» (the SAME
  // release to PyPI and to pip, which prefers the cp312 wheel) yesterday.
  const hijacked = {
    pkg: [
      wheel('pkg', '0.9', 'py3-none-any', daysAgo(900)),
      wheel('pkg', '1.0', 'py3-none-any', daysAgo(700)),
      wheel('pkg', '1.0.0', 'cp312-cp312-manylinux_2_17_x86_64', daysAgo(1)),
    ],
  };
  const verdict = await vet('pkg', fakeFetch({ files: hijacked, downloads: { pkg: 900_000 } }));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.evidence.version, '0.9', 'the re-touched release waits; the previous one is used');
  const pinned = await vet('pkg', fakeFetch({ files: hijacked, downloads: { pkg: 900_000 } }), { specifier: '==1.0' });
  assert.equal(pinned.reason, 'release_too_new');
  // Spellings the old parser did not know are the same release too.
  for (const spelling of ['0!1.0', '1.0.0.0', 'v1.0']) {
    const files = { pkg: [wheel('pkg', '1.0', 'py3-none-any', daysAgo(700)), wheel('pkg', spelling, 'py3-none-any', daysAgo(2))] };
    assert.equal((await vet('pkg', fakeFetch({ files, downloads: { pkg: 900_000 } }))).reason, 'release_too_new', spelling);
  }
  const rc = { pkg: [wheel('pkg', '2.0rc1', 'py3-none-any', daysAgo(300)), wheel('pkg', '2.0c1', 'cp312-cp312-manylinux_2_17_x86_64', daysAgo(1))] };
  assert.equal((await vet('pkg', fakeFetch({ files: rc, downloads: { pkg: 900_000 } }), { specifier: '==2.0rc1' })).reason, 'release_too_new', '«2.0c1» is «2.0rc1»');
  // The pin keeps the release's original spelling, and OSV is asked about it.
  const net = fakeFetch({ files: { pkg: [wheel('pkg', '1.0', 'py3-none-any', daysAgo(700)), wheel('pkg', '1.0.0', 'cp312-cp312-manylinux_2_17_x86_64', daysAgo(600))] }, downloads: { pkg: 900_000 } });
  const old = await vet('pkg', net);
  assert.equal(old.pin, 'pkg==1.0');
  assert.equal(net.calls.find((c) => c.url.includes('osv')).body.version, '1.0');
});

test('specifiers follow PEP 440 exactly as pip reads them', () => {
  const cases = [
    // Exclusive ordered comparisons.
    ['2.0rc1', '<2.0', false], ['2.0.dev1', '<2.0', false], ['1.9', '<2.0', true], ['2.0rc1', '<2.0rc2', true],
    ['1.0a1', '<1.0.post1', true], ['2.0rc1', '<2.0.post0', true],
    ['1.0.post1', '>1.0', false], ['1.0+local', '>1.0', false], ['1.1', '>1.0', true],
    ['1.0.post1', '>1.0a1', true], ['1.0.post1', '>1.0.dev1', true], ['1.0.post2', '>1.0.post1', true], ['1.0.post1', '>1.0.post1', false],
    ['1.0.dev1', '>=1.0a1', false],
    // Prefix wildcards.
    ['1.2.5', '==1.2.*', true], ['1.20', '==1.2.*', false], ['1.2rc1', '==1.2.*', true], ['1.2.post1', '==1.2.*', true],
    ['2', '==2.0.*', true], ['16.0', '==0x10.*', null], ['1000.0', '==1e3.*', null], ['0.5', '==.*', null],
    ['1.0.5', '==1..*', null], ['1.0rc1', '==1.0rc1.*', null],
    // Compatible release.
    ['2.9', '~=2.2', true], ['3.0', '~=2.2', false], ['1.4.5', '~=1.4.2', true], ['1.5.0', '~=1.4.2', false], ['1.0', '~=1', null],
    // Equality, spellings, epochs and local labels.
    ['1.0.0', '==1.0', true], ['1.0+local', '==1.0', true], ['1.0', '==1.0+local', false], ['1.0.0', '==v1.0.0', true],
    ['0!1.0', '==1.0', true], ['1!0.5', '>=2.0', true], ['1.0alpha1', '==1.0a1', true], ['1.0-1', '==1.0.post1', true],
    ['1.0rev2', '==1.0.post2', true], ['1.0c1', '==1.0rc1', true], ['1.0preview1', '==1.0rc1', true],
    // Arbitrary equality compares the normalized form.
    ['1.0-1', '===1.0.post1', true], ['1.0.0', '===1.0', false], ['V1.0.0', '===v1.0.0', false],
  ];
  for (const [version, specifier, expected] of cases) {
    assert.equal(vetting.evaluateSpecifier(version, specifier), expected, `${version} ${specifier}`);
  }
  // Ordering: a dev-only release before every pre-release of the same version.
  const sorted = ['1.0', '1.0.post1', '1.0rc1', '1.0.dev1', '1.0a1', '1.0rc1.post1', '1.0+local', '0!0.9', '1!0.1']
    .map((v) => ({ v, p: vetting.parseVersion(v) }))
    .sort((a, b) => vetting.compareParsedVersions(a.p, b.p))
    .map((x) => x.v);
  assert.deepEqual(sorted, ['0!0.9', '1.0.dev1', '1.0a1', '1.0rc1', '1.0rc1.post1', '1.0', '1.0+local', '1.0.post1', '1!0.1']);
});

test('pre-releases: opted into by «>=2.0.dev0» or «==2.1rc1», never by «!=2.0rc1»; rc beats dev', () => {
  const rel = (version) => ({ version, newestUploadAt: NOW - 400 * DAY });
  assert.equal(vetting.specifierAllowsPrereleases('>=2.0.dev0'), true);
  assert.equal(vetting.specifierAllowsPrereleases('!=2.0rc1'), false);
  assert.equal(vetting.chooseRelease([rel('2.0.dev1'), rel('2.0rc1')], { specifier: '>=2.0.dev0', now: NOW }).release.version, '2.0rc1');
  assert.equal(vetting.chooseRelease([rel('1.0'), rel('2.0rc2')], { specifier: '!=2.0rc1', now: NOW }).release.version, '1.0');
  assert.equal(vetting.chooseRelease([rel('1.0'), rel('2.0rc1')], { now: NOW }).release.version, '1.0', 'stable first');
  assert.equal(vetting.chooseRelease([rel('2.0.dev3'), rel('2.0b1')], { now: NOW }).release.version, '2.0b1', 'only pre-releases: the highest');
});

test('a file without an upload time never counts as old enough', async () => {
  const files = { tool: [wheel('tool', '3.0.0', 'py3-none-any', undefined)] };
  delete files.tool[0]['upload-time'];
  const verdict = await vet('tool', fakeFetch({ files, downloads: { tool: 2_000_000 } }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'release_too_new');
  assert.match(verdict.detail, /without a publication date/);
  assert.equal(verdict.evidence.releaseAgeDays, null);
});

test('wheel tags: exactly the ones pip accepts for CPython 3.12 on glibc Linux', () => {
  const ok = (tags) => vetting.wheelCompatible(`x-1.0-${tags}.whl`, 'x86_64');
  for (const tags of ['cp312-cp312-any', 'cp38-abi3-any', 'py3-cp39-manylinux2014_x86_64', 'py312-abi3-manylinux2014_x86_64', 'cp312-abi3-any', 'cp313-cp313-manylinux_2_17_x86_64', 'cp312-cp312d-manylinux_2_17_x86_64']) {
    assert.equal(ok(tags), false, tags);
  }
  for (const tags of ['cp312-none-any', 'py310-none-manylinux_2_17_x86_64', 'cp36-abi3-manylinux_2_17_x86_64', 'cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64', 'py2.py3-none-any', 'py3-none-linux_x86_64']) {
    assert.equal(ok(tags), true, tags);
  }
});

test('an invalid requires-python is ignored, as pip does, instead of hiding the release', async () => {
  const files = { lib: [wheel('lib', '1.0.0', 'py3-none-any', daysAgo(400)), wheel('lib', '2.0.0', 'py3-none-any', daysAgo(300), { 'requires-python': '>=3.7.*' })] };
  const verdict = await vet('lib', fakeFetch({ files, downloads: { lib: 900_000 } }));
  assert.equal(verdict.evidence.version, '2.0.0');
  // A valid one that excludes 3.12 still does.
  const excluded = { lib: [wheel('lib', '1.0.0'), wheel('lib', '2.0.0', 'py3-none-any', daysAgo(300), { 'requires-python': '>=3.13' })] };
  assert.equal((await vet('lib', fakeFetch({ files: excluded, downloads: { lib: 900_000 } }))).evidence.version, '1.0.0');
});

test('malware means the PACKAGE is malicious; a vulnerability about malicious input is not malware', async () => {
  const mal = (summary, details) => vetting.isMaliciousAdvisory({ id: 'GHSA-x', summary, details });
  for (const malware of [
    'A number of releases of ultralytics contained malicious crypto miner software.',
    'Embedded Malicious Code in ctx',
    'Malicious versions of num2words were published to PyPI',
    'Malicious code was injected into release 2.1 after the token leaked',
    'Versions 8.3.41 and 8.3.42 contain malicious code that mines cryptocurrency',
    'Releases were published from a compromised PyPI account',
    'Credential stealer embedded in the setup hook',
  ]) {
    assert.equal(mal(malware), true, malware);
  }
  for (const vulnerability of [
    'Zip Slip: an archive containing malicious symlinks can write outside the target',
    'Parsing a PDF that contains a malicious font crashes the renderer',
    'The updater fetches over HTTP, allowing malicious updates via MITM',
    'An attacker with a compromised account can escalate privileges',
    'Cookie stealer via stored XSS in the comments page',
    'Loading a pickle containing malicious code leads to RCE',
    'Could allow malicious software on the host to escalate privileges',
    'An attacker-controlled malicious project file can trigger code execution',
    'File uploads containing malicious HTML are served inline',
  ]) {
    assert.equal(mal(vulnerability), false, vulnerability);
  }
  // End to end: an archive library with such a CVE is installed, not branded malware.
  const net = fakeFetch({
    files: { archivelib: [wheel('archivelib', '3.1.0')] },
    downloads: { archivelib: 400_000 },
    osv: { archivelib: { vulns: [{ id: 'GHSA-zip1', summary: 'Zip Slip: an archive containing malicious symlinks can write outside the target' }] } },
  });
  const verdict = await vet('archivelib', net);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});
