'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  verifySandboxRelease, verifyIsolatedCodeRunner, buildCatalogProbe, parseCatalog, parseProofs, CATALOG_MARKER,
} = require('../scripts/verify-agent-sandbox-runtime.cjs');

const SCRIPT = path.resolve(__dirname, '../scripts/verify-agent-sandbox-runtime.cjs');
const REPO = path.resolve(__dirname, '../..');
const HASH = 'a'.repeat(64);
const PRIVATE = 'private-transport-diagnostic-not-for-release-output';
const catalog = (extra = {}) => ({
  digest: HASH, python: 3, cli: 2, node: 1, libraries: 2,
  proofs: ['document-edit', 'structured-data'], ...extra,
});
const report = () => ({
  ok: true, libraries: 2, checks: 5,
  proofs: [
    { id: 'document-edit', ok: true, checks: 3, artifacts: ['edited.docx'] },
    { id: 'structured-data', ok: true, checks: 2, artifacts: ['values.parquet'] },
  ],
});
const output = (stdout, extra = {}) => ({ stdout, stderr: '', exitCode: 0, ...extra });
const responses = () => [
  output(CATALOG_MARKER + JSON.stringify(catalog())),
  output('SIRA_ENV_OK python=3 cli=2 node=1\n'),
  output('SPSS_RUNTIME_OK\n'),
  output(JSON.stringify(report())),
];
const isCode = (expected) => (error) => {
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.ok(!JSON.stringify(error).includes(PRIVATE));
  return true;
};

function fakeSandbox({ driver = 'remote', results = responses(), failAt = -1, cleanupError = false } = {}) {
  const state = { calls: [], created: 0, destroyed: 0 };
  state.createSandbox = async (...args) => {
    assert.deepEqual(args, [], 'release checks must never reuse a user persistKey');
    state.created += 1;
    return {
      driver,
      async exec(command, options) {
        const index = state.calls.length;
        state.calls.push({ command, options });
        if (index === failAt) throw new Error(PRIVATE);
        assert.ok(index < results.length, 'no retries or extra unverified execution');
        return results[index];
      },
      async destroy() {
        state.destroyed += 1;
        if (cleanupError) throw new Error(PRIVATE);
      },
    };
  };
  return state;
}

test('release verifies the actual isolated driver with target digest before imports and exact functional proof coverage', async () => {
  for (const driver of ['remote', 'docker']) {
    const state = fakeSandbox({ driver });
    assert.deepEqual(await verifySandboxRelease(HASH, state), {
      ok: true, driver, catalog: HASH, python: 3, libraries: 2, proofs: 2, checks: 5,
    });
    assert.equal(state.created, 1);
    assert.equal(state.destroyed, 1);
    assert.equal(state.calls.length, 4);
    assert.match(state.calls[0].command, /^\/usr\/bin\/python3 -I -s -c /);
    assert.ok(state.calls[0].command.includes(HASH));
    assert.ok(!/import pandas|import pyreadstat|smoke_precision|verify_env/.test(state.calls[0].command));
    assert.match(state.calls[1].command, /^SIRA_CAPABILITIES=\/opt\/sira\/capabilities.json \/usr\/bin\/python3 -E -s \/opt\/sira\/verify_env.py$/);
    assert.match(state.calls[2].command, /pyreadstat\.write_sav/);
    assert.match(state.calls[3].command, /smoke_precision\.py \/workspace\/tmp\/release-proof --catalog \/opt\/sira\/capabilities\.json$/);
    assert.deepEqual(state.calls.map((entry) => entry.options.timeoutMs), [10000, 60000, 30000, 180000]);
  }
});

test('a target digest is mandatory and rejected before any sandbox is allocated', async () => {
  for (const hash of [undefined, '', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64) + '; command']) {
    const state = fakeSandbox();
    await assert.rejects(verifySandboxRelease(hash, state), isCode('invalid_expected_catalog'));
    assert.equal(state.created, 0);
    assert.equal(state.destroyed, 0);
  }
});

test('local or unknown execution can never certify an origin release', async () => {
  for (const driver of ['local', undefined, 'unknown']) {
    const state = fakeSandbox({ driver: driver === undefined ? '' : driver });
    await assert.rejects(verifySandboxRelease(HASH, state), isCode('sandbox_not_isolated'));
    assert.equal(state.calls.length, 0);
    assert.equal(state.destroyed, 1);
  }
});

test('wrong image, malformed or interrupted catalog checks fail closed before document imports', async () => {
  const invalid = [
    output(CATALOG_MARKER + JSON.stringify(catalog({ digest: 'b'.repeat(64) }))),
    output(CATALOG_MARKER + JSON.stringify(catalog({ python: 0 }))),
    output(CATALOG_MARKER + JSON.stringify(catalog({ libraries: 4 }))),
    output(CATALOG_MARKER + JSON.stringify(catalog({ proofs: ['document-edit', 'document-edit'] }))),
    output(CATALOG_MARKER + JSON.stringify(catalog({ proofs: ['unsafe/name'] }))),
    output(CATALOG_MARKER + '{}'), output(CATALOG_MARKER + '{'), output(PRIVATE),
    output('x'.repeat(8193)), output('', { exitCode: 137 }),
    output(CATALOG_MARKER + JSON.stringify(catalog()), { timedOut: true }),
    output(CATALOG_MARKER + JSON.stringify(catalog()), { aborted: true }),
    output(CATALOG_MARKER + JSON.stringify(catalog()), { exitCode: 1, stderr: PRIVATE }),
  ];
  for (const result of invalid) {
    const state = fakeSandbox({ results: [result] });
    await assert.rejects(verifySandboxRelease(HASH, state), isCode('catalog_check_failed'));
    assert.equal(state.calls.length, 1);
    assert.equal(state.destroyed, 1);
  }
});

test('successful self-check markers must have the target counts and intact SAV result', async () => {
  for (const [index, result, code] of [
    [1, output('SIRA_ENV_OK python=2 cli=2 node=1'), 'environment_check_failed'],
    [1, output('SIRA_ENV_OK python=3 cli=2 node=1', { exitCode: 1 }), 'environment_check_failed'],
    [1, output('SIRA_ENV_OK python=3 cli=2 node=1\n' + PRIVATE), 'environment_check_failed'],
    [2, output('SPSS_RUNTIME_OK', { timedOut: true }), 'spss_check_failed'],
    [2, output('SPSS_RUNTIME_FAILED'), 'spss_check_failed'],
  ]) {
    const results = responses(); results[index] = result;
    const state = fakeSandbox({ results });
    await assert.rejects(verifySandboxRelease(HASH, state), isCode(code));
    assert.equal(state.calls.length, index + 1);
    assert.equal(state.destroyed, 1);
  }
});

test('functional certification rejects partial, skipped, duplicate or contradictory proofs', async () => {
  const mutations = [
    (value) => { value.ok = false; },
    (value) => { value.complete = false; },
    (value) => { value.skipped = 1; },
    (value) => { value.proofs.pop(); },
    (value) => { value.proofs.push(value.proofs[0]); },
    (value) => { value.proofs[1].id = value.proofs[0].id; },
    (value) => { value.proofs[1].id = 'unrequested-proof'; },
    (value) => { value.proofs[0].ok = false; },
    (value) => { value.proofs[0].complete = false; },
    (value) => { value.proofs[0].skipped = true; },
    (value) => { value.proofs[0].checks = 0; value.checks = 2; },
    (value) => { value.proofs[0].checks = '3'; },
    (value) => { value.proofs[0].artifacts = []; },
    (value) => { value.proofs[0].artifacts = [null]; },
    (value) => { value.proofs[0].artifacts = ['x'.repeat(256)]; },
    (value) => { value.checks = 6; },
    (value) => { value.libraries = 1; },
  ];
  for (const mutate of mutations) {
    const value = report(); mutate(value);
    assert.throws(() => parseProofs(output(JSON.stringify(value)), catalog()), isCode('functional_proof_failed'));
  }
  for (const result of [output('{'), output('x'.repeat(65537)), output(JSON.stringify(report()), { exitCode: 1 }), output(JSON.stringify(report()), { timedOut: true })]) {
    const results = responses(); results[3] = result;
    const state = fakeSandbox({ results });
    await assert.rejects(verifySandboxRelease(HASH, state), isCode('functional_proof_failed'));
    assert.equal(state.calls.length, 4);
    assert.equal(state.destroyed, 1);
  }
});

test('transport failures and cleanup failures are bounded diagnostics and never become success', async () => {
  for (let failAt = 0; failAt < 4; failAt += 1) {
    const state = fakeSandbox({ failAt });
    await assert.rejects(verifySandboxRelease(HASH, state), isCode('sandbox_transport_failed'));
    assert.equal(state.destroyed, 1);
    assert.equal(state.calls.length, failAt + 1);
  }
  const cleanup = fakeSandbox({ cleanupError: true });
  await assert.rejects(verifySandboxRelease(HASH, cleanup), isCode('sandbox_cleanup_failed'));
  assert.equal(cleanup.destroyed, 1);
  await assert.rejects(verifySandboxRelease(HASH, { createSandbox: async () => { throw new Error(PRIVATE); } }), isCode('sandbox_transport_failed'));
});

test('real isolated Python validates exact catalog bytes without importing document packages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-release-catalog-'));
  try {
    const file = path.join(directory, 'capabilities.json');
    const bytes = JSON.stringify({
      python: [{ pip: 'not-installed==1', import: 'not_installed', proof: 'document-edit' }], cli: [], node: [],
    });
    fs.writeFileSync(file, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const run = (hash) => {
      const child = spawnSync('python3', ['-I', '-s', '-c', buildCatalogProbe(hash, file)], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.error, undefined);
      return output(child.stdout, { exitCode: child.status, stderr: child.stderr });
    };
    assert.deepEqual(parseCatalog(run(digest), digest), {
      digest, python: 1, cli: 0, node: 0, libraries: 1, proofs: ['document-edit'],
    });
    assert.throws(() => parseCatalog(run(HASH), HASH), isCode('catalog_check_failed'));
    fs.appendFileSync(file, '\n');
    assert.throws(() => parseCatalog(run(digest), digest), isCode('catalog_check_failed'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('TARGET script runs over stdin in an old backend that has only the existing sandbox driver', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-release-stdin-'));
  try {
    const modulePath = path.join(directory, 'src/services/doc-agent');
    fs.mkdirSync(modulePath, { recursive: true });
    const source = `const fs = require('node:fs');
exports.createSandbox = async () => {
  const results = ${JSON.stringify(responses())}; let index = 0;
  return {driver:'remote', exec: async () => results[index++],
    destroy: async () => fs.writeFileSync('destroyed', 'yes')};
};\n`;
    fs.writeFileSync(path.join(modulePath, 'sandbox.js'), source);
    const run = (args) => spawnSync(process.execPath, ['-', ...args], {
      cwd: directory, input: fs.readFileSync(SCRIPT, 'utf8'), encoding: 'utf8', timeout: 10000,
    });
    const child = run([HASH]);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const marker = 'SIRA_SANDBOX_RELEASE_OK ';
    assert.ok(child.stdout.startsWith(marker));
    assert.deepEqual(JSON.parse(child.stdout.slice(marker.length)), {
      ok: true, driver: 'remote', catalog: HASH, python: 3, libraries: 2, proofs: 2, checks: 5,
      // An old backend has no isolated code runner yet: reported, never fatal.
      codeRunner: { status: 'not_in_release' },
    });
    assert.equal(fs.readFileSync(path.join(directory, 'destroyed'), 'utf8'), 'yes');
    assert.equal(fs.existsSync(path.join(directory, 'src/services/agent-runner')), false);
    for (const args of [[], [HASH, HASH]]) {
      const invalid = run(args);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.equal(invalid.stderr, 'SIRA_SANDBOX_RELEASE_FAILED expected_catalog_argument_required\n');
    }
    fs.writeFileSync(path.join(modulePath, 'sandbox.js'), `exports.createSandbox = async () => { throw new Error(${JSON.stringify(PRIVATE)}); };`);
    const failed = run([HASH]);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, 'SIRA_SANDBOX_RELEASE_FAILED sandbox_transport_failed\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('publication binds both origin probes to the target checkout and postpublish has no runner-only rollback', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/publish-production.yml'), 'utf8');
  const before = workflow.slice(workflow.indexOf('      - name: Publish (reviewed publish.sh)'), workflow.indexOf('      - name: Verify the published backend'));
  const after = workflow.slice(workflow.indexOf('      - name: Verify the published backend'), workflow.indexOf('      - name: Publish and verify the existing computer orchestrator'));
  for (const step of [before, after]) {
    assert.match(step, /sha256sum "\$REPO\/backend\/src\/services\/agent-runner\/sandbox-capabilities\.json"/);
    assert.match(step, /docker exec -w \/app -i "\$\{backend_ids\[0\]\}" node - "\$expected_catalog" < "\$REPO\/backend\/scripts\/verify-agent-sandbox-runtime\.cjs"/);
  }
  assert.match(before, /trap rollback_runner_image EXIT/);
  assert.doesNotMatch(after, /rollback|docker image tag|\n\s+if:/);
  assert.match(after, /set -euo pipefail/);
});

// The chat's model-authored code path (agents/isolated-code-runner.js) is
// proven in the published backend: isolated driver, stdin, file read-back.
function fakeRunner({ mode = 'isolated', result, throws } = {}) {
  const calls = [];
  return {
    calls,
    loadRunner: () => ({
      resolveCodeExecutionMode: () => mode,
      runIsolated: async (opts) => {
        calls.push(opts);
        if (throws) throw new Error(PRIVATE);
        return result;
      },
    }),
  };
}
const runnerOk = (extra = {}) => ({
  ok: true,
  stdout: 'CODE_RUNNER_OK proof 10\n',
  isolation: { driver: 'docker', runtime: 'runsc', gvisor: true },
  collected: { 'out/proof.csv': Buffer.from('a,b\n1,3\n2,4\n') },
  ...extra,
});

test('isolated code runner: the exact chat path is proven with an isolated driver', async () => {
  const runner = fakeRunner({ result: runnerOk() });
  assert.deepEqual(await verifyIsolatedCodeRunner({ loadRunner: runner.loadRunner, env: {} }), {
    status: 'ok', driver: 'docker', gvisor: true,
  });
  const [call] = runner.calls;
  assert.equal(call.language, 'python');
  assert.equal(call.stdin, 'proof');
  assert.equal(call.persistKey, null, 'probes never touch a user workspace');
  assert.deepEqual(call.collect, ['out/proof.csv']);
  assert.match(call.source, /import os, sys, pandas as pd/);
});

test('workspace computer: staged upload, real bash and the outputs/ hand-back are proven, and reported without blocking', async () => {
  const workspaceResult = (extra = {}) => ({
    ok: true,
    stdout: 'WORKSPACE_OK 1\n',
    isolation: { driver: 'remote' },
    outbox: { files: [{ rel: 'probe-out.txt', buffer: Buffer.from('SIRA PROBE\n') }], skipped: [] },
    ...extra,
  });
  const runnerWith = (second) => {
    const calls = [];
    return {
      calls,
      loadRunner: () => ({
        OUTBOX_DETECTOR: 'import json',
        resolveCodeExecutionMode: () => 'isolated',
        runIsolated: async (opts) => {
          calls.push(opts);
          if (opts.workdir === 'workspace') {
            if (second instanceof Error) throw second;
            return second;
          }
          return runnerOk({ isolation: { driver: 'remote', gvisor: false } });
        },
      }),
    };
  };
  const good = runnerWith(workspaceResult());
  assert.deepEqual(await verifyIsolatedCodeRunner({ loadRunner: good.loadRunner, env: {} }), {
    status: 'ok', driver: 'remote', gvisor: false, workspace: 'ok',
  });
  const probe = good.calls.find((call) => call.workdir === 'workspace');
  assert.equal(probe.language, 'bash');
  assert.equal(probe.persistKey, null, 'never a user workspace');
  assert.deepEqual(probe.outbox, { dir: 'outputs' });
  assert.deepEqual(probe.stage.map((item) => item.rel), ['uploads/probe.txt']);
  // A failing workspace probe is reported in the release line, never fatal.
  for (const [result, status] of [
    [workspaceResult({ ok: false }), 'failed:run'],
    [workspaceResult({ stdout: 'otra cosa' }), 'failed:stdout'],
    [workspaceResult({ outbox: { files: [], skipped: [] } }), 'failed:outbox'],
    [new Error(PRIVATE), 'failed:error'],
  ]) {
    const out = await verifyIsolatedCodeRunner({ loadRunner: runnerWith(result).loadRunner, env: {} });
    assert.equal(out.status, 'ok');
    assert.equal(out.workspace, status);
    assert.ok(!JSON.stringify(out).includes(PRIVATE));
  }
});

test('isolated code runner: host mode and old releases are reported, not failed', async () => {
  assert.deepEqual(await verifyIsolatedCodeRunner({ loadRunner: fakeRunner({ mode: 'host' }).loadRunner, env: {} }), { status: 'host_mode' });
  const missing = () => { const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error; };
  assert.deepEqual(await verifyIsolatedCodeRunner({ loadRunner: missing, env: {} }), { status: 'not_in_release' });
});

test('isolated code runner: local driver, wrong output, missing file or a crash fail closed', async () => {
  const cases = [
    [runnerOk({ isolation: { driver: 'local' } }), 'code_runner_not_isolated'],
    [runnerOk({ ok: false }), 'code_runner_failed'],
    [runnerOk({ stdout: PRIVATE }), 'code_runner_failed'],
    [runnerOk({ collected: { 'out/proof.csv': null } }), 'code_runner_failed'],
    [runnerOk({ collected: { 'out/proof.csv': Buffer.from('a,b\n9,9\n') } }), 'code_runner_failed'],
  ];
  for (const [result, code] of cases) {
    await assert.rejects(verifyIsolatedCodeRunner({ loadRunner: fakeRunner({ result }).loadRunner, env: {} }), isCode(code));
  }
  await assert.rejects(verifyIsolatedCodeRunner({ loadRunner: fakeRunner({ throws: true }).loadRunner, env: {} }), isCode('code_runner_failed'));
  const broken = () => { throw new SyntaxError(PRIVATE); };
  await assert.rejects(verifyIsolatedCodeRunner({ loadRunner: broken, env: {} }), isCode('code_runner_failed'));
});
