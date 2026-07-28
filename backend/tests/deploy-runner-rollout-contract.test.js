'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'),
  'utf8',
);
const COMPOSE = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'docker-compose.prod.yml'),
  'utf8',
);
const GVISOR_WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '.github', 'workflows', 'gvisor-runner-compat.yml'),
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

test('runner mounts every control-plane module required by code-runner.js', () => {
  assert.match(COMPOSE, /\.\/scripts\/code-runner\.js:\/scripts\/code-runner\.js:ro/);
  assert.match(COMPOSE, /\.\/scripts\/code-runner-utils\.js:\/scripts\/code-runner-utils\.js:ro/);
  assert.match(COMPOSE, /\.\/scripts\/code-runner-worktrees\.js:\/scripts\/code-runner-worktrees\.js:ro/);
  assert.match(GVISOR_WORKFLOW, /code-runner-worktrees\.js",dst=\/scripts\/code-runner-worktrees\.js,readonly/);
});

test('production keeps run concurrency and fleet QA disabled by default', () => {
  const concurrencyDefaults = COMPOSE.match(
    /CODEX_RUN_CONCURRENCY_ENABLED:[^\n]*\$\{CODEX_RUN_CONCURRENCY_ENABLED:-0\}/g,
  );

  assert.equal(
    concurrencyDefaults?.length,
    2,
    'both runner and backend must fail closed unless concurrency is explicitly enabled',
  );
  assert.match(
    COMPOSE,
    /CODEX_RUN_OS_ISOLATION_ATTESTED:[^\n]*\$\{CODEX_RUN_OS_ISOLATION_ATTESTED:-0\}/,
  );
  assert.match(COMPOSE, /CODEX_MAX_CONCURRENT_RUNS:[^\n]*\$\{CODEX_MAX_CONCURRENT_RUNS:-1\}/);
  assert.match(COMPOSE, /CODEX_FLEET_QA_ENABLED:[^\n]*\$\{CODEX_FLEET_QA_ENABLED:-0\}/);
});

test('runner rollout is healthy before the backend is replaced', () => {
  const buildRunner = position('${COMPOSE} build runner');
  const recreateRunner = positionAfter('${COMPOSE} up -d --no-deps --force-recreate runner', buildRunner);
  const waitRunner = WORKFLOW.indexOf('            wait_runner\n', recreateRunner);
  const startBackend = WORKFLOW.indexOf(
    '${COMPOSE} up -d --no-deps --force-recreate backend frontend',
    recreateRunner,
  );

  assert.ok(recreateRunner > buildRunner, 'runner must be built before it is recreated');
  assert.ok(waitRunner > recreateRunner, 'runner health must be awaited after recreation');
  assert.ok(startBackend > waitRunner, 'backend must not be replaced before runner health passes');
  assert.match(WORKFLOW, /health="\$\(docker inspect[\s\S]*\.State\.Health[\s\S]*health\}" == "healthy"/);
});

test('the rollout fails closed on the real /code build, browser, and second-run canary', () => {
  const buildRunner = position('${COMPOSE} build runner');
  const recreateBackend = positionAfter('${COMPOSE} up -d --no-deps --force-recreate backend frontend', buildRunner);
  const ready = positionAfter('            wait_ready\n', recreateBackend);
  const version = positionAfter('            wait_version "${TARGET_SHA}" "${SIRAGPT_VERSION}"', ready);
  const canary = positionAfter('            run_code_runtime_canary\n', version);
  const cleanup = positionAfter('            cleanup_old_rollback_images', canary);

  assert.match(WORKFLOW, /node scripts\/code-runtime-canary\.js/);
  assert.ok(canary > version, 'runtime canary must run only after the exact release is healthy and versioned');
  assert.ok(cleanup > canary, 'rollback images must remain available until the runtime canary passes');
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
