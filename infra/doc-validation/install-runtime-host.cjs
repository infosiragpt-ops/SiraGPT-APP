'use strict';

// Resume the verified package installation from a real administrative host shell.
// No SSH, helper container, privilege escalation, profile changes or restarts.
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const guards = require('./install-runtime-config.cjs');
const { parseArchive, MEMBERS } = require('./install-runtime-apply.cjs');
const CONFIG = '/etc/docker/daemon.json';
const PACKAGE = path.dirname(guards.RUNTIME_PATH);
const LOCKS = ['/tmp/siragpt-publish.lock', '/usr/local/bin/.siragpt-gvisor-install-lock'];
const SMOKE_IMAGE = 'sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
const VALIDATOR_IMAGE = 'sha256:1a2be5c74d0291ffb120dbb5d8adb9689672858a181946adb7082c3398c4becc';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireValue = (value, code) => { if (!value) throw Error(code); };

function execute(binary, args, input, timeout = 30000) {
  const result = cp.spawnSync(binary, args, { input, timeout, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  // Neither configuration nor arbitrary stderr is returned on failure.
  requireValue(!result.error && result.status === 0, `host_command_failed_${path.basename(binary)}_${result.status ?? 'unavailable'}`);
  if (binary === '/usr/bin/dockerd' && args.includes('--validate')) {
    requireValue((String(result.stdout) + '\n' + String(result.stderr)).split('\n').some(s => s.trim() === 'configuration OK'),
      'dockerd_validation_not_confirmed');
    return 'configuration OK';
  }
  return result.stdout.toString('utf8').trim();
}
const docker = (args, input, timeout) => execute('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], input, timeout);

function assertTrustedMetadata(stat, directory = false, exactMode) {
  requireValue((directory ? stat.isDirectory() : stat.isFile()) && !stat.isSymbolicLink() &&
    stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o7022) &&
    (exactMode === undefined || (stat.mode & 0o777) === exactMode), 'unsafe_host_metadata');
}
function trustedFile(filename, limit, exactMode, maxLinks = 1) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assertTrustedMetadata(stat, false, exactMode);
    requireValue(stat.size <= limit && stat.nlink >= 1 && stat.nlink <= maxLinks, 'unsafe_host_file_size_or_links');
    return { bytes: fs.readFileSync(fd), mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
  } finally { fs.closeSync(fd); }
}
function assertRecoveryConfiguration(config, pending, write) {
  requireValue(config.dev === write.dev && config.ino === write.ino && hash(config.bytes) === write.configurationHash,
    'configuration_identity_or_hash_changed');
  if (config.nlink === 2) requireValue(pending && pending.nlink === 2 && pending.dev === config.dev && pending.ino === config.ino &&
    hash(pending.bytes) === write.configurationHash, 'configuration_pending_link_changed');
  else requireValue(config.nlink === 1, 'unsafe_host_file_size_or_links');
}
function configuration(recoveryWrite) {
  assertTrustedMetadata(fs.lstatSync('/etc/docker'), true);
  let config;
  try { config = trustedFile(CONFIG, 1024 * 1024, undefined, recoveryWrite?.pending ? 2 : 1); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (recoveryWrite) {
    const pending = config.nlink === 2 ? trustedFile(recoveryWrite.pending, 1024 * 1024, 0o644, 2) : null;
    assertRecoveryConfiguration(config, pending, recoveryWrite);
  }
  return config;
}
function assertReloadService(text, daemon) {
  const lines = Object.fromEntries(text.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  requireValue(lines.MainPID === String(daemon.pid) && lines.FragmentPath === '/lib/systemd/system/docker.service',
    'unexpected_docker_service');
  requireValue(/^\{ path=\/bin\/kill ; argv\[\]=\/bin\/kill -s HUP \$MAINPID ; ignore_errors=no ; [^{}\n]+ \}$/.test(lines.ExecReload || ''),
    'reload_is_not_exclusively_sighup');
}
function daemonIdentity() {
  const pid = fs.readFileSync('/run/docker.pid', 'utf8').trim();
  requireValue(/^[1-9][0-9]{0,8}$/.test(pid), 'unsafe_daemon_pid');
  const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const configAt = args.indexOf('--config-file');
  const configFlag = args.find(arg => arg.startsWith('--config-file='));
  const configPath = configFlag ? configFlag.slice('--config-file='.length) : configAt < 0 ? CONFIG : args[configAt + 1];
  requireValue(configPath === CONFIG && !args.some(arg => arg === '--add-runtime' || arg.startsWith('--add-runtime=')),
    'unexpected_daemon_configuration');
  const result = { pid: Number(pid), comm, startTicks };
  guards.assertDaemonIdentity(result, result);
  assertReloadService(execute('/usr/bin/systemctl', ['show', 'docker', '--property=MainPID', '--property=ExecReload', '--property=FragmentPath']), result);
  return result;
}
function snapshot(recoveryWrite) {
  const ids = docker(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean);
  requireValue(ids.length > 0 && ids.every(id => /^[a-f0-9]{64}$/.test(id)), 'invalid_container_ids');
  const containers = docker(['inspect', '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"pid":{{.State.Pid}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},"restarts":{{.RestartCount}},"runtime":{{json .HostConfig.Runtime}}}',
    ...ids]).split('\n').map(line => JSON.parse(line));
  const runtimeRows = docker(['info', '--format', '{{.DefaultRuntime}}{{println}}{{range $name, $runtime := .Runtimes}}{{$name}} {{$runtime.Path}}{{println}}{{end}}']).split('\n');
  const runtimes = Object.fromEntries(runtimeRows.slice(1).filter(Boolean).map(row => { const at = row.indexOf(' '); return [row.slice(0, at), row.slice(at + 1)]; }));
  const config = configuration(recoveryWrite);
  for (const name of ['/iliagpt-backend', '/iliagpt-frontend', '/iliagpt-db', '/iliagpt-redis']) {
    requireValue(containers.find(c => c.name === name)?.health === 'healthy', 'production_health_precondition');
  }
  return { daemon: daemonIdentity(), defaultRuntime: runtimeRows[0], runtimes, containers,
    configurationHash: config === null ? 'absent' : hash(config.bytes) };
}
function assertContinuity(before, after) {
  guards.assertProductionUnchanged({ ...before, containers: before.containers.filter(c => c.status === 'running') },
    { ...after, containers: after.containers.filter(c => c.status === 'running') });
  requireValue(new Set(after.containers.map(c => c.id)).size === after.containers.length, 'duplicate_container_snapshot');
  const current = new Map(after.containers.map(c => [c.id, c]));
  for (const prior of before.containers) {
    const next = current.get(prior.id);
    requireValue(next && ['name', 'pid', 'startedAt', 'status', 'restarts', 'runtime'].every(field => next[field] === prior[field]),
      'existing_container_changed');
    if (prior.health === 'healthy') requireValue(next.health === 'healthy', 'existing_container_unhealthy');
  }
}
function verifyInstalledPackage(archive) {
  requireValue(path.isAbsolute(archive), 'absolute_archive_required');
  const stat = fs.lstatSync(archive);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size === guards.ARCHIVE_BYTES, 'official_package_size_mismatch');
  const compressed = fs.readFileSync(archive);
  requireValue(crypto.createHash('sha512').update(compressed).digest('hex') === guards.ARCHIVE_SHA512, 'official_package_hash_mismatch');
  const result = cp.spawnSync('/usr/bin/bzip2', ['-dc'], { input: compressed, maxBuffer: 512 * 1024 * 1024, timeout: 60000 });
  requireValue(!result.error && result.status === 0, 'package_decompression_failed');
  const files = parseArchive(result.stdout);
  assertTrustedMetadata(fs.lstatSync('/usr/local/bin'), true);
  for (const directory of [PACKAGE, path.join(PACKAGE, 'gvisor-bin')]) assertTrustedMetadata(fs.lstatSync(directory), true, 0o755);
  requireValue(JSON.stringify(fs.readdirSync(PACKAGE).sort()) === JSON.stringify(['containerd-shim-runsc-v1', 'gvisor-bin', 'runsc']) &&
    JSON.stringify(fs.readdirSync(path.join(PACKAGE, 'gvisor-bin')).sort()) === JSON.stringify(MEMBERS.filter(s => s.startsWith('gvisor-bin/')).map(s => path.basename(s)).sort()),
    'installed_package_layout_changed');
  const manifest = [];
  for (const file of files.filter(f => !f.directory)) {
    const actual = trustedFile(path.join(PACKAGE, file.name), 128 * 1024 * 1024, 0o755);
    requireValue(actual.bytes.length === file.bytes.length && hash(actual.bytes) === hash(file.bytes), 'installed_package_content_changed');
    manifest.push({ name: file.name, bytes: actual.bytes.length, sha256: hash(actual.bytes) });
  }
  const version = execute(guards.RUNTIME_PATH, ['--version']);
  requireValue(version === `runsc version release-${guards.RELEASE}\nspec: 1.2.1`, 'installed_runsc_version_mismatch');
  return { release: guards.RELEASE, sha512: guards.ARCHIVE_SHA512, version, files: manifest };
}
function validateImageMetadata(id, row) {
  requireValue(row.id === id && row.architecture === 'amd64' && row.os === 'linux', 'required_image_identity_mismatch');
  if (id === VALIDATOR_IMAGE) requireValue(row.user === '65532:65532', 'validator_image_user_mismatch');
  return row;
}
function verifyImages() {
  return [SMOKE_IMAGE, VALIDATOR_IMAGE].map(id => {
    const row = JSON.parse(docker(['image', 'inspect', '--format', '{"id":{{json .Id}},"user":{{with (index .Config "User")}}{{json .}}{{else}}""{{end}},"architecture":{{json .Architecture}},"os":{{json .Os}}}', id]));
    return validateImageMetadata(id, row);
  });
}
function assertHost(mode) {
  requireValue(process.platform === 'linux' && os.hostname() === 'user-06' && process.arch === 'x64', 'expected_lenovo_host_required');
  requireValue(/^NoNewPrivs:\s+0$/m.test(fs.readFileSync('/proc/self/status', 'utf8')), 'administrative_host_context_required');
  assertTrustedMetadata(fs.lstatSync('/etc/sudo.conf'));
  if (mode !== '--preflight') requireValue(process.getuid() === 0, 'root_host_session_required');
}
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function exclusiveWrite(filename, bytes, mode) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    return { dev: stat.dev, ino: stat.ino };
  } finally { fs.closeSync(fd); }
}
function saveEvidence(filename, evidence) {
  const pending = `${filename}.${crypto.randomBytes(12).toString('hex')}.pending`;
  exclusiveWrite(pending, Buffer.from(JSON.stringify(evidence, null, 2) + '\n'), 0o600);
  fs.renameSync(pending, filename);
  syncDirectory(path.dirname(filename));
}
function acquireLocks(nonce) {
  const held = [];
  try {
    for (const directory of LOCKS) {
      fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.lstatSync(directory);
      held.push({ directory, dev: stat.dev, ino: stat.ino, ownerWritten: false });
      exclusiveWrite(path.join(directory, 'owner'), Buffer.from(nonce), 0o400);
      held[held.length - 1].ownerWritten = true;
    }
    return held;
  } catch (error) { releaseLocks(held, nonce); throw error; }
}
function releaseLocks(held, nonce) {
  for (const lock of [...held].reverse()) {
    const stat = fs.lstatSync(lock.directory);
    requireValue(stat.dev === lock.dev && stat.ino === lock.ino && stat.isDirectory() && !stat.isSymbolicLink(), 'lock_identity_changed');
    if (lock.ownerWritten) {
      requireValue(fs.readFileSync(path.join(lock.directory, 'owner'), 'utf8') === nonce, 'lock_owner_changed');
      fs.unlinkSync(path.join(lock.directory, 'owner'));
    }
    fs.rmdirSync(lock.directory);
  }
}
function commitAbsentConfiguration(directory, candidate, nonce, recordIntent, assertStillAbsent) {
  const filename = path.join(directory, 'daemon.json');
  const backup = path.join(directory, `.siragpt-runtime-${nonce}.backup`);
  const pending = path.join(directory, `.siragpt-runtime-${nonce}.candidate`);
  exclusiveWrite(backup, Buffer.from('absent\n'), 0o400);
  const identity = exclusiveWrite(pending, candidate, 0o644);
  syncDirectory(directory);
  const intent = { backup, backupSha256: hash(Buffer.from('absent\n')), pending, configurationHash: hash(candidate), ...identity };
  // Persist recovery identity before publishing. A crash after link() may leave
  // both names; recovery proves that exact second link and retains it as evidence.
  recordIntent(intent);
  assertStillAbsent();
  // link() is atomic and fails if anyone creates daemon.json concurrently.
  fs.linkSync(pending, filename);
  fs.unlinkSync(pending);
  syncDirectory(directory);
  return intent;
}
function writeAbsentConfiguration(candidate, nonce, before, recordIntent) {
  const assertStillAbsent = () => {
    guards.assertDaemonIdentity(before.daemon, daemonIdentity());
    guards.assertUnchangedConfiguration(configuration()?.bytes ?? null, 'absent');
  };
  assertStillAbsent();
  const intent = commitAbsentConfiguration('/etc/docker', candidate, nonce, recordIntent, assertStillAbsent);
  const written = configuration();
  requireValue(written && hash(written.bytes) === hash(candidate), 'configuration_write_not_confirmed');
  assertRecoveryConfiguration(written, null, intent);
  return intent;
}
async function reload(before, expectedHash, expectedRunsc) {
  assertContinuity(before, snapshot());
  guards.assertUnchangedConfiguration(configuration()?.bytes ?? null, expectedHash);
  guards.assertDaemonIdentity(before.daemon, daemonIdentity());
  execute('/usr/bin/systemctl', ['--no-ask-password', 'reload', 'docker'], undefined, 20000);
  const deadline = Date.now() + 15000;
  do {
    const current = snapshot();
    assertContinuity(before, current);
    requireValue(current.configurationHash === expectedHash, 'configuration_changed_after_reload');
    if (expectedRunsc ? current.runtimes.runsc === guards.RUNTIME_PATH : !Object.hasOwn(current.runtimes, 'runsc')) return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw Error('runtime_reload_not_confirmed');
}
function smoke(nonce, save) {
  const name = `doc-validation-runtime-smoke-${nonce}`;
  const id = docker(['create', '--name', name, '--pull', 'never', '--runtime', 'runsc', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--read-only', '--user', '65532:65532', '--memory', '128m', '--cpus', '0.5',
    '--pids-limit', '32', '--label', 'siragpt.role=doc-validation-runtime-smoke', '--entrypoint', 'node', SMOKE_IMAGE,
    '-e', 'console.log(JSON.stringify({uid:process.getuid(),message:"runsc-isolated-smoke-ok"}))']);
  requireValue(/^[a-f0-9]{64}$/.test(id), 'invalid_smoke_id');
  const evidence = { id, name, removed: false }; save(evidence);
  try {
    const output = JSON.parse(docker(['start', '-a', id], undefined, 30000));
    const state = JSON.parse(docker(['inspect', '--format', '{"runtime":{{json .HostConfig.Runtime}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}}}', id]));
    requireValue(state.runtime === 'runsc' && state.status === 'exited' && state.exitCode === 0 &&
      output.uid === 65532 && output.message === 'runsc-isolated-smoke-ok', 'runsc_smoke_failed');
    Object.assign(evidence, state, { output });
  } finally { docker(['rm', '-f', id]); evidence.removed = true; save(evidence); }
  return evidence;
}
async function main() {
  const [mode, archive] = process.argv.slice(2);
  requireValue(['--preflight', '--apply'].includes(mode) && process.argv.length === 4, 'usage_preflight_or_apply_absolute_archive');
  assertHost(mode);
  const evidenceDir = fs.mkdtempSync('/tmp/siragpt-runtime-host-evidence.'); fs.chmodSync(evidenceDir, 0o700);
  const evidence = { startedAt: new Date().toISOString(), mode, hostWrites: false };
  const save = () => saveEvidence(path.join(evidenceDir, 'evidence.json'), evidence);
  const stage = name => { evidence.stage = name; save(); console.log(JSON.stringify({ stage: name, evidenceDir })); };
  const nonce = crypto.randomBytes(12).toString('hex'); let locks = [];
  try {
    stage('verify-installed-package-and-images'); evidence.package = verifyInstalledPackage(archive); evidence.images = verifyImages();
    stage('read-production-preflight'); const before = snapshot(); evidence.before = before;
    requireValue(before.defaultRuntime === 'runc' && !Object.hasOwn(before.runtimes, 'runsc') && before.configurationHash === 'absent', 'resume_precondition_changed');
    const plan = guards.planConfiguration(null); evidence.configuration = { originalHash: plan.originalHash, candidateHash: plan.candidateHash };
    execute('/usr/bin/dockerd', ['--validate', '--config-file=/dev/stdin'], plan.candidate); evidence.hostDockerdValidation = true;
    if (mode === '--preflight') { stage('preflight-passed-no-configuration-writes'); return; }
    stage('acquire-publish-and-install-locks'); locks = acquireLocks(nonce);
    assertContinuity(before, snapshot()); verifyInstalledPackage(archive);
    stage('backup-cas-absent-configuration'); evidence.hostWrites = true; save();
    evidence.configurationWrite = writeAbsentConfiguration(plan.candidate, nonce, before, intent => {
      evidence.configurationWrite = intent; save();
    }); save();
    stage('host-systemctl-reload-only'); evidence.after = await reload(before, plan.candidateHash, true);
    stage('runsc-nonroot-smoke'); evidence.smoke = smoke(nonce, row => { evidence.smoke = row; save(); });
    evidence.final = snapshot(); assertContinuity(before, evidence.final);
    stage('registered-smoke-passed-no-restarts');
  } catch (error) {
    evidence.error = { stage: evidence.stage, code: error.code || error.message };
    console.error(JSON.stringify({ failed: true, code: evidence.error.code, evidenceDir, hostWrites: evidence.hostWrites })); process.exitCode = 1;
  } finally {
    if (locks.length) { try { releaseLocks(locks, nonce); evidence.locksReleased = true; } catch { evidence.locksReleased = false; process.exitCode = 1; } }
    save();
  }
}
module.exports = { assertTrustedMetadata, assertReloadService, assertContinuity, verifyInstalledPackage, assertHost,
  configuration, daemonIdentity, snapshot, reload, acquireLocks, releaseLocks, trustedFile, syncDirectory, hash, CONFIG, SMOKE_IMAGE, VALIDATOR_IMAGE,
  assertRecoveryConfiguration, validateImageMetadata, commitAbsentConfiguration, saveEvidence };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.message })); process.exitCode = 1; });
