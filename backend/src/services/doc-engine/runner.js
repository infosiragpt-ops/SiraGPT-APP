'use strict';

/**
 * Isolated ephemeral sandbox runner.
 *
 * docker run --rm
 *   --network=none
 *   --read-only
 *   --cap-drop=ALL
 *   --security-opt=no-new-privileges
 *   --user=10001:10001
 *   --tmpfs /workspace:rw,nosuid,nodev,noexec,size=536870912
 *   --pids-limit=256
 *   --memory=768m
 *   --cpus=1
 *   IMAGE
 *
 * Bind-mounts /in (ro) and /out are added so binaries never travel through Redis.
 * /tmp is a separate tmpfs (soffice profile) without noexec.
 * If Docker / the image is missing, callers fall back to the in-process pipeline.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getDocEngineConfig } = require('./flags');

const SKILLS_SCRIPTS = path.resolve(__dirname, '../../../../packages/doc-skills/scripts');
const WORKSPACE_TMPFS = 'rw,nosuid,nodev,noexec,size=536870912';
const DEFAULT_IMAGE = 'siragpt-sandbox:doc-engine';

function buildHardenedRunArgs({
  name,
  image,
  jobId,
  hostIn,
  hostOut,
  command = ['python3', '/opt/doc-skills/scripts/transform_to_template.py'],
} = {}) {
  if (!name) throw new Error('runner: name required');
  if (!image) throw new Error('runner: image required');
  if (!jobId) throw new Error('runner: jobId required');
  const args = [
    'run', '--rm',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '10001:10001',
    '--tmpfs', `/workspace:${WORKSPACE_TMPFS}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
    '--pids-limit', '256',
    '--memory', '768m',
    '--cpus', '1',
    '-e', 'HOME=/workspace',
    '-e', 'TMPDIR=/tmp',
    '-w', '/workspace',
  ];
  if (hostIn) args.push('-v', `${hostIn}:/in:ro`);
  if (hostOut) args.push('-v', `${hostOut}:/out`);
  args.push(image, ...command);
  return args;
}

function runnerLimits(env = process.env) {
  const cfg = getDocEngineConfig(env);
  return {
    image: cfg.image,
    workspaceSize: '536870912',
    tmpfs: WORKSPACE_TMPFS,
    timeoutMs: cfg.timeoutMs,
    user: '10001:10001',
    network: 'none',
    capDrop: 'ALL',
    readOnlyRootfs: true,
    seccomp: 'default',
    pidsLimit: 256,
    memory: '768m',
    cpus: '1',
    noNewPrivileges: true,
  };
}

function scriptsDir() {
  return SKILLS_SCRIPTS;
}

function dockerImagePresent(image, spawn = spawnSync) {
  const r = spawn('docker', ['image', 'inspect', image], {
    encoding: 'utf8',
    timeout: 8_000,
  });
  return r.status === 0;
}

function runEphemeralSandbox({
  jobId,
  sourcePath,
  templatePath,
  outPath,
  image,
  timeoutMs,
  spawn = spawnSync,
} = {}) {
  const cfg = getDocEngineConfig();
  const img = image || cfg.image || DEFAULT_IMAGE;
  if (!dockerImagePresent(img, spawn)) {
    return { ok: false, skipped: true, reason: 'image_missing' };
  }
  const hostIn = path.dirname(sourcePath);
  const hostOut = path.dirname(outPath);
  fs.mkdirSync(hostOut, { recursive: true });
  const name = `sira-doceng-${String(jobId || 'job').slice(0, 24)}-${Date.now().toString(36)}`;
  const args = buildHardenedRunArgs({
    name,
    image: img,
    jobId,
    hostIn,
    hostOut,
    command: [
      'python3', '/opt/doc-skills/scripts/transform_to_template.py',
      '--source', `/in/${path.basename(sourcePath)}`,
      '--template', `/in/${path.basename(templatePath)}`,
      '--out', `/out/${path.basename(outPath)}`,
      '--work', '/workspace/unpacked',
    ],
  });
  const ran = spawn('docker', args, {
    encoding: 'utf8',
    timeout: timeoutMs || cfg.timeoutMs,
  });
  const ok = ran.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  return {
    ok,
    skipped: false,
    status: ran.status,
    stdout: String(ran.stdout || '').slice(0, 2000),
    stderr: String(ran.stderr || ran.error || '').slice(0, 2000),
    args,
  };
}

module.exports = {
  DEFAULT_IMAGE,
  WORKSPACE_TMPFS,
  buildHardenedRunArgs,
  runnerLimits,
  scriptsDir,
  dockerImagePresent,
  runEphemeralSandbox,
};
