'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION_ROUTE_PATH = require.resolve('../src/routes/version');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadVersionInfo(env) {
  const keys = ['GIT_COMMIT', 'SOURCE_COMMIT', 'COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'SIRAGPT_VERSION'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[VERSION_ROUTE_PATH];

  try {
    return require('../src/routes/version').VERSION_INFO;
  } finally {
    delete require.cache[VERSION_ROUTE_PATH];
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('/api/version prefers the build-injected application version', () => {
  const info = loadVersionInfo({ SIRAGPT_VERSION: '9.8.7-release.1' });
  assert.equal(info.version, '9.8.7-release.1');
});

test('/api/version never reports malformed release provenance as a commit', () => {
  const info = loadVersionInfo({ GIT_COMMIT: 'not-a-git-sha' });
  assert.notEqual(info.commit, 'not-a-git-sha');
  assert.match(info.commit, /^(unknown|[0-9a-f]{7,40})$/i);
});

test('/api/version reports an exact valid build-injected commit', () => {
  const commit = 'a4f15ce9a4f15ce9a4f15ce9a4f15ce9a4f15ce9';
  const info = loadVersionInfo({ GIT_COMMIT: commit });
  assert.equal(info.commit, commit);
});

test('/api/version rejects short commit identifiers', () => {
  const info = loadVersionInfo({ GIT_COMMIT: 'a4f15ce' });
  assert.notEqual(info.commit, 'a4f15ce');
  assert.match(info.commit, /^(unknown|[0-9a-f]{40})$/i);
});

test('backend image receives immutable release provenance at build time', () => {
  const dockerfile = read('backend/Dockerfile');
  const compose = read('docker-compose.prod.yml');

  assert.match(dockerfile, /ARG GIT_COMMIT=unknown/);
  assert.match(dockerfile, /ARG SIRAGPT_VERSION=unknown/);
  assert.match(dockerfile, /ENV GIT_COMMIT=\$\{GIT_COMMIT\}/);
  assert.match(dockerfile, /ENV SIRAGPT_VERSION=\$\{SIRAGPT_VERSION\}/);
  assert.match(compose, /GIT_COMMIT:\s+\$\{GIT_COMMIT:-unknown\}/);
  assert.match(compose, /SIRAGPT_VERSION:\s+\$\{SIRAGPT_VERSION:-unknown\}/);
});

test('backend Docker build context excludes local secrets and dependencies', () => {
  const dockerignore = read('backend/.dockerignore');

  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^\*\.log$/m);
  assert.match(dockerignore, /^coverage$/m);
  assert.match(dockerignore, /^tests$/m);
  assert.match(dockerignore, /^\*\.pem$/m);
  assert.match(dockerignore, /^\.mcp\.json$/m);
  assert.match(dockerignore, /^prisma\/\*\.db\*$/m);
  assert.match(dockerignore, /^data$/m);
  assert.match(dockerignore, /^deployments-backup\.json$/m);
});

test('production deploy accepts only a green production-main commit', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const sshScript = workflow.match(/          script: \|\n([\s\S]*?)\n      - name: Surface deploy result/);

  assert.ok(sshScript, 'expected to extract the VPS deployment script');
  assert.match(workflow, /actions:\s+read/);
  assert.match(workflow, /git merge-base --is-ancestor "\$\{TARGET_SHA\}" origin\/production-main/);
  assert.match(workflow, /gh run list --workflow CI --branch production-main --commit "\$\{TARGET_SHA\}"/);
  assert.match(workflow, /envs: DEPLOY_GH_TOKEN,TARGET_SHA/);
  assert.doesNotMatch(sshScript[1], /\$\{\{\s*inputs\.target_sha/);
});

test('production deploy supports an explicit release tag without enabling branch auto-deploys', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)\n# Production deploys/m);

  assert.ok(triggerBlock, 'expected to extract workflow trigger block');
  assert.match(triggerBlock[1], /workflow_dispatch:/);
  assert.match(triggerBlock[1], /push:\s*\n\s+tags:\s*\n\s+- 'deploy-production-\*'/);
  assert.doesNotMatch(triggerBlock[1], /branches:/);
  assert.match(workflow, /FALLBACK_SHA:\s+\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.event\.created == true/);
  assert.match(workflow, /github\.event\.deleted == false/);
  assert.match(workflow, /github\.event\.forced == false/);
});

test('production deploy proves the exact commit and restores rollback provenance', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const rollback = workflow.match(/            rollback\(\) \{([\s\S]*?)\n            \}/);

  assert.ok(rollback, 'expected to extract rollback function');
  assert.match(workflow, /export GIT_COMMIT SIRAGPT_VERSION/);
  assert.match(workflow, /set_release_metadata "\$\{TARGET_SHA\}"/);
  assert.match(workflow, /set_release_metadata "\$\{PREV_SHA\}"/);
  assert.match(workflow, /verify_checkout "\$\{TARGET_SHA\}"/);
  assert.match(workflow, /verify_checkout "\$\{PREV_SHA\}"/);
  assert.match(workflow, /wait_version "\$\{TARGET_SHA\}" "\$\{SIRAGPT_VERSION\}"/);
  assert.match(workflow, /wait_version "\$\{PREV_SHA\}" "\$\{PREV_APP_VERSION\}"/);
  assert.match(workflow, /wait_frontend/);
  assert.match(workflow, /preserve_rollback_images/);
  assert.match(rollback[1], /restore_rollback_images/);
  assert.doesNotMatch(rollback[1], /\$\{COMPOSE\} build/);
  assert.match(workflow, /TARGET_SHA="\$\{TARGET_SHA,,\}"/);
  assert.match(workflow, /resolve_previous_release/);
  assert.match(workflow, /docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(workflow, /cleanup_old_rollback_images/);
  assert.doesNotMatch(workflow, /PREV_SHA="\$\(git rev-parse HEAD/);
});

test('production deploy only tolerates the known unbaselined Prisma error', () => {
  const workflow = read('.github/workflows/deploy.yml');

  assert.match(workflow, /P3005/);
  assert.match(workflow, /The database schema is not empty/);
  assert.match(workflow, /OTHER_PRISMA_CODE/);
  assert.match(workflow, /Database migration failed; aborting deploy/);
});
