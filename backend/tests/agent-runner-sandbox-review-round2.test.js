'use strict';

/**
 * Second review of the document agent's sandbox (agent-runner). Each test
 * fails without its fix:
 *  - execute_python ended its heredoc at any line that was exactly «PY» (a
 *    multi-line string of country codes: AR / PY / UY), and bash ran the rest
 *    of the Python as shell commands;
 *  - grep quoted its pattern with JSON.stringify: inside double quotes bash
 *    turned «\$[0-9]+» into «\-9+» and would run $(…) / `…`;
 *  - a PyPI / OSV outage while vetting was a permanent refusal: «do not retry»,
 *    a capability gap for the administrator, and the turn's install budget spent;
 *  - the retry with pinned dependencies could exceed the remote sandbox's
 *    20-requirement limit and fail with an opaque 400 after all the vetting;
 *  - a 502 / 503 / reset from the sandbox service re-sent execute_python up to
 *    three times although the command could already be running;
 *  - an overlay package with an invalid version or unreadable metadata broke
 *    every document turn of the chat for good (the repair never ran), and a
 *    console script in /workspace/.sira-packages/bin could stand in for a
 *    promised system binary;
 *  - one bad image (corrupt, mislabeled, refused by policy) demoted every
 *    vision model for six hours, switching visual review off for all users.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const tools = require('../src/services/agent-runner/tools');
const policyLib = require('../src/services/agent-runner/sandbox-packages/policy');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createRemoteSandbox } = require('../src/services/doc-agent/remote-sandbox');
const { verifySandboxRuntime, buildRuntimeProbe, MARKER, EXPECTED } = require('../src/services/agent-runner/runtime-verification');
const ladder = require('../src/services/agent-runner/multimodal/vision-ladder');

const hasPython = spawnSync('python3', ['--version']).status === 0;
const pythonWithPackaging = spawnSync('python3', ['-I', '-s', '-c', 'import packaging']).status === 0;

// ─── execute_python / grep ───────────────────────────────────────────────

test('execute_python runs a script that contains a line «PY» whole (it is Python, never shell)', async (t) => {
  const commands = [];
  const executors = tools.makeToolExecutors({ exec: async (cmd) => { commands.push(cmd); return { stdout: '', stderr: '', exitCode: 0 }; } });
  await executors.execute_python({ code: 'print(1)' });
  assert.match(commands[0], /<<'PY'\nprint\(1\)\nPY$/, 'ordinary scripts keep the usual terminator');
  const code = ['paises = """AR', 'PY', 'UY"""', 'print(len(paises.split()))', 'print("fin")'].join('\n');
  await executors.execute_python({ code });
  const [, delimiter] = /<<'([A-Za-z0-9_]+)'\n/.exec(commands[1]);
  assert.notEqual(delimiter, 'PY');
  assert.ok(commands[1].endsWith(`\n${code}\n${delimiter}`), 'the whole script travels in the heredoc');
  if (!hasPython) { t.diagnostic('python3 not available: shell run skipped'); return; }
  const run = spawnSync('bash', ['-c', commands[1]], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '3\nfin\n');
});

test('grep searches the pattern literally: «\\$[0-9]+» finds amounts, nothing is expanded by the shell', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-grep-'));
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'Lista de precios\nTotal: $100\n');
  const commands = [];
  const executors = tools.makeToolExecutors({
    exec: async (cmd) => {
      commands.push(cmd);
      const local = cmd.replace(/^cd \/workspace && /, `cd '${dir}' && `);
      const r = spawnSync('bash', ['-c', local], { encoding: 'utf8', timeout: 20_000 });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
    },
  });
  const out = await executors.grep({ pattern: '\\$[0-9]+' });
  assert.match(out, /notas\.txt:2:Total: \$100/);
  assert.match(commands[0], / -- '\\\$\[0-9\]\+' '\.'/, 'single-quoted, after --');
  const injected = await executors.grep({ pattern: '$(echo Lista)' });
  assert.equal(injected, '(no matches)', '$(…) is a literal, not a command');
});

// ─── install: outages are not refusals; the remote requirement cap ───────

function installSandbox({ maxInstallRequirements, notAllowed = [] } = {}) {
  const installs = [];
  return {
    installs,
    sandbox: {
      driver: 'remote',
      ...(maxInstallRequirements ? { maxInstallRequirements } : {}),
      async installPythonPackages(opts) {
        installs.push(opts.requirements);
        if (maxInstallRequirements && opts.requirements.length > maxInstallRequirements) {
          throw Object.assign(new Error('sandbox service 400: invalid_install_request'), { status: 400 });
        }
        if (installs.length === 1 && notAllowed.length) {
          return { ok: false, code: 'not_allowed', installed: [], notAllowed, notFound: [], bytes: 0, durationMs: 1, detail: '' };
        }
        return { ok: true, code: 'ok', installed: opts.requirements.map((r) => ({ name: r.split('=')[0], version: '1.0.0' })), notAllowed: [], notFound: [], bytes: 1, durationMs: 1, detail: '' };
      },
      async readFile() { throw new Error('ENOENT'); },
      async writeFile() {},
      async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
    },
  };
}

const ok = (name, version = '1.0.0') => ({ ok: true, name, reason: 'vetted', detail: '', evidence: { version, ageDays: 900, monthlyDownloads: 100_000 } });
const outage = (name) => ({ ok: false, name, reason: 'vet_unavailable', detail: 'PyPI could not be reached (pypi_http_503)', evidence: {} });
const refusedVerdict = (name) => ({ ok: false, name, reason: 'possible_typosquat', detail: 'its name imitates «requests»', evidence: {} });

test('a vetting outage is temporary: no capability gap, no «do not retry», the install budget is kept', async () => {
  const policy = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1', SIRAGPT_SANDBOX_PIP_MAX_PER_TURN: '1' });
  const gaps = [];
  let down = true;
  const vetter = { async vet(entries) { return entries.map((e) => (down ? outage(e.name) : ok(e.name))); } };
  const { sandbox, installs } = installSandbox();
  const executors = tools.makeToolExecutors(sandbox, { capability: { policy, vetter, onGap: (g) => gaps.push(g) } });
  const first = await executors.install_sandbox_package({ packages: ['lifelines'] });
  assert.match(first, /^ERROR: nothing was installed\. The package vetting could not verify «lifelines»/);
  assert.match(first, /This is temporary/);
  assert.doesNotMatch(first, /Do not retry/);
  assert.deepEqual(gaps, [], 'an outage is not a capability gap');
  assert.equal(installs.length, 0);
  down = false;
  const second = await executors.install_sandbox_package({ packages: ['lifelines'] });
  assert.match(second, /^Installed into the sandbox: lifelines/, 'the retry still has the budget');

  // A real refusal next to an outage: both are told apart.
  const mixedVetter = { async vet(entries) { return entries.map((e) => (e.name === 'reqeusts' ? refusedVerdict(e.name) : outage(e.name))); } };
  const mixedGaps = [];
  const mixed = await tools.makeToolExecutors(installSandbox().sandbox, { capability: { policy, vetter: mixedVetter, onGap: (g) => mixedGaps.push(g) } })
    .install_sandbox_package({ packages: ['reqeusts', 'lifelines'] });
  assert.match(mixed, /Refused by the package vetting: «reqeusts»: its name imitates «requests»\. Do not retry these names/);
  assert.match(mixed, /Could not be verified right now \(temporary; may be retried once later\): «lifelines»/);
  assert.deepEqual(mixedGaps.map((g) => g.name), ['reqeusts']);

  // Stop pressed while vetting: cancelled, not «could not verify».
  const stopped = new AbortController();
  stopped.abort();
  const cancelled = await tools.makeToolExecutors(installSandbox().sandbox, { capability: { policy, vetter: { async vet(entries) { return entries.map((e) => outage(e.name)); } } } })
    .install_sandbox_package({ packages: ['lifelines'] }, { signal: stopped.signal });
  assert.equal(cancelled, 'ERROR: the install was cancelled; nothing was installed.');
});

test('a vetting outage on the dependencies is temporary too, and no gap is reported for them', async () => {
  const policy = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1' });
  const gaps = [];
  const vetter = { async vet(entries) { return entries.map((e) => (e.name === 'interface-meta' ? outage(e.name) : ok(e.name, '1.1.0'))); } };
  const { sandbox } = installSandbox({ notAllowed: ['interface-meta'] });
  const out = await tools.makeToolExecutors(sandbox, { capability: { policy, vetter, onGap: (g) => gaps.push(g) } })
    .install_sandbox_package({ packages: ['formulaic'] });
  assert.match(out, /^ERROR: the dependencies it needs could not be verified right now \(«interface-meta»: PyPI could not be reached/);
  assert.match(out, /This is temporary/);
  assert.deepEqual(gaps, []);
});

test('the retry with pinned dependencies respects the remote sandbox limit (20) instead of an opaque 400', async () => {
  const policy = policyLib.resolvePolicy({ NODE_ENV: 'test', SIRAGPT_SANDBOX_PIP: '1' });
  const deps = Array.from({ length: 25 }, (_, i) => `dep-${i}`);
  const vetted = [];
  const vetter = { async vet(entries) { vetted.push(...entries.map((e) => e.name)); return entries.map((e) => ok(e.name)); } };
  const { sandbox, installs } = installSandbox({ maxInstallRequirements: 20, notAllowed: deps });
  const out = await tools.makeToolExecutors(sandbox, { capability: { policy, vetter } })
    .install_sandbox_package({ packages: ['bigframework'] });
  assert.match(out, /^ERROR: it pulls in 25 packages outside the curated list \(this sandbox installs at most 19 of them together with the package\)/);
  assert.equal(installs.length, 1, 'no second installer call that the service would reject');
  assert.deepEqual(vetted, ['bigframework'], 'the 25 dependencies are not vetted for nothing');
  // The remote driver declares the service's limit.
  const remote = createRemoteSandbox({ baseUrl: 'http://sandbox.test', apiKey: 'k', fetchImpl: async () => { throw new Error('no network in this test'); } });
  assert.equal(remote.maxInstallRequirements, 20);
});

// ─── exec retries ─────────────────────────────────────────────────────────

function oneToolThenFinal(name, args = '{"code":"print(1)"}') {
  const seen = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (payload) => {
    seen.push(payload.messages);
    calls += 1;
    if (calls === 1) {
      return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name, arguments: args } }] } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: 'Listo.' } }] };
  } } } };
  return { client, seen };
}
const execTool = [{ type: 'function', function: { name: 'execute_python', parameters: { type: 'object', properties: {} } } }];

test('execute_python is never re-sent after a 502 / reset from the sandbox (it may already be running)', async () => {
  for (const failure of [
    Object.assign(new Error('sandbox service 502: bad gateway'), { status: 502 }),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  ]) {
    const { client, seen } = oneToolThenFinal('execute_python');
    let executions = 0;
    const result = await runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Crea un Excel' }],
      tools: execTool,
      executors: { execute_python: async () => { executions += 1; throw failure; } },
      maxIterations: 3,
    });
    assert.equal(executions, 1, `${failure.message}: a command that may be running is not re-sent`);
    assert.notEqual(result.stoppedReason, 'tool_retry_exhausted');
    const observation = seen[1].find((m) => m.role === 'tool' && m.tool_call_id === 'x1');
    assert.match(observation.content, /puede que se haya ejecutado o no/);
  }
});

test('a failure that proves the command never started (no capacity) is still retried', async () => {
  const { client } = oneToolThenFinal('execute_python');
  let executions = 0;
  await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Crea un Excel' }],
    tools: execTool,
    executors: {
      execute_python: async () => {
        executions += 1;
        if (executions < 3) throw Object.assign(new Error('El entorno de documentos está ocupado'), { code: 'sandbox_at_capacity', category: 'capacity', status: 429, retryable: true });
        return '[exit 0]';
      },
    },
    maxIterations: 3,
  });
  assert.equal(executions, 3);
});

// ─── runtime probe: chat-local damage is repaired ────────────────────────

test('unreadable overlay metadata is chat-local damage: the overlay is cleared and the runtime verified', async () => {
  const report = (extra) => ({ stdout: MARKER + JSON.stringify({ protocol: 1, digest: EXPECTED.digest, checked: EXPECTED.packages, missing: 0, mismatched: 0, overlay: 0, cliMissing: 0, ...extra }) + '\n' });
  const commands = [];
  let probes = 0;
  const verified = await verifySandboxRuntime({
    driver: 'remote',
    exec: async (command) => {
      commands.push(command);
      if (!command.startsWith('/usr/bin/python3')) return { exitCode: 0, stdout: '', stderr: '' };
      probes += 1;
      return probes === 1
        ? { ...report({ ok: false, reason: 'packages_mismatch', overlayBroken: 2 }), exitCode: 1 }
        : { ...report({ ok: true, reason: 'verified', overlayBroken: 0 }), exitCode: 0 };
    },
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.overlayReset, true);
  assert.ok(commands.includes('command -p rm -rf -- /workspace/.sira-packages'));
});

function probeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-probe-r2-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(site);
  const userbase = path.join(root, 'userbase');
  const env = { ...process.env, PYTHONUSERBASE: userbase };
  const userSite = spawnSync('python3', ['-I', '-s', '-c', 'import site; print(site.getusersitepackages())'], { env, encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(userSite, { recursive: true });
  const distribution = (dir, name, version, raw) => {
    const info = path.join(dir, `${name.replaceAll('-', '_')}-${version}.dist-info`);
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'METADATA'), raw || `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
  };
  const catalog = (requirements, cli = []) => {
    const raw = JSON.stringify({ version: 2, python: requirements.map((pip) => ({ pip })), cli: [], node: [] });
    const file = path.join(root, 'capabilities.json');
    fs.writeFileSync(file, raw);
    return { file, expected: { digest: createHash('sha256').update(raw).digest('hex'), packages: requirements.length, requirements, cli } };
  };
  const probe = (config, { workspace = '/workspace', extraEnv = {} } = {}) => {
    const code = `import sys\nsys.path[0:0] = ${JSON.stringify([site])}\n${buildRuntimeProbe(config.expected, config.file, workspace)}`;
    const child = spawnSync('python3', ['-I', '-s', '-c', code], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000 });
    return JSON.parse(String(child.stdout).slice(MARKER.length));
  };
  return { root, site, userSite, distribution, catalog, probe };
}

test('real probe: an overlay with an invalid version, or unreadable metadata, is repairable (not a broken image)', { skip: !pythonWithPackaging && 'python3 with packaging required for real metadata probes' }, () => {
  const f = probeFixture();
  try {
    f.distribution(f.site, 'tabulate', '0.9.0');
    const config = f.catalog(['tabulate>=0.9,<1']);
    f.distribution(f.userSite, 'tabulate', 'bogus', 'Metadata-Version: 2.1\nName: tabulate\nVersion: not-a-version\n');
    const invalid = f.probe(config);
    assert.equal(invalid.reason, 'packages_mismatch');
    assert.equal(invalid.mismatched, 1);
    assert.equal(invalid.overlay, 1, 'counted as an overlay, so the caller clears it');
    fs.rmSync(path.join(f.userSite, 'tabulate-bogus.dist-info'), { recursive: true });
    const info = path.join(f.userSite, 'broken-1.0.dist-info');
    fs.mkdirSync(info);
    fs.writeFileSync(path.join(info, 'METADATA'), Buffer.from([0xff, 0xfe, 0x00, 0x4e, 0xc3, 0x28]));
    const unreadable = f.probe(config);
    assert.equal(unreadable.reason, 'packages_mismatch', 'not catalog_invalid');
    assert.equal(unreadable.overlayBroken, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('real probe: a console script in the workspace does not stand in for a promised system binary', { skip: !pythonWithPackaging && 'python3 with packaging required for real metadata probes' }, () => {
  const f = probeFixture();
  try {
    f.distribution(f.site, 'tabulate', '0.9.0');
    const config = f.catalog(['tabulate>=0.9,<1'], ['sira-fake-cli']);
    const workspace = path.join(f.root, 'workspace');
    const bin = path.join(workspace, '.sira-packages', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sira-fake-cli'), '#!/bin/sh\necho fake\n', { mode: 0o755 });
    const report = f.probe(config, { workspace, extraEnv: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(report.cliMissing, 1);
    assert.equal(report.reason, 'cli_missing');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

// ─── vision ladder ────────────────────────────────────────────────────────

test('one bad image demotes no vision model; a missing model (404) is demoted at once', async () => {
  ladder.resetVisionDemotions();
  const candidates = [
    { provider: 'DeepSeek', model: 'deepseek-flash', apiKey: 'k', baseURL: 'u' },
    { provider: 'xAI', model: 'grok-4.6', apiKey: 'k', baseURL: 'u' },
  ];
  const image = (data) => ({ model: 'x', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }] });
  const seen = [];
  const client = ladder.createVisionClient(candidates, {
    createClient: (c) => ({ chat: { completions: { create: async (p) => {
      seen.push(c.model);
      if (JSON.stringify(p).includes('CORRUPTA')) throw Object.assign(new Error('Invalid image: could not decode'), { status: 400 });
      return { choices: [{ message: { content: 'ok' } }] };
    } } } }),
  });
  await assert.rejects(client.chat.completions.create(image('CORRUPTA')), /could not decode/);
  assert.deepEqual(seen, ['deepseek-flash', 'grok-4.6']);
  seen.length = 0;
  await client.chat.completions.create(image('BUENA'));
  assert.deepEqual(seen, ['deepseek-flash'], 'every model is still available for the next image');

  const missing = ladder.createVisionClient(candidates, {
    createClient: (c) => ({ chat: { completions: { create: async () => {
      seen.push(c.model);
      if (c.model === 'deepseek-flash') throw Object.assign(new Error('model not found'), { status: 404 });
      return { choices: [{ message: { content: 'ok' } }] };
    } } } }),
  });
  await missing.chat.completions.create(image('X1'));
  seen.length = 0;
  await missing.chat.completions.create(image('X2'));
  assert.deepEqual(seen, ['grok-4.6'], 'a model that does not exist is skipped from now on');
  ladder.resetVisionDemotions();
});
