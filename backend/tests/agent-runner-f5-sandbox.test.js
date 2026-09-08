'use strict';

/**
 * F5 — Sandbox hardening (gVisor / fail-closed isolation).
 *
 * (a) workspace path confinement: `../`, absolute paths, sneaky mixes and
 *     symlink-out escapes are all rejected;
 * (b) the docker driver enforces the isolation flags in the actual spawn
 *     args (verified against a stubbed docker CLI — this machine/CI may not
 *     have Docker): --runtime runsc, --network none, memory/cpu/pids/tmpfs
 *     limits, cap-drop, no-new-privileges, read-only rootfs, ulimits; and no
 *     docker.sock mount / host network / privileged flags can appear;
 * (c) runtime selection is honest: SIRAGPT_SANDBOX_REQUIRE_GVISOR=1 (or
 *     NODE_ENV=production) with runsc absent fails CLOSED — never a silent
 *     runc/local downgrade; explicit SIRAGPT_SANDBOX_RUNTIME=runc stays as
 *     the documented CI/dev opt-in;
 * (d) F3 abort still works: an abort mid-exec kills the process group and
 *     leaves no leaked process; destroy() still issues `docker rm -f`;
 * (e) command injection through crafted paths is neutralised (single-quote
 *     shell quoting, argv-only cat);
 * (f) real-isolation assertions run ONLY when Docker (+ the sandbox image)
 *     is actually present, and skip honestly otherwise.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');

const {
  createSandbox,
  resolveInWorkspace,
  resolveSandboxRuntime,
  buildDockerRunArgs,
  sandboxLimitsFromEnv,
  safeContainerRel,
  shQuote,
  SandboxRuntimeError,
  _createDockerSandbox,
} = require('../src/services/doc-agent/sandbox');

const pexec = promisify(execFile);

const ENV_CLEAN = Object.freeze({}); // no NODE_ENV, no flags — plain dev
const ENV_PROD = Object.freeze({ NODE_ENV: 'production' });
const ENV_REQUIRE = Object.freeze({ SIRAGPT_SANDBOX_REQUIRE_GVISOR: '1' });

function stubRunner(calls, { runExitCode = 0 } = {}) {
  return async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === 'run') {
      return { stdout: 'container-id\n', stderr: '', exitCode: runExitCode, timedOut: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, stdoutBuffer: Buffer.alloc(0) };
  };
}

function hasFlagPair(args, flag, value) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag && args[i + 1] === value) return true;
  }
  return false;
}

/* ── (a) workspace path confinement ──────────────────────────────────────── */

test('F5(a): resolveInWorkspace rejects traversal, absolute paths and sneaky mixes', () => {
  const root = '/srv/ws';
  assert.throws(() => resolveInWorkspace(root, '../../etc/passwd'), /escapes/);
  assert.throws(() => resolveInWorkspace(root, '..'), /escapes/);
  assert.throws(() => resolveInWorkspace(root, 'a/../../b'), /escapes/);
  assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), /absolute/);
  assert.throws(() => resolveInWorkspace(root, '/workspace/../etc/passwd'), /escapes/);
  assert.throws(() => resolveInWorkspace(root, ''), /empty/);
  // Legit shapes still resolve.
  assert.equal(resolveInWorkspace(root, 'uploads/a.pptx'), '/srv/ws/uploads/a.pptx');
  assert.equal(resolveInWorkspace(root, '/workspace/outputs/b.docx'), '/srv/ws/outputs/b.docx');
});

test('F5(a): docker-driver relative paths are confined under /workspace', () => {
  assert.equal(safeContainerRel('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeContainerRel('/etc/passwd'), 'etc/passwd');
  assert.equal(safeContainerRel('/workspace/../../root/.ssh/id_rsa'), 'root/.ssh/id_rsa');
  assert.equal(safeContainerRel('..'), '.');
  assert.equal(safeContainerRel(''), '.');
  assert.equal(safeContainerRel('uploads/a.pptx'), 'uploads/a.pptx');
});

test('F5(a): a symlink inside the local workspace pointing OUT is rejected (read/write)', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    // /etc/passwd via symlinked FILE
    await sandbox.exec('ln -s /etc/passwd leak-file');
    await assert.rejects(sandbox.readFile('leak-file'), /symlink/);
    // /etc/passwd via symlinked DIRECTORY
    await sandbox.exec('ln -s /etc leak-dir');
    await assert.rejects(sandbox.readFile('leak-dir/passwd'), /symlink/);
    // writes through the symlink are blocked too
    await assert.rejects(sandbox.writeFile('leak-dir/pwned', 'x'), /symlink/);
    await assert.rejects(sandbox.putFile('leak-file', Buffer.from('x')), /symlink/);
    // and legit files keep working
    await sandbox.writeFile('uploads/ok.txt', 'hola');
    assert.equal((await sandbox.readFile('uploads/ok.txt')).toString(), 'hola');
  } finally {
    await sandbox.destroy();
  }
});

test('F5(a): direct /etc/passwd reads are rejected by the path layer', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    await assert.rejects(sandbox.readFile('/etc/passwd'), /absolute/);
    await assert.rejects(sandbox.readFile('../../../etc/passwd'), /escapes/);
  } finally {
    await sandbox.destroy();
  }
});

/* ── (b) docker isolation flags actually enforced in spawn args ──────────── */

test('F5(b): buildDockerRunArgs carries every isolation flag by default', () => {
  const limits = sandboxLimitsFromEnv(ENV_CLEAN);
  const args = buildDockerRunArgs({ name: 'sira-doc-t', runtime: 'runsc', limits });
  assert.ok(hasFlagPair(args, '--runtime', 'runsc'));
  assert.ok(hasFlagPair(args, '--network', 'none'), 'network must be CLOSED');
  assert.ok(hasFlagPair(args, '--memory', '1g'));
  assert.ok(hasFlagPair(args, '--memory-swap', '1g'), 'no swap headroom beyond the memory cap');
  assert.ok(hasFlagPair(args, '--cpus', '1'));
  assert.ok(hasFlagPair(args, '--pids-limit', '256'));
  assert.ok(hasFlagPair(args, '--cap-drop', 'ALL'));
  assert.ok(hasFlagPair(args, '--security-opt', 'no-new-privileges'));
  assert.ok(args.includes('--read-only'), 'rootfs is read-only by default');
  assert.ok(hasFlagPair(args, '--ulimit', 'nofile=1024:1024'));
  assert.ok(args.some((a) => /^fsize=\d+:\d+$/.test(a)), 'per-file size ulimit present');
  assert.ok(args.some((a) => a.startsWith('/tmp:rw,exec,size=')), 'tmpfs /tmp');
  assert.ok(args.some((a) => a.startsWith('/workspace:rw,exec,size=')), 'ephemeral workspace is a size-capped tmpfs');
});

test('F5(b): no docker.sock mount, no host network, no privileged — ever', () => {
  // Even a hostile persistKey cannot smuggle a host path/socket into -v.
  const args = buildDockerRunArgs({
    name: 'sira-doc-t',
    runtime: 'runc',
    persistKey: '../../var/run/docker.sock:!@#',
    limits: sandboxLimitsFromEnv(ENV_CLEAN),
  });
  const joined = args.join(' ');
  assert.ok(!joined.includes('/var/run'), 'no host path leaks into the mount');
  assert.ok(!joined.includes('docker.sock'), 'docker.sock can never be mounted');
  assert.ok(!args.includes('--privileged'));
  assert.ok(!hasFlagPair(args, '--network', 'host'));
  const vol = args[args.indexOf('-v') + 1];
  assert.match(vol, /^sira-ws-[a-zA-Z0-9_-]+:\/workspace$/, `sanitised volume, got ${vol}`);
});

test('F5(b): limits are env-overridable and garbage env values fall back to defaults', () => {
  const custom = sandboxLimitsFromEnv({
    SIRAGPT_SANDBOX_CPUS: '2',
    SIRAGPT_SANDBOX_MEMORY: '2g',
    SIRAGPT_SANDBOX_PIDS_LIMIT: '512',
    SIRAGPT_SANDBOX_WORKSPACE_SIZE: '1g',
    SIRAGPT_SANDBOX_ULIMIT_NOFILE: '2048',
  });
  const args = buildDockerRunArgs({ name: 'n', runtime: 'runc', limits: custom });
  assert.ok(hasFlagPair(args, '--cpus', '2'));
  assert.ok(hasFlagPair(args, '--memory', '2g'));
  assert.ok(hasFlagPair(args, '--pids-limit', '512'));
  assert.ok(hasFlagPair(args, '--ulimit', 'nofile=2048:2048'));
  assert.ok(args.some((a) => a === '/workspace:rw,exec,size=1g'));

  const hostile = sandboxLimitsFromEnv({
    SIRAGPT_SANDBOX_MEMORY: '2g; rm -rf /',
    SIRAGPT_SANDBOX_WORKSPACE_SIZE: '$(reboot)',
    SIRAGPT_SANDBOX_CPUS: 'lots',
    SIRAGPT_SANDBOX_SECCOMP_PROFILE: 'unconfined',
  });
  assert.equal(hostile.memory, '1g', 'malformed memory falls back');
  assert.equal(hostile.workspaceSize, '512m', 'malformed size falls back');
  assert.equal(hostile.cpus, 1, 'malformed cpus falls back');
  assert.equal(hostile.seccompProfile, null, 'seccomp=unconfined is NEVER accepted');
});

test('F5(b): the stubbed docker CLI receives the hardened run args end-to-end', async () => {
  const calls = [];
  const sandbox = await _createDockerSandbox({
    processRunner: stubRunner(calls),
    availableRuntimes: ['runc', 'runsc'],
    env: ENV_CLEAN,
  });
  const run = calls.find((c) => c.args[0] === 'run');
  assert.ok(run, 'docker run happened');
  assert.ok(hasFlagPair(run.args, '--runtime', 'runsc'), 'runsc selected when available');
  assert.ok(hasFlagPair(run.args, '--network', 'none'));
  assert.ok(hasFlagPair(run.args, '--memory', '1g'));
  assert.ok(hasFlagPair(run.args, '--cpus', '1'));
  assert.ok(hasFlagPair(run.args, '--pids-limit', '256'));
  assert.ok(hasFlagPair(run.args, '--cap-drop', 'ALL'));
  assert.equal(sandbox.driver, 'docker');
  assert.equal(sandbox.runtime, 'runsc');
  assert.equal(sandbox.gvisor, true);
  await sandbox.destroy();
  const rm = calls.find((c) => c.args[0] === 'rm' && c.args[1] === '-f');
  assert.ok(rm, 'destroy still issues docker rm -f');
  assert.equal(rm.options.signal, undefined, 'cleanup uses an independent signal');
});

/* ── (c) honest runtime selection / fail-closed ──────────────────────────── */

test('F5(c): resolveSandboxRuntime decision matrix', () => {
  // runsc available → runsc, gvisor claimed truthfully
  assert.deepEqual(
    resolveSandboxRuntime({ env: ENV_CLEAN, availableRuntimes: ['runc', 'runsc'] }),
    { runtime: 'runsc', gvisor: true, fallback: false },
  );
  // dev/CI without runsc → runc, marked as a fallback and NOT gvisor
  assert.deepEqual(
    resolveSandboxRuntime({ env: ENV_CLEAN, availableRuntimes: ['runc'] }),
    { runtime: 'runc', gvisor: false, fallback: true },
  );
  // production without runsc → fail closed
  assert.throws(
    () => resolveSandboxRuntime({ env: ENV_PROD, availableRuntimes: ['runc'] }),
    SandboxRuntimeError,
  );
  // REQUIRE_GVISOR without runsc → fail closed
  assert.throws(
    () => resolveSandboxRuntime({ env: ENV_REQUIRE, availableRuntimes: ['runc'] }),
    SandboxRuntimeError,
  );
  // explicit runsc request that cannot be honoured → fail even in dev
  assert.throws(
    () => resolveSandboxRuntime({ env: { SIRAGPT_SANDBOX_RUNTIME: 'runsc' }, availableRuntimes: [] }),
    SandboxRuntimeError,
  );
  // explicit runc opt-in works in production (the documented escape hatch)
  assert.deepEqual(
    resolveSandboxRuntime({ env: { NODE_ENV: 'production', SIRAGPT_SANDBOX_RUNTIME: 'runc' }, availableRuntimes: ['runc'] }),
    { runtime: 'runc', gvisor: false, fallback: false },
  );
  // …but REQUIRE_GVISOR beats even the explicit runc opt-in
  assert.throws(
    () => resolveSandboxRuntime({
      env: { SIRAGPT_SANDBOX_REQUIRE_GVISOR: '1', SIRAGPT_SANDBOX_RUNTIME: 'runc' },
      availableRuntimes: ['runc', 'runsc'],
    }),
    SandboxRuntimeError,
  );
  // unknown value → honest config error
  assert.throws(
    () => resolveSandboxRuntime({ env: { SIRAGPT_SANDBOX_RUNTIME: 'firecracker' }, availableRuntimes: [] }),
    /inválido/,
  );
});

test('F5(c): REQUIRE_GVISOR=1 without runsc fails BEFORE any container is created', async () => {
  const calls = [];
  await assert.rejects(
    _createDockerSandbox({
      processRunner: stubRunner(calls),
      availableRuntimes: ['runc'],
      env: ENV_REQUIRE,
    }),
    (err) => err instanceof SandboxRuntimeError && /runsc/.test(err.message),
  );
  assert.equal(calls.filter((c) => c.args[0] === 'run').length, 0, 'no docker run was attempted');
});

test('F5(c): createSandbox with REQUIRE_GVISOR=1 never hands out the local driver', async () => {
  await assert.rejects(
    createSandbox({ driver: 'local', env: ENV_REQUIRE }),
    (err) => err instanceof SandboxRuntimeError && /local/.test(err.message),
  );
});

test('F5(c): createSandbox auto + REQUIRE_GVISOR=1 fails honestly or delivers real gVisor', async () => {
  // Hermetic across machines: without Docker (or without runsc) this MUST
  // reject with an honest error instead of degrading; on a host that truly
  // has Docker+runsc(+image) it must deliver a gvisor sandbox.
  let result;
  try {
    result = await createSandbox({ env: ENV_REQUIRE });
  } catch (err) {
    assert.match(String(err.message), /gVisor|runsc|Docker/i, `honest failure, got: ${err.message}`);
    assert.ok(err.name === 'SandboxRuntimeError' || /docker run failed/.test(String(err.message)));
    return;
  }
  try {
    assert.equal(result.driver, 'docker');
    assert.equal(result.gvisor, true, 'a sandbox handed out under REQUIRE_GVISOR must BE gVisor');
  } finally {
    await result.destroy();
  }
});

test('F5(c): the local driver never claims gVisor', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    assert.equal(sandbox.driver, 'local');
    assert.equal(sandbox.gvisor, false);
    assert.equal(sandbox.runtime, 'none');
  } finally {
    await sandbox.destroy();
  }
});

/* ── (d) F3 abort contract still holds ───────────────────────────────────── */

test('F5(d): abort mid-exec kills the process group — no leaked process', async () => {
  // Unique sleep DURATION as the marker so the leaf process itself is
  // identifiable in `ps` output (same technique as the F3 gate).
  const marker = `${4000 + (process.pid % 900)}.${Date.now() % 89}`;
  const sandbox = await createSandbox({ driver: 'local' });
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 150);
    const startedAt = Date.now();
    const r = await sandbox.exec(`sleep ${marker}`, { timeoutMs: 30_000, signal: controller.signal });
    assert.equal(r.aborted, true);
    assert.equal(r.exitCode, 130);
    assert.ok(Date.now() - startedAt < 5_000, 'abort unwinds quickly');
  } finally {
    await sandbox.destroy();
  }
  const { stdout } = await pexec('ps', ['-eo', 'args']).catch(() => ({ stdout: '' }));
  const leaked = String(stdout).split('\n').filter((l) => l.includes(`sleep ${marker}`) && !l.includes('ps -eo'));
  assert.deepEqual(leaked, [], `sandbox process leaked after abort: ${leaked.join(' | ')}`);
});

test('F5(d): docker exec forwards the per-call AbortSignal; destroy stays signal-independent', async () => {
  const calls = [];
  const sandbox = await _createDockerSandbox({
    processRunner: stubRunner(calls),
    availableRuntimes: ['runsc'],
    env: ENV_CLEAN,
  });
  const controller = new AbortController();
  await sandbox.exec('sleep 999', { signal: controller.signal });
  const exec = calls.find((c) => c.args[0] === 'exec' && String(c.args.at(-1)).includes('sleep 999'));
  assert.ok(exec, 'docker exec happened');
  assert.equal(exec.options.signal, controller.signal, 'per-call signal reaches the docker CLI spawn');
  await sandbox.destroy();
  const rm = calls.find((c) => c.args[0] === 'rm' && c.args[1] === '-f');
  assert.ok(rm && rm.options.signal === undefined);
});

/* ── (e) command injection through crafted paths ─────────────────────────── */

test('F5(e): crafted file names cannot break out of the docker shell commands', async () => {
  const calls = [];
  const sandbox = await _createDockerSandbox({
    processRunner: stubRunner(calls),
    availableRuntimes: ['runsc'],
    env: ENV_CLEAN,
  });
  const evil = "uploads/a'; touch /pwned; echo '$(reboot)";
  await sandbox.putFile(evil, Buffer.from('data'));
  const put = calls.find((c) => c.args[0] === 'exec' && c.args.includes('-i'));
  assert.ok(put, 'putFile streams through docker exec -i');
  const shCmd = put.args.at(-1);
  // The full destination path must be one single-quoted token: the embedded
  // quote is escaped, so `touch /pwned` and `$(reboot)` stay inert data.
  assert.ok(shCmd.includes(`cat > ${shQuote('/workspace/' + safeContainerRel(evil))}`), shCmd);
  assert.equal(put.options.input.toString(), 'data');

  await sandbox.readFile('outputs/report.pptx');
  const read = calls.find((c) => c.args[0] === 'exec' && c.args.includes('cat'));
  assert.deepEqual(read.args.slice(-2), ['cat', '/workspace/outputs/report.pptx'], 'read is argv-only, no shell');
  assert.equal(read.options.binary, true, 'binary-safe read (no utf8 truncation of OOXML)');

  calls.length = 0;
  await sandbox.listFiles('"; touch /pwned; "');
  const find = calls.find((c) => c.args[0] === 'exec' && String(c.args.at(-1)).includes('find'));
  assert.ok(find.args.at(-1).includes(shQuote(safeContainerRel('"; touch /pwned; "'))), find.args.at(-1));
  await sandbox.destroy();
});

test('F5(e): shQuote neutralises embedded single quotes', () => {
  assert.equal(shQuote("a'b"), "'a'\\''b'");
  assert.equal(shQuote('$(reboot)'), "'$(reboot)'");
});

/* ── (f) real-Docker isolation probes (skip honestly when absent) ────────── */

test('F5(f): real container has no network, read-only rootfs, writable /workspace', async (t) => {
  let runtimes = null;
  try {
    const r = await pexec('docker', ['info', '--format', '{{json .Runtimes}}']);
    runtimes = Object.keys(JSON.parse(String(r.stdout).trim() || '{}'));
  } catch (_) {
    t.skip('Docker no disponible en esta máquina — la prueba de aislamiento real se omite honestamente');
    return;
  }
  let sandbox;
  try {
    sandbox = await createSandbox({ driver: 'docker', env: ENV_CLEAN });
  } catch (err) {
    t.skip(`Docker presente pero el sandbox no arranca (imagen/permisos): ${String(err.message).slice(0, 160)}`);
    return;
  }
  try {
    assert.ok(['runsc', 'runc'].includes(sandbox.runtime));
    if (runtimes.includes('runsc')) assert.equal(sandbox.runtime, 'runsc');
    // network CLOSED: no interface except lo, and no way out
    const net = await sandbox.exec('cat /sys/class/net/eth0/operstate 2>/dev/null; (exec 3<>/dev/tcp/1.1.1.1/80) 2>&1; echo "net_rc=$?"', { timeoutMs: 20_000 });
    assert.ok(String(net.stdout).includes('net_rc=1') || net.exitCode !== 0, `network must be unreachable: ${net.stdout} ${net.stderr}`);
    // rootfs read-only, workspace writable
    const ro = await sandbox.exec('touch /pwned 2>&1; echo "root_rc=$?"; touch /workspace/ok && echo ws_ok', { timeoutMs: 20_000 });
    assert.ok(String(ro.stdout).includes('root_rc=1'), `rootfs must be read-only: ${ro.stdout}`);
    assert.ok(String(ro.stdout).includes('ws_ok'), `/workspace must be writable: ${ro.stdout}`);
    // file IO round-trip stays binary-safe through exec streaming
    const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00]);
    await sandbox.putFile('uploads/bin.dat', payload);
    assert.deepEqual(await sandbox.readFile('uploads/bin.dat'), payload);
  } finally {
    await sandbox.destroy();
  }
});
