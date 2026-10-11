'use strict';

// The sandbox installer: a throw-away installer container streams approved
// wheels into a --network none sandbox. Exercised without Docker or pip: a
// fake `docker` CLI and a fake `python3` on PATH reproduce the exact
// shell contract, so the script, the pipe, the caps, the staging/commit
// dance and the driver methods are all tested end to end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pip = require('../src/services/doc-agent/sandbox-pip');
const sandboxModule = require('../src/services/doc-agent/sandbox');
const { createRemoteSandbox } = require('../src/services/doc-agent/remote-sandbox');
const { writeFakePython3 } = require('./helpers/fake-pip-python');
const { writeFakeDocker } = require('./helpers/fake-docker');

const REPO = path.join(__dirname, '..', '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** spawn with the fake binaries first on PATH plus extra env knobs. */
function fakeSpawn(binDir, extra = {}) {
  return (cmd, args, opts = {}) => spawn(cmd, args, {
    ...opts,
    env: { ...(opts.env || process.env), PATH: `${binDir}:${process.env.PATH}`, ...extra },
  });
}

test('the install script: pip --user --only-binary, output on stderr, allowlist validation of the report, tar on stdout', () => {
  const script = pip.buildInstallScript({ requirements: ['seaborn==0.13.2', 'numpy'], indexUrl: 'https://devpi.local/simple/' });
  assert.match(script, /python3 -m pip install --user --only-binary=:all: --no-cache-dir --no-warn-script-location --timeout 60 --retries 2 --index-url 'https:\/\/devpi\.local\/simple\/' --report "\$BASE\/report\.json" -- 'seaborn==0\.13\.2' 'numpy' 1>&2/);
  assert.match(script, /SIRA_PIP_ALLOW/);
  assert.match(script, /SIRA_PIP_NOT_ALLOWED/);
  assert.match(script, /cd "\$BASE\/site" && tar -cf - \.$/);
  assert.doesNotMatch(script, /--index-url ''/);
  assert.doesNotMatch(pip.buildInstallScript({ requirements: ['numpy'] }), /--index-url/);
  for (const bad of [['git+https://x'], ['./x.whl'], ['a b'], ["x'; rm -rf /"], []]) {
    assert.throws(() => pip.buildInstallScript({ requirements: bad }), /unsafe requirement|requirements are required/, JSON.stringify(bad));
  }
  assert.throws(() => pip.buildInstallScript({ requirements: ['numpy'], indexUrl: 'ftp://x' }), /unsafe index url/);
  assert.throws(() => pip.buildInstallScript({ requirements: ['numpy'], base: '/tmp/x; id' }), /unsafe base dir/);
});

test('the installer container mirrors the sandbox hardening, gets a network and NEVER the workspace', () => {
  const args = pip.installerRunArgs({
    name: 'sira-pip-1', image: 'siragpt-doc-sandbox:latest', runtime: 'runsc', network: 'iliagpt-app',
    limits: { memory: '1g', cpus: 1, pidsLimit: 256, ulimitNofile: 1024, maxFileBytes: 268435456 }, tmpSize: '1g',
    allowJson: '["numpy"]', script: 'echo hi',
  });
  const joined = args.join(' ');
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.match(joined, /--runtime runsc --network iliagpt-app --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges --read-only --ulimit nofile=1024:1024 --ulimit fsize=268435456:268435456 --tmpfs \/tmp:rw,exec,size=1g -e HOME=\/tmp -e TMPDIR=\/tmp -e SIRA_PIP_ALLOW=\["numpy"\] siragpt-doc-sandbox:latest bash -c echo hi$/);
  assert.ok(!args.includes('-v') && !args.includes('--mount'), 'no volume: the only output is the tar on stdout');
  assert.ok(!args.includes('-d') && !args.includes('-i'), 'foreground, no stdin');
  const minimal = pip.installerRunArgs({ name: 'n', image: 'img', runtime: null, script: 'x' });
  assert.ok(!minimal.includes('--runtime'), 'the microservice runs without a pinned runtime');
  assert.ok(minimal.includes('--network') && minimal[minimal.indexOf('--network') + 1] === 'bridge');
  assert.throws(() => pip.installerRunArgs({ name: 'n', image: 'img', script: 'x', network: 'bad net' }), /unsafe docker network/);
  assert.throws(() => pip.installerRunArgs({ name: 'n', image: 'img', script: 'x', tmpSize: '1g;id' }), /unsafe tmpfs size/);
});

test('stderr markers and pip wording classify the outcome for the model', () => {
  assert.deepEqual(pip.parseInstallerStderr('Collecting x\nSIRA_PIP_OK [{"name":"numpy","version":"2.1.0"}]\n'), {
    code: 'ok', installed: [{ name: 'numpy', version: '2.1.0' }], notAllowed: [], notFound: [], detail: 'Collecting x',
  });
  assert.equal(pip.parseInstallerStderr('SIRA_PIP_NOT_ALLOWED torch,nvidia-cublas').code, 'not_allowed');
  assert.deepEqual(pip.parseInstallerStderr('SIRA_PIP_NOT_ALLOWED torch,nvidia-cublas').notAllowed, ['torch', 'nvidia-cublas']);
  const nf = pip.parseInstallerStderr('ERROR: No matching distribution found for foo==9\nSIRA_PIP_INSTALL_FAILED 1');
  assert.equal(nf.code, 'not_found');
  assert.deepEqual(nf.notFound, ['foo==9']);
  assert.equal(pip.parseInstallerStderr('WARNING: Retrying … NewConnectionError … Max retries exceeded\nSIRA_PIP_INSTALL_FAILED 1').code, 'network');
  assert.equal(pip.parseInstallerStderr('OSError: [Errno 28] No space left on device\nSIRA_PIP_INSTALL_FAILED 1').code, 'disk');
  assert.equal(pip.parseInstallerStderr('SIRA_PIP_REPORT_UNREADABLE boom').code, 'report_unreadable');
  assert.equal(pip.parseInstallerStderr('nothing').code, 'install_failed');
});

test('pipeProcesses: byte cap, timeout, abort and a missing producer all resolve with a verdict and kill both sides', async () => {
  const big = await pip.pipeProcesses({ producer: { cmd: 'bash', args: ['-c', 'head -c 3000000 /dev/zero'] }, consumer: { cmd: 'bash', args: ['-c', 'cat > /dev/null'] }, maxBytes: 1024 * 1024, timeoutMs: 10_000 });
  assert.equal(big.tooLarge, true);
  assert.ok(big.bytes > 1024 * 1024);
  const slow = await pip.pipeProcesses({ producer: { cmd: 'bash', args: ['-c', 'sleep 5'] }, consumer: { cmd: 'cat', args: [] }, maxBytes: 1024, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const aborted = await pip.pipeProcesses({ producer: { cmd: 'bash', args: ['-c', 'sleep 5'] }, consumer: { cmd: 'cat', args: [] }, maxBytes: 1024, timeoutMs: 5000, signal: ac.signal });
  assert.equal(aborted.aborted, true);
  const missing = await pip.pipeProcesses({ producer: { cmd: 'definitely-missing-binary-xyz', args: [] }, consumer: { cmd: 'cat', args: [] }, maxBytes: 1024, timeoutMs: 5000 });
  assert.equal(missing.exitCode, 127);
  assert.match(missing.stderr, /ENOENT/);
  const fine = await pip.pipeProcesses({ producer: { cmd: 'bash', args: ['-c', 'printf hello'] }, consumer: { cmd: 'bash', args: ['-c', 'cat > /dev/null'] }, maxBytes: 1024, timeoutMs: 5000 });
  assert.deepEqual([fine.exitCode, fine.consumerExitCode, fine.bytes, fine.tooLarge, fine.timedOut], [0, 0, 5, false, false]);
});

test('local driver: an approved install lands in <root>/.sira-packages and every failure leaves no staging behind', async () => {
  const bin = tmpDir('sira-fakebin-');
  writeFakePython3(bin);
  const root = tmpDir('sira-ws-');
  const run = (requirements, allow, extra = {}, more = {}) => pip.runSandboxInstall({
    kind: 'local', root, requirements, allowJson: JSON.stringify(allow), timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024,
    spawnImpl: fakeSpawn(bin, extra), ...more,
  });
  const ok = await run(['seaborn==0.13.2'], ['seaborn', 'numpy']);
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 'ok');
  assert.deepEqual(ok.installed, [{ name: 'seaborn', version: '1.2.3' }]);
  assert.ok(ok.bytes > 0);
  assert.ok(fs.existsSync(path.join(root, '.sira-packages/lib/python3.12/site-packages/seaborn/__init__.py')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.sira-packages/.sira/installed.json'), 'utf8')), { installed: [{ name: 'seaborn', version: '1.2.3' }] });
  const notAllowed = await run(['numpy'], ['numpy'], { FAKE_PIP_DEP: 'torch' });
  assert.equal(notAllowed.code, 'not_allowed');
  assert.deepEqual(notAllowed.notAllowed, ['torch']);
  assert.ok(!fs.existsSync(path.join(root, '.sira-packages/lib/python3.12/site-packages/numpy')), 'one unapproved dependency refuses the whole batch');
  assert.equal((await run(['foo==9'], ['foo'], { FAKE_PIP_FAIL: 'notfound' })).code, 'not_found');
  assert.equal((await run(['foo'], ['foo'], { FAKE_PIP_FAIL: 'network' })).code, 'network');
  assert.equal((await run(['bigpkg'], ['bigpkg'], { FAKE_PIP_BYTES: String(30 * 1024 * 1024) }, { maxBytes: 10 * 1024 * 1024 })).code, 'too_large');
  assert.equal((await run(['slowpkg'], ['slowpkg'], { FAKE_PIP_SLEEP: '5' }, { timeoutMs: 800 })).code, 'timeout');
  const second = await run(['numpy'], ['numpy']);
  assert.equal(second.code, 'ok');
  for (const name of ['seaborn', 'numpy']) assert.ok(fs.existsSync(path.join(root, `.sira-packages/lib/python3.12/site-packages/${name}/__init__.py`)), `${name} survives the next install`);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('staging')), [], 'no staging dir survives');
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sira-pip-') && fs.existsSync(path.join(os.tmpdir(), n, 'report.json'))), [], 'installer bases are cleaned');
  assert.equal((await pip.runSandboxInstall({ kind: 'local', root, requirements: ['git+https://x'] })).code, 'invalid_request');
  assert.equal((await pip.runSandboxInstall({ kind: 'nope', requirements: ['numpy'] })).code, 'invalid_request');
});

test('docker driver: installer `docker run` streams into `docker exec -i tar`, staging is committed with cp -a and the sandbox never gets a network', async () => {
  const bin = tmpDir('sira-fakebin-');
  writeFakePython3(bin);
  writeFakeDocker(bin);
  const root = tmpDir('sira-ws-');
  const tmpBase = tmpDir('sira-piptmp-');
  const log = path.join(tmpBase, 'docker.log');
  const env = { FAKE_DOCKER_ROOT: root, FAKE_DOCKER_TMP: tmpBase, FAKE_DOCKER_LOG: log };
  const spawnImpl = fakeSpawn(bin, env);
  const runCommand = (cmd, args, opts = {}) => pip.runCommandOnce(cmd, args, { ...opts, spawnImpl });
  const result = await pip.runSandboxInstall({
    kind: 'docker', containerName: 'sira-doc-abc', image: 'siragpt-doc-sandbox:latest', runtime: 'runsc',
    limits: { memory: '1g', cpus: 1, pidsLimit: 256 }, requirements: ['seaborn'], allowJson: JSON.stringify(['seaborn']),
    network: 'bridge', timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024, spawnImpl, runCommand,
  });
  assert.equal(result.code, 'ok', result.detail);
  assert.ok(fs.existsSync(path.join(root, '.sira-packages/lib/python3.12/site-packages/seaborn/__init__.py')));
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(lines[0], /^docker run --rm --name sira-pip-[0-9a-f]+ --runtime runsc --network bridge --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs \/tmp:rw,exec,size=1g -e HOME=\/tmp -e TMPDIR=\/tmp -e SIRA_PIP_ALLOW=\["seaborn"\] siragpt-doc-sandbox:latest bash -c /);
  assert.match(lines[1], /^docker exec -i sira-doc-abc sh -c rm -rf '\/workspace\/\.sira-packages\.staging-[0-9a-f]+' && mkdir -p .* && tar -xf - -C /);
  assert.match(lines[2], /^docker exec sira-doc-abc sh -c mkdir -p '\/workspace\/\.sira-packages' && cp -a '\/workspace\/\.sira-packages\.staging-[0-9a-f]+'\/\. '\/workspace\/\.sira-packages'\/ && rm -rf /);
  assert.equal(lines.length, 3, 'no rollback and no rm on success');
  // A refused batch: rollback of the staging dir + rm -f of the installer.
  const refused = await pip.runSandboxInstall({
    kind: 'docker', containerName: 'sira-doc-abc', image: 'siragpt-doc-sandbox:latest', runtime: null,
    requirements: ['numpy'], allowJson: JSON.stringify(['numpy']), timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024,
    spawnImpl: fakeSpawn(bin, { ...env, FAKE_PIP_DEP: 'torch' }), runCommand,
  });
  assert.equal(refused.code, 'not_allowed');
  const after = fs.readFileSync(log, 'utf8').trim().split('\n').slice(3);
  assert.ok(after.some((l) => /^docker exec sira-doc-abc sh -c rm -rf '\/workspace\/\.sira-packages\.staging-/.test(l)), 'staging rolled back');
  assert.ok(after.some((l) => /^docker rm -f sira-pip-/.test(l)), 'installer removed');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('staging')), []);
  // A docker daemon failure is an honest install_failed, never a crash.
  const daemon = await pip.runSandboxInstall({
    kind: 'docker', containerName: 'sira-doc-abc', image: 'img', requirements: ['numpy'], allowJson: '["numpy"]',
    timeoutMs: 30_000, maxBytes: 1024 * 1024, spawnImpl: fakeSpawn(bin, { ...env, FAKE_DOCKER_RUN_FAIL: 'no such image' }), runCommand,
  });
  assert.equal(daemon.code, 'install_failed');
  assert.match(daemon.detail, /no such image/);
});

test('sandbox drivers expose installPythonPackages with the policy-derived options (docker: container, image, runtime, limits; local: root)', async () => {
  const calls = [];
  const processRunner = async (command, args) => { calls.push([command, ...args].join(' ')); return { exitCode: 0, stdout: '', stderr: '' }; };
  let captured = null;
  const docker = await sandboxModule._createDockerSandbox({
    processRunner, availableRuntimes: ['runc', 'runsc'], persistKey: 'chat1', env: { NODE_ENV: 'test' },
    installRunner: async (opts) => { captured = opts; return { ok: true, code: 'ok', installed: [{ name: 'numpy', version: '2' }], bytes: 1, durationMs: 1, detail: '' }; },
  });
  const r = await docker.installPythonPackages({ requirements: ['numpy'], allowJson: '["numpy"]', indexUrl: 'https://x/simple/', network: 'iliagpt-app', timeoutMs: 1, maxBytes: 1, tmpSize: '1g;id' });
  assert.equal(r.code, 'ok');
  assert.equal(captured.kind, 'docker');
  assert.match(captured.containerName, /^sira-doc-/);
  assert.equal(captured.image, sandboxModule.DOCKER_IMAGE);
  assert.equal(captured.runtime, 'runsc');
  assert.equal(captured.limits.memory, '1g');
  assert.deepEqual([captured.requirements, captured.allowJson, captured.indexUrl, captured.network], [['numpy'], '["numpy"]', 'https://x/simple/', 'iliagpt-app']);
  assert.equal(captured.timeoutMs, 30_000, 'clamped');
  assert.equal(captured.maxBytes, 10 * 1024 * 1024, 'clamped');
  assert.equal(captured.tmpSize, '1g', 'unsafe size falls back');
  assert.equal(typeof captured.runCommand, 'function');
  await captured.runCommand('docker', ['exec', 'x', 'true']);
  assert.ok(calls.some((c) => c === 'docker exec x true'), 'commit/rollback commands ride the driver\'s own process runner');
  await docker.destroy();
  await assert.rejects(docker.installPythonPackages({ requirements: ['numpy'] }), /destroyed/);

  let localCaptured = null;
  const local = await sandboxModule._createLocalSandbox({ installRunner: async (opts) => { localCaptured = opts; return { ok: false, code: 'network', installed: [], bytes: 0, durationMs: 1, detail: '' }; } });
  const lr = await local.installPythonPackages({ requirements: ['numpy'], allowJson: '["numpy"]' });
  assert.equal(lr.code, 'network');
  assert.equal(localCaptured.kind, 'local');
  assert.equal(localCaptured.root, local.root);
  await local.destroy();
});

test('remote driver: POST /v1/sessions/:id/install carries the validated request and the same result comes back', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null, method: init.method });
    if (url.endsWith('/v1/sessions')) return new Response(JSON.stringify({ sessionId: 's1' }), { status: 201 });
    if (url.endsWith('/install')) return new Response(JSON.stringify({ ok: true, code: 'ok', installed: [{ name: 'numpy', version: '2' }], bytes: 5, durationMs: 7, detail: '' }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const remote = createRemoteSandbox({ baseUrl: 'https://sandbox.test', apiKey: 'k', fetchImpl, workspaceKey: 'chat1' });
  const r = await remote.installPythonPackages({ requirements: ['numpy'], allowJson: '["numpy","pandas"]', indexUrl: null, network: 'bridge', timeoutMs: 45_000, maxBytes: 123456789, tmpSize: '1g' });
  assert.equal(r.code, 'ok');
  const install = requests.find((q) => q.url.endsWith('/v1/sessions/s1/install'));
  assert.ok(install, 'install request sent to the session');
  assert.deepEqual(install.body, { requirements: ['numpy'], allow: ['numpy', 'pandas'], indexUrl: null, network: 'bridge', timeoutMs: 45_000, maxBytes: 123456789, tmpSize: '1g' });
  await remote.destroy();
});

test('the sandbox microservice ships a byte-identical copy of sandbox-pip.js', () => {
  const backend = fs.readFileSync(path.join(REPO, 'backend/src/services/doc-agent/sandbox-pip.js'), 'utf8');
  const service = fs.readFileSync(path.join(REPO, 'services/sandbox/lib/sandbox-pip.js'), 'utf8');
  assert.equal(service, backend, 'services/sandbox/lib/sandbox-pip.js must mirror backend/src/services/doc-agent/sandbox-pip.js');
  const server = fs.readFileSync(path.join(REPO, 'services/sandbox/server.js'), 'utf8');
  assert.match(server, /action === 'install'/);
  assert.match(server, /validateInstallBody/);
});
