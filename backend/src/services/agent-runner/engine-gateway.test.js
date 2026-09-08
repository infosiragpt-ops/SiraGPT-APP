'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gw = require('./engine-gateway');

function tmpAudit() {
  const p = path.join(os.tmpdir(), `gw-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  gw.setAuditPathForTests(p);
  return p;
}

test.beforeEach(() => {
  gw.resetGatewayStateForTests();
  tmpAudit();
});

test('allow: default owner policy permit + audit row', () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: [], allow: ['true'] });
  const d = gw.decideAndAudit({ tool: 'execute_bash', actorId: 'luis', botId: 'ceo' });
  assert.equal(d.allow, true);
  assert.equal(d.rule, 'true');
  assert.ok(d.auditId);
  const rows = gw.readAudit({ limit: 5 });
  assert.equal(rows[0].status, 'permitted');
  assert.equal(rows[0].auditId, d.auditId);
  assert.equal(rows[0].tool, 'execute_bash');
});

test('deny: deny list beats allow', () => {
  gw.setPolicyForTests({
    mode: 'enforce',
    deny: ['tool.name == "write_file" && contains(file.name, ".env")'],
    allow: ['true'],
  });
  const d = gw.decideAndAudit({
    tool: 'write_file',
    actorId: 'luis',
    file: '.env',
  });
  assert.equal(d.allow, false);
  assert.ok(String(d.rule).includes('.env') || d.rule.includes('write_file'));
  const rows = gw.readAudit({ limit: 1 });
  assert.equal(rows[0].status, 'refused');
  assert.ok(rows[0].rule);
});

test('fail-closed: missing policy permits nothing, still writes audit', () => {
  gw.setPolicyForTests(null);
  const d = gw.decideAndAudit({ tool: 'execute_bash', actorId: 'luis' });
  assert.equal(d.allow, false);
  assert.equal(d.rule, 'missing_policy');
  assert.ok(d.auditId);
  const rows = gw.readAudit({ limit: 1 });
  assert.equal(rows[0].status, 'refused');
});

test('fail-closed: empty allow list denies', () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: [], allow: [] });
  const d = gw.decideAndAudit({ tool: 'read_file', file: 'a.js' });
  assert.equal(d.allow, false);
  assert.equal(d.rule, 'default_deny');
});

test('fail-closed: broken deny still denies', () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: ['matches(page.host, "(unclosed" )'], allow: ['true'] });
  const d = gw.decideAndAudit({ tool: 'computer_click', page: { url: 'https://x.com', host: 'x.com' } });
  assert.equal(d.allow, false);
});

test('fail-closed: broken allow does not permit', () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: [], allow: ['matches(page.host, "(unclosed" )'] });
  const d = gw.decideAndAudit({ tool: 'read_file', file: 'a.js' });
  assert.equal(d.allow, false);
  assert.equal(d.rule, 'default_deny');
});

test('secret redaction: value never stored, length is', () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: [], allow: ['true'] });
  const secret = 'super-secret-password-123';
  const d = gw.decideAndAudit({
    tool: 'computer_type',
    actorId: 'luis',
    secret,
    secretLabel: 'login',
  });
  assert.equal(d.allow, true);
  const rows = gw.readAudit({ limit: 1 });
  const dumped = JSON.stringify(rows[0]);
  assert.equal(dumped.includes(secret), false);
  assert.equal(rows[0].secret.length, secret.length);
  assert.equal(rows[0].secret.requested, true);
  const red = gw.redactSecret(secret, 'login');
  assert.equal(red.length, secret.length);
  assert.equal(red.value, undefined);
});

test('human-control: refuse bot computer actions, do not queue', () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: [], allow: ['true'] });
  const bound = gw.bindComputer({ coworkerId: 'ceo-office' });
  gw.takeControl({ computerId: bound.computerId, actorId: 'luis', reason: '2fa' });
  const hold = gw.withHumanControl(bound.computerId);
  assert.equal(hold.held, true);
  const d = gw.decideAndAudit({
    tool: 'computer_click',
    computerId: bound.computerId,
    botId: 'ceo-bot',
    actorId: 'ceo-bot',
  });
  assert.equal(d.allow, false);
  assert.equal(d.rule, 'human_control');
  gw.releaseControl({ computerId: bound.computerId, actorId: 'luis' });
  const after = gw.decideAndAudit({
    tool: 'computer_click',
    computerId: bound.computerId,
    botId: 'ceo-bot',
  });
  assert.equal(after.allow, true);
});

test('wrapExecutors: denied tool never runs', async () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: ['tool.name == "execute_bash"'], allow: ['true'] });
  let ran = false;
  const wrapped = gw.wrapExecutors({
    execute_bash: async () => { ran = true; return 'PWN'; },
    retrieve_memory: async () => 'mem',
  });
  const out = await wrapped.execute_bash({ command: 'id' }, { userId: 'luis' });
  assert.equal(ran, false);
  assert.match(String(out), /action_refused/);
  const mem = await wrapped.retrieve_memory({});
  assert.equal(mem, 'mem');
});

test('wrapExecutors: allowed tool runs after audit', async () => {
  gw.setPolicyForTests({ mode: 'enforce', deny: [], allow: ['true'] });
  const wrapped = gw.wrapExecutors({
    read_file: async (args) => `ok:${args.path}`,
  });
  const out = await wrapped.read_file({ path: 'app.js' }, { userId: 'luis', botId: 'code' });
  assert.equal(out, 'ok:app.js');
  const rows = gw.readAudit({ limit: 1 });
  assert.equal(rows[0].status, 'permitted');
  assert.equal(rows[0].file.name, 'app.js');
});

test('handoff events: help_requested / control_taken / control_released', () => {
  const id = 'cowork:dept-sales';
  const help = gw.requestHelp({ computerId: id, botId: 'sales', reason: 'login_wall' });
  assert.equal(help.event, 'computer.help_requested');
  assert.equal(gw.withHumanControl(id).held, true);
  const take = gw.takeControl({ computerId: id, actorId: 'luis' });
  assert.equal(take.event, 'computer.control_taken');
  const rel = gw.releaseControl({ computerId: id, actorId: 'luis' });
  assert.equal(rel.event, 'computer.control_released');
  assert.equal(gw.withHumanControl(id).held, false);
  const rows = gw.readAudit({ limit: 10 });
  const events = rows.map((r) => r.event).filter(Boolean);
  assert.ok(events.includes('computer.help_requested'));
  assert.ok(events.includes('computer.control_taken'));
  assert.ok(events.includes('computer.control_released'));
});
