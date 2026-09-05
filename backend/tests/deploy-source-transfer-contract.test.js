'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const PUBLISHER = fs.readFileSync(path.join(ROOT, 'deploy/iliagpt/publish-reviewed.sh'), 'utf8');
const PACKAGE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
const TEST_SHARD = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'test-shard.sh'), 'utf8');
const CI_QUARANTINE = fs.readFileSync(path.resolve(__dirname, '.ci-quarantine.txt'), 'utf8');

// The retired SSH/SCP workflow no longer transfers source or credentials.
// Preserve its safety contracts on the read-only workflow and local publisher.
// These source checks supplement tests/publish-reviewed.test.ts; none certifies
// a real SSH connection, database backup or production deployment.
test('read-only workflow cannot transfer credentials or initiate SSH/SCP deployments', () => {
  assert.match(WORKFLOW, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(WORKFLOW, /^\s*(push|pull_request_target|workflow_run|schedule):/m);
  assert.match(WORKFLOW, /^permissions:\n  actions: read\n  contents: read/m);
  assert.doesNotMatch(WORKFLOW, /:\s*(?:write|write-all)\s*$/m);
  assert.doesNotMatch(WORKFLOW, /\$\{\{\s*secrets\.|\b(?:DEPLOY_GH_TOKEN|DEPLOY_SSH_KEY)\b/);
  assert.doesNotMatch(WORKFLOW, /uses:\s*appleboy\/|^\s*envs:|\b(?:ssh|scp|rsync)\s|docker\s+compose|publish(?:-reviewed)?\.sh\s/m);
  assert.doesNotMatch(WORKFLOW + PUBLISHER, /https?:\/\/[^\s"']+@github\.com|x-access-token|oauth2:|authorization[^\n]*(?:bearer|basic)/i);
  assert.doesNotMatch(PUBLISHER, /\b(?:GITHUB_TOKEN|GH_TOKEN|DEPLOY_GH_TOKEN)\b|git\s+-c[^\n]*(?:credential|authorization)/i);
});

test('read-only verification requires exact SHA, production ancestry and successful push CI', () => {
  assert.match(WORKFLOW, /TARGET_SHA: \$\{\{ inputs\.target_sha \}\}/);
  assert.match(WORKFLOW, /\[\[ "\$TARGET_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(WORKFLOW, /git cat-file -e "\$TARGET_SHA\^\{commit\}"/);
  assert.match(WORKFLOW, /git merge-base --is-ancestor "\$TARGET_SHA" origin\/production-main/);
  assert.match(WORKFLOW, /gh run list --workflow CI --branch production-main --commit "\$TARGET_SHA"/);
  assert.match(WORKFLOW, /\.event == "push" and \.conclusion == "success"/);
  assert.match(WORKFLOW, /\[\[ "\$runs" -gt 0 \]\] \|\|/);
  const ci = WORKFLOW.indexOf('[[ "$runs" -gt 0 ]]');
  const verify = WORKFLOW.indexOf('node scripts/verify-lenovo-release.cjs "$TARGET_SHA"');
  const summary = WORKFLOW.indexOf('>> "$GITHUB_STEP_SUMMARY"');
  assert.ok(ci >= 0 && verify > ci && summary > verify, 'success evidence must follow CI and live verification');
});

test('publisher requires approved clean checkout without destructive source transfer', () => {
  assert.match(PUBLISHER, /\[\[ \$# == 2 && \$1 =~ \^\[0-9a-f\]\{40\}\$ && \$2 =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(PUBLISHER, /head=\$\(git rev-parse HEAD\) && changes=\$\(git status --porcelain\) \|\| return 1/);
  assert.match(PUBLISHER, /\[\[ \$head == "\$TARGET" && -z \$changes \]\]/);
  assert.match(PUBLISHER, /git fetch --no-tags origin production-main/);
  assert.match(PUBLISHER, /git merge-base --is-ancestor "\$TARGET" refs\/remotes\/origin\/production-main/);
  assert.match(PUBLISHER, /git merge-base --is-ancestor "\$PREVIOUS" "\$TARGET"/);
  assert.doesNotMatch(PUBLISHER, /git (?:reset|clean|checkout|switch)|rsync[^\n]*--delete|git bundle|\bscp\s/);
  const first = PUBLISHER.indexOf('checkout_clean || die');
  const build = PUBLISHER.indexOf('"${COMPOSE[@]}" build runner backend frontend');
  const second = PUBLISHER.indexOf('checkout_clean || die', first + 1);
  assert.ok(first >= 0 && build > first && second > build, 'checkout must be verified before and after build');
});

test('publisher reserves private backups and a non-destructive publication lock', () => {
  assert.match(PUBLISHER, /^umask 077$/m);
  assert.match(PUBLISHER, /mkdir "\$LOCK" 2>\/dev\/null \|\| die/);
  assert.doesNotMatch(PUBLISHER, /mkdir\s+-p\s+"\$LOCK"|\brm\s[^\n]*"\$LOCK"/);
  assert.match(PUBLISHER, /\[\[ ! -L \$DEPLOY\/backups \]\]/);
  assert.match(PUBLISHER, /mktemp -d "\$DEPLOY\/backups\/reviewed-\$\{TARGET:0:12\}-XXXXXX"/);
  assert.match(PUBLISHER, /\[\[ -f \$DEPLOY\/\$file && ! -L \$DEPLOY\/\$file \]\]/);
  assert.match(PUBLISHER, /chmod 600 "\$BACKUP\/\$file"/);
  assert.match(PUBLISHER, /exec >> "\$LOG" 2>&1/);
  assert.doesNotMatch(PUBLISHER, /cat\s+"?\$LOG|tail[^\n]*\$LOG|docker logs/);
  assert.match(PUBLISHER, /trap finish EXIT/);
});

test('workflow checkout never persists its temporary Actions token', () => {
  const checkout = WORKFLOW.match(/- uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n([\s\S]*?)(?=\n      - |$)/);
  assert.ok(checkout, 'expected production-main read-only checkout');
  assert.match(checkout[1], /ref: production-main/);
  assert.match(checkout[1], /fetch-depth: 0/);
  assert.match(checkout[1], /persist-credentials: false/);
  assert.doesNotMatch(checkout[1], /token:\s*\$\{\{\s*secrets\./);
});

test('every remaining third-party Action is pinned to an immutable SHA', () => {
  const uses = [...WORKFLOW.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 1, 'read-only verification still requires checkout');
  for (const action of uses) {
    if (action.startsWith('./')) continue;
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${action} is not pinned by SHA`);
  }
  assert.doesNotMatch(WORKFLOW, /StrictHostKeyChecking\s*=\s*no|UserKnownHostsFile\s*=\s*\/dev\/null/i);
});

test('credential-transfer regression contracts remain part of canonical sharded CI', () => {
  const command = PACKAGE.scripts && PACKAGE.scripts['test:deploy-contract'];
  assert.match(command || '', /tests\/deploy-runner-rollout-contract\.test\.js/);
  assert.match(command || '', /tests\/deploy-source-transfer-contract\.test\.js/);
  assert.match(TEST_SHARD, /find tests -name '\*\.test\.js' -type f/);
  assert.doesNotMatch(CI_QUARANTINE, /^tests\/deploy-source-transfer-contract\.test\.js(?:\s|$)/m);
});

test('backup, candidate proof, preactivation CAS and exact-image rollback remain enforced', () => {
  assert.match(PUBLISHER, /"\$\{COMPOSE\[@\]\}" config -q/);
  assert.match(PUBLISHER, /pg_dump -Fc/);
  assert.match(PUBLISHER, /gzip -t "\$BACKUP\/database\.dump\.gz"/);
  assert.match(PUBLISHER, /pg_restore --list/);
  assert.match(PUBLISHER, /docker image tag "\$image" "\$tag"/);
  assert.match(PUBLISHER, /\[\[ \$image =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(PUBLISHER, /i!=="iliagpt-backend:"\+process\.argv\[1\]/);
  const proof = PUBLISHER.indexOf('docker run --rm --network none --entrypoint node "$candidate" scripts/image-size-security-patch.cjs --verify');
  const cas = PUBLISHER.indexOf('cmp -s "$BACKUP/release.keys" "$BACKUP/preactivation.keys"');
  const activated = PUBLISHER.indexOf('\nACTIVATED=1\n');
  const up = PUBLISHER.indexOf('"${COMPOSE[@]}" up -d --no-deps --no-build --pull never runner frontend');
  assert.ok(proof >= 0 && cas > proof && activated > cas && up > activated, 'proof and CAS must precede partial-activation boundary');
  assert.match(PUBLISHER, /cmp -s "\$DEPLOY\/compose\.yaml" "\$BACKUP\/compose\.yaml"/);
  assert.match(PUBLISHER, /cmp -s "\$DEPLOY\/Caddyfile" "\$BACKUP\/Caddyfile"/);
  assert.match(PUBLISHER, /healthy && http_release "\$PREVIOUS" \|\| die 'Live release changed/);
  assert.match(PUBLISHER, /== "\$expected_image" \]\] \|\| die/);
  assert.match(PUBLISHER, /unset GIT_COMMIT SIRAGPT_VERSION/);
  assert.match(PUBLISHER, /-f "\$BACKUP\/rollback\.yaml" up -d --no-deps --no-build --pull never runner frontend/);
  assert.match(PUBLISHER, /-f "\$BACKUP\/rollback\.yaml" up -d --no-deps --no-build --pull never backend/);
  assert.match(PUBLISHER, /wait_release "\$PREVIOUS" \|\| rollback_ok=0/);
  assert.match(PUBLISHER, /wait_release "\$TARGET" \|\| die/);
  assert.doesNotMatch(PUBLISHER, /down -v|volume rm|docker (?:system|image) prune|--force-recreate[^\n]*(?:gateway|db|redis)/);
});

test('metadata restoration failure cannot short-circuit exact-image rollback or health verification', () => {
  const match = PUBLISHER.match(/\n(finish\(\) \{[\s\S]*?\n\})\ntrap finish EXIT/);
  assert.ok(match, 'could not extract actual publisher EXIT handler');
  for (const failMetadata of [false, true]) {
    const harness = `
set -Eeuo pipefail
exec 3>&1
write_release_keys() { ${failMetadata ? 'return 97;' : 'return 0;'} }
compose_fixture() { printf 'rollback-images-reached\\n'; return 0; }
wait_services() { printf 'rollback-services-reached\\n'; return 0; }
wait_release() { printf 'rollback-health-reached:%s\\n' "$1"; return 0; }
rmdir() { return 0; }
COMPOSE=(compose_fixture)
ENV_CHANGED=1
ACTIVATED=1
BACKUP=/private/fixture-only
LOCK=/private/fixture-lock
PREVIOUS=1111111111111111111111111111111111111111
export GIT_COMMIT=2222222222222222222222222222222222222222 SIRAGPT_VERSION=target-fixture
${match[1]}
trap finish EXIT
exit 23
`;
    const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, failMetadata ? 2 : 23, result.stderr);
    assert.match(result.stdout, /rollback-images-reached/);
    assert.match(result.stdout, /rollback-services-reached/);
    assert.match(result.stdout, /rollback-health-reached:1111111111111111111111111111111111111111/);
    if (failMetadata) {
      assert.match(result.stdout, /CRITICAL: rollback verification failed/);
      assert.doesNotMatch(result.stdout, /previous release restored and verified/);
    } else assert.match(result.stdout, /previous release restored and verified/);
  }
});
