'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'),
  'utf8',
);
const PUBLISHER = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'deploy', 'iliagpt', 'publish-reviewed.sh'),
  'utf8',
);
const RUNTIME_CANARY = fs.readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'code-runtime-canary.js'),
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
const RUNNER = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'scripts', 'code-runner.js'),
  'utf8',
);
const GVISOR_SMOKE = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'scripts', 'gvisor-runner-smoke.mjs'),
  'utf8',
);

function position(fragment) {
  const index = PUBLISHER.indexOf(fragment);
  assert.notEqual(index, -1, `missing reviewed publisher fragment: ${fragment}`);
  return index;
}

function positionAfter(fragment, after) {
  const index = PUBLISHER.indexOf(fragment, after);
  assert.notEqual(index, -1, `missing reviewed publisher fragment after offset ${after}: ${fragment}`);
  return index;
}

test('production deploy preserves and restores the exact runner image', () => {
  assert.match(PUBLISHER, /for service in runner backend frontend; do[\s\S]*image=\$\(docker inspect --format '\{\{\.Image\}\}' "\$id"\)/);
  assert.match(PUBLISHER, /\[\[ \$image =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(PUBLISHER, /tag="iliagpt-\$service:rollback-\$\{BACKUP##\*\/\}"/);
  assert.match(PUBLISHER, /docker image tag "\$image" "\$tag"/);
  assert.match(PUBLISHER, /image: %s\\n    pull_policy: never\\n/);
  assert.match(PUBLISHER, /-f "\$BACKUP\/rollback\.yaml" up -d --no-deps --no-build --pull never runner frontend/);
  assert.doesNotMatch(PUBLISHER, /docker (?:rmi|image prune|system prune)|cleanup_old_rollback_images/);
});

test('runner mounts the integrated control-plane modules required by code-runner.js', () => {
  assert.match(COMPOSE, /\.\/scripts\/code-runner\.js:\/scripts\/code-runner\.js:ro/);
  assert.match(COMPOSE, /\.\/scripts\/code-runner-utils\.js:\/scripts\/code-runner-utils\.js:ro/);
  assert.doesNotMatch(COMPOSE, /code-runner-worktrees\.js/);
  assert.doesNotMatch(GVISOR_WORKFLOW, /code-runner-worktrees\.js/);
});

test('runner recovery preserves dirty base work under a durable private ref', () => {
  assert.match(RUNNER, /\/workspace\/worktree\/recover-base/);
  assert.match(RUNNER, /refs\/sira\/recovery\/\$\{runId\}-/);
  assert.match(RUNNER, /latestStash\.stdout\.trim\(\) === recoverySha/);
  assert.match(GVISOR_SMOKE, /assert\.equal\(dirtyWorktree\.error, 'working_tree_dirty'\)/);
  assert.match(GVISOR_SMOKE, /assert\.match\(recoveredBase\.recoveryRef, \/\^refs\\\/sira\\\/recovery/);
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
  assert.equal(
    COMPOSE.match(/^\s+CODEX_RUN_OS_ISOLATION_ATTESTED:/gm)?.length,
    2,
    'runner and backend must agree on the OS isolation attestation',
  );
  assert.match(COMPOSE, /CODEX_MAX_CONCURRENT_RUNS:[^\n]*\$\{CODEX_MAX_CONCURRENT_RUNS:-1\}/);
  assert.match(COMPOSE, /CODEX_FLEET_QA_ENABLED:[^\n]*\$\{CODEX_FLEET_QA_ENABLED:-0\}/);
});

test('runner rollout is healthy before the backend is replaced', () => {
  const buildRunner = position('"${COMPOSE[@]}" build runner backend frontend');
  const recreateRunner = positionAfter('"${COMPOSE[@]}" up -d --no-deps --no-build --pull never runner frontend', buildRunner);
  const waitRunner = positionAfter('wait_services runner frontend || die', recreateRunner);
  const startBackend = positionAfter('"${COMPOSE[@]}" up -d --no-deps --no-build --pull never backend', waitRunner);
  assert.ok(recreateRunner > buildRunner, 'runner must be built before it is recreated');
  assert.ok(waitRunner > recreateRunner, 'runner health must be awaited after recreation');
  assert.ok(startBackend > waitRunner, 'backend must not be replaced before runner health passes');
  assert.match(PUBLISHER, /wait_services\(\) \{[\s\S]*attempt<24[\s\S]*healthy "\$@"[\s\S]*\n  return 1\n\}/);
  assert.match(PUBLISHER, /docker inspect --format '[^\n]*\.State\.Health[^\n]*' "\$id"\) == 'running healthy'/);
});

test('Lenovo readiness retains rollback images and reusable runtime canary without claiming legacy VPS canary execution', () => {
  // Reviewed scope: Lenovo's publisher never used the retired VPS /code canary
  // wiring. Application acceptance remains a separate manual release gate;
  // readiness/SHA are not represented as a successful build/browser canary.
  const activate = position('"${COMPOSE[@]}" up -d --no-deps --no-build --pull never backend');
  const ready = positionAfter('wait_release "$TARGET" || die', activate);
  const journal = positionAfter('>> "$DEPLOY/releases.log"', ready);
  assert.ok(journal > ready, 'success journal must follow healthy, exact-SHA release verification');
  assert.doesNotMatch(PUBLISHER, /cleanup_old_rollback_images|docker (?:rmi|image prune|system prune)/);
  assert.match(WORKFLOW, /node scripts\/verify-lenovo-release\.cjs "\$TARGET_SHA"/);
  assert.doesNotMatch(WORKFLOW, /run_code_runtime_canary/);
  assert.match(RUNTIME_CANARY, /require\('\.\.\/src\/services\/codex\/runtime-canary'\)/);
  assert.match(RUNTIME_CANARY, /await runRuntimeCanary\(\{/);
  assert.match(RUNTIME_CANARY, /process\.exitCode = 1/);
});

test('rollback restores and verifies the runner before restoring the API', () => {
  const rollback = PUBLISHER.slice(position('finish() {'), position('trap finish EXIT'));
  const restoreMetadata = rollback.indexOf('write_release_keys "$BACKUP/release.keys"');
  const recreateRunner = rollback.indexOf('"${COMPOSE[@]}" -f "$BACKUP/rollback.yaml" up -d --no-deps --no-build --pull never runner frontend');
  const waitRunner = rollback.indexOf('wait_services runner frontend', recreateRunner);
  const recreateApi = rollback.indexOf('"${COMPOSE[@]}" -f "$BACKUP/rollback.yaml" up -d --no-deps --no-build --pull never backend');
  assert.ok(restoreMetadata >= 0 && recreateRunner > restoreMetadata, 'rollback must restore metadata before using pinned images');
  assert.ok(waitRunner > recreateRunner, 'rollback must verify runner health');
  assert.ok(recreateApi > waitRunner, 'rollback must restore API only after runner health passes');
  assert.match(rollback, /wait_services runner frontend[\s\S]*then[\s\S]*--pull never backend/);
  assert.match(rollback, /wait_release "\$PREVIOUS"/);
});
