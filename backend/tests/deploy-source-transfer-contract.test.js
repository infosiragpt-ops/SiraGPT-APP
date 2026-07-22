'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'),
  'utf8',
);
const PACKAGE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
const TEST_SHARD = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'test-shard.sh'), 'utf8');

function stepBlock(name) {
  const marker = `      - name: ${name}`;
  const start = WORKFLOW.indexOf(marker);
  assert.notEqual(start, -1, `missing deploy workflow step: ${name}`);
  const next = WORKFLOW.indexOf('\n      - name:', start + marker.length);
  return WORKFLOW.slice(start, next === -1 ? WORKFLOW.length : next);
}

test('remote deploy receives no GitHub credential through envs, URLs, or git argv', () => {
  const ssh = stepBlock('Deploy via SSH (with auto-rollback)');
  const envSection = ssh.match(/\n        env:\n([\s\S]*?)\n        with:/);
  assert.ok(envSection, 'SSH deploy step must have an explicit env section');
  assert.doesNotMatch(envSection[1], /\$\{\{\s*secrets\./i);

  const envs = ssh.match(/^\s*envs:\s*([^\n#]+)$/m);
  assert.ok(envs, 'SSH deploy step must enumerate its remote environment');
  const remoteEnvLists = [...WORKFLOW.matchAll(/^\s*envs:\s*([^\n#]+)$/gm)];
  assert.ok(remoteEnvLists.length >= 1, 'expected at least one remote env allowlist');
  for (const match of remoteEnvLists) {
    for (const name of match[1].split(',').map((value) => value.trim())) {
      assert.doesNotMatch(name, /(token|secret|password|credential|private|key)/i);
    }
  }

  assert.doesNotMatch(ssh, /\b(?:DEPLOY_GH_TOKEN|GITHUB_TOKEN|GH_TOKEN)\b/);
  assert.doesNotMatch(ssh, /x-access-token|oauth2:|authorization[^\n]*(?:bearer|basic)/i);
  assert.doesNotMatch(ssh, /git\s+(?:-c\s+[^\n]+\s+)?fetch[^\n]*(?:https?:\/\/|github\.com|\borigin\b)/i);
  assert.doesNotMatch(WORKFLOW, /https?:\/\/[^\s"']+@github\.com/i);
});

test('approved SHA is packaged, checksummed, transferred, and reverified before checkout', () => {
  const build = stepBlock('Build and verify credential-free deploy bundle');
  const transfer = stepBlock('Transfer verified deploy bundle');
  const ssh = stepBlock('Deploy via SSH (with auto-rollback)');

  assert.match(build, /git bundle create \.deploy-artifact\/deploy\.bundle HEAD/);
  assert.match(build, /git bundle verify \.deploy-artifact\/deploy\.bundle/);
  assert.match(build, /git bundle list-heads \.deploy-artifact\/deploy\.bundle/);
  assert.match(build, /"\$\{BUNDLE_SHA\}" != "\$\{TARGET_SHA\}"/);
  assert.match(build, /sha256sum deploy\.bundle > deploy\.bundle\.sha256/);
  assert.match(build, /sha256sum --check --strict deploy\.bundle\.sha256/);
  assert.match(build, /TRANSFER_NONCE="\$\(openssl rand -hex 16\)"/);
  assert.match(build, /transfer_dir=\/tmp\/siragpt-deploy-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{TRANSFER_NONCE\}/);

  assert.match(transfer, /source: "\.deploy-artifact\/deploy\.bundle,\.deploy-artifact\/deploy\.bundle\.sha256"/);
  assert.match(transfer, /target: \$\{\{ env\.DEPLOY_TRANSFER_DIR \}\}/);
  assert.match(transfer, /tar_tmp_path: \$\{\{ env\.DEPLOY_TRANSFER_DIR \}\}\//);
  assert.match(transfer, /strip_components: 1/);

  assert.match(ssh, /CHECKSUM_LINE="\$\(cat "\$\{DEPLOY_BUNDLE_CHECKSUM\}"\)"/);
  assert.match(ssh, /\^\[0-9a-f\]\{64\}\[\[:space:\]\]\[\[:space:\]\]deploy\\\.bundle\$/);
  const checksum = ssh.indexOf('(cd "${DEPLOY_TRANSFER_DIR}" && sha256sum --check --strict deploy.bundle.sha256)');
  const verify = ssh.indexOf('git bundle verify "${DEPLOY_BUNDLE}"');
  const compare = ssh.indexOf('if [[ "${BUNDLE_SHA}" != "${TARGET_SHA}" ]]');
  const fetch = ssh.indexOf('git fetch --no-tags "${DEPLOY_BUNDLE}" HEAD');
  const reset = ssh.indexOf('git reset --hard "${TARGET_SHA}"');
  assert.ok(checksum >= 0, 'remote checksum verification is required');
  assert.ok(verify > checksum, 'bundle structure must be verified after its checksum');
  assert.ok(compare > verify, 'bundle HEAD must be compared with the approved SHA');
  assert.ok(fetch > compare, 'bundle must not be fetched before its HEAD is approved');
  assert.ok(reset > fetch, 'checkout must happen only after the verified bundle is fetched');
});

test('remote transfer directory is atomically reserved with an unpredictable suffix', () => {
  const reserve = stepBlock('Reserve remote transfer directory');
  assert.match(reserve, /id: reserve/);
  assert.match(reserve, /DEPLOY_TRANSFER_DIR: \$\{\{ steps\.bundle\.outputs\.transfer_dir \}\}/);
  assert.match(reserve, /\^\/tmp\/siragpt-deploy-\[0-9\]\+-\[0-9\]\+-\[0-9a-f\]\{32\}\$/);
  assert.match(reserve, /umask 077/);
  assert.match(reserve, /mkdir -- "\$\{DEPLOY_TRANSFER_DIR\}"/);
  assert.doesNotMatch(reserve, /mkdir\s+-p/);
  assert.match(reserve, /chmod 0700 -- "\$\{DEPLOY_TRANSFER_DIR\}"/);
});

test('the exact release checkout does not retain the Actions token', () => {
  const checkout = stepBlock('Checkout exact approved release');
  assert.match(checkout, /ref: \$\{\{ needs\.pre-check\.outputs\.target_sha \}\}/);
  assert.match(checkout, /fetch-depth: 0/);
  assert.match(checkout, /persist-credentials: false/);
});

test('third-party Actions used by the deploy workflow are immutable SHA pins', () => {
  const uses = [...WORKFLOW.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 5, 'expected checkout, transfer, SSH, and setup Actions');
  for (const action of uses) {
    if (action.startsWith('./')) continue;
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${action} is not pinned by commit SHA`);
  }
});

test('every SSH and SCP action authenticates the production host key', () => {
  const appleboyActions = WORKFLOW.match(/uses:\s*appleboy\/(?:ssh|scp)-action@[0-9a-f]{40}/g) || [];
  const pinnedFingerprints = WORKFLOW.match(/fingerprint:\s*SHA256:6LAHynq\+d0qaQczONpBPj4O3qAYbknmSLNJqNo7FDcA/g) || [];
  assert.ok(appleboyActions.length >= 4, 'expected reserve, transfer, deploy, and failure cleanup actions');
  assert.equal(pinnedFingerprints.length, appleboyActions.length);
});

test('credential-transfer regression contracts are part of canonical sharded CI', () => {
  const command = PACKAGE.scripts && PACKAGE.scripts['test:deploy-contract'];
  assert.match(command || '', /tests\/deploy-runner-rollout-contract\.test\.js/);
  assert.match(command || '', /tests\/deploy-source-transfer-contract\.test\.js/);
  assert.match(TEST_SHARD, /p\.scripts\['test:deploy-contract'\]/);
});

test('bundle cleanup is scoped while rollback, override, config validation, and provenance remain enforced', () => {
  const ssh = stepBlock('Deploy via SSH (with auto-rollback)');
  assert.match(ssh, /\^\/tmp\/siragpt-deploy-\[0-9\]\+-\[0-9\]\+-\[0-9a-f\]\{32\}\$/);
  assert.match(ssh, /-L "\$\{DEPLOY_TRANSFER_DIR\}" \|\| ! -d "\$\{DEPLOY_TRANSFER_DIR\}"/);
  assert.match(ssh, /stat -c '%u:%a' "\$\{DEPLOY_TRANSFER_DIR\}"/);
  assert.match(ssh, /"\$\(id -u\):700"/);
  assert.match(ssh, /find "\$\{DEPLOY_TRANSFER_DIR\}" -mindepth 1 -maxdepth 1 -type f -delete/);
  assert.match(ssh, /trap cleanup_transfer EXIT/);
  assert.match(ssh, /rollback\(\) \{[\s\S]*cleanup_transfer[\s\S]*git reset --hard "\$\{PREV_SHA\}"/);

  const rollback = ssh.slice(ssh.indexOf('            rollback() {'), ssh.indexOf('            echo "[deploy-workflow] Remote disk before deploy"'));
  const disableErrexit = rollback.indexOf('set +e');
  const cleanup = rollback.indexOf('cleanup_transfer');
  const reset = rollback.indexOf('git reset --hard "${PREV_SHA}"');
  assert.ok(disableErrexit >= 0 && cleanup > disableErrexit, 'cleanup must run only after rollback disables errexit');
  assert.ok(reset > cleanup, 'rollback checkout must follow best-effort transfer cleanup');

  assert.match(ssh, /docker-compose\.production\.override\.yml --env-file \.env/);
  assert.doesNotMatch(ssh, /git clean|rsync[^\n]*--delete/);
  assert.match(ssh, /\$\{COMPOSE\} config -q/);
  assert.match(ssh, /wait_version "\$\{TARGET_SHA\}" "\$\{SIRAGPT_VERSION\}"/);

  const finalCleanup = stepBlock('Cleanup transferred bundle');
  assert.match(finalCleanup, /if: always\(\) && steps\.bundle\.outputs\.transfer_dir != '' && steps\.reserve\.outcome == 'success'/);
  assert.match(finalCleanup, /find "\$\{DEPLOY_TRANSFER_DIR\}" -mindepth 1 -maxdepth 1 -type f -delete/);
});

test('a failed transfer cleanup cannot short-circuit the actual rollback function', () => {
  const ssh = stepBlock('Deploy via SSH (with auto-rollback)');
  const functionMatch = ssh.match(/\n {12}(rollback\(\) \{[\s\S]*?\n {12}\})\n\n {12}echo "\[deploy-workflow\] Remote disk before deploy"/);
  assert.ok(functionMatch, 'could not extract rollback function from deploy workflow');
  const rollbackFunction = functionMatch[1]
    .split('\n')
    .map((line) => line.replace(/^ {12}/, ''))
    .join('\n');

  const harness = `
set -Eeuo pipefail
cleanup_transfer() { return 97; }
git() { if [[ "\${1:-}" == "reset" ]]; then echo rollback-checkout-reached; fi; return 0; }
verify_checkout() { return 0; }
set_release_metadata() { return 0; }
restore_rollback_images() { return 0; }
wait_runner() { return 0; }
wait_ready() { return 0; }
wait_frontend() { return 0; }
wait_version() { return 0; }
COMPOSE=:
PREV_SHA=1111111111111111111111111111111111111111
PREV_APP_VERSION=0.0.0
PREV_PROVENANCE_VERIFIABLE=1
${rollbackFunction}
trap rollback EXIT
exit 23
`;
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /rollback-checkout-reached/);
});
