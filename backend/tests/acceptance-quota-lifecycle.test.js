'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const lifecycle = require('../src/services/ai/acceptance-quota-lifecycle');
const { generateStreamFailure } = require('../src/services/ai/generate-sse-close');
const normalizer = require('../src/services/direct-answer-normalizer');
const streamCache = require('../src/services/stream-cache');
const { waitForActiveTurn } = require('../src/services/chat-turn-idempotency');

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
const error = { acceptanceSpendGuard: true, code: 'E_QUOTA' };
const message = generateStreamFailure(error).message;
const prompt = 'Responde solo en español qué idioma es bonjour';
const quietLog = { info() {}, warn() {}, error() {}, warnError() {} };
const response = () => ({ chunks: [], writableEnded: false, destroyed: false,
  write(chunk) { this.chunks.push(String(chunk)); return true; }, end() { this.writableEnded = true; } });
const frames = (res) => res.chunks.filter((chunk) => chunk.startsWith('data: {')).map((chunk) => JSON.parse(chunk.slice(6)));
const doneCount = (res) => res.chunks.filter((chunk) => chunk === 'data: [DONE]\n\n').length;

// Load the two real, pure frontend modules so this SSE contract test tracks
// the same private discriminator and safe error construction as the browser.
function loadActualRecovery() {
  const modules = new Map();
  function load(name) {
    assert.ok(['pending-messages', 'recover-persisted-turn'].includes(name));
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    const source = fs.readFileSync(path.join(__dirname, '../../lib', `${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports,
      require: (request) => { assert.equal(request, './pending-messages'); return load('pending-messages'); } });
    return module.exports;
  }
  return load('recover-persisted-turn');
}

// Execute the ACTUAL save and post-generation branches with in-memory DB
// boundaries. No account, auth bypass, live database or provider is created.
function loadActualSave({ owner = true, createFailure = null, existing = null } = {}) {
  const writes = [];
  const users = [];
  const calls = { usage: 0, retries: 0, owner: 0 };
  const start = routeSource.indexOf('async function saveChatAndTrackUsage(');
  const end = routeSource.indexOf('\nconst streamControllers', start);
  assert.ok(start >= 0 && end > start);
  const save = vm.runInNewContext(`(${routeSource.slice(start, end).trim()})`, {
    acceptanceLifecycle: lifecycle, generatePersistenceLog: quietLog,
    buildGenerateTurnFingerprint: () => 'synthetic-fingerprint',
    withGenerateTurnSaveLock: async (_key, fn) => fn(),
    MESSAGE_IDEMPOTENCY_HASH_FIELD: 'idempotencyRequestHash',
    findExistingGenerateTurn: async () => existing,
    deriveChatTitleFromPrompt: () => 'Synthetic title',
    persistUserMessageOnce: async (_chat, _content, _files, metadata) => { users.push(metadata); return { id: 'user-row' }; },
    usageService: { calculateTextTokens: (text) => text.length,
      recordUsage: async () => { calls.usage += 1; } },
    setTimeout() { calls.retries += 1; },
    prisma: {
      chat: { findFirst: async ({ where }) => {
        assert.equal(where.id, 'synthetic-chat');
        assert.equal(where.userId, 'synthetic-owner');
        calls.owner += 1;
        return owner ? { id: 'synthetic-chat', title: 'Existing title' } : null;
      }, update: async () => {} },
      message: { create: async ({ data }) => {
        if (createFailure) throw createFailure;
        const row = { ...data, id: 'assistant-row' };
        writes.push(row);
        return row;
      } },
    },
  });
  return { save, writes, users, calls,
    persist: (content) => save('synthetic-owner', 'synthetic-chat', prompt, content, 0, 'muse-spark-1.3-contributor',
      [], [], false, { idempotencyKey: 'synthetic-turn', streamId: 'synthetic-stream' }, null, null, null, 0,
      { observabilityLog: quietLog, strictAcceptanceFailure: true }) };
}

function actualPostGeneration({ res, cacheHandle, save, includeFailureGuard = true }) {
  const afterStream = routeSource.indexOf('if (acceptanceLifecycle.getAcceptanceFailure(res)) {', routeSource.indexOf('const out = await aiService.generateStream('));
  const endGuard = routeSource.indexOf('\n        if (processedFiles.length > 0)', afterStream);
  const directAt = routeSource.indexOf('const normalizedDirectAnswer = directAnswerNormalizer.normalizeDirectAnswer', endGuard);
  const directStart = routeSource.lastIndexOf('        if (fullResponseContent) {', directAt);
  const directEnd = routeSource.indexOf('\n        // ─── Cognitive core', directAt);
  assert.ok(afterStream >= 0 && endGuard > afterStream && directStart > endGuard && directEnd > directStart);
  const code = `${includeFailureGuard ? routeSource.slice(afterStream, endGuard) : ''}
    ${routeSource.slice(directStart, directEnd)}
    cacheHandle.complete(); return fullResponseContent;`;
  return vm.runInNewContext(`(async () => { ${code} })()`, {
    acceptanceLifecycle: lifecycle, directAnswerNormalizer: normalizer,
    res, cacheHandle, fullResponseContent: lifecycle.getAcceptanceFailure(res)?.content || message,
    streamFailureMessage: null, userId: 'synthetic-owner', canPersist: true, chatId: 'synthetic-chat', prompt,
    actualModel: 'muse-spark-1.3-contributor', processedFiles: [], regenerate: false,
    idempotencyKey: 'synthetic-turn', streamId: 'synthetic-stream', generateIdempotencyRequestHash: 'synthetic-hash',
    MESSAGE_IDEMPOTENCY_HASH_FIELD: 'idempotencyRequestHash', req: { user: { plan: 'PRO' } },
    __reasoningSink: {}, generateLog: quietLog, saveChatAndTrackUsage: save,
  });
}

function activeTurn() {
  const turn = { settled: false };
  turn.promise = new Promise((resolve) => { turn.resolve = (value) => { turn.settled = true; resolve(value); }; });
  return turn;
}

test('actual normalizer regression: quota previously became frances + done; route now persists failed and returns before normalization', async (t) => {
  const before = await streamCache.start('synthetic-before-owner', 'synthetic-before-chat');
  const after = await streamCache.start('synthetic-owner', 'synthetic-chat');
  t.after(() => { before.forget(); after.forget(); });
  assert.equal(normalizer.normalizeDirectAnswer({ prompt, response: message }), 'frances');
  const unguarded = response();
  assert.equal(await actualPostGeneration({ res: unguarded, cacheHandle: before,
    save: () => assert.fail('old normalizer did not save failed state'), includeFailureGuard: false }), 'frances');
  assert.equal((await streamCache.resume('synthetic-before-owner', 'synthetic-before-chat')).status, 'done');

  const res = response();
  lifecycle.markAcceptanceFailure(res, error, message);
  after.append(message);
  const db = loadActualSave();
  await actualPostGeneration({ res, cacheHandle: after, save: db.save });
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].content, message);
  assert.equal(db.writes[0].metadata.status, 'failed');
  assert.equal(db.writes[0].metadata.errorCode, 'E_QUOTA');
  assert.equal(db.writes[0].metadata.acceptanceFailure.terminal, true);
  assert.equal(db.users[0].acceptanceFailure, undefined, 'USER metadata must not be marked failed');
  assert.equal(db.calls.owner, 1);
  assert.equal(db.calls.usage, 0);
  assert.equal(db.calls.retries, 0);
  assert.equal((await streamCache.resume('synthetic-owner', 'synthetic-chat')).status, 'error');
  assert.equal(frames(res).some((frame) => frame.replace), false);
  assert.equal(doneCount(res), 0);
});

test('partial is stored before terminal error, normal writer broadcasts one error/DONE, and failed singleflight replays as failure', async () => {
  const res = response();
  const subscriber = response();
  const baseWrite = res.write.bind(res);
  res.write = (frame) => { subscriber.write(frame); return baseWrite(frame); };
  res._siraRawWrite = () => assert.fail('terminal failure must use normal fanout writer');
  const content = `Borrador parcial.\n\n${message}`;
  lifecycle.markAcceptanceFailure(res, error, content);
  res.write(`data: ${JSON.stringify({ type: 'text_delta', content })}\n\n`);
  const db = loadActualSave();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = lifecycle.persistAcceptanceFailure({ res, persist: async (text) => { await gate; return db.persist(text); } });
  assert.equal(frames(res).some((frame) => frame.type === 'error'), false);
  assert.equal(doneCount(res), 0);
  release();
  await pending;
  const turn = activeTurn();
  const resume = { error: null, complete: false };
  const active = new Map([['synthetic-session', { subscribers: new Set([subscriber]) }]]);
  await lifecycle.finalizeAcceptanceFailure({ res, activeTurn: turn, resumeSession: { streamId: 'synthetic-session' },
    activeResumeStreams: active, streamResume: {
      fail: async (_id, code) => { assert.equal(db.writes.length, 1); resume.error = code; },
      complete: () => assert.fail('quota cannot complete resume'),
    } });
  assert.equal(resume.error, 'E_QUOTA');
  assert.equal(resume.complete, false);
  assert.equal(turn.failed, true);
  assert.equal(active.size, 0);
  assert.equal(doneCount(res), 1);
  assert.equal(doneCount(subscriber), 1);
  const terminal = frames(res).filter((frame) => frame.type === 'error');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].recovered, false);
  assert.equal(terminal[0].code, 'E_QUOTA');
  assert.equal(terminal[0].acceptanceFailure, true);
  // Run the real frontend error branch (not a second implementation) to
  // prove recovered:false delivers fail and cannot continue to completion.
  const apiSource = fs.readFileSync(path.join(__dirname, '../../lib/api.ts'), 'utf8');
  const apiStart = apiSource.indexOf('if (jsonData.recovered) {');
  const apiEnd = apiSource.indexOf('\n              }\n            } catch', apiStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart);
  let deliveredErrors = 0;
  let cancelledReaders = 0;
  const readerResult = await vm.runInNewContext(`(async () => { ${apiSource.slice(apiStart, apiEnd)}
    return 'incorrectly-completed'; })()`, {
    ...loadActualRecovery(),
    jsonData: terminal[0], flushBatch() {}, sanitizeStreamError: (text) => text,
    deliverStreamError(received) {
      assert.equal(received.message, message);
      assert.equal(received.acceptanceFailure, true);
      assert.equal(received.code, 'E_QUOTA');
      assert.equal(received.retryable, false);
      deliveredErrors += 1;
    },
    reader: { async cancel() { cancelledReaders += 1; } },
    console: { warn() { assert.fail('quota must not use recovered warning branch'); } },
  });
  assert.equal(readerResult, undefined);
  assert.equal(deliveredErrors, 1);
  assert.equal(cancelledReaders, 1);
  assert.equal(frames(res).filter((frame) => frame.content).map((frame) => frame.content).join(''), content);
  assert.equal(res.writableEnded, true);
  const replay = await waitForActiveTurn(turn);
  assert.equal(replay.outcome, 'replay');
  assert.equal(lifecycle.isFailedAcceptanceTurn(replay.turn), true);
  const next = response();
  assert.equal(lifecycle.replayAcceptanceFailure(next, replay.turn), true);
  assert.equal(frames(next).filter((frame) => frame.type === 'error')[0].recovered, false);
  assert.equal(frames(next).filter((frame) => frame.type === 'error')[0].acceptanceFailure, true);
  assert.equal(frames(next).some((frame) => frame.replace), false);
  assert.equal(doneCount(next), 1);
  lifecycle.writeAcceptanceFailureEnd(next);
  assert.equal(doneCount(next), 1, 'late finalizers cannot write a second DONE');
});

test('strict storage failure or owner mismatch never queues retry, advertises DONE, or replays success', async () => {
  for (const options of [{ owner: false }, { createFailure: new Error('synthetic DB unavailable') }]) {
    const db = loadActualSave(options);
    const res = response();
    lifecycle.markAcceptanceFailure(res, error, message);
    await assert.rejects(lifecycle.persistAcceptanceFailure({ res, persist: db.persist }));
    assert.equal(db.calls.retries, 0);
    assert.equal(db.calls.usage, 0);
    const turn = activeTurn();
    let resumeError;
    await lifecycle.finalizeAcceptanceFailure({ res, activeTurn: turn, resumeSession: { streamId: 'synthetic-session' },
      streamResume: { fail: async (_id, code) => { resumeError = code; } } });
    assert.equal(doneCount(res), 0);
    assert.equal(res.writableEnded, true);
    assert.equal(frames(res)[0].code, 'E_QUOTA');
    assert.equal(resumeError, 'E_QUOTA_PERSISTENCE_FAILED');
    const replay = await waitForActiveTurn(turn);
    const next = response();
    lifecycle.replayAcceptanceFailure(next, replay.turn);
    assert.equal(doneCount(next), 0);
    const resumed = response();
    assert.equal(lifecycle.replayAcceptanceResumeFailure(resumed, resumeError), true);
    assert.equal(doneCount(resumed), 0);
    assert.equal(frames(resumed)[0].message, message);
  }
});

test('actual private route finalizer returns before post-filters and success finalizers', async () => {
  const start = routeSource.indexOf('if (acceptanceLifecycle.getAcceptanceFailure(res)) {', routeSource.indexOf('// Private terminal failure path.'));
  const end = routeSource.indexOf('\n      keepAlive = stopGenerateSseHeartbeat(keepAlive);', start + 1);
  assert.ok(start >= 0 && end > start);
  const res = response();
  lifecycle.markAcceptanceFailure(res, error, message);
  await lifecycle.persistAcceptanceFailure({ res, persist: loadActualSave().persist });
  const controller = {};
  const controllers = new Map([['synthetic-controller', controller]]);
  let released = 0;
  const turn = activeTurn();
  turn.key = 'synthetic-turn';
  await vm.runInNewContext(`(async () => { ${routeSource.slice(start, end)}
    throw new Error('fell through to ordinary post-filter/success finalizer'); })()`, {
    acceptanceLifecycle: lifecycle, res, streamCompleted: false, streamFailureMessage: null,
    keepAlive: null, stopGenerateSseHeartbeat: () => null, __firstByteWatchdog: null, resumeLeaseHeartbeat: null,
    req: { _activeGenerateTurn: turn }, resumeSession: null, streamResume: {}, activeResumeStreams: new Map(),
    __fairQueueRelease: () => { released += 1; }, __ownsStreamController: true,
    __streamControllerKey: 'synthetic-controller', streamControllers: controllers, controller,
    activeGenerateTurns: new Map([[turn.key, turn]]), clearInterval, setTimeout,
    endGenerateSse: (writer) => writer.end(),
  });
  assert.equal(released, 1);
  assert.equal(controllers.size, 0);
  assert.equal(turn.failed, true);
  assert.equal(doneCount(res), 1);
});

test('history and durable resume failure wiring prevents completed replay and protects failed owner on disconnect', () => {
  const replayStart = routeSource.indexOf('function streamDuplicateTurnReplay(');
  const replayEnd = routeSource.indexOf('\nfunction respondGenerateTurnError', replayStart);
  const replaySource = routeSource.slice(replayStart, replayEnd);
  assert.ok(replaySource.indexOf('replayAcceptanceFailure') < replaySource.indexOf("type: 'duplicate_turn_replay'"));
  assert.match(routeSource, /success: !acceptanceLifecycle\.isFailedAcceptanceTurn\(duplicateTurn\)/);
  assert.match(routeSource, /replayAcceptanceResumeFailure\(res, record\.error\)/);
  const closeStart = routeSource.indexOf("res.on('close', () => {");
  const closeEnd = routeSource.indexOf('let __lastClientAt', closeStart);
  const closeSource = routeSource.slice(closeStart, closeEnd);
  assert.equal((closeSource.match(/if \(!acceptanceLifecycle.getAcceptanceFailure\(res\)\)/g) || []).length, 2);
  const resumed = response();
  assert.equal(lifecycle.replayAcceptanceResumeFailure(resumed, 'E_QUOTA'), true);
  assert.equal(doneCount(resumed), 1);
  assert.equal(frames(resumed)[0].code, 'E_QUOTA');
});

test('ordinary responses and malformed metadata never activate private failure handling', async () => {
  const res = response();
  assert.equal(lifecycle.markAcceptanceFailure(res, new Error('E_QUOTA')), null);
  assert.equal(lifecycle.getAcceptanceFailure(null), null);
  assert.equal(await lifecycle.persistAcceptanceFailure({ res }), false);
  assert.equal(await lifecycle.finalizeAcceptanceFailure({ res }), false);
  assert.equal(lifecycle.writeAcceptanceFailureEnd(res), false);
  assert.equal(lifecycle.replayAcceptanceFailure(res, { assistantMessage: { content: 'Normal reply' } }), false);
  assert.equal(lifecycle.replayAcceptanceResumeFailure(res, 'ordinary provider error'), false);
  assert.equal(lifecycle.isFailedAcceptanceTurn({ assistantMessage: { metadata: '{' } }), false);
  assert.equal(lifecycle.isFailedAcceptanceTurn({ assistantMessage: { metadata: JSON.stringify(lifecycle.acceptanceFailureMetadata()) } }), true);
  assert.equal(res.chunks.length, 0);
  assert.equal(res.writableEnded, false);
  lifecycle.markAcceptanceFailure(res, error, message);
  assert.equal(Object.keys(res).includes('_siraAcceptanceFailure'), false);
  assert.equal(lifecycle.markAcceptanceFailure(res, error, 'replacement'), lifecycle.getAcceptanceFailure(res));
  assert.equal(lifecycle.getAcceptanceFailure(res).content, message);
});

test('missing confirmation and broken cache/socket/resume cannot turn quota into success', async () => {
  const res = response();
  lifecycle.markAcceptanceFailure(res, error, message);
  const cacheHandle = { fail() { throw new Error('synthetic cache failed'); } };
  await assert.rejects(lifecycle.persistAcceptanceFailure({ res, cacheHandle,
    persist: async () => ({ assistantMessage: { id: 'row', metadata: {} } }) }));
  res.write = () => { throw new Error('synthetic socket failed'); };
  const active = new Map([['session', { subscribers: new Set([{ end() { throw new Error('synthetic subscriber failed'); } }]) }]]);
  await lifecycle.finalizeAcceptanceFailure({ res, resumeSession: { streamId: 'session' }, activeResumeStreams: active,
    streamResume: { fail: async () => { throw new Error('synthetic resume failed'); } } });
  assert.equal(doneCount(res), 0);
  assert.equal(active.size, 0);
  assert.equal(res.writableEnded, true);
});
