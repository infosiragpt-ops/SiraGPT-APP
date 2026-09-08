'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('../src/services/cron-as-turn');
const { createSessionDlq } = require('../src/services/agent-gateway/session-dlq');

let sequence = 0;
function job(overrides = {}) {
  return { id: `cron-dispatch-${++sequence}`, userId: 'synthetic-owner', prompt: 'Synthetic local dispatch', ...overrides };
}

function deferred({ observeRejection = true } = {}) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The pre-fix implementation ignores asynchronous startAgent rejections.
  // Keep that regression observable without an unhandled-rejection crash.
  if (observeRejection) promise.catch(() => {});
  return { promise, resolve, reject };
}

test('awaits asynchronous acceptance and preserves the accepted run id', async () => {
  const gate = deferred();
  let settled = false;
  const running = cron.dispatchCronJobAsAgentTurn({ startAgent: () => gate.promise }, job());
  running.then(() => { settled = true; });
  let result;
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.equal(cron.inflightSnapshot().size, 1);
  } finally {
    gate.resolve({ runId: 'synthetic-accepted-run' });
    result = await running;
  }
  assert.equal(result.ok, true);
  assert.equal(result.runId, 'synthetic-accepted-run');
  assert.equal(cron.inflightSnapshot().size, 0);
});

test('records an asynchronous dispatch rejection once in the real in-memory DLQ', async () => {
  const gate = deferred();
  const sessionDlq = createSessionDlq();
  let calls = 0;
  const running = cron.dispatchCronJobAsAgentTurn({
    startAgent() { calls++; return gate.promise; }, sessionDlq,
  }, job());
  gate.reject(Object.assign(new Error('synthetic failure'), { code: 'remote_unreachable' }));
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'remote_unreachable');
  assert.equal(result.deadLettered, true);
  assert.equal(calls, 1);
  assert.equal(sessionDlq.length, 1);
  assert.equal(sessionDlq.list()[0].userId, 'synthetic-owner');
});

for (const method of ['startAgent', 'run']) {
  test(`propagates ${method} explicit failed results without retry`, async () => {
    const sessionDlq = createSessionDlq();
    let calls = 0;
    const result = await cron.dispatchCronJobAsAgentTurn({
      async [method]() { calls++; return { ok: false, code: 'E_QUOTA', error: 'synthetic quota' }; },
      sessionDlq,
    }, job());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_QUOTA');
    assert.equal(result.deadLettered, true);
    assert.equal(sessionDlq.length, 1);
    assert.equal(calls, 1);
  });
}

test('missing dispatcher reports the real failure, not recursive overlap', async () => {
  const result = await cron.dispatchCronJobAsAgentTurn({}, job());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cron_dispatch_unavailable');
  assert.equal(result.deadLettered, false);
  assert.equal(cron.inflightSnapshot().size, 0);
});

for (const kind of ['absent', 'throws', 'false', 'rejects', 'rejected-result']) {
  test(`does not claim dead lettering when the sink ${kind}`, async () => {
    const gateway = {
      async run() { throw Object.assign(new Error('synthetic failure'), { code: 'synthetic_failure' }); },
    };
    if (kind === 'throws') gateway.pushDeadLetter = () => { throw new Error('synthetic sink failure'); };
    if (kind === 'false') gateway.pushDeadLetter = () => false;
    if (kind === 'rejects') gateway.pushDeadLetter = async () => { throw new Error('synthetic sink failure'); };
    if (kind === 'rejected-result') gateway.pushDeadLetter = () => ({ ok: false });
    const result = await cron.dispatchCronJobAsAgentTurn(gateway, job());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'synthetic_failure');
    assert.equal(result.deadLettered, false);
  });
}

test('overlap is scoped to owner, and a rejected duplicate cannot release the active claim', async () => {
  const a = deferred();
  const b = deferred();
  const sameId = job().id;
  const ownerA = job({ id: sameId, userId: 'owner-A' });
  const ownerB = job({ id: sameId, userId: 'owner-B' });
  let calls = 0;
  const runner = { run(args) { calls++; return args.userId === ownerA.userId ? a.promise : b.promise; } };
  const first = cron.dispatchCronJobAsAgentTurn(runner, ownerA);
  const second = cron.dispatchCronJobAsAgentTurn(runner, ownerB);
  try {
    const duplicate = await cron.dispatchCronJobAsAgentTurn(runner, ownerA);
    assert.equal(duplicate.error, 'overlap_skipped');
    assert.equal(calls, 2);
    assert.equal(cron.inflightSnapshot().size, 2);
    a.resolve({ ok: true });
    assert.equal((await first).ok, true);
    assert.equal(cron.inflightSnapshot().size, 1);
    const stillRunning = await cron.dispatchCronJobAsAgentTurn(runner, ownerB);
    assert.equal(stillRunning.error, 'overlap_skipped');
    assert.equal(calls, 2);
  } finally {
    a.resolve({ ok: true });
    b.resolve({ ok: true });
    await Promise.all([first, second]);
  }
  assert.equal(cron.inflightSnapshot().size, 0);
});

test('successful direct runner remains compatible and does not create a failure record', async () => {
  const sessionDlq = createSessionDlq();
  const result = await cron.dispatchCronJobAsAgentTurn({ async run() {}, sessionDlq }, job());
  assert.equal(result.ok, true);
  assert.equal(result.via, 'runner.run');
  assert.equal(sessionDlq.length, 0);
});

test('an unscoped or foreign finish request cannot release another owner pending dispatch', async () => {
  const gate = deferred();
  const task = job();
  const running = cron.dispatchCronJobAsAgentTurn({ run: () => gate.promise }, task);
  try {
    assert.deepEqual(cron.markCronTickFinished(task.id), { ok: false, code: 'user_required' });
    cron.markCronTickFinished(task.id, 'another-owner');
    const duplicate = await cron.dispatchCronJobAsAgentTurn({ async run() {} }, task);
    assert.equal(duplicate.error, 'overlap_skipped');
    assert.equal(cron.inflightSnapshot().size, 1);
  } finally {
    gate.resolve();
    await running;
  }
  assert.equal(cron.inflightSnapshot().size, 0);
});

for (const finish of ['never settles', 'rejects late', 'succeeds late']) {
  test(`dead-letter acknowledgment is bounded when the sink ${finish}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred({ observeRejection: false });
    let calls = 0;
    const running = cron.dispatchCronJobAsAgentTurn({
      async run() { return { ok: false, code: 'E_PROVIDER' }; },
      pushDeadLetter() { calls++; return gate.promise; },
    }, job());
    await new Promise(setImmediate);
    t.mock.timers.tick(cron.CRON_DEAD_LETTER_TIMEOUT_MS);
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PROVIDER');
    assert.equal(result.deadLettered, false);
    assert.equal(calls, 1);
    assert.equal(cron.inflightSnapshot().size, 0);
    if (finish === 'rejects late') gate.reject(new Error('synthetic late rejection'));
    if (finish === 'succeeds late') gate.resolve({ ok: true });
    await new Promise(setImmediate);
    assert.equal(result.deadLettered, false);
    assert.equal(calls, 1);
  });
}

test('failure payload objects and arbitrary messages never become public error codes', async () => {
  const sessionDlq = createSessionDlq();
  const first = await cron.dispatchCronJobAsAgentTurn({
    async run() { return { ok: false, error: { message: 'private synthetic details' } }; },
    sessionDlq,
  }, job());
  assert.equal(first.code, 'cron_dispatch_failed');
  const second = await cron.dispatchCronJobAsAgentTurn({
    async startAgent() { throw Object.assign(new Error('private synthetic details'), { code: 'private detail with spaces' }); },
    sessionDlq,
  }, job());
  assert.equal(second.code, 'cron_error');
  const syntheticToken = ['ghp', 'a'.repeat(36)].join('_');
  const third = await cron.dispatchCronJobAsAgentTurn({
    async run() { return { ok: false, code: syntheticToken }; }, sessionDlq,
  }, job());
  assert.equal(third.code, 'cron_dispatch_failed');
  const rendered = JSON.stringify([first, second, third, sessionDlq.list()]);
  assert.equal(rendered.includes(syntheticToken), false);
  assert.equal(rendered.includes('private'), false);
  assert.equal(rendered.includes('[object Object]'), false);
});

test('dispatch failure cancels its timer before waiting for dead-letter acknowledgment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dispatch = deferred();
  const sink = deferred();
  const aborts = [];
  const running = cron.dispatchCronJobAsAgentTurn({
    run: () => dispatch.promise,
    pushDeadLetter: () => sink.promise,
    abortSession: (...args) => aborts.push(args),
  }, job());
  t.mock.timers.tick(cron.cronTurnTimeoutMs() - 1);
  dispatch.reject(Object.assign(new Error('synthetic failure'), { code: 'E_PROVIDER' }));
  await new Promise(setImmediate);
  // Cross the original dispatch deadline while failure evidence is pending.
  t.mock.timers.tick(cron.CRON_DEAD_LETTER_TIMEOUT_MS);
  const result = await running;
  assert.equal(result.code, 'E_PROVIDER');
  assert.equal(result.deadLettered, false);
  assert.deepEqual(aborts, []);
  assert.equal(cron.inflightSnapshot().size, 0);
  sink.resolve({ ok: true });
  await new Promise(setImmediate);
  assert.deepEqual(aborts, []);
});

test('abortPrevious supplies the job owner to the gateway authorization boundary', async () => {
  const task = job({ abortPrevious: true, sessionKey: 'synthetic-existing-session' });
  const aborts = [];
  const result = await cron.dispatchCronJobAsAgentTurn({
    startAgent: () => ({ runId: 'synthetic-accepted-run' }),
    abortSession: (...args) => aborts.push(args),
  }, task);
  assert.equal(result.ok, true);
  assert.deepEqual(aborts, [[task.sessionKey, 'cron_overlap', task.userId]]);
});

test('dispatch timeout supplies the job owner and aborts only once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = job({ sessionKey: 'synthetic-timeout-session' });
  const gate = deferred();
  const aborts = [];
  const running = cron.dispatchCronJobAsAgentTurn({
    run: () => gate.promise,
    abortSession: (...args) => aborts.push(args),
  }, task);
  t.mock.timers.tick(cron.cronTurnTimeoutMs());
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cron_timeout');
  assert.equal(result.deadLettered, false);
  assert.deepEqual(aborts, [[task.sessionKey, 'cron_timeout', task.userId]]);
  gate.resolve({ ok: true });
  await new Promise(setImmediate);
  t.mock.timers.tick(cron.cronTurnTimeoutMs());
  assert.equal(aborts.length, 1);
  assert.equal(cron.inflightSnapshot().size, 0);
});
