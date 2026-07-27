'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'),
  'utf8',
);

function position(fragment) {
  const index = WORKFLOW.indexOf(fragment);
  assert.notEqual(index, -1, `missing deploy workflow fragment: ${fragment}`);
  return index;
}

function positionAfter(fragment, after) {
  const index = WORKFLOW.indexOf(fragment, after);
  assert.notEqual(index, -1, `missing deploy workflow fragment after offset ${after}: ${fragment}`);
  return index;
}

test('production deploy preserves and restores the exact runner image', () => {
  assert.match(WORKFLOW, /runner_image="\$\(docker inspect --format '\{\{\.Image\}\}' "\$\{runner_container\}"\)"/);
  assert.match(WORKFLOW, /docker tag "\$\{runner_image\}" "\$\{ROLLBACK_RUNNER_IMAGE\}"/);
  assert.match(WORKFLOW, /docker image inspect "\$\{ROLLBACK_RUNNER_IMAGE\}"/);
  assert.match(WORKFLOW, /docker tag "\$\{ROLLBACK_RUNNER_IMAGE\}" siragpt-runner:latest/);
  assert.match(WORKFLOW, /siragpt-runner:rollback-\*/);
});

test('runner rollout is healthy before the backend is replaced', () => {
  const buildRunner = position('${COMPOSE} build runner');
  const recreateRunner = positionAfter('${COMPOSE} up -d --no-deps --force-recreate runner', buildRunner);
  const waitRunner = WORKFLOW.indexOf('            wait_runner\n', recreateRunner);
  const startBackend = WORKFLOW.indexOf('${COMPOSE} up -d --no-deps backend frontend', recreateRunner);

  assert.ok(recreateRunner > buildRunner, 'runner must be built before it is recreated');
  assert.ok(waitRunner > recreateRunner, 'runner health must be awaited after recreation');
  assert.ok(startBackend > waitRunner, 'backend must not be replaced before runner health passes');
  assert.match(WORKFLOW, /health="\$\(docker inspect[\s\S]*\.State\.Health[\s\S]*health\}" == "healthy"/);
});

test('rollback restores and verifies the runner before restoring the API', () => {
  const rollbackStart = position('            rollback() {');
  const rollbackEnd = position('            echo "[deploy-workflow] Remote disk before deploy"');
  const rollback = WORKFLOW.slice(rollbackStart, rollbackEnd);

  const restoreImages = rollback.indexOf('restore_rollback_images');
  const recreateRunner = rollback.indexOf('${COMPOSE} up -d --no-deps --force-recreate runner');
  const waitRunner = rollback.indexOf('wait_runner');
  const recreateApi = rollback.indexOf('${COMPOSE} up -d --no-deps --force-recreate backend frontend');

  assert.ok(restoreImages >= 0, 'rollback must restore tagged images');
  assert.ok(recreateRunner > restoreImages, 'rollback must recreate the restored runner image');
  assert.ok(waitRunner > recreateRunner, 'rollback must verify runner health');
  assert.ok(recreateApi > waitRunner, 'rollback must restore API only after runner health passes');
});
