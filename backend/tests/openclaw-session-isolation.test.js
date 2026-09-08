'use strict';

/**
 * Gateway-style session isolation + Spanish denial audit trail.
 * 25+ node:test. Native rewrite coverage. No OpenClaw runtime or vendor dump.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const isolation = require('../src/services/agents/session-isolation');
const {
  DENIAL_KINDS,
  DENIAL_LABELS_ES,
  AUDIT_PREFIX,
  trimId,
  actorProvided,
  idsMatch,
  authorizeSessionAbort,
  authorizeEventReplay,
  emptyResumePayload,
  resumeLeaksEventSeq,
  sanitizeAuditPart,
  formatDenialAuditLine,
  recordDenialAudit,
  recentDenialAudits,
  resetDenialAudits,
  attachAuditLine,
} = isolation;

const {
  buildTaskEventsResumePayload,
  beginSseResume,
  eventSeq,
} = require('../src/services/agents/agent-task-event-resume');
const {
  CANCEL_REASONS,
  decideTaskCancel,
  claimTaskCancel,
  isCancelAck,
} = require('../src/services/agents/agent-task-cancel');
const {
  createToolFailureCircuit,
  presentCircuitDenial,
  CIRCUIT_CODE,
} = require('../src/services/agents/tool-failure-circuit');
const { heldResult, OVERLAP_HELD_REASON_ES } = require('../src/services/scheduler/overlap-lease');
const { rejectedReceipt } = require('../src/orchestration/multichannel/delivery-receipt');
const { createGateway, gatewayReplayFrom } = require('../src/services/agent-gateway');
const { createEventLog } = require('../src/services/agent-gateway/event-log');

const VENDOR_LEAK = /openclaw|openrouter|deepseek|sk-|Bearer|AKIA|BEGIN /i;

beforeEach(() => {
  resetDenialAudits();
});

test('trimId and idsMatch treat blank as no identity', () => {
  assert.equal(trimId(null), '');
  assert.equal(trimId('  alice  '), 'alice');
  assert.equal(idsMatch('alice', 'alice'), true);
  assert.equal(idsMatch('alice', 'bob'), false);
  assert.equal(idsMatch('', ''), false);
  assert.equal(actorProvided(undefined), false);
  assert.equal(actorProvided(null), false);
  assert.equal(actorProvided(''), true);
});

test('internal abort without actor stays compatible (3H2 leftover)', () => {
  const out = authorizeSessionAbort({
    ownerUserId: 'u1',
    sessionKnown: true,
  });
  assert.equal(out.allowed, true);
  assert.equal(out.code, null);
});

test('HTTP abort of another user is forbidden and does not name the owner', () => {
  const out = authorizeSessionAbort({
    ownerUserId: 'alice',
    actorUserId: 'bob',
    sessionKnown: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.code, 'forbidden');
  assert.equal(out.reason, 'abort_forbidden');
  assert.match(out.message, /otro usuario/);
  assert.equal(out.message.includes('alice'), false);
});

test('HTTP abort of an unknown session is not_found (no guessed-lane abort)', () => {
  const out = authorizeSessionAbort({
    actorUserId: 'bob',
    sessionKnown: false,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.code, 'not_found');
  assert.equal(out.reason, 'abort_unknown');
});

test('HTTP abort of an unowned session is forbidden', () => {
  const out = authorizeSessionAbort({
    ownerUserId: '',
    actorUserId: 'bob',
    sessionKnown: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'abort_unowned');
});

test('HTTP abort with empty actor string is forbidden', () => {
  const out = authorizeSessionAbort({
    ownerUserId: 'alice',
    actorUserId: '   ',
    sessionKnown: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'abort_actor_required');
});

test('owner abort is allowed when actor matches', () => {
  const out = authorizeSessionAbort({
    ownerUserId: 'alice',
    actorUserId: 'alice',
    sessionKnown: true,
  });
  assert.equal(out.allowed, true);
});

test('event replay without actor is user_required', () => {
  const out = authorizeEventReplay({
    ownerUserId: 'alice',
    sessionKnown: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.code, 'user_required');
});

test('event replay of an unknown session is forbidden (no eventSeq leak)', () => {
  const out = authorizeEventReplay({
    actorUserId: 'bob',
    sessionKnown: false,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'replay_unknown');
});

test('event replay of an unowned session is forbidden', () => {
  const out = authorizeEventReplay({
    ownerUserId: '',
    actorUserId: 'bob',
    sessionKnown: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'replay_unowned');
});

test('cross-user event replay is forbidden and does not echo the owner id', () => {
  const out = authorizeEventReplay({
    ownerUserId: 'alice',
    actorUserId: 'bob',
    sessionKnown: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'replay_forbidden');
  assert.equal(out.message.includes('alice'), false);
});

test('owner event replay is allowed', () => {
  const out = authorizeEventReplay({
    ownerUserId: 'alice',
    actorUserId: 'alice',
    sessionKnown: true,
  });
  assert.equal(out.allowed, true);
});

test('empty resume payload never leaks eventSeq or events', () => {
  const payload = emptyResumePayload({ message: DENIAL_LABELS_ES.replay_forbidden });
  assert.equal(resumeLeaksEventSeq(payload), false);
  assert.deepEqual(payload.events, []);
  assert.equal(payload.lastEventSeq, 0);
  assert.equal(payload.firstRetainedSeq, 0);
  assert.equal(payload.sinceSeq, 0);
  assert.equal(payload.resumeStatus, 'forbidden');
  assert.match(payload.resumeLabel, /otra sesión/);
});

test('resumeLeaksEventSeq detects seq on events, lastEventSeq, gaps and sinceSeq', () => {
  assert.equal(resumeLeaksEventSeq({ lastEventSeq: 4, events: [] }), true);
  assert.equal(resumeLeaksEventSeq({ firstRetainedSeq: 2, events: [] }), true);
  assert.equal(resumeLeaksEventSeq({ sinceSeq: 3, events: [] }), true);
  assert.equal(resumeLeaksEventSeq({ gapFrom: 2, gapTo: 5, events: [] }), true);
  assert.equal(resumeLeaksEventSeq({ events: [{ seq: 9 }] }), true);
  assert.equal(resumeLeaksEventSeq({ events: [], lastEventSeq: 0 }), false);
});

test('buildTaskEventsResumePayload hides another user lastEventSeq', () => {
  const task = {
    taskId: 'task-iso',
    userId: 'alice',
    status: 'running',
    lastEventSeq: 12,
    events: [
      { id: 'e1', seq: 11, type: 'tool_call', tool: 'web_search' },
      { id: 'e2', seq: 12, type: 'done' },
    ],
  };
  const leaked = buildTaskEventsResumePayload(task, { actorUserId: 'bob' });
  assert.equal(resumeLeaksEventSeq(leaked), false);
  assert.equal(leaked.lastEventSeq, 0);
  assert.equal(leaked.events.length, 0);
  assert.equal(leaked.resumeStatus, 'forbidden');
});

test('buildTaskEventsResumePayload still replays for the owner', () => {
  const task = {
    taskId: 'task-iso-ok',
    userId: 'alice',
    status: 'running',
    lastEventSeq: 2,
    events: [
      { id: 'e1', seq: 1, type: 'step_start' },
      { id: 'e2', seq: 2, type: 'done' },
    ],
  };
  const payload = buildTaskEventsResumePayload(task, { actorUserId: 'alice', sinceSeq: 0 });
  assert.equal(payload.lastEventSeq, 2);
  assert.ok(payload.events.length >= 1);
  assert.equal(payload.resumeStatus, 'ok');
});

test('beginSseResume drops pending frames for a cross-user actor', () => {
  const started = beginSseResume({
    events: [
      { id: 'e1', seq: 1, type: 'tool_call' },
      { id: 'e2', seq: 2, type: 'done' },
    ],
    lastEventSeq: 2,
    actorUserId: 'bob',
    ownerUserId: 'alice',
  });
  assert.equal(started.lastSeq, 0);
  assert.deepEqual(started.pending, []);
  assert.equal(started.ackedTerminal, false);
});

test('cross-user cancel is not an ack and does not latch the task', () => {
  const task = { taskId: 't-x', userId: 'alice', status: 'running' };
  const decision = decideTaskCancel(task, { actorUserId: 'bob' });
  assert.equal(decision.apply, false);
  assert.equal(decision.reason, CANCEL_REASONS.FORBIDDEN);
  assert.equal(isCancelAck(decision), false);
  const claimed = claimTaskCancel(task, { actorUserId: 'bob' });
  assert.equal(claimed.apply, false);
  assert.equal(task.cancelClaimed, undefined);
});

test('owner cancel still applies once and stays idempotent', () => {
  const task = { taskId: 't-ok', userId: 'alice', status: 'running' };
  const first = claimTaskCancel(task, { actorUserId: 'alice' });
  assert.equal(first.apply, true);
  assert.equal(task.cancelClaimed, true);
  const second = claimTaskCancel(task, { actorUserId: 'alice' });
  assert.equal(second.apply, false);
  assert.equal(second.already, true);
  assert.equal(isCancelAck(second), true);
});

test('presentCircuitDenial attaches a Spanish audit line without vendor leak', () => {
  const circuit = createToolFailureCircuit({ sessionThreshold: 1, toolThreshold: 20 });
  circuit.record('s1', 'web_search', { ok: false });
  const denial = presentCircuitDenial(circuit.authorize('s1', 'web_search'));
  assert.equal(denial.code, CIRCUIT_CODE);
  assert.match(denial.auditLine, new RegExp(AUDIT_PREFIX));
  assert.match(denial.auditLine, /circuito/);
  assert.equal(VENDOR_LEAK.test(denial.auditLine), false);
});

test('heldResult lease denial carries the Spanish audit line', () => {
  const skip = heldResult({ jobId: 'job-iso', distributed: true });
  assert.equal(skip.code, 'overlap_skipped');
  assert.equal(skip.reason, OVERLAP_HELD_REASON_ES);
  assert.match(skip.auditLine, /lease/);
  assert.match(skip.auditLine, /solapamiento/);
  assert.equal(skip.auditLine.includes('OpenClaw'), false);
});

test('rejected receipt denial carries the Spanish audit line', () => {
  const receipt = rejectedReceipt('channel_not_allowed', { channel: 'telegram' });
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.delivered, false);
  assert.match(receipt.auditLine, /recibo/);
  assert.match(receipt.auditLine, /no está permitido/);
  assert.equal(VENDOR_LEAK.test(receipt.auditLine), false);
});

test('formatDenialAuditLine is Spanish, greppable, and drops secrets', () => {
  const line = formatDenialAuditLine({
    kind: DENIAL_KINDS.CIRCUIT,
    code: 'E_TIMEOUT',
    scope: 'session',
    label: 'El circuito está abierto.',
  });
  assert.match(line, /^\[DENEGACIÓN\] circuito/);
  assert.match(line, /código=E_TIMEOUT/);
  assert.match(line, /motivo=El circuito está abierto/);
  const dirty = formatDenialAuditLine({
    kind: 'receipt',
    code: 'secret_rejected',
    label: 'Bearer sk-abc1234567890token',
  });
  assert.equal(/sk-abc|Bearer /i.test(dirty), false);
});

test('sanitizeAuditPart strips vendor tokens and eventSeq mentions', () => {
  assert.equal(sanitizeAuditPart('openclaw gateway dump'), '');
  assert.equal(sanitizeAuditPart('lastEventSeq=12'), '');
  assert.equal(sanitizeAuditPart('El canal no está permitido.'), 'El canal no está permitido.');
});

test('recordDenialAudit keeps a recent ring and accepts an injectable sink', () => {
  const lines = [];
  recordDenialAudit({ kind: 'lease', code: 'overlap_skipped', label: OVERLAP_HELD_REASON_ES }, {
    sink: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[DENEGACIÓN\]/);
  const recent = recentDenialAudits();
  assert.ok(recent.some((row) => row.code === 'overlap_skipped'));
  resetDenialAudits();
  assert.equal(recentDenialAudits().length, 0);
});

test('attachAuditLine mutates the target and records the trail', () => {
  const target = { ok: false };
  attachAuditLine(target, {
    kind: 'abort',
    code: 'forbidden',
    label: DENIAL_LABELS_ES.abort_forbidden,
  });
  assert.match(target.auditLine, /aborto/);
  assert.match(target.auditLine, /otro usuario/);
});

test('gateway abort by another user throws forbidden and leaves the run', () => {
  const g = createGateway({
    env: { SIRAGPT_GATEWAY_MODEL: 'deepseek-v4-flash' },
    runner: { run: async () => ({ text: 'ok' }) },
  });
  const started = g.startAgent({ sessionKey: 'lane-iso', surface: 'chat', userId: 'alice', message: 'hola' });
  assert.ok(started.runId);
  assert.throws(
    () => g.abortSession('lane-iso', 'user_abort', 'bob'),
    (err) => err && err.code === 'forbidden',
  );
  const sess = g.getSession('lane-iso');
  assert.equal(String(sess.userId), 'alice');
});

test('gateway owner abort still succeeds', () => {
  const g = createGateway({
    env: { SIRAGPT_GATEWAY_MODEL: 'deepseek-v4-flash' },
    runner: { run: async () => ({ text: 'ok' }) },
  });
  g.startAgent({ sessionKey: 'lane-own', surface: 'chat', userId: 'alice', message: 'hola' });
  const out = g.abortSession('lane-own', 'user_abort', 'alice');
  assert.equal(out.aborted, true);
  assert.equal(out.sessionKey, 'lane-own');
});

test('gateway HTTP-style abort of an unknown lane is not_found', () => {
  const g = createGateway({ env: { SIRAGPT_GATEWAY_MODEL: 'deepseek-v4-flash' } });
  assert.throws(
    () => g.abortSession('missing-lane', 'user_abort', 'bob'),
    (err) => err && err.code === 'not_found',
  );
});

test('event log replayFrom with a foreign actor returns no frames', () => {
  const log = createEventLog();
  log.remember('lane-a', { event: 'message', seq: 1, text: 'privado' }, { ownerUserId: 'alice' });
  log.remember('lane-a', { event: 'message', seq: 2, text: 'sigue' }, { ownerUserId: 'alice' });
  assert.equal(log.ownerOf('lane-a'), 'alice');
  const leaked = log.replayFrom('lane-a', 0, { actorUserId: 'bob', requireOwner: true });
  assert.deepEqual(leaked, []);
  const owned = log.replayFrom('lane-a', 0, { actorUserId: 'alice', requireOwner: true });
  assert.ok(owned.length >= 1);
  assert.equal(eventSeq(owned[0]) > 0, true);
});

test('gatewayReplayFrom with actor does not leak another user eventSeq', () => {
  const g = createGateway({
    env: { SIRAGPT_GATEWAY_MODEL: 'deepseek-v4-flash' },
    runner: { run: async () => ({ text: 'ok' }) },
  });
  g.startAgent({ sessionKey: 'lane-rep', surface: 'chat', userId: 'alice', message: 'hola' });
  const foreign = gatewayReplayFrom(g, 'lane-rep', 0, 'bob');
  assert.deepEqual(foreign, []);
  const owned = gatewayReplayFrom(g, 'lane-rep', 0, 'alice');
  assert.ok(Array.isArray(owned));
});

test('isolation module is a native rewrite, not an OpenClaw dump', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/agents/session-isolation.js'), 'utf8');
  assert.match(src, /Not a dump/);
  assert.match(src, /SiraGPT-owned/);
  assert.doesNotMatch(src, /dmScope|per-channel-peer|pairing approve/);
  assert.doesNotMatch(src, /from ['"]openclaw/);
  const notices = fs.readFileSync(path.join(__dirname, '../../THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /session-isolation\.js/);
});

test('Spanish denial labels cover abort, replay and cancel', () => {
  for (const label of Object.values(DENIAL_LABELS_ES)) {
    assert.match(label, /[áéíóúñ¿]|sesión|sesion|usuario|historial|tarea|propietario/i);
    assert.equal(VENDOR_LEAK.test(label), false);
  }
});

test('audit ring caps and never stores a raw eventSeq field', () => {
  for (let i = 0; i < 80; i += 1) {
    recordDenialAudit({
      kind: 'circuit',
      code: 'E_TIMEOUT',
      label: `El circuito está abierto ${i}.`,
    });
  }
  const recent = recentDenialAudits();
  assert.ok(recent.length <= 64);
  assert.equal(recent.some((row) => /eventSeq=/.test(row.line)), false);
});

test('circuit + lease + receipt denials all land on the audit ring', () => {
  resetDenialAudits();
  const circuit = createToolFailureCircuit({ sessionThreshold: 1, toolThreshold: 20 });
  circuit.record('s-audit', 'web_search', { ok: false });
  presentCircuitDenial(circuit.authorize('s-audit', 'web_search'));
  heldResult({ jobId: 'lease-audit' });
  rejectedReceipt('empty_message', { channel: 'telegram' });
  const kinds = recentDenialAudits().map((row) => row.kind);
  assert.ok(kinds.includes('circuit'));
  assert.ok(kinds.includes('lease'));
  assert.ok(kinds.includes('receipt'));
  for (const row of recentDenialAudits()) {
    assert.match(row.line, /^\[DENEGACIÓN\]/);
    assert.equal(VENDOR_LEAK.test(row.line), false);
  }
});
