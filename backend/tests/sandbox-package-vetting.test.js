'use strict';

// Vetting of PyPI distributions outside the curated sandbox allowlist: what
// is accepted, what is refused and why, and how install_sandbox_package uses
// it for the requested names AND the dependencies pip resolves. All offline:
// PyPI, OSV and pypistats are a fake fetch; the installer is a fake sandbox.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const vetting = require('../src/services/agent-runner/sandbox-packages/vetting');
const policyLib = require('../src/services/agent-runner/sandbox-packages/policy');
const tools = require('../src/services/agent-runner/tools');
const { buildAgentRunnerPrompt } = require('../src/services/agent-runner/prompt');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T00:00:00Z');

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function project({ dist = 'pkg', firstUpload = '2019-01-01T00:00:00Z', versions = ['1.0', '1.1', '1.2', '2.0', '2.1'], wheels = true, yanked = false, status = null } = {}) {
  const files = versions.map((v, i) => ({
    filename: wheels ? `${dist.replace(/-/g, '_')}-${v}-py3-none-any.whl` : `${dist}-${v}.tar.gz`,
    'upload-time': new Date(Date.parse(firstUpload) + i * 30 * DAY).toISOString(),
    yanked,
  }));
  const body = { meta: { 'api-version': '1.1' }, name: dist, files, versions };
  if (status) body['project-status'] = { status };
  return body;
}

function fakeFetch({ projects = {}, malicious = {}, advisories = {}, downloads = {}, down = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.startsWith('https://pypi.org/simple/')) {
      if (down.pypi) return response(503, {});
      const name = decodeURIComponent(u.slice('https://pypi.org/simple/'.length).replace(/\/$/, ''));
      return projects[name] ? response(200, projects[name]) : response(404, {});
    }
    if (u === 'https://api.osv.dev/v1/query') {
      if (down.osv) return response(500, {});
      const name = JSON.parse(init.body).package.name;
      const vulns = [...(malicious[name] || []).map((id) => ({ id })), ...(advisories[name] || [])];
      return response(200, vulns.length ? { vulns } : {});
    }
    if (u.startsWith('https://pypistats.org/api/packages/')) {
      if (down.stats) return response(429, {});
      const name = decodeURIComponent(u.split('/')[5]);
      return name in downloads ? response(200, { data: { last_month: downloads[name] } }) : response(404, {});
    }
    throw new Error(`unexpected url ${u}`);
  };
  return { fetchImpl, calls };
}

const vet = (name, net, opts = {}) => vetting.vetPackage(name, { fetchImpl: net.fetchImpl, now: NOW, ...opts });

test('an established, widely used project with wheels passes and reports its evidence', async () => {
  const net = fakeFetch({ projects: { lifelines: project({ dist: 'lifelines' }) }, downloads: { lifelines: 1_200_000 } });
  const verdict = await vet('Lifelines', net);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.name, 'lifelines');
  assert.equal(verdict.evidence.version, '2.1');
  assert.equal(verdict.evidence.monthlyDownloads, 1_200_000);
  assert.ok(verdict.evidence.ageDays > 2000);
  // The malware query asks about the version that would be installed.
  assert.deepEqual(net.calls.find((c) => c.url.includes('osv')).body, { package: { name: 'lifelines', ecosystem: 'PyPI' }, version: '2.1' });
  assert.equal(vetting.describeEvidence(verdict.evidence), 'on PyPI for 7+ year(s), 1,200,000 downloads last month, no malware advisory');
  // A pinned, existing version is the one checked.
  const pinned = fakeFetch({ projects: { lifelines: project({ dist: 'lifelines' }) }, downloads: { lifelines: 1_200_000 } });
  await vet('lifelines', pinned, { version: '1.1' });
  assert.equal(pinned.calls.find((c) => c.url.includes('osv')).body.version, '1.1');
});

test('refusals: missing, source-only, withdrawn, malicious, brand new, unused', async () => {
  const projects = {
    'source-only': project({ dist: 'source-only', wheels: false }),
    quarantined: project({ dist: 'quarantined', status: 'quarantined' }),
    withdrawn: project({ dist: 'withdrawn', yanked: true }),
    'evil-utils': project({ dist: 'evil-utils' }),
    'fresh-lib': project({ dist: 'fresh-lib', firstUpload: new Date(NOW - 10 * DAY).toISOString(), versions: ['0.1'] }),
    'tiny-lib': project({ dist: 'tiny-lib' }),
  };
  const net = fakeFetch({
    projects,
    malicious: { 'evil-utils': ['MAL-2025-1234'] },
    downloads: { 'evil-utils': 90_000, 'fresh-lib': 40_000, 'tiny-lib': 150 },
  });
  const reasons = {};
  for (const name of ['not-on-pypi', 'source-only', 'quarantined', 'withdrawn', 'evil-utils', 'fresh-lib', 'tiny-lib']) {
    const v = await vet(name, net);
    assert.equal(v.ok, false, name);
    reasons[name] = v.reason;
  }
  assert.deepEqual(reasons, {
    'not-on-pypi': 'not_found',
    'source-only': 'no_wheels',
    quarantined: 'withdrawn',
    withdrawn: 'withdrawn',
    'evil-utils': 'malicious',
    'fresh-lib': 'too_new',
    'tiny-lib': 'low_adoption',
  });
  const evil = await vet('evil-utils', net);
  assert.match(evil.detail, /MAL-2025-1234/);
});

test('the version checked is the one pip installs; hijacked releases are caught by their advisory text', async () => {
  // A backport (2.4.5) uploaded after 3.0.1 and a newer release candidate:
  // pip installs 3.0.1, so that is the version checked for malware.
  const files = [
    ['0.9.9', '2014-01-01'], ['3.0.1', '2024-09-22'], ['2.4.5', '2025-01-10'], ['3.1.0rc1', '2025-02-01'],
  ].map(([v, day]) => ({ filename: `pydicom-${v}-py3-none-any.whl`, 'upload-time': `${day}T00:00:00Z`, yanked: false }));
  const net = fakeFetch({ projects: { pydicom: { files, versions: ['0.9.9', '2.4.5', '3.0.1', '3.1.0rc1'] } }, downloads: { pydicom: 5_000_000 } });
  const verdict = await vet('pydicom', net);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.evidence.version, '3.0.1');
  assert.equal(net.calls.find((c) => c.url.includes('osv')).body.version, '3.0.1');
  assert.equal(vetting.highestVersion(['1.9', '1.10', '1.10.post1', '2.0rc1']), '1.10.post1');
  assert.equal(vetting.highestVersion(['1.0rc1', '1.0b2']), '1.0rc1', 'only pre-releases: the highest one');

  // ultralytics 8.3.41-46 was published as PYSEC-2024-154, not a MAL-* id.
  const hijacked = fakeFetch({
    projects: { ultralytics: project({ dist: 'ultralytics' }) },
    downloads: { ultralytics: 9_000_000 },
    advisories: { ultralytics: [{ id: 'PYSEC-2024-154', summary: 'A number of releases of ultralytics contained malicious crypto miner software.' }] },
  });
  const h = await vet('ultralytics', hijacked);
  assert.equal(h.reason, 'malicious');
  assert.match(h.detail, /PYSEC-2024-154/);
  // An ordinary vulnerability is not malware, even when it says «malicious».
  const cve = fakeFetch({
    projects: { mlflow: project({ dist: 'mlflow' }) },
    downloads: { mlflow: 20_000_000 },
    advisories: { mlflow: [{ id: 'GHSA-abcd-efgh-ijkl', summary: 'Deserialization of untrusted data lets a malicious user execute malicious code' }] },
  });
  assert.equal((await vet('mlflow', cve)).ok, true);
  assert.equal(vetting.isMaliciousAdvisory({ id: 'GHSA-1', aliases: ['MAL-2025-9'] }), true);
  assert.equal(vetting.isMaliciousAdvisory({ id: 'PYSEC-1', summary: 'Supply chain attack: compromised release uploaded' }), true);
  assert.equal(vetting.isMaliciousAdvisory({ id: 'PYSEC-2', summary: 'Crafted pickle files from a malicious server cause code execution' }), false);
});

test('look-alike names are refused unless the project is widely used itself', async () => {
  const net = fakeFetch({
    projects: { reqeusts: project({ dist: 'reqeusts' }), pyaml: project({ dist: 'pyaml' }) },
    downloads: { reqeusts: 3_000, pyaml: 400_000 },
  });
  const squat = await vet('reqeusts', net);
  assert.equal(squat.reason, 'possible_typosquat');
  assert.equal(squat.evidence.imitates, 'requests');
  assert.match(squat.detail, /install «requests»/);
  assert.equal((await vet('pyaml', net)).ok, true, 'one edit from pyyaml, but with real adoption of its own');

  assert.equal(vetting.typosquatTarget('python-requests'), 'requests');
  assert.equal(vetting.typosquatTarget('requests-python'), 'requests');
  assert.equal(vetting.typosquatTarget('pyrequests'), 'requests');
  assert.equal(vetting.typosquatTarget('scikitlearn'), 'scikit-learn');
  assert.equal(vetting.typosquatTarget('nunpy'), 'numpy');
  assert.equal(vetting.typosquatTarget('pytorch'), 'torch');
  for (const legit of ['requests', 'scapy', 'pydicom', 'lifelines', 'polars', 'py-cord']) {
    assert.equal(vetting.typosquatTarget(legit), null, legit);
  }
  assert.equal(vetting.editDistance('reqeusts', 'requests'), 1, 'a transposition is one edit');
  assert.equal(vetting.editDistance('abcdef', 'uvwxyz', 2), 3, 'stops once past the limit');
});

test('fail closed: PyPI or OSV unreachable refuses; missing download stats demand a long track record', async () => {
  const projects = {
    lifelines: project({ dist: 'lifelines' }),
    youngish: project({ dist: 'youngish', firstUpload: new Date(NOW - 200 * DAY).toISOString() }),
  };
  assert.equal((await vet('lifelines', fakeFetch({ projects, down: { pypi: true } }))).reason, 'vet_unavailable');
  assert.equal((await vet('lifelines', fakeFetch({ projects, down: { osv: true } }))).reason, 'vet_unavailable');
  const noStats = fakeFetch({ projects, down: { stats: true } });
  assert.equal((await vet('lifelines', noStats)).ok, true, '7 years and 5 releases without stats');
  assert.equal((await vet('youngish', noStats)).reason, 'vet_unavailable');
  assert.equal((await vetting.vetPackage('lifelines', { fetchImpl: null })).reason, 'vet_unavailable');
});

test('the shared vetter caches verdicts but never a transient failure', async () => {
  const net = fakeFetch({ projects: { lifelines: project({ dist: 'lifelines' }) }, downloads: { lifelines: 1_000_000 } });
  const vetter = vetting.createVetter({ fetchImpl: net.fetchImpl, now: () => NOW });
  const [first] = await vetter.vet([{ name: 'lifelines' }]);
  const callsAfterFirst = net.calls.length;
  const [second] = await vetter.vet([{ name: 'Lifelines' }]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(net.calls.length, callsAfterFirst, 'cached');

  let pypiDown = true;
  const flaky = fakeFetch({ projects: { lifelines: project({ dist: 'lifelines' }) }, downloads: { lifelines: 1_000_000 } });
  const flakyFetch = (url, init) => (pypiDown && String(url).startsWith('https://pypi.org') ? Promise.resolve(response(503, {})) : flaky.fetchImpl(url, init));
  const vetter2 = vetting.createVetter({ fetchImpl: flakyFetch, now: () => NOW });
  assert.equal((await vetter2.vet([{ name: 'lifelines' }]))[0].reason, 'vet_unavailable');
  pypiDown = false;
  assert.equal((await vetter2.vet([{ name: 'lifelines' }]))[0].ok, true, 'retried after the outage');
});

// ─── install_sandbox_package with vetting ───────────────────────────────

const VETTED = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1', SIRAGPT_SANDBOX_PIP_MAX_PER_TURN: '3' });

function fakeVetter(verdicts) {
  const calls = [];
  return {
    calls,
    async vet(entries) {
      calls.push(entries.map((e) => e.name));
      return entries.map((e) => verdicts[e.name] || { ok: false, name: e.name, reason: 'not_found', detail: 'it does not exist on PyPI' });
    },
  };
}
const ok = (name, evidence = { ageDays: 2600, monthlyDownloads: 1_000_000 }) => ({ ok: true, name, reason: 'vetted', detail: '', evidence });

function fakeSandbox(installResult) {
  const files = new Map();
  const calls = { install: [], exec: [] };
  return {
    driver: 'docker',
    calls,
    async exec(cmd) { calls.exec.push(cmd); return { exitCode: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'pydicom'" }; },
    async installPythonPackages(opts) { calls.install.push(opts); return installResult(opts, calls.install.length); },
    async readFile(rel) { if (!files.has(rel)) throw new Error('ENOENT'); return Buffer.from(files.get(rel)); },
    async writeFile(rel, content) { files.set(rel, String(content)); },
  };
}
const installed = (...pairs) => ({ ok: true, code: 'ok', installed: pairs.map(([name, version]) => ({ name, version })), notAllowed: [], notFound: [], bytes: 1000, durationMs: 40, detail: '' });

test('a name outside the curated list is vetted, then installed with only that name added to the allowlist', async () => {
  assert.equal(policyLib.isAllowed('pydicom', VETTED), false);
  const sandbox = fakeSandbox(() => installed(['pydicom', '3.0.1']));
  const vetter = fakeVetter({ pydicom: ok('pydicom') });
  const installs = [];
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: VETTED, vetter, onInstall: (i) => installs.push(i) } });
  const out = await executors.install_sandbox_package({ packages: ['pydicom', 'seaborn'] });
  assert.match(out, /^Installed into the sandbox: pydicom 3\.0\.1\./);
  assert.match(out, /Outside the curated list, vetted: pydicom \(on PyPI for 7\+ year\(s\), 1,000,000 downloads last month, no malware advisory\)/);
  assert.deepEqual(vetter.calls, [['pydicom']], 'curated names are not vetted');
  assert.deepEqual(sandbox.calls.install[0].requirements, ['seaborn', 'pydicom']);
  const allow = JSON.parse(sandbox.calls.install[0].allowJson);
  assert.ok(allow.includes('pydicom') && allow.includes('seaborn'));
  assert.equal(allow.length, VETTED.allow.size + 1);
  assert.deepEqual(installs[0].vetted.map((v) => v.name), ['pydicom']);
});

test('a refused name never reaches the installer and is reported as a gap with its reason', async () => {
  const sandbox = fakeSandbox(() => installed());
  const gaps = [];
  const vetter = fakeVetter({ reqeusts: { ok: false, name: 'reqeusts', reason: 'possible_typosquat', detail: 'its name imitates «requests»; if that is the library you meant, install «requests»' } });
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: VETTED, vetter, onGap: (g) => gaps.push(g) } });
  const out = await executors.install_sandbox_package({ packages: ['reqeusts'] });
  assert.match(out, /^ERROR: nothing was installed\. Refused by the package vetting: «reqeusts»: its name imitates «requests»/);
  assert.match(out, /Do not retry these names/);
  assert.equal(sandbox.calls.install.length, 0);
  assert.deepEqual(gaps, [{ kind: 'python_package', name: 'reqeusts', package: 'reqeusts', allowed: false, tool: 'install_sandbox_package' }]);
});

test('dependencies pip resolves outside the list are vetted and the install retried once with them allowed', async () => {
  const sandbox = fakeSandbox((opts, n) => (n === 1
    ? { ok: false, code: 'not_allowed', installed: [], notAllowed: ['formulaic', 'autograd'], notFound: [], bytes: 0, durationMs: 30, detail: '' }
    : installed(['lifelines', '0.30.0'], ['formulaic', '1.1.0'], ['autograd', '1.7.0'])));
  const vetter = fakeVetter({ lifelines: ok('lifelines'), formulaic: ok('formulaic'), autograd: ok('autograd') });
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: VETTED, vetter } });
  const out = await executors.install_sandbox_package({ packages: ['lifelines'] });
  assert.match(out, /^Installed into the sandbox: lifelines 0\.30\.0, formulaic 1\.1\.0, autograd 1\.7\.0\./);
  assert.deepEqual(vetter.calls, [['lifelines'], ['formulaic', 'autograd']]);
  assert.equal(sandbox.calls.install.length, 2);
  const second = JSON.parse(sandbox.calls.install[1].allowJson);
  for (const name of ['lifelines', 'formulaic', 'autograd']) assert.ok(second.includes(name), name);
  assert.ok(!JSON.parse(sandbox.calls.install[0].allowJson).includes('formulaic'), 'the first attempt only allowed the request');
});

test('a refused dependency or an oversize closure stops the install with an explanation', async () => {
  const gaps = [];
  const sandbox = fakeSandbox(() => ({ ok: false, code: 'not_allowed', installed: [], notAllowed: ['formulaic', 'autograd'], notFound: [], bytes: 0, durationMs: 30, detail: '' }));
  const vetter = fakeVetter({
    lifelines: ok('lifelines'),
    formulaic: ok('formulaic'),
    autograd: { ok: false, name: 'autograd', reason: 'too_new', detail: 'first published 3 day(s) ago; new projects need 90 days of history' },
  });
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: VETTED, vetter, onGap: (g) => gaps.push(g) } });
  const out = await executors.install_sandbox_package({ packages: ['lifelines'] });
  assert.match(out, /^ERROR: the dependencies it needs did not pass vetting \(«autograd»: first published 3 day\(s\) ago/);
  assert.equal(sandbox.calls.install.length, 1);
  assert.deepEqual(gaps.map((g) => g.name), ['autograd']);

  const many = Array.from({ length: 41 }, (_, i) => `dep-${i}`);
  const sb2 = fakeSandbox(() => ({ ok: false, code: 'not_allowed', installed: [], notAllowed: many, notFound: [], bytes: 0, durationMs: 30, detail: '' }));
  const ex2 = tools.makeToolExecutors(sb2, { capability: { policy: VETTED, vetter: fakeVetter({ lifelines: ok('lifelines') }) } });
  assert.match(await ex2.install_sandbox_package({ packages: ['lifelines'] }), /pulls in 41 packages outside the curated list \(at most 40 are vetted per install\)/);
  assert.equal(sb2.calls.install.length, 1);
});

test('vetting needs both the policy and a wired vetter; batches are still capped and validated', async () => {
  // No vetter wired: the curated-list behaviour, unchanged.
  const sb = fakeSandbox(() => installed());
  const plain = tools.makeToolExecutors(sb, { capability: { policy: VETTED } });
  assert.match(await plain.install_sandbox_package({ packages: ['pydicom'] }), /Not on the approved package list \(reported to the administrator; do not retry them\): pydicom/);
  // SIRAGPT_SANDBOX_PIP=allowlist: curated only, even with a vetter.
  const curatedOnly = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: 'allowlist' });
  assert.equal(curatedOnly.enabled, true);
  assert.equal(curatedOnly.vetting, false);
  const vetter = fakeVetter({ pydicom: ok('pydicom') });
  const ex = tools.makeToolExecutors(fakeSandbox(() => installed()), { capability: { policy: curatedOnly, vetter } });
  assert.match(await ex.install_sandbox_package({ packages: ['pydicom'] }), /Not on the approved package list/);
  assert.equal(vetter.calls.length, 0);
  // A private index: public PyPI data does not describe its packages.
  assert.equal(policyLib.resolvePolicy({ NODE_ENV: 'production', SIRAGPT_SANDBOX_PIP_INDEX_URL: 'https://devpi.internal/simple' }).vetting, false);
  assert.equal(policyLib.resolvePolicy({ NODE_ENV: 'production' }).vetting, true);
  // The per-call cap counts the vetted names too; invalid specs refuse the batch.
  const capped = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1', SIRAGPT_SANDBOX_PIP_MAX_PACKAGES: '2' });
  const ex3 = tools.makeToolExecutors(fakeSandbox(() => installed()), { capability: { policy: capped, vetter: fakeVetter({}) } });
  assert.match(await ex3.install_sandbox_package({ packages: ['seaborn', 'pydicom', 'lifelines'] }), /At most 2 packages per call/);
  const ex4 = tools.makeToolExecutors(fakeSandbox(() => installed()), { capability: { policy: VETTED, vetter: fakeVetter({}) } });
  const invalid = await ex4.install_sandbox_package({ packages: ['git+https://x', 'pydicom'] });
  assert.match(invalid, /Invalid specs/);
  assert.doesNotMatch(invalid, /Not on the approved package list/);
});

test('names the operator denied are never vetted, neither requested nor pulled in as dependencies', async () => {
  const denyPolicy = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1', SIRAGPT_SANDBOX_PIP_DENY: 'pydicom autograd' });
  assert.ok(denyPolicy.deny.has('pydicom'));
  const vetter = fakeVetter({ pydicom: ok('pydicom'), lifelines: ok('lifelines'), autograd: ok('autograd') });
  const sandbox = fakeSandbox(() => ({ ok: false, code: 'not_allowed', installed: [], notAllowed: ['autograd'], notFound: [], bytes: 0, durationMs: 30, detail: '' }));
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: denyPolicy, vetter } });
  assert.match(await executors.install_sandbox_package({ packages: ['pydicom'] }), /^ERROR: nothing was installed\. Blocked by the administrator on this server: pydicom\./);
  assert.equal(sandbox.calls.install.length, 0);
  assert.match(await executors.install_sandbox_package({ packages: ['lifelines'] }), /did not pass vetting \(«autograd»: blocked by the administrator on this server\)/);
  assert.deepEqual(vetter.calls, [['lifelines']], 'neither denied name reached the vetting');
  assert.equal(sandbox.calls.install.length, 1);
});

test('the recovery note, the tool description and the prompt tell the model it may ask for any PyPI distribution', async () => {
  const sandbox = fakeSandbox(() => installed());
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy: VETTED, vetter: fakeVetter({}) } });
  const note = await executors.execute_python({ code: 'import pydicom' });
  assert.match(note, /«pydicom» is not on the curated list, but the server can vet it/);
  assert.match(note, /install_sandbox_package once with the exact PyPI distribution that provides this module — usually \["pydicom"\]/);
  assert.doesNotMatch(note, /reported to the administrator/);

  const installDef = (env) => tools.buildToolDefinitions(env).find((d) => d.function.name === 'install_sandbox_package');
  assert.equal(installDef({ NODE_ENV: 'production' }), tools.VETTED_INSTALL_TOOL_DEFINITION);
  assert.match(tools.VETTED_INSTALL_TOOL_DEFINITION.function.description, /any other package is vetted first/);
  assert.deepEqual(tools.VETTED_INSTALL_TOOL_DEFINITION.function.parameters, tools.INSTALL_TOOL_DEFINITION.function.parameters);
  assert.equal(installDef({ NODE_ENV: 'production', SIRAGPT_SANDBOX_PIP: 'allowlist' }), tools.INSTALL_TOOL_DEFINITION);

  const prompt = buildAgentRunnerPrompt({ fileNames: ['a.docx'], packageInstaller: { enabled: true, vetting: true } });
  assert.match(prompt, /any other is vetted first \(PyPI history and adoption, malware advisories, look-alike names\)/);
  assert.match(prompt, /- install_sandbox_package: install Python packages from PyPI/);
  assert.doesNotMatch(prompt, /reported to the administrator automatically/);
});
