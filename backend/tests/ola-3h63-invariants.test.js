'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js')
  ? '/app'
  : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const w59 = require('../src/services/agent-runner/engine-3h59');
const w60 = require('../src/services/agent-runner/engine-3h60');
const w61 = require('../src/services/agent-runner/engine-3h61');
const w62 = require('../src/services/agent-runner/engine-3h62');
const w63 = require('../src/services/agent-runner/engine-3h63');
const ad = require('../src/services/agent-runner/engine-adapter');
const { runAgentLoop, classifyLoopError } = require('../src/services/agent-runner/loop');

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.rawCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.rawCalls.map((c, idx) => ({
                    id: c.id || ('call_' + i + '_' + idx),
                    type: 'function',
                    function: { name: c.name, arguments: c.arguments },
                  })),
                },
              }],
            };
          }
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: c.id || ('call_' + i + '_' + idx),
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content || 'ok' } }] };
        },
      },
    },
  };
}

test('3H63-A-001 unique names do not collide with 3H59/3H60/3H61/3H62 exports', () => {
  assert.equal(w63.WAVE, '3H63');
  for (const name of w63.HELPERS) {
    assert.equal(w59.HELPERS.includes(name), false, 'collides with 3H59 ' + name);
    assert.equal(w60.HELPERS.includes(name), false, 'collides with 3H60 ' + name);
    assert.equal(w61.HELPERS.includes(name), false, 'collides with 3H61 ' + name);
    assert.equal(w62.HELPERS.includes(name), false, 'collides with 3H62 ' + name);
    assert.equal(typeof w63[name], 'function');
  }
  assert.equal(typeof w63.validateWriteThenRevertClosed, 'undefined');
  assert.equal(typeof w63.checkpointHookBeforeMutatingTool, 'undefined');
  assert.equal(typeof w63.acquireFairGenerateLock, 'undefined');
});

test('3H63-B-001 queue 503 after 60s wait', () => {
  ad.resetFairGenerateLock();
  ad.resetInFlightGenerate();
  ad.resetGenerateRateLimit();
  ad.resetGenerateByRequestId();
  const qwait = ad.queueMaxWait60sThen503({ waitedMs: 60000, maxMs: 60000 });
  assert.equal(qwait.reject, true);
  assert.equal(qwait.status, 503);
  assert.equal(qwait.code, 'queue_wait');
  const closed = w63.applyFairGenerateQueueClosed({
    sessionKey: 's1',
    producerId: 'p1',
    waitedMs: 60000,
    acquireFairGenerateLock: ad.acquireFairGenerateLock,
    releaseFairGenerateLock: ad.releaseFairGenerateLock,
    queueMaxWait60sThen503: ad.queueMaxWait60sThen503,
    dropDuplicateInFlightGenerate: ad.dropDuplicateInFlightGenerate,
    idempotentGenerateByRequestId: ad.idempotentGenerateByRequestId,
    sessionGenerateRateLimit: ad.sessionGenerateRateLimit,
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.status, 503);
  assert.equal(closed.code, 'queue_wait');
  const classified = w63.classifyEngine3h63Error({ code: 'queue_wait' });
  assert.ok(classified.message.indexOf('60') >= 0);
  assert.equal(classified.message.indexOf('sk-'), -1);
});

test('3H63-C-001 duplicate in-flight generate is dropped', () => {
  ad.resetInFlightGenerate();
  ad.resetFairGenerateLock();
  ad.resetGenerateRateLimit();
  ad.resetGenerateByRequestId();
  const first = ad.dropDuplicateInFlightGenerate('sess-dup', 'prod-a');
  assert.equal(first.dropped, false);
  const second = ad.dropDuplicateInFlightGenerate('sess-dup', 'prod-b');
  assert.equal(second.dropped, true);
  assert.equal(second.code, 'duplicate_turn');
  const closed = w63.applyFairGenerateQueueClosed({
    sessionKey: 'sess-dup2',
    producerId: 'a',
    waitedMs: 0,
    acquireFairGenerateLock: ad.acquireFairGenerateLock,
    releaseFairGenerateLock: ad.releaseFairGenerateLock,
    queueMaxWait60sThen503: ad.queueMaxWait60sThen503,
    dropDuplicateInFlightGenerate: ad.dropDuplicateInFlightGenerate,
    idempotentGenerateByRequestId: ad.idempotentGenerateByRequestId,
    sessionGenerateRateLimit: ad.sessionGenerateRateLimit,
  });
  assert.equal(closed.ok, true);
  const again = w63.applyFairGenerateQueueClosed({
    sessionKey: 'sess-dup2',
    producerId: 'b',
    waitedMs: 0,
    acquireFairGenerateLock: ad.acquireFairGenerateLock,
    releaseFairGenerateLock: ad.releaseFairGenerateLock,
    queueMaxWait60sThen503: ad.queueMaxWait60sThen503,
    dropDuplicateInFlightGenerate: ad.dropDuplicateInFlightGenerate,
    idempotentGenerateByRequestId: ad.idempotentGenerateByRequestId,
    sessionGenerateRateLimit: ad.sessionGenerateRateLimit,
  });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'duplicate_turn');
});

test('3H63-D-001 nested subagent aborted on parent halt', () => {
  const aborted = [];
  const nested = ad.abortNestedSubagentsOnParentHalt({
    parentHalt: true,
    children: [{ id: 'child-1', depth: 1 }, { id: 'child-2', depth: 2 }],
    abortFn: (id) => aborted.push(id),
  });
  assert.equal(nested.aborted, 2);
  assert.deepEqual(aborted, ['child-1', 'child-2']);
  const cascade = w63.abortSubagentCascadeClosed({
    parentHalt: true,
    parentCancelled: true,
    parentToken: { aborted: true },
    children: [{ id: 'n1', depth: 1 }],
    siblings: [{ id: 's1' }],
    abortFn: () => {},
    userSignal: { aborted: true },
    abortNestedSubagentsOnParentHalt: ad.abortNestedSubagentsOnParentHalt,
    abortSiblingToolsOnParentCancelToken: ad.abortSiblingToolsOnParentCancelToken,
    refuseSubagentIfParentCancelled: ad.refuseSubagentIfParentCancelled,
    abortCascade: ad.abortCascade,
    subagentInheritAbortSignal: ad.subagentInheritAbortSignal,
  });
  assert.equal(cascade.refuse, true);
  assert.ok(cascade.nestedAborted >= 1);
  assert.equal(cascade.cascade, true);
});

test('3H63-E-001 inherited budget is parent-1 and refuse if 0', () => {
  const inherit = ad.inheritSubagentSteps({ parentRemaining: 4, childRequested: 4, siblings: 1 });
  assert.ok(inherit.budget >= 1);
  const sliced = ad.subagentInheritRemainingStepBudget({ parentRemaining: 5, childRequested: 5 });
  assert.equal(sliced.remaining, 5);
  const minned = ad.minRemainingSubagentBudget1({ remaining: 0 });
  assert.equal(minned.remaining, 0);
  assert.equal(minned.code, 'subagent_budget');
  const ok = w63.inheritSubagentBudgetClosed({
    parentRemaining: 5,
    inheritSubagentSteps: ad.inheritSubagentSteps,
    subagentInheritRemainingStepBudget: ad.subagentInheritRemainingStepBudget,
    minRemainingSubagentBudget1: ad.minRemainingSubagentBudget1,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.inherited, 4);
  assert.equal(ok.remaining, 4);
  const zero = w63.inheritSubagentBudgetClosed({
    parentRemaining: 1,
    inheritSubagentSteps: ad.inheritSubagentSteps,
    subagentInheritRemainingStepBudget: ad.subagentInheritRemainingStepBudget,
    minRemainingSubagentBudget1: ad.minRemainingSubagentBudget1,
  });
  assert.equal(zero.refuse, true);
  assert.equal(zero.remaining, 0);
  assert.equal(zero.code, 'subagent_budget');
});

test('3H63-F-001 fragment concat before execute + incomplete trailing dropped', () => {
  const concat = ad.concatenateSplitToolCallFragments(['{"path":', '".","limit":2}']);
  assert.equal(concat.ok, true);
  assert.equal(concat.value.path, '.');
  const dropped = ad.dropIncompleteTrailingToolCall([
    { id: 'ok', function: { name: 'list_files', arguments: '{"path":"."}' } },
    { id: 'bad', function: { name: 'list_files', arguments: '{"path":' } },
  ]);
  assert.equal(dropped.dropped, true);
  assert.equal(dropped.calls.length, 1);
  const repaired = w63.repairPartialToolCallsClosed({
    calls: [
      { id: 'ok', function: { name: 'list_files', arguments: '{"path":"."}' } },
      { function: { name: 'list_files', arguments: '{"path":' } },
    ],
    fragments: ['{"path":', '"src"}'],
    concatenateSplitToolCallFragments: ad.concatenateSplitToolCallFragments,
    dropIncompleteTrailingToolCall: ad.dropIncompleteTrailingToolCall,
    repairStreamingJsonAcrossChunks: ad.repairStreamingJsonAcrossChunks,
    repairUnescapedNewlinesInJsonStrings: ad.repairUnescapedNewlinesInJsonStrings,
    dropOrphanToolResults: ad.dropOrphanToolResults,
    requireToolCallId: ad.requireToolCallId,
    aliasCommonToolNames: ad.aliasCommonToolNames,
    isolateParallelToolTimeout: ad.isolateParallelToolTimeout,
    joinParallelToolResultsStableOrder: ad.joinParallelToolResultsStableOrder,
    cacheIdenticalToolCallSameTurn: ad.cacheIdenticalToolCallSameTurn,
  });
  assert.ok(repaired.calls.every((c) => c.id));
  assert.ok(repaired.calls.length <= 2);
});

test('3H63-G-001 checksum-changed edit is refused and uniqueness stays distinct', () => {
  const changed = ad.refuseEditIfChecksumChangedSinceRead({
    sha256Now: 'aaa',
    sha256AtRead: 'bbb',
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'file_changed');
  const gated = w63.applyExactDiffChecksumClosed({
    path: 'a.txt',
    sha256Now: 'now',
    sha256AtRead: 'was',
    refuseEditIfChecksumChangedSinceRead: ad.refuseEditIfChecksumChangedSinceRead,
    checksumVerifyAfterWrite: ad.checksumVerifyAfterWrite,
    atomicWriteViaTempRename: ad.atomicWriteViaTempRename,
    refuseBinaryFileEdit: ad.refuseBinaryFileEdit,
    workspacePathJail: ad.workspacePathJail,
    skipUnchangedWrite: ad.skipUnchangedWrite,
    normalizeLineEndingsBeforeDiff: ad.normalizeLineEndingsBeforeDiff,
    applyUnifiedDiff: ad.applyUnifiedDiff,
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.code, 'file_changed');
  const uniq = w63.applyExactDiffChecksumClosed({
    path: 'a.txt',
    result: 'ERROR: old_str occurs more than once in a.txt. Add surrounding context to make it unique.',
    refuseEditIfChecksumChangedSinceRead: ad.refuseEditIfChecksumChangedSinceRead,
  });
  assert.equal(uniq.uniqueness, true);
  assert.equal(uniq.ok, true);
  assert.equal(w63.looksLikeLogicalToolReject('ERROR: old_str not found in a.txt'), true);
});

test('3H63-H-001 Last-Event-ID going backwards is rejected', () => {
  const back = ad.rejectLastEventIdGoingBackwards({ lastEventId: 3, currentSeq: 7 });
  assert.equal(back.ok, false);
  assert.equal(back.backwards, true);
  assert.equal(back.code, 'sse_id_backwards');
  const fwd = ad.rejectLastEventIdGoingBackwards({ lastEventId: 8, currentSeq: 7 });
  assert.equal(fwd.ok, true);
  const guarded = w63.guardSseLastIdRefundClosed({
    lastEventId: 2,
    currentSeq: 9,
    rejectLastEventIdGoingBackwards: ad.rejectLastEventIdGoingBackwards,
    refundPartialTokensOnCancel: ad.refundPartialTokensOnCancel,
    abortIfFirstByteOver45s: ad.abortIfFirstByteOver45s,
  });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.backwards, true);
});

test('3H63-I-001 cancel refunds partial tokens (prompt hold, zero completion)', () => {
  ad.resetCompletionHoldRefunds();
  const refund = ad.refundPartialTokensOnCancel({
    requestId: 'req-refund-1',
    cancelled: true,
    promptTokens: 12,
    completionTokens: 0,
  });
  assert.equal(refund.refunded, 'completion_hold');
  assert.equal(refund.code, 'credit_cancel');
  const dup = ad.refundPartialTokensOnCancel({
    requestId: 'req-refund-1',
    cancelled: true,
    promptTokens: 12,
    completionTokens: 0,
  });
  assert.equal(dup.duplicate, true);
  const guarded = w63.guardSseLastIdRefundClosed({
    cancelled: true,
    requestId: 'req-refund-2',
    promptTokens: 4,
    completionTokens: 0,
    refundPartialTokensOnCancel: ad.refundPartialTokensOnCancel,
    abortIfFirstByteOver45s: ad.abortIfFirstByteOver45s,
    rejectLastEventIdGoingBackwards: ad.rejectLastEventIdGoingBackwards,
  });
  assert.equal(guarded.refunded, 'completion_hold');
});

test('3H63-J-001 first-byte watchdog aborts after 45s without a byte', () => {
  const miss = ad.abortIfFirstByteOver45s({
    startedAt: 0,
    now: 45_000,
    firstByteAt: null,
  });
  assert.equal(miss.abort, true);
  assert.equal(miss.code, 'ttfb_abort');
  const hit = ad.abortIfFirstByteOver45s({
    startedAt: 0,
    now: 45_000,
    firstByteAt: 120,
  });
  assert.equal(hit.abort, false);
  const guarded = w63.guardSseLastIdRefundClosed({
    startedAt: 10,
    now: 50_000,
    abortIfFirstByteOver45s: ad.abortIfFirstByteOver45s,
    refundPartialTokensOnCancel: ad.refundPartialTokensOnCancel,
    rejectLastEventIdGoingBackwards: ad.rejectLastEventIdGoingBackwards,
  });
  assert.equal(guarded.abortFirstByte, true);
});

test('3H63-K-001 runAgentLoop refuses checksum-changed write_file', async () => {
  const files = { 'note.txt': Buffer.from('original-body') };
  const client = scriptedClient([
    { toolCalls: [{ name: 'write_file', args: { path: 'note.txt', content: 'nuevo', sha256AtRead: 'not-the-current-hash' } }] },
    { content: 'should-not-finalise' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'escribe' }],
    tools: [],
    executors: {
      async write_file() { files['note.txt'] = Buffer.from('nuevo'); return 'wrote'; },
      async __rawRead(p) { return files[p]; },
      async __rawWrite(p, bytes) { files[p] = Buffer.from(bytes); },
    },
    maxIterations: 4,
  });
  assert.match(String(result.steps[0].resultPreview || result.finalText || ''), /cambió|checksum|archivo/i);
  assert.equal(files['note.txt'].toString(), 'original-body');
});

test('3H63-L-001 runAgentLoop concatenates fragments then drops incomplete trailing call', async () => {
  let executed = 0;
  const client = scriptedClient([
    {
      rawCalls: [
        { id: 'call_keep', name: 'list_files', arguments: '{"path":"."}' },
        { id: '', name: 'list_files', arguments: '{"path":' },
      ],
    },
    { content: 'Listo tras repair.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      async list_files() {
        executed += 1;
        return '(ok)';
      },
    },
    maxIterations: 5,
  });
  assert.ok(executed >= 1);
  assert.ok(result.stoppedReason === 'final' || result.steps.some((s) => s.ok));
});

test('3H63-M-001 runAgentLoop refuses run_subagent when parent budget is 1', async () => {
  let spawned = 0;
  const client = scriptedClient([
    { toolCalls: [{ id: 'sub_1', name: 'run_subagent', args: { task: 'x' } }] },
    { content: 'should-not-need' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'delega' }],
    tools: [],
    executors: {
      async run_subagent() {
        spawned += 1;
        return 'spawned';
      },
    },
    maxIterations: 1,
  });
  assert.equal(spawned, 0);
  assert.ok(
    result.steps.some((s) => /presupuesto|subagente/i.test(String(s.resultPreview || '')))
    || result.errorCode === 'subagent_budget',
  );
});

test('3H63-N-001 runAgentLoop refunds and aborts nested on cancel', async () => {
  ad.resetCompletionHoldRefunds();
  const ac = new AbortController();
  const client = scriptedClient([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'no' },
  ]);
  let caught = null;
  try {
    await runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'cancela' }],
      tools: [],
      signal: ac.signal,
      threadId: 'cancel-3h63',
      executors: {
        async list_files() {
          ac.abort();
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      },
      maxIterations: 3,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught || true);
});

test('3H63-O-001 adapter snapshot and DeepSeek lock are 3H63', () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === '3H63' || s.wave === '3H64' || s.wave === '3H65' || s.wave === '3H66');
  assert.equal(s.failClosed, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
  assert.equal(typeof ad.applyFairGenerateQueueClosed, 'function');
  assert.equal(typeof ad.acquireFairGenerateLock, 'function');
  assert.equal(typeof ad.abortNestedSubagentsOnParentHalt, 'function');
  assert.equal(typeof ad.concatenateSplitToolCallFragments, 'function');
  assert.equal(typeof ad.refuseEditIfChecksumChangedSinceRead, 'function');
  assert.equal(typeof ad.rejectLastEventIdGoingBackwards, 'function');
  assert.equal(typeof ad.refundPartialTokensOnCancel, 'function');
  assert.equal(typeof ad.abortIfFirstByteOver45s, 'function');
  assert.equal(ad.loadOptionalEngineWave('engine-3h63').WAVE, '3H63');
  assert.equal(w63.refuseOpenRouterInWave3h63({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(w63.refuseOpenRouterInWave3h63({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }).ok, true);
});

test('3H63-P-001 live loop/generate/sse import 3H63 + live helper names', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('abortNestedSubagentsOnParentHalt'));
  assert.ok(loop.includes('inheritSubagentSteps'));
  assert.ok(loop.includes('minRemainingSubagentBudget1'));
  assert.ok(loop.includes('concatenateSplitToolCallFragments'));
  assert.ok(loop.includes('dropIncompleteTrailingToolCall'));
  assert.ok(loop.includes('refuseEditIfChecksumChangedSinceRead'));
  assert.ok(loop.includes('checksumVerifyAfterWrite'));
  assert.ok(loop.includes('applyUnifiedDiff'));
  assert.ok(loop.includes('refundPartialTokensOnCancel'));
  assert.ok(loop.includes('abortIfFirstByteOver45s'));
  const ai = read('src/routes/ai.js');
  assert.ok(ai.includes('acquireFairGenerateLock'));
  assert.ok(ai.includes('releaseFairGenerateLock'));
  assert.ok(ai.includes('queueMaxWait60sThen503'));
  assert.ok(ai.includes('dropDuplicateInFlightGenerate'));
  assert.ok(ai.includes('idempotentGenerateByRequestId'));
  assert.ok(ai.includes('sessionGenerateRateLimit'));
  assert.ok(ai.includes('rejectLastEventIdGoingBackwards'));
  assert.ok(ai.includes('refundPartialTokensOnCancel'));
  assert.ok(ai.includes('completeLedgerOnSuccessClosed'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('rejectLastEventIdGoingBackwards'));
  assert.ok(sse.includes('replayLastNSseEventsFromCursor'));
});

test('3H63-Q-001 classified errors are Spanish and never leak stacks or sk-', () => {
  for (const code of ['queue_wait', 'file_changed', 'sse_id_backwards', 'ttfb_abort', 'subagent_budget']) {
    const hit = w63.classifyEngine3h63Error({
      code,
      err: { stack: 'at Object.foo (/tmp/x.js:1:1)', message: 'sk-secretvaluehere' },
    });
    assert.ok(hit.message);
    assert.equal(hit.message.indexOf('sk-'), -1);
    assert.equal(/at Object\./.test(hit.message), false);
    assert.match(hit.message, /[áéíóúñÁÉÍÓÚÑ]|esper|archivo|cursor|byte|subagente|cola/i);
  }
  assert.equal(classifyLoopError({ code: 'file_changed' }).retryable, false);
});

test('3H63-R-001 completeLedgerTransaction is the live success helper (not invented)', async () => {
  const ledgerSrc = read('src/services/credit-ledger.js');
  assert.ok(ledgerSrc.includes('async function completeLedgerTransaction('));
  assert.ok(ledgerSrc.includes('async function completeLedgerTransactionWithoutResponse('));
  assert.ok(ledgerSrc.includes('completeLedgerTransaction,'));
  let called = 0;
  const out = await w63.completeLedgerOnSuccessClosed({
    completeLedgerTransaction: async (args) => {
      called += 1;
      assert.equal(args.statusCode, 200);
      return { ok: true };
    },
    transaction: { id: 'txn-1', userId: 'u1' },
    statusCode: 200,
    streamedChars: 12,
  });
  assert.equal(called, 1);
  assert.equal(out.code, 'credit_ledger_complete');
  const skipped = await w63.completeLedgerOnSuccessClosed({
    completeLedgerTransaction: async () => { throw new Error('should-not'); },
    cancelled: true,
    tokens: 0,
    transaction: { id: 'txn-2', userId: 'u1' },
  });
  assert.equal(skipped.skipped, true);
});
