'use strict';

// Execute the production route's compaction block and completion adapter with
// the real planner/progress collector. Database and model I/O are isolated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const conversationCompactor = require('../src/services/conversation-compactor');
const contextWindow = require('../src/services/context-window');
const turnProgressLib = require('../src/services/turn-progress');
const adTtfb = require('../src/services/agent-runner/engine-adapter');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
const adapterStart = source.indexOf('function buildCompactionCompletion(runtime, req) {');
const adapterEnd = source.indexOf('// One-shot boot-time provider-key audit.', adapterStart);
const blockStart = source.indexOf('      if (!req._githubConnectionTurn && canPersist && !req._miniShortChitchat && historyMessages.length > 0) {');
const blockEnd = source.indexOf('      // Anthropic models via OpenRouter require', blockStart);
assert.ok(adapterStart > 0 && adapterEnd > adapterStart && blockStart > 0 && blockEnd > blockStart);
const run = new vm.Script(`${source.slice(adapterStart, adapterEnd)}\n(async () => {
${source.slice(blockStart, blockEnd)}
return { historyMessages, __chatContextState, req, systemInstruction, systemBlocks, __ttfbClockStartedAt, __contextCompactionStartedAt };
})()`);

const watchdogStart = source.indexOf('__firstByteWatchdog = setInterval(function () {') + '__firstByteWatchdog = setInterval('.length;
const watchdogEnd = source.indexOf('}, 5000);', watchdogStart) + 1;
const watchdog = new vm.Script(`(${source.slice(watchdogStart, watchdogEnd)})()`);

function fixture(t, { connectionTurn = false, shortHistory = false, clock = { now: 130000 }, dbFailure = false, delayWrite = false } = {}) {
  const rows = Array.from({ length: shortHistory ? 2 : 20 }, (_, i) => ({
    id: `message-${i}`, role: i % 2 ? 'ASSISTANT' : 'USER',
    content: `${i % 2 ? 'Resultado' : 'Pregunta'} ${i}: ${'datos '.repeat(260)}`,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, i)), files: null,
  }));
  const controller = new AbortController();
  const events = [], writes = [], providerCalls = [], transactions = [];
  let enterWrite, releaseWrite;
  const writing = new Promise(resolve => { enterWrite = resolve; });
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const progress = turnProgressLib.createTurnProgress({ emitStage: (label, fields) => events.push({ label, ...fields }), protocol: 2, env: {} });
  t.after(() => progress.dispose());
  const context = vm.createContext({
    conversationCompactor, contextWindow, turnProgressLib,
    historyMessages: rows, __chatContextState: null,
    __ttfbClockStartedAt: 100000, __contextCompactionStartedAt: null,
    Date: class extends Date { static now() { return clock.now; } },
    adTtfb, controller, __ttfbLimitMs: undefined, __firstByteAt: null, __ttfbAbortedAt: null, __firstByteWatchdog: null, clearInterval() {},
    req: { _githubConnectionTurn: connectionTurn }, canPersist: true,
    actualModel: 'deepseek-chat', actualProvider: 'DeepSeek',
    systemInstruction: { content: shortHistory ? 'Reglas.' : 'base '.repeat(48000) },
    systemBlocks: [], prompt: 'Continúa con el informe.', processedFiles: [], actualMaxOutputTokens: 1000,
    chatId: `context-lifecycle-${t.name}`, userId: null, signal: controller.signal,
    turnProgress: progress, generateLog: { info() {}, warn() {}, warnError() {} },
    prisma: { $transaction: async (operation, options) => {
      const transaction = { options, committed: false, rolledBack: false };
      transactions.push(transaction);
      const staged = [];
      try {
        const result = await operation({ chat: { update: async ({ data }) => {
          enterWrite();
          if (delayWrite) await writeGate;
          if (dbFailure) throw new Error('fixture persistence failed');
          staged.push(data);
          return data;
        } } });
        writes.push(...staged);
        transaction.committed = true;
        return result;
      } catch (error) {
        transaction.rolledBack = true;
        throw error;
      }
    } },
    createProviderClientForRequest: (provider, req, { model }) => ({ client: { chat: { completions: {
      create: async (params, options) => {
        providerCalls.push({ provider, model, params, signal: options.signal });
        const value = await Promise.race([completion, new Promise((_, reject) => {
          const abort = () => { const error = new Error('Stopped'); error.name = 'AbortError'; reject(error); };
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        })]);
        return { choices: [{ message: { content: value } }] };
      },
    } } } }),
  });
  return { rows, controller, events, writes, providerCalls, transactions, writing, releaseWrite, release, clock, tick: () => watchdog.runInContext(context), start: () => run.runInContext(context) };
}
const summary = '## Objetivo del usuario\nContinuar el informe de los documentos analizados.\n## Pendientes\nRevisar las conclusiones.';

test('preemptive compaction announces actual work, commits once, and resumes the same history tail', async t => {
  const f = fixture(t);
  const pending = f.start();
  assert.equal(f.events[0]?.label, 'Compactando contexto…');
  assert.equal(f.events[0]?.tool, 'compact');
  assert.equal(f.events[0]?.status, 'running');
  assert.equal(f.writes.length, 0, 'announcement precedes summary persistence');
  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].model, 'deepseek-chat');
  assert.equal(f.providerCalls[0].provider, 'DeepSeek');
  f.release(summary);
  const result = await pending;
  assert.equal(result.req._contextCompactionPlan.reason, 'preemptive');
  assert.equal(f.writes.length, 1);
  assert.ok(result.historyMessages.length > 0 && result.historyMessages.length < f.rows.length);
  assert.equal(result.historyMessages[0].role, 'USER');
  assert.equal(result.historyMessages.at(-1).id, f.rows.at(-1).id);
  assert.equal(f.events.at(-1).status, 'done');
  assert.equal(f.events.at(-1).stageId, f.events[0].stageId);
  assert.match(f.events.at(-1).label, /Contexto compactado/);
  assert.equal(result.systemBlocks.at(-1).kind, 'context-summary');
});

test('Stop aborts the summarizer and leaves the previous history intact', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const pending = f.start();
  assert.equal(f.providerCalls.length, 1);
  f.controller.abort();
  const result = await pending;
  assert.equal(f.providerCalls[0].signal.aborted, true);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(result.historyMessages, f.rows);
  assert.equal(result.systemBlocks.length, 0);
  assert.equal(f.events.at(-1).status, 'error');
  assert.equal(f.events.at(-1).label, 'Compactación cancelada');
});

for (const options of [{ shortHistory: true }, { connectionTurn: true }]) {
  test(`no false compaction notice for ${options.shortHistory ? 'a short conversation' : 'an account connection turn'}`, async t => {
    const f = fixture(t, options);
    const result = await f.start();
    assert.equal(f.events.length, 0);
    assert.equal(f.providerCalls.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(result.historyMessages.length, f.rows.length);
  });
}

for (const outcome of ['success', 'failure', 'stop']) {
  test(`compaction excludes only its elapsed time from the answer watchdog on ${outcome}`, async t => {
    const f = fixture(t, { dbFailure: outcome === 'failure' });
    const pending = f.start();
    f.clock.now += 20000;
    f.tick();
    assert.equal(f.controller.signal.aborted, false, 'the answer clock is paused during real compaction');
    if (outcome === 'stop') f.controller.abort();
    else f.release(summary);
    const result = await pending;
    assert.equal(result.__contextCompactionStartedAt, null, 'the pause clears on every outcome');
    assert.equal(result.__ttfbClockStartedAt, 120000, 'only the 20 seconds spent compacting are excluded');
    if (outcome !== 'stop') {
      f.tick();
      assert.equal(f.controller.signal.aborted, false, 'the original 30 seconds of preparation still count');
      f.clock.now += 16000;
      f.tick();
      assert.equal(f.controller.signal.aborted, true, 'the answer watchdog still enforces the original 45-second limit');
    }
  });
}


test('Stop during persistence rolls back before ending the notice and releases the watchdog pause', { timeout: 1000 }, async t => {
  const f = fixture(t, { delayWrite: true });
  const pending = f.start();
  f.release(summary);
  await f.writing;
  f.clock.now += 1000;
  f.controller.abort();
  const result = await pending;
  assert.equal(f.transactions[0].rolledBack, true);
  assert.equal(f.transactions[0].committed, false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(result.historyMessages, f.rows);
  assert.equal(result.req._contextCompaction, undefined);
  assert.equal(result.systemBlocks.length, 0);
  assert.equal(result.__contextCompactionStartedAt, null);
  assert.equal(result.__ttfbClockStartedAt, 101000);
  assert.equal(f.events.at(-1).label, 'Compactación cancelada');
  assert.equal(f.events.some(event => event.status === 'done'), false);
  // Resolving an already cancelled update cannot commit the transaction or
  // emit a success notice after the user's Stop.
  f.releaseWrite();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 0);
  assert.equal(f.events.at(-1).status, 'error');
});
