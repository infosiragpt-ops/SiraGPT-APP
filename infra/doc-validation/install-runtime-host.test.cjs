'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { assertTrustedMetadata, assertReloadService, assertContinuity, assertRecoveryConfiguration,
  validateImageMetadata, commitAbsentConfiguration, saveEvidence, SMOKE_IMAGE, VALIDATOR_IMAGE } = require('./install-runtime-host.cjs');
const { validateHostRecovery } = require('./install-runtime-host-rollback.cjs');
const { planConfiguration } = require('./install-runtime-config.cjs');
const { createHash } = require('node:crypto');
const daemon = { pid: 173770, comm: 'dockerd', startTicks: '7292944' };
const service = 'MainPID=173770\nExecReload={ path=/bin/kill ; argv[]=/bin/kill -s HUP $MAINPID ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\nFragmentPath=/lib/systemd/system/docker.service';
test('host reload accepts exactly the observed SIGHUP-only service', () => assertReloadService(service, daemon));
for (const [label, modified] of [
  ['PID reuse target', service.replace('MainPID=173770', 'MainPID=173771')],
  ['SIGTERM', service.replace('-s HUP', '-s TERM')],
  ['shell wrapper', service.replace('path=/bin/kill', 'path=/bin/sh')],
  ['second command', service.replace('FragmentPath=', 'ExecReload={ path=/bin/kill ; argv[]=/bin/kill -s HUP $MAINPID ; ignore_errors=no ; pid=0 } { path=/bin/sh ; argv[]=/bin/sh unsafe ; ignore_errors=no }\nFragmentPath=')],
  ['ignored signal error', service.replace('ignore_errors=no', 'ignore_errors=yes')],
  ['different unit', service.replace('/lib/systemd/system/docker.service', '/tmp/docker.service')],
]) test(`reject reload with ${label}`, () => assert.throws(() => assertReloadService(modified, daemon)));

const meta = { uid: 0, gid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
test('only root-owned regular package executables with 0755 are trusted', () => {
  assertTrustedMetadata(meta, false, 0o755);
  for (const changed of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o104755 }, { mode: 0o100775 }, { mode: 0o100777 },
    { isSymbolicLink: () => true }, { isFile: () => false }]) assert.throws(() => assertTrustedMetadata({ ...meta, ...changed }, false, 0o755));
});
const running = { id: 'a'.repeat(64), name: '/prod-fixture', pid: 1234, startedAt: '2026-09-04T20:31:10Z', status: 'running', health: 'healthy', restarts: 0, runtime: 'runc' };
const stopped = { ...running, id: 'b'.repeat(64), name: '/stopped-fixture', pid: 0, status: 'exited', health: null };
const baseline = { defaultRuntime: 'runc', daemon, containers: [running, stopped] };
test('continuity includes stopped containers and restart count', () => {
  assertContinuity(baseline, structuredClone(baseline));
  for (const [index, field, value] of [[0, 'restarts', 1], [0, 'runtime', 'runsc'], [1, 'status', 'running'], [1, 'startedAt', '2026-09-05T01:00:00Z']]) {
    const after = structuredClone(baseline); after.containers[index][field] = value;
    assert.throws(() => assertContinuity(baseline, after));
  }
  assert.throws(() => assertContinuity(baseline, { ...baseline, containers: [running] }));
});
test('CAS recovery refuses unrelated content and requires the recorded inode', () => {
  const candidateHash = planConfiguration(null).candidateHash;
  const evidence = { mode: '--apply', configuration: { originalHash: 'absent', candidateHash }, configurationWrite: {
    configurationHash: candidateHash, backup: '/etc/docker/.siragpt-runtime-' + 'a'.repeat(24) + '.backup',
    backupSha256: createHash('sha256').update('absent\n').digest('hex'), dev: 1, ino: 2 } };
  validateHostRecovery(evidence);
  for (const changed of [{ mode: '--preflight' }, { configurationWrite: { ...evidence.configurationWrite, ino: undefined } },
    { configurationWrite: { ...evidence.configurationWrite, pending: '/etc/docker/unrelated.candidate' } },
    { configuration: { originalHash: 'absent', candidateHash: 'b'.repeat(64) }, configurationWrite: { ...evidence.configurationWrite, configurationHash: 'b'.repeat(64) } }]) {
    assert.throws(() => validateHostRecovery({ ...evidence, ...changed }));
  }
});
test('smoke image may omit Config.User while the validator must declare the fixed nonroot UID', () => {
  const row = { id: SMOKE_IMAGE, architecture: 'amd64', os: 'linux' };
  validateImageMetadata(SMOKE_IMAGE, row);
  validateImageMetadata(SMOKE_IMAGE, { ...row, user: '' });
  for (const user of [undefined, '', null, '0', '65532']) {
    assert.throws(() => validateImageMetadata(VALIDATOR_IMAGE, { ...row, id: VALIDATOR_IMAGE, user }), /validator_image_user_mismatch/);
  }
  validateImageMetadata(VALIDATOR_IMAGE, { ...row, id: VALIDATOR_IMAGE, user: '65532:65532' });
  assert.throws(() => validateImageMetadata(SMOKE_IMAGE, { ...row, id: VALIDATOR_IMAGE }), /required_image_identity_mismatch/);
});
function readFixtureFile(filename) {
  const stat = fs.statSync(filename);
  return { bytes: fs.readFileSync(filename), dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}
test('failure immediately after publishing preserves a complete recovery journal and exact two-link proof', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-runtime-commit-'));
  const filename = path.join(directory, 'daemon.json');
  const journal = path.join(directory, 'evidence.json');
  const originalLink = fs.linkSync;
  const originalUmask = process.umask(0o077);
  const plan = planConfiguration(null);
  const evidence = { mode: '--apply', configuration: { originalHash: plan.originalHash, candidateHash: plan.candidateHash } };
  try {
    fs.linkSync = (source, destination) => {
      if (destination !== filename) return originalLink(source, destination);
      const recorded = JSON.parse(fs.readFileSync(journal, 'utf8'));
      assert.equal(recorded.configurationWrite.ino, fs.statSync(source).ino);
      assert.equal(recorded.configurationWrite.configurationHash, plan.candidateHash);
      originalLink(source, destination);
      throw Error('injected_failure_after_publish');
    };
    assert.throws(() => commitAbsentConfiguration(directory, plan.candidate, 'a'.repeat(24), intent => {
      evidence.configurationWrite = intent; saveEvidence(journal, evidence);
    }, () => assert.equal(fs.existsSync(filename), false)), /injected_failure_after_publish/);
    const recorded = JSON.parse(fs.readFileSync(journal, 'utf8'));
    const config = readFixtureFile(filename);
    const pending = readFixtureFile(recorded.configurationWrite.pending);
    assert.equal(config.nlink, 2);
    assertRecoveryConfiguration(config, pending, recorded.configurationWrite);
    assert.throws(() => assertRecoveryConfiguration(config, { ...pending, ino: pending.ino + 1 }, recorded.configurationWrite), /configuration_pending_link_changed/);
    assert.throws(() => assertRecoveryConfiguration({ ...config, nlink: 3 }, pending, recorded.configurationWrite), /unsafe_host_file_size_or_links/);
    // Match the production rollback: remove only daemon.json, retaining the
    // proven candidate link and backup when interruption left both names.
    fs.unlinkSync(filename);
    assert.equal(fs.existsSync(filename), false);
    assert.equal(fs.statSync(recorded.configurationWrite.pending).nlink, 1);
    assert.equal(fs.statSync(recorded.configurationWrite.pending).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(recorded.configurationWrite.backup, 'utf8'), 'absent\n');
    assert.equal(fs.statSync(recorded.configurationWrite.backup).mode & 0o777, 0o400);
    assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  } finally { process.umask(originalUmask); fs.linkSync = originalLink; fs.rmSync(directory, { recursive: true, force: true }); }
});
test('failure while saving intent leaves the prior journal intact and never publishes configuration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-runtime-journal-'));
  const filename = path.join(directory, 'daemon.json');
  const journal = path.join(directory, 'evidence.json');
  const originalRename = fs.renameSync;
  try {
    saveEvidence(journal, { stage: 'before-configuration-write' });
    fs.renameSync = (source, destination) => {
      if (destination === journal) throw Error('injected_journal_failure');
      return originalRename(source, destination);
    };
    assert.throws(() => commitAbsentConfiguration(directory, planConfiguration(null).candidate, 'b'.repeat(24), intent => {
      saveEvidence(journal, { configurationWrite: intent });
    }, () => assert.equal(fs.existsSync(filename), false)), /injected_journal_failure/);
    assert.equal(fs.existsSync(filename), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(journal, 'utf8')), { stage: 'before-configuration-write' });
  } finally { fs.renameSync = originalRename; fs.rmSync(directory, { recursive: true, force: true }); }
});
test('exclusive publication preserves a concurrent configuration even after intent was saved', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-runtime-race-'));
  const filename = path.join(directory, 'daemon.json');
  try {
    assert.throws(() => commitAbsentConfiguration(directory, planConfiguration(null).candidate, 'c'.repeat(24), () => {},
      () => fs.writeFileSync(filename, '{"debug":false}\n')), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(filename, 'utf8'), '{"debug":false}\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('requiring either adapter performs no host commands or filesystem mutations', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-runtime-import-'));
  try {
    const script = `const fs=require('node:fs'),cp=require('node:child_process');
      for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[method]=()=>{throw Error('unexpected_command')};
      for(const method of ['writeFileSync','mkdirSync','unlinkSync','renameSync','linkSync'])fs[method]=()=>{throw Error('unexpected_write')};
      require(${JSON.stringify(path.join(__dirname, 'install-runtime-host.cjs'))});
      require(${JSON.stringify(path.join(__dirname, 'install-runtime-host-rollback.cjs'))});`;
    const result = cp.spawnSync(process.execPath, ['-e', script], { cwd: stage, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(stage), []);
  } finally { fs.rmdirSync(stage); }
});
