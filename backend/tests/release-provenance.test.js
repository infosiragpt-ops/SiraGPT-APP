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
  const { resolveCommit } = require('../src/utils/deployed-tree-commit');
  const commit = resolveCommit({ GIT_COMMIT: 'not-a-git-sha' }, { gitSha: null });
  assert.notEqual(commit, 'not-a-git-sha');
  assert.match(commit, /^(unknown|[0-9a-f]{7,40})$/i);
});

test('/api/version reports an exact valid build-injected commit when git tree is absent', () => {
  const commit = 'a4f15ce9a4f15ce9a4f15ce9a4f15ce9a4f15ce9';
  const { resolveCommit } = require('../src/utils/deployed-tree-commit');
  assert.equal(resolveCommit({ GIT_COMMIT: commit }, { gitSha: null }), commit);
});

test('/api/version prefers the deployed tree SHA over a stale GIT_COMMIT env', () => {
  const stale = 'a4f15ce9a4f15ce9a4f15ce9a4f15ce9a4f15ce9';
  const live = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { resolveCommit } = require('../src/utils/deployed-tree-commit');
  assert.equal(resolveCommit({ GIT_COMMIT: stale }, { gitSha: live }), live);
});

test('/api/version rejects short commit identifiers', () => {
  const { resolveCommit } = require('../src/utils/deployed-tree-commit');
  const commit = resolveCommit({ GIT_COMMIT: 'a4f15ce' }, { gitSha: null });
  assert.notEqual(commit, 'a4f15ce');
  assert.match(commit, /^(unknown|[0-9a-f]{40})$/i);
});

test('version route and env loader bind deployed-tree commit resolution', () => {
  const version = read('backend/src/routes/version.js');
  const loadEnv = read('backend/src/config/load-env.js');
  assert.match(version, /utils\/deployed-tree-commit/);
  assert.match(loadEnv, /applyGitCommitFromDeployedTree/);
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
  const gitCommitInterpolations = compose.match(/GIT_COMMIT:\s+"?\$\{GIT_COMMIT:-unknown\}"?/g) || [];
  assert.equal(
    gitCommitInterpolations.length,
    1,
    'only the backend build ARG may interpolate GIT_COMMIT; leftover .env must not override the image',
  );
  assert.doesNotMatch(
    compose,
    /PORT:\s+"5000"[\s\S]{0,400}GIT_COMMIT:\s+"\$\{GIT_COMMIT:-unknown\}"/,
  );
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

test('production verification accepts only a green production-main commit and publisher requires its exact checkout', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const publisher = read('deploy/iliagpt/publish-reviewed.sh');
  assert.match(workflow, /actions:\s+read/);
  assert.match(workflow, /TARGET_SHA:\s+\$\{\{ inputs\.target_sha \}\}/);
  assert.match(workflow, /\[\[ "\$TARGET_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(workflow, /git merge-base --is-ancestor "\$TARGET_SHA" origin\/production-main/);
  assert.match(workflow, /gh run list --workflow CI --branch production-main --commit "\$TARGET_SHA"/);
  assert.match(workflow, /select\(\.event == "push" and \.conclusion == "success"\)/);
  assert.match(workflow, /\[\[ "\$runs" -gt 0 \]\] \|\| .*exit 1/);
  assert.match(workflow, /node scripts\/verify-lenovo-release\.cjs "\$TARGET_SHA"/);
  assert.match(publisher, /\[\[ \$head == "\$TARGET" && -z \$changes \]\]/);
  assert.match(publisher, /git merge-base --is-ancestor "\$TARGET" refs\/remotes\/origin\/production-main/);
  assert.match(publisher, /git merge-base --is-ancestor "\$PREVIOUS" "\$TARGET"/);
});

test('production verification is explicit and read-only, never an automatic remote deployment', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m);

  assert.ok(triggerBlock, 'expected to extract workflow trigger block');
  assert.match(triggerBlock[1], /workflow_dispatch:/);
  assert.match(triggerBlock[1], /target_sha:[\s\S]*required: true/);
  assert.doesNotMatch(triggerBlock[1], /workflow_run:|\bpush:|\bpull_request:/);
  assert.match(workflow, /contents:\s+read/);
  assert.doesNotMatch(workflow, /contents:\s+write|\$\{\{\s*secrets\.|appleboy\/|\bssh\b|\bscp\b|docker compose|git reset --hard/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('main auto-promotion is fast-forward only and CI gated', () => {
  const workflow = read('.github/workflows/promote-main-to-production.yml');

  assert.match(workflow, /name:\s+Promote main to production/);
  assert.match(workflow, /workflow_run:\s*\n\s+workflows:\s+\['CI'\]\s*\n\s+types:\s+\[completed\]\s*\n\s+branches:\s+\[main\]/);
  assert.match(workflow, /permissions:\s*\n\s+actions:\s+read\s*\n\s+contents:\s+write/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /WORKFLOW_RUN_SHA:\s+\$\{\{ github\.event\.workflow_run\.head_sha \|\| '' \}\}/);
  assert.match(workflow, /gh run list --workflow CI --branch main --commit "\$\{TARGET_SHA\}"/);
  assert.match(workflow, /git merge-base --is-ancestor origin\/production-main "\$\{TARGET_SHA\}"/);
  assert.match(workflow, /git push origin "\$\{TARGET_SHA\}:refs\/heads\/production-main"/);
  assert.match(workflow, /Refusing stale promotion/);
  assert.match(workflow, /main and production-main have diverged/);
  assert.doesNotMatch(workflow, /--force/);
  assert.doesNotMatch(workflow, /git reset --hard/);
  assert.doesNotMatch(workflow, /git merge --no-ff/);
});

test('reviewed Lenovo publication refuses schema changes and cannot trigger migration baselining', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const publisher = read('deploy/iliagpt/publish-reviewed.sh');
  assert.match(publisher, /schema_changes=\$\(git diff --name-only "\$PREVIOUS" "\$TARGET"/);
  for (const scope of ['**/migrations/**', '**/schema.prisma', '**/schema.sql', '**/drizzle/**']) assert.ok(publisher.includes(scope));
  assert.match(publisher, /\[\[ -z \$schema_changes \]\] \|\| die 'Schema or migration changes require a separate reviewed release\.'/);
  for (const source of [workflow, publisher]) assert.doesNotMatch(source, /ALLOW_EQUIVALENT_UNBASELINED|MIGRATION_ALLOW_EQUIVALENT_UNBASELINED|baseline-migration-history\.js|deploy-production-baseline-|prisma\s+(?:db push|migrate)/);
});

test('production deploy proves the exact commit and restores rollback provenance', () => {
  const publisher = read('deploy/iliagpt/publish-reviewed.sh');
  const rollback = publisher.match(/finish\(\) \{([\s\S]*?)\n\}/);
  assert.ok(rollback, 'expected to extract rollback function');
  assert.match(publisher, /export GIT_COMMIT="\$TARGET" SIRAGPT_VERSION=/);
  assert.match(publisher, /for service in runner backend frontend; do/);
  assert.match(publisher, /docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(publisher, /docker image tag "\$image" "\$tag"/);
  assert.match(publisher, /\[\[ \$image =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(publisher, /wait_release "\$TARGET" \|\| die/);
  assert.match(publisher, /JSON\.parse\(s\)\.commit!==process\.argv\[1\]/);
  assert.match(rollback[1], /write_release_keys "\$BACKUP\/release\.keys"/);
  assert.match(rollback[1], /unset GIT_COMMIT SIRAGPT_VERSION/);
  assert.match(rollback[1], /-f "\$BACKUP\/rollback\.yaml" up -d --no-deps --no-build --pull never runner frontend && wait_services runner frontend; then/);
  assert.match(rollback[1], /-f "\$BACKUP\/rollback\.yaml" up -d --no-deps --no-build --pull never backend && wait_release "\$PREVIOUS"/);
  assert.match(rollback[1], /wait_release "\$PREVIOUS"/);
  assert.doesNotMatch(rollback[1], /\sbuild\s|git reset --hard/);
  assert.doesNotMatch(publisher, /(?:PREVIOUS|PREV_SHA)="?\$\(git rev-parse HEAD/);
});

test('reviewed publication retains private diagnostics without replaying secret-bearing command output', () => {
  const publisher = read('deploy/iliagpt/publish-reviewed.sh');
  const redactor = read('backend/scripts/redact-log-stream.js');
  assert.match(publisher, /umask 077/);
  assert.match(publisher, /LOG="\$BACKUP\/publish\.log"/);
  assert.match(publisher, /chmod 600 "\$LOG"/);
  assert.match(publisher, /exec >> "\$LOG" 2>&1/);
  assert.doesNotMatch(publisher, /(?:cat|tail|tee)\s+"\$LOG"/);
  assert.match(publisher, /attempt<24/);
  assert.match(publisher, /--connect-timeout 5 --max-time 15/);
  assert.match(publisher, /trap finish EXIT/);
  assert.match(redactor, /redactString/);
  assert.doesNotMatch(redactor, /console\.log\(line\)/);
});

test('Lenovo release runs no migrations while the separate legacy migration path stays bounded', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const publisher = read('deploy/iliagpt/publish-reviewed.sh');
  const deployScript = read('scripts/deploy-production.sh');
  assert.doesNotMatch(workflow + publisher, /start-with-migrations\.js|baseline-migration-history\.js|\bnpx\s+prisma\b/);
  assert.match(
    deployScript,
    /node scripts\/start-with-migrations\.js --migrate-only/,
  );
  assert.match(deployScript, /git -C "\$\{APP_DIR\}" rev-parse HEAD/);
  assert.match(deployScript, /export GIT_COMMIT/);
  assert.doesNotMatch(workflow, /\bnpx\s+prisma\b/);
  assert.doesNotMatch(deployScript, /\bnpx\s+prisma\b/);
  assert.match(publisher, /Schema or migration changes require a separate reviewed release/);
});

test('backend vercel-build uses the bounded migration-only lifecycle', () => {
  const backendPackage = JSON.parse(read('backend/package.json'));
  const command = backendPackage.scripts['vercel-build'];

  assert.match(
    command,
    /^node scripts\/start-with-migrations\.js --migrate-only$/,
  );
  assert.doesNotMatch(command, /(?:^|&&)\s*(?:npx\s+)?prisma\s+/);
});
