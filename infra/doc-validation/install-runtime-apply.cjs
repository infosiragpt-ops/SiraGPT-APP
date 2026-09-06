'use strict';

// Explicitly reviewed one-time installer. No action runs on require().
// --preflight never writes the host. --apply adds runsc and sends ONLY SIGHUP.
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const path = require('node:path');
const guards = require('./install-runtime-config.cjs');
const NODE_IMAGE = 'sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
const VALIDATE_IMAGE = 'sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b';
const BASE = ['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--read-only', '--user', '0:0', '--memory', '2g', '--cpus', '2', '--pids-limit', '32',
  '--label', 'siragpt.role=doc-validation-runtime-install'];
const LIBRARIES = ['libnftables.so.1', 'libmnl.so.0', 'libnftnl.so.11', 'libxtables.so.12', 'libjansson.so.4'];
const MEMBERS = ['containerd-shim-runsc-v1', 'runsc', 'gvisor-bin/checkpointgofer', 'gvisor-bin/gvisor-sentry-prewarmer',
  'gvisor-bin/gvisor_sentry', 'gvisor-bin/runsc-metric-server'];

function parseArchive(tar) {
  const allowed = ['containerd-shim-runsc-v1', 'runsc', 'gvisor-bin/checkpointgofer', 'gvisor-bin/gvisor-sentry-prewarmer',
    'gvisor-bin/gvisor_sentry', 'gvisor-bin/runsc-metric-server'];
  if (!Buffer.isBuffer(tar) || tar.length > 512 * 1024 * 1024 || tar.length % 512) throw Error('unsafe_tar_size');
  const entries = new Map();
  let offset = 0;
  let finished = false;
  const octal = b => {
    const value = b.toString('ascii').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(value)) throw Error('unsafe_tar_octal');
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) throw Error('unsafe_tar_number');
    return number;
  };
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) throw Error('unsafe_tar_trailing_data');
      finished = true;
      break;
    }
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const link = h.subarray(157, 257).toString('utf8').replace(/\0.*$/s, '');
    const type = h[156];
    const size = octal(h.subarray(124, 136));
    const mode = octal(h.subarray(100, 108));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
    if (checksum !== octal(h.subarray(148, 156)) || prefix || link || entries.has(name) || mode !== 0o755 ||
      octal(h.subarray(108, 116)) !== 0 || octal(h.subarray(116, 124)) !== 0) throw Error('unsafe_tar_header');
    const directory = name === 'gvisor-bin/' && type === 53 && size === 0;
    if (!directory && (!(type === 48 || type === 0) || !allowed.includes(name) || size < 1 || size > 128 * 1024 * 1024)) {
      throw Error('unexpected_tar_member');
    }
    const end = offset + 512 + size;
    if (end > tar.length) throw Error('truncated_tar');
    entries.set(name, { name, directory, bytes: tar.subarray(offset + 512, end) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!finished || entries.size !== allowed.length + 1 || !entries.has('gvisor-bin/') || allowed.some(name => !entries.has(name))) {
    throw Error('incomplete_tar_package');
  }
  return [...entries.values()];
}

function quote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function ssh(args, input, timeout = 45000) {
  try {
    const result = cp.spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', 'siragpt-lenovo', args.map(quote).join(' ')],
    { input, timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw Object.assign(result.error || Error('remote_command_failed'), { status: result.status, stderr: result.stderr });
    const stdout = result.stdout.toString('utf8').trim();
    // dockerd --validate writes its fixed success marker to stderr on this host.
    if (args.includes('/host-dockerd') && args.includes('--validate') &&
      (stdout + '\n' + result.stderr.toString('utf8')).split('\n').some(line => line.trim() === 'configuration OK')) return 'configuration OK';
    return stdout;
  } catch (error) {
    error.operation = args.slice(0, 2).join(' ');
    const stderr = String(error.stderr || '');
    error.safeDiagnostic = stderr.includes('map has no entry for key') ? 'inspect_field_missing' :
      stderr.includes('No such object') ? 'container_disappeared' :
      stderr.includes('unexpected_daemon_configuration') ? 'daemon_configuration_guard_failed' :
      stderr.includes('unsafe_configuration') ? 'host_configuration_guard_failed' :
      stderr.includes('Cannot find module') ? 'helper_module_missing' :
      /\bEPERM\b/.test(stderr) ? 'EPERM' : /\bENOENT\b/.test(stderr) ? 'ENOENT' :
      stderr.includes('permission denied') || stderr.includes('Operation not permitted') ? 'permission_denied' :
      stderr.match(/Error: ([A-Za-z_][A-Za-z0-9_]{0,70})(?:\n|$)/)?.[1] || 'remote_failure';
    throw error;
  }
}
function docker(args, input, timeout) { return ssh(['docker', ...args], input, timeout); }
function bind(src, dst, write = false) { return ['--mount', `type=bind,src=${src},dst=${dst}${write ? '' : ',readonly'}`]; }
function helper(code, mounts = [], extra = [], input, timeout) {
  return docker([...BASE, ...extra, ...mounts, '--entrypoint', 'node', NODE_IMAGE, '-e', code], input, timeout);
}
function readIdentity() {
  const fs = require('node:fs');
  const pidText = fs.readFileSync('/host-docker.pid', 'utf8').trim();
  if (!/^[1-9][0-9]{0,8}$/.test(pidText)) throw Error('unsafe_daemon_pid');
  const stat = fs.readFileSync(`/host-proc/${pidText}/stat`, 'utf8');
  const comm = fs.readFileSync(`/host-proc/${pidText}/comm`, 'utf8').trim();
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const args = fs.readFileSync(`/host-proc/${pidText}/cmdline`, 'utf8').split('\0');
  const configFlag = args.find(value => value.startsWith('--config-file='));
  const configAt = args.indexOf('--config-file');
  const configPath = configFlag ? configFlag.slice('--config-file='.length) : configAt >= 0 ? args[configAt + 1] : '/etc/docker/daemon.json';
  if (comm !== 'dockerd' || configPath !== '/etc/docker/daemon.json' || args.some(x => x === '--add-runtime' || x.startsWith('--add-runtime='))) {
    throw Error('unexpected_daemon_configuration');
  }
  return { pid: Number(pidText), comm, startTicks };
}
function readConfiguration() {
  const fs = require('node:fs');
  const p = '/host-docker/daemon.json';
  try {
    const s = fs.lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024 || s.uid !== 0 || s.gid !== 0 || (s.mode & 0o022)) throw Error('unsafe_configuration');
    return { bytes: fs.readFileSync(p), mode: s.mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { bytes: null, mode: 0o644 };
  }
}
const IDENTITY_MOUNTS = [...bind('/run/docker.pid', '/host-docker.pid'), ...bind('/proc', '/host-proc')];
function hostSnapshot() {
  return JSON.parse(helper(`const readIdentity=${readIdentity}; const readConfiguration=${readConfiguration};
    const fs=require('node:fs'); const c=readConfiguration();
    console.log(JSON.stringify({daemon:readIdentity(),config:c.bytes===null?null:c.bytes.toString('base64'),mode:c.mode,
    runtimeDirectoryExists:fs.existsSync('/host-local-bin/siragpt-gvisor-${guards.RELEASE}')}));`,
  [...IDENTITY_MOUNTS, ...bind('/etc/docker', '/host-docker'), ...bind('/usr/local/bin', '/host-local-bin')]));
}
function snapshot() {
  const listings = docker(['ps', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const names = listings.filter(name => !name.startsWith('doc-sandbox-test-') && !name.startsWith('doc-validation-runtime-'));
  if (names.length === 0) throw Error('no_production_containers');
  const containers = docker(['inspect', '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"pid":{{.State.Pid}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}}}',
    ...names]).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const info = JSON.parse(docker(['info', '--format', '{"defaultRuntime":{{json .DefaultRuntime}},"runtimes":{{json .Runtimes}}}']));
  const host = hostSnapshot();
  for (const name of ['/iliagpt-backend', '/iliagpt-frontend', '/iliagpt-db', '/iliagpt-redis']) {
    if (containers.find(c => c.name === name)?.health !== 'healthy') throw Error('production_health_precondition');
  }
  return { ...info, ...host, containers };
}
function validateCandidate(candidate) {
  const mounts = [...bind('/usr/bin/dockerd', '/host-dockerd'), ...bind('/usr/bin/docker-proxy', '/usr/bin/docker-proxy'),
    ...LIBRARIES.flatMap(name => bind(`/usr/lib/x86_64-linux-gnu/${name}`, `/usr/lib/x86_64-linux-gnu/${name}`))];
  const result = docker([...BASE, ...mounts, '--entrypoint', '/host-dockerd', VALIDATE_IMAGE, '--validate', '--config-file=/dev/stdin'], candidate);
  if (!result.includes('configuration OK')) throw Error('dockerd_validation_not_confirmed');
}

async function main() {
  const mode = process.argv[2];
  const archive = process.argv[3];
  if (!['--preflight', '--apply'].includes(mode) || !archive || !path.isAbsolute(archive)) throw Error('usage_mode_absolute_archive_required');
  const evidenceDir = fs.mkdtempSync('/private/tmp/siragpt-runtime-evidence.');
  fs.chmodSync(evidenceDir, 0o700);
  let stage = 'package-verification';
  const nonce = crypto.randomBytes(12).toString('hex');
  let acquiredLock = false;
  const evidence = { startedAt: new Date().toISOString(), mode, release: guards.RELEASE, hostWrites: false };
  const save = () => fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const log = phase => { stage = phase; evidence.stage = phase; save(); console.log(JSON.stringify({ stage, evidenceDir })); };
  try {
    log(stage);
    const compressed = fs.readFileSync(archive);
    if (compressed.length !== guards.ARCHIVE_BYTES || crypto.createHash('sha512').update(compressed).digest('hex') !== guards.ARCHIVE_SHA512) throw Error('official_package_hash_mismatch');
    const unpacked = cp.spawnSync('bzip2', ['-dc', archive], { maxBuffer: 512 * 1024 * 1024 });
    if (unpacked.status !== 0 || unpacked.error) throw Error('package_decompression_failed');
    const tar = unpacked.stdout;
    const files = parseArchive(tar);
    const tarHash = crypto.createHash('sha256').update(tar).digest('hex');
    evidence.package = { sha512: guards.ARCHIVE_SHA512, compressedBytes: compressed.length, tarHash,
      files: files.map(f => ({ name: f.name, bytes: f.bytes.length, sha256: crypto.createHash('sha256').update(f.bytes).digest('hex') })) };
    log('fresh-production-preflight');
    const before = snapshot();
    if (before.defaultRuntime !== 'runc' || before.runtimes.runsc || before.runtimeDirectoryExists) throw Error('runtime_precondition_changed');
    const original = before.config === null ? null : Buffer.from(before.config, 'base64');
    const plan = guards.planConfiguration(original);
    evidence.before = { ...before, config: undefined, runtimes: Object.keys(before.runtimes) };
    evidence.configuration = { originalHash: plan.originalHash, candidateHash: plan.candidateHash };
    log('validate-with-host-dockerd');
    validateCandidate(plan.candidate);
    evidence.hostDockerdValidation = true;
    if (mode === '--preflight') { log('preflight-passed-no-host-writes'); return; }
    log('acquire-exclusive-install-lock');
    helper(`const fs=require('node:fs');const root='/host-local-bin/.siragpt-gvisor-install-lock';
      fs.mkdirSync(root,{mode:0o700});fs.writeFileSync(root+'/owner',${JSON.stringify(nonce)},{flag:'wx',mode:0o400});
      console.log('locked');`, bind('/usr/local/bin', '/host-local-bin', true));
    acquiredLock = true;
    log('continuity-before-install');
    const latest = snapshot();
    guards.assertProductionUnchanged(before, latest);
    guards.assertUnchangedConfiguration(latest.config === null ? null : Buffer.from(latest.config, 'base64'), plan.originalHash);
    log('install-verified-versioned-package');
    evidence.hostMutationAttempted = true;
    save();
    const root = `/host-local-bin/siragpt-gvisor-${guards.RELEASE}`;
    const install = helper(`const fs=require('node:fs'),crypto=require('node:crypto');
      const parseArchive=${parseArchive}; const readIdentity=${readIdentity}; const readConfiguration=${readConfiguration};
      const expected=${JSON.stringify(before.daemon)}; const id=readIdentity();
      if(id.pid!==expected.pid||id.startTicks!==expected.startTicks)throw Error('daemon_changed_before_install');
      const config=readConfiguration().bytes;
      if((config===null?'absent':crypto.createHash('sha256').update(config).digest('hex'))!==${JSON.stringify(plan.originalHash)})throw Error('config_changed_before_install');
      const tar=fs.readFileSync(0); if(crypto.createHash('sha256').update(tar).digest('hex')!==${JSON.stringify(tarHash)})throw Error('transfer_hash_mismatch');
      const files=parseArchive(tar),root=${JSON.stringify(root)};
      fs.mkdirSync(root,{mode:0o755}); fs.mkdirSync(root+'/gvisor-bin',{mode:0o755});
      for(const file of files){if(file.directory)continue;const fd=fs.openSync(root+'/'+file.name,'wx',0o755);
        try{fs.writeFileSync(fd,file.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      const fd=fs.openSync(root,'r');fs.fsyncSync(fd);fs.closeSync(fd);
      console.log(JSON.stringify({installed:true,files:files.length,directory:root.replace('/host-local-bin','/usr/local/bin')}));`,
    [...IDENTITY_MOUNTS, ...bind('/etc/docker', '/host-docker'), ...bind('/usr/local/bin', '/host-local-bin', true)], [], tar, 180000);
    evidence.hostWrites = true;
    evidence.packageInstallation = JSON.parse(install);
    const runscVersion = docker([...BASE, ...bind(`/usr/local/bin/siragpt-gvisor-${guards.RELEASE}`, '/runtime'),
      '--entrypoint', '/runtime/runsc', NODE_IMAGE, '--version']);
    if (!runscVersion.includes(guards.RELEASE)) throw Error('installed_runsc_version_mismatch');
    evidence.runscVersion = runscVersion;
    log('continuity-before-configuration');
    const priorConfigWrite = snapshot();
    guards.assertProductionUnchanged(before, priorConfigWrite);
    guards.assertUnchangedConfiguration(priorConfigWrite.config === null ? null : Buffer.from(priorConfigWrite.config, 'base64'), plan.originalHash);
    log('backup-cas-atomic-configuration');
    const writeResult = helper(`const fs=require('node:fs'),crypto=require('node:crypto');
      const readIdentity=${readIdentity};const readConfiguration=${readConfiguration};
      const expected=${JSON.stringify(before.daemon)},id=readIdentity();
      if(id.pid!==expected.pid||id.startTicks!==expected.startTicks)throw Error('daemon_changed_before_config');
      const current=readConfiguration();const hash=b=>b===null?'absent':crypto.createHash('sha256').update(b).digest('hex');
      if(hash(current.bytes)!==${JSON.stringify(plan.originalHash)})throw Error('config_changed_before_write');
      const backup='/host-docker/.siragpt-runtime-${nonce}.backup';
      const backupBytes=current.bytes===null?Buffer.from('absent\\n'):current.bytes;
      const fd=fs.openSync(backup,'wx',0o400);fs.writeFileSync(fd,backupBytes);fs.fsyncSync(fd);fs.closeSync(fd);
      const next=Buffer.from(${JSON.stringify(plan.candidate.toString('base64'))},'base64');
      const pending='/host-docker/.siragpt-runtime-${nonce}.candidate';
      const nextfd=fs.openSync(pending,'wx',current.mode);fs.writeFileSync(nextfd,next);fs.fsyncSync(nextfd);fs.closeSync(nextfd);
      if(hash(readConfiguration().bytes)!==${JSON.stringify(plan.originalHash)})throw Error('config_raced_after_backup');
      if(current.bytes===null){fs.linkSync(pending,'/host-docker/daemon.json');fs.unlinkSync(pending);}
      else{fs.renameSync(pending,'/host-docker/daemon.json');}
      const dirfd=fs.openSync('/host-docker','r');fs.fsyncSync(dirfd);fs.closeSync(dirfd);
      console.log(JSON.stringify({backup:backup.replace('/host-docker','/etc/docker'),backupSha256:hash(backupBytes),
        configurationHash:hash(readConfiguration().bytes)}));`,
    [...IDENTITY_MOUNTS, ...bind('/etc/docker', '/host-docker', true)]);
    evidence.configurationWrite = JSON.parse(writeResult);
    log('signal-only-sighup');
    const reload = helper(`const fs=require('node:fs');const expected=${JSON.stringify(before.daemon)};
      const comm=fs.readFileSync('/proc/'+expected.pid+'/comm','utf8').trim();
      const stat=fs.readFileSync('/proc/'+expected.pid+'/stat','utf8');const ticks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
      if(comm!=='dockerd'||ticks!==expected.startTicks||expected.pid<=1)throw Error('daemon_identity_changed_before_sighup');
      process.kill(expected.pid,'SIGHUP');console.log(JSON.stringify({signal:'SIGHUP',pid:expected.pid,startTicks:ticks}));`, [], ['--pid', 'host', '--cap-add', 'KILL']);
    evidence.reload = JSON.parse(reload);
    log('verify-reload-and-production');
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const info = JSON.parse(docker(['info', '--format', '{"defaultRuntime":{{json .DefaultRuntime}},"runtimes":{{json .Runtimes}}}']));
      if (info.defaultRuntime !== before.defaultRuntime) throw Error('default_runtime_changed');
      if (info.runtimes.runsc?.path === guards.RUNTIME_PATH) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw Error('runsc_not_registered_within_deadline');
    const after = snapshot();
    guards.assertProductionUnchanged(before, after);
    evidence.after = { ...after, config: undefined, runtimes: Object.keys(after.runtimes) };
    log('runsc-nonroot-isolated-smoke');
    const smokeName = 'doc-validation-runtime-smoke-' + nonce;
    const smokeId = docker(['create', '--name', smokeName, '--pull', 'never', '--runtime', 'runsc', '--network', 'none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '65532:65532', '--memory', '128m', '--cpus', '0.5',
      '--pids-limit', '32', '--label', 'siragpt.role=doc-validation-runtime-smoke', '--entrypoint', 'node', NODE_IMAGE,
      '-e', 'console.log(JSON.stringify({uid:process.getuid(),message:"runsc-isolated-smoke-ok"}))']);
    if (!/^[a-f0-9]{64}$/.test(smokeId)) throw Error('invalid_smoke_id');
    evidence.smoke = { id: smokeId, name: smokeName };
    save();
    try {
      const smokeOutput = docker(['start', '-a', smokeId], undefined, 30000);
      const smoke = JSON.parse(docker(['inspect', '--format', '{"runtime":{{json .HostConfig.Runtime}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}}}', smokeId]));
      if (smoke.runtime !== 'runsc' || smoke.status !== 'exited' || smoke.exitCode !== 0 ||
        JSON.parse(smokeOutput).uid !== 65532 || !smokeOutput.includes('runsc-isolated-smoke-ok')) throw Error('runsc_smoke_failed');
      evidence.smoke = { ...evidence.smoke, ...smoke, output: JSON.parse(smokeOutput) };
    } finally {
      // Only this newly created and full-ID-validated test container is removable.
      docker(['rm', '-f', smokeId], undefined, 15000);
      evidence.smoke.removed = true;
      save();
    }
    const final = snapshot();
    guards.assertProductionUnchanged(before, final);
    evidence.final = { ...final, config: undefined, runtimes: Object.keys(final.runtimes) };
    log('installed-reloaded-no-restarts-smoke-passed');
  } catch (error) {
    evidence.error = { stage, operation: error.operation, diagnostic: error.safeDiagnostic,
      message: error.status ? `remote_command_failed_status_${error.status}` : String(error.code || error.message) };
    // Never print remote stderr: daemon config or future provider values might occur there.
    // Preserve stage and exact writes for manual reviewed recovery; no silent restart/rollback.
    save();
    console.error(JSON.stringify({ failed: true, ...evidence.error, evidenceDir, hostWrites: evidence.hostWrites }));
    process.exitCode = 1;
  } finally {
    if (acquiredLock) {
      try {
        helper(`const fs=require('node:fs');const root='/host-local-bin/.siragpt-gvisor-install-lock';
          if(fs.readFileSync(root+'/owner','utf8')!==${JSON.stringify(nonce)})throw Error('lock_owner_changed');
          fs.unlinkSync(root+'/owner');fs.rmdirSync(root);console.log('unlocked');`, bind('/usr/local/bin', '/host-local-bin', true));
        evidence.lockReleased = true;
      } catch { evidence.lockReleased = false; process.exitCode = 1; }
      save();
    }
  }
}

module.exports = { parseArchive, quote, MEMBERS, rollbackOperations: { snapshot, helper, bind, readIdentity, readConfiguration, IDENTITY_MOUNTS } };
if (require.main === module) main();
