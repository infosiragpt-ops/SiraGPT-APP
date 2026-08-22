'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H4-BE-001 orgs SSE Last-Event-ID', () => {
  const src = read('src/routes/orgs.js');
  assert.match(src, /createSseEventCounter/);
  assert.match(src, /parseLastEventId\(req\)/);
  assert.match(src, /lastSseId > 0 \? new Date\(\)/);
});

test('3H4-BE-002 codex-runs SSE Last-Event-ID', () => {
  const src = read('src/routes/codex-runs.js');
  assert.match(src, /createSseEventCounter/);
  assert.match(src, /events\.slice\(start\)/);
});

test('3H4-BE-003 createSSEEvents honors Last-Event-ID', () => {
  const src = read('src/services/sira/turn-events.js');
  assert.match(src, /parseLastEventId\(req\)/);
  const ent = read('src/routes/enterprise.js');
  assert.match(ent, /createSSEEvents\(res, \{ requestId: req\.requestId \|\| req\.id \|\| null, req \}\)/);
});

test('3H4-BE-004/005/016 rate-limit leftovers', () => {
  const src = read('src/middleware/rate-limit-policy.js');
  assert.match(src, /\/api\/thesis/);
  assert.match(src, /\/api\/marco-teorico/);
  assert.match(src, /\/api\/paraphrase/);
  assert.match(src, /\/api\/computer-use/);
  assert.match(src, /\/api\/computer-use\/stop/);
  assert.match(src, /\/cancel/);
});

test('3H4-BE-006/007 PII leftover no email in impersonation/GDPR logs', () => {
  const auth = read('src/routes/auth.js');
  assert.doesNotMatch(auth, /impersonate_denied non_admin=\$\{req\.user\.email\}/);
  assert.match(auth, /impersonate_denied non_admin=\$\{req\.user\.id\}/);
  const users = read('src/routes/users.js');
  assert.doesNotMatch(users, /user_delete user=\$\{user\.email\}/);
  assert.match(users, /user_delete id=\$\{userId\}/);
});

test('3H4-BE-008 remote sandbox idle wrap', () => {
  const src = read('src/services/doc-agent/sandbox.js');
  assert.match(src, /attachIdleTimeout\(attachDestroyOnAbort\(require\('\.\/remote-sandbox'\)/);
});

test('3H4-BE-009 social-posts OAuth leftover map', () => {
  const src = read('src/routes/social-posts.js');
  assert.match(src, /consent_required/);
  assert.match(src, /provider_unavailable/);
});

test('3H4-BE-010 gateway HTTP userId from req.user only', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /function actorUserId/);
  assert.match(src, /userId: actorUserId\(req\)/);
  assert.doesNotMatch(src, /userId: body\.userId/);
  assert.doesNotMatch(src, /queryOf\(req, 'userId'\)/);
});

test('3H4-BE-011/012 cron scoped + skills.delete leftover', () => {
  const cron = read('src/services/agent-cron/index.js');
  assert.match(cron, /function listJobs\(\{ userId \} = \{\}\)/);
  const proto = read('src/services/agent-gateway/protocol.js');
  assert.match(proto, /SKILLS_DELETE: 'skills\.delete'/);
  const gw = read('src/services/agent-gateway/index.js');
  assert.match(gw, /METHODS\.SKILLS_DELETE/);
  assert.match(gw, /scoped: \{ memory: true, skills: true, cron: true \}/);
  const live = read('src/routes/gateway.js');
  assert.match(live, /deletePersistedSkill/);
  assert.match(live, /listJobs\(\{ userId \}\)/);
});

test('3H4-BE-013 EDIT_TOOLS add_slides', () => {
  const src = read('src/services/agent-runner/verify.js');
  assert.match(src, /'add_slides'/);
});

test('3H4-BE-014 computer-use GET audit', () => {
  const src = read('src/routes/computer-use.js');
  assert.match(src, /action: 'capabilities'/);
  assert.match(src, /action: 'status'/);
});

test('3H4-BE-017/018 logger+health leftover PII keys', () => {
  const log = read('src/services/observability/structured-logger.js');
  assert.match(log, /ssn\|iban\|cvv\|phone/);
  const health = read('src/services/observability/health-check.js');
  assert.match(health, /cookie\|client_secret\|id_token/);
});

test('3H4 live helpers: actorUserId ignores spoof', () => {
  const { actorUserId } = (() => {
    const src = read('src/services/agent-gateway/http.js');
    const start = src.indexOf('function actorUserId');
    const end = src.indexOf('function queryOf');
    // eslint-disable-next-line no-new-func
    return new Function(`${src.slice(start, end)}; return { actorUserId };`)();
  })();
  assert.equal(actorUserId({ user: { id: 'u1' }, query: { userId: 'spoof' }, body: { userId: 'spoof' } }), 'u1');
  assert.equal(actorUserId({ query: { userId: 'spoof' } }), '');
});

test('3H4 cron listJobs fail-closed without userId', () => {
  const { createCron } = require('../src/services/agent-cron');
  const cron = createCron({ persistPath: `/tmp/siragpt-cron-3h4-${process.pid}.json`, now: () => Date.now() });
  cron.createJob({ userId: 'alice', prompt: 'hello alice', everyMs: 60_000 });
  cron.createJob({ userId: 'bob', prompt: 'hello bob', everyMs: 60_000 });
  assert.equal(cron.listJobs().length, 0);
  assert.equal(cron.listJobs({ userId: 'alice' }).length, 1);
  assert.equal(cron.listJobs({ userId: 'bob' })[0].prompt, 'hello bob');
});
