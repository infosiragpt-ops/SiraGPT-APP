'use strict';

/**
 * Runner endurecido del sandbox doc-engine.
 *
 * docker run:
 *   --network=none
 *   --read-only (rootfs) + tmpfs /workspace 512MB
 *   --cap-drop=ALL
 *   seccomp por defecto (nunca unconfined)
 *   --user 10001
 *
 * Si Docker no está, cae al driver local (tests / CI) igual que doc-agent.
 */

const path = require('path');
const { getDocEngineConfig } = require('./flags');

const SKILLS_SCRIPTS = path.resolve(__dirname, '../../../../packages/doc-skills/scripts');

function buildHardenedRunArgs({
  name,
  image,
  jobId,
  workspaceSize = '512m',
  command = ['python3', '/opt/doc-skills/scripts/transform_to_template.py'],
} = {}) {
  if (!name) throw new Error('runner: name required');
  if (!image) throw new Error('runner: image required');
  if (!jobId) throw new Error('runner: jobId required');
  const ws = `/workspace/${jobId}`;
  return [
    'run', '--rm',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '10001:10001',
    '--tmpfs', `/workspace:rw,exec,size=${workspaceSize}`,
    '--tmpfs', '/tmp:rw,exec,size=64m',
    '-e', 'HOME=/workspace',
    '-e', 'TMPDIR=/tmp',
    '-w', ws,
    image,
    ...command,
  ];
}

function runnerLimits(env = process.env) {
  const cfg = getDocEngineConfig(env);
  return {
    image: cfg.image,
    workspaceSize: cfg.workspaceSize,
    timeoutMs: cfg.timeoutMs,
    user: '10001',
    network: 'none',
    capDrop: 'ALL',
    readOnlyRootfs: true,
    seccomp: 'default',
  };
}

function scriptsDir() {
  return SKILLS_SCRIPTS;
}

module.exports = {
  buildHardenedRunArgs,
  runnerLimits,
  scriptsDir,
};
