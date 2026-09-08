'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const vm = require('vm');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const rel = require('../src/services/agent-runner/engine-reliability');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient, createMockExecutors } = require('../src/services/agent-runner/evals/scripted-llm');

test('3H16-BE-001 repairToolArgs trailing comma / single quotes / truncated', () => {
  const a = rel.repairToolArgs('{"path":"a.js",}');
  assert.equal(a.ok, true);
  assert.equal(a.repaired, true);
  assert.equal(a.value.path, 'a.js');
  const b = rel.repairToolArgs("{'code':'print(1)'}");
  assert.equal(b.ok, true);
  assert.equal(b.value.code, 'print(1)');
  const c = rel.repairToolArgs('{"x":1');
  assert.equal(c.ok, true);
  assert.equal(c.value.x, 1);
  const d = rel.repairToolArgs('{"ok":true}');
  assert.equal(d.ok, true);
  assert.equal(d.repaired, false);
});

test('3H16-BE-002 normalizeToolCalls drops unknown, repairs, dedupes', () => {
  const calls = rel.normalizeToolCalls([
    { function: { name: 'read_file', arguments: '{"path":"a",}' } },
    { name: 'read_file', arguments: { path: 'a' } },
    { function: { arguments: '{}' } },
    null,
  ], 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(JSON.parse(calls[0].function.arguments).path, 'a');
  assert.equal(calls[0].__repaired, true);
});

test('3H16-BE-003/004 transient LLM error + backoff', () => {
  assert.equal(rel.isTransientLlmError({ status: 503 }), true);
  assert.equal(rel.isTransientLlmError({ status: 429 }), true);
  assert.equal(rel.isTransientLlmError({ message: 'ECONNRESET' }), true);
  assert.equal(rel.isTransientLlmError({ status: 402 }), false);
  assert.equal(rel.isTransientLlmError({ name: 'AbortError' }), false);
  assert.equal(rel.backoffMs(0, { jitter: false }), 200);
  assert.equal(rel.backoffMs(1, { jitter: false }), 400);
  assert.equal(rel.backoffMs(10, { jitter: false }), 4000);
});

test('3H16-BE-005 RepeatGuard cuts infinite same tool+args', () => {
  const g = rel.createRepeatGuard({ limit: 3 });
  assert.equal(g.see('read_file', { path: 'a' }).cut, false);
  assert.equal(g.see('read_file', { path: 'a' }).cut, false);
  const third = g.see('read_file', { path: 'a' });
  assert.equal(third.cut, true);
  assert.equal(third.count, 3);
  assert.equal(g.see('read_file', { path: 'b' }).cut, false);
});

test('3H16-BE-006 StepBudget distinct from iteration cap', () => {
  const b = rel.createStepBudget({ maxSteps: 2 });
  assert.equal(b.consume(1), false);
  assert.equal(b.used(), 1);
  assert.equal(b.exceeded(), false);
  b.consume(1);
  assert.equal(b.exceeded(), true);
  assert.equal(b.remaining(), 0);
});

test('3H16-BE-007/008 compact + pin critical facts', () => {
  const turns = [];
  for (let i = 0; i < 20; i += 1) {
    turns.push({ role: i % 2 ? 'assistant' : 'user', content: `turn-${i}-${'x'.repeat(800)}` });
  }
  const compact = rel.compactMessagesIfNeeded(turns, { targetMaxTokens: 200 });
  assert.equal(compact.compressed, true);
  assert.ok(compact.messages.length < turns.length);
  const pinned = rel.pinCriticalFacts([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }], ['user=Luis', 'model=deepseek-v4-flash']);
  assert.ok(pinned.some((m) => /PINNED FACTS/.test(String(m.content || ''))));
  assert.ok(pinned.some((m) => /user=Luis/.test(String(m.content || ''))));
});

test('3H16-BE-009 checkpoint save + rollback', () => {
  const ck = rel.createCheckpoint();
  const id = ck.save({ iteration: 1, messages: [{ role: 'user', content: 'a' }], steps: [] });
  assert.ok(id);
  assert.equal(ck.size(), 1);
  const rolled = ck.rollback();
  assert.equal(rolled.messages[0].content, 'a');
  assert.equal(ck.pop().id, id);
  assert.equal(ck.size(), 0);
});

test('3H16-BE-010/011 usage accumulator + latency observe', () => {
  const u = rel.createUsageAccumulator();
  u.add({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
  u.add({ usage: { prompt_tokens: 2, completion_tokens: 3 } });
  assert.deepEqual(u.snapshot(), { promptTokens: 12, completionTokens: 8, totalTokens: 20 });
  rel.observeFirstToken(40);
  rel.observeTurnEnd(90);
  const snap = rel.engineLatencySnapshot();
  assert.ok(snap.firstTokenMs);
  assert.ok(snap.turnEndMs);
  assert.equal(typeof snap.firstTokenMs.count, 'number');
});

test('3H16-BE-012 classifyLoopError actionable not raw trace', () => {
  assert.equal(rel.classifyLoopError({ name: 'AbortError' }).code, 'aborted');
  assert.equal(rel.classifyLoopError({ status: 402 }).code, 'credits_exhausted');
  assert.equal(rel.classifyLoopError({ code: 'loop_cut' }).code, 'loop_cut');
  assert.equal(rel.classifyLoopError({ code: 'budget_exceeded' }).code, 'budget_exceeded');
  assert.equal(rel.classifyLoopError({ status: 503, message: 'service unavailable' }).code, 'provider_unavailable');
  assert.equal(rel.classifyLoopError(new Error('ECONNRESET boom at /opt/siragpt')).message.includes('/opt/siragpt'), false);
});

test('3H16-BE-013 callModel retries transient then succeeds (scripted)', async () => {
  let n = 0;
  const client = {
    chat: {
      completions: {
        async create() {
          n += 1;
          if (n < 3) {
            const err = new Error('ECONNRESET');
            err.status = 503;
            throw err;
          }
          return { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } };
        },
      },
    },
  };
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    executors: {},
    maxIterations: 2,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.finalText, 'ok');
  assert.equal(n, 3);
  assert.equal(out.usage.totalTokens, 6);
  assert.ok(out.firstTokenMs != null);
  assert.ok(out.canResume === true || out.canResume === false);
});

test('3H16-BE-014/015 repair invalid JSON args inside live loop', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'c1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"notes.md",}' },
                }],
              },
            }],
          };
        },
      },
    },
  };
  let second = false;
  const origCreate = client.chat.completions.create;
  client.chat.completions.create = async (payload) => {
    if (!second) {
      second = true;
      return origCreate(payload);
    }
    return { choices: [{ message: { role: 'assistant', content: 'leído' } }] };
  };
  const log = [];
  const executors = {
    async read_file(args) {
      log.push(args);
      return 'OK: notes';
    },
  };
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lee' }],
    tools: [],
    executors,
    maxIterations: 4,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(log.length, 1);
  assert.equal(log[0].path, 'notes.md');
  assert.equal(log[0].__parse_error, undefined);
});

test('3H16-BE-016 infinite loop cut on repeated tool', async () => {
  const client = createScriptedClient([
    { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { content: 'no debería llegar' },
  ]);
  const events = [];
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lee' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 8,
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.stoppedReason, 'loop_cut');
  assert.ok(events.some((e) => e.type === 'loop_cut'));
  assert.match(out.finalText, /repitió|bucle/i);
});

test('3H16-BE-017 long tool-chain completes without human (scripted)', async () => {
  const client = createScriptedClient([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.py', content: 'x=1' } }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'print(1)' } }] },
    { toolCalls: [{ name: 'render_preview', args: { path: 'a.py' } }] },
    { content: 'Listo' },
  ]);
  const toolLog = [];
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hazlo' }],
    tools: [],
    executors: createMockExecutors({ toolLog }),
    maxIterations: 8,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.finalText, 'Listo');
  assert.deepEqual(toolLog.map((t) => t.tool), ['write_file', 'execute_python', 'render_preview']);
  assert.ok(out.iterations >= 4);
});

test('3H16-BE-018 mid-stream cancel attaches usage (no leaked throw without accounting)', async () => {
  const ac = new AbortController();
  let calls = 0;
  const client = {
    chat: {
      completions: {
        async create() {
          calls += 1;
          if (calls === 1) {
            return {
              choices: [{
                message: {
                  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_python', arguments: '{"code":"1"}' } }],
                },
              }],
              usage: { prompt_tokens: 7, completion_tokens: 1 },
            };
          }
          return { choices: [{ message: { content: 'nope' } }] };
        },
      },
    },
  };
  const executors = {
    async execute_python() {
      ac.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
  await assert.rejects(
    () => runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      executors,
      signal: ac.signal,
      maxIterations: 4,
    }),
    (err) => {
      assert.equal(err.name, 'AbortError');
      assert.ok(err.usage);
      assert.equal(err.usage.promptTokens, 7);
      return true;
    },
  );
});

test('3H16-BE-019 syntaxValidate json/js compile-only', () => {
  assert.equal(rel.syntaxValidate('a.json', '{"a":1}').ok, true);
  assert.throws(() => rel.syntaxValidate('a.json', '{bad'));
  assert.equal(rel.syntaxValidate('a.js', 'const x = 1;').ok, true);
  assert.throws(() => rel.syntaxValidate('a.js', 'const x = ;'));
  assert.equal(rel.syntaxValidate('a.md', '# hi').kind, 'skip');
});

test('3H16-BE-020 session-manager unique patch + snapshot + destroyExpired', async () => {
  const sm = require('../src/services/sandbox/session-manager');
  const sess = await sm.createSession({ userId: 'u-3h16' });
  const sessionId = sess.sessionId || sess.id;
  assert.ok(sessionId);
  const w = sm.writeFile(sessionId, 'n.js', 'const a = 1;\nconst a = 1;\n');
  assert.equal(w.ok, true);
  const dup = sm.patchFile(sessionId, 'n.js', 'const a = 1;', 'const b = 2;');
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'old_text_not_unique');
  sm.writeFile(sessionId, 'once.js', 'hello world');
  const one = sm.patchFile(sessionId, 'once.js', 'hello', 'hola');
  assert.equal(one.ok, true);
  assert.equal(one.replacements, 1);
  const snap = sm.snapshot();
  assert.ok(snap.sessions >= 1);
  assert.equal(typeof snap.ttlMs, 'number');
  assert.equal(typeof sm.destroyExpired, 'function');
  assert.equal(sm.destroySession(sessionId), true);
  assert.equal(sm.destroySession(sessionId), false);
});

test('3H16-BE-021 event-log per-session seq + Last-Event-ID replay', () => {
  const { createEventLog } = require('../src/services/agent-gateway/event-log');
  const log = createEventLog();
  log.remember('s1', { type: 'a' });
  log.remember('s2', { type: 'b' });
  log.remember('s1', { type: 'c' });
  assert.equal(log.lastSeq('s1'), 2);
  assert.equal(log.lastSeq('s2'), 1);
  const replay = log.replayFrom('s1', 1);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].type, 'c');
  assert.equal(replay[0].seq, 2);
});

test('3H16-BE-022 gateway queue fifo snapshot + concurrency enqueue', async () => {
  const { createSessionQueue } = require('../src/services/agent-gateway/queue');
  const q = createSessionQueue();
  const order = [];
  const p1 = q.enqueue('k', async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
  const p2 = q.enqueue('k', async () => { order.push(2); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
  const snap = q.snapshot();
  assert.equal(snap.order, 'fifo');
  assert.equal(snap.maxPending, 8);
});

test('3H16-BE-023 error taxonomy leftovers loop_cut/tool_args/budget', () => {
  const { CODES, isRetryable, httpStatusFor } = require('../src/services/error_codes');
  assert.equal(CODES.LOOP_CUT, 'loop_cut');
  assert.equal(CODES.TOOL_ARGS_INVALID, 'tool_args_invalid');
  assert.equal(CODES.BUDGET_EXCEEDED, 'budget_exceeded');
  assert.equal(CODES.SYNTAX_INVALID, 'syntax_invalid');
  assert.equal(isRetryable(CODES.CHECKPOINT_ROLLBACK), true);
  assert.equal(isRetryable(CODES.LOOP_CUT), false);
});

test('3H16-BE-024 public-stream-error classifies engine codes', () => {
  const { classifyPublicStreamError, sanitizePublicStoppedReason } = require('../src/services/observability/public-stream-error');
  assert.equal(classifyPublicStreamError({ code: 'loop_cut' }).code, 'loop_cut');
  assert.equal(classifyPublicStreamError({ code: 'budget_exceeded' }).code, 'budget_exceeded');
  assert.equal(classifyPublicStreamError({ code: 'tool_args_invalid' }).code, 'tool_args_invalid');
  assert.equal(sanitizePublicStoppedReason('loop_cut'), 'limit_reached');
  assert.equal(sanitizePublicStoppedReason('budget_exceeded'), 'limit_reached');
});

test('3H16-BE-025 react parseJsonish uses repairToolArgs', () => {
  const { parseReact } = require('../src/services/agent-runner/react');
  const calls = parseReact('Action: read_file\nAction Input: {"path":"x.md",}\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].args.path, 'x.md');
});

test('3H16-BE-026 health checkEngineLoop exported', () => {
  const hc = require('../src/services/observability/health-check');
  assert.equal(typeof hc.checkEngineLoop, 'function');
  const c = hc.checkEngineLoop();
  assert.equal(c.name, 'engine_loop');
  assert.ok(c.status === 'healthy' || c.status === 'skipped');
  assert.equal(c.critical, false);
  assert.equal(c.details.repair, true);
});

test('3H16-BE-027 tools.js markers read-after-write / revert / onChunk', () => {
  const src = read('src/services/agent-runner/tools.js');
  assert.match(src, /read-after-write mismatch/);
  assert.match(src, /syntax_invalid after edit_file, reverted/);
  assert.match(src, /ctx\.onChunk/);
});

test('3H16-BE-028 loop.js wires compact/loop_cut/usage-on-abort', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /compactMessagesIfNeeded/);
  assert.match(src, /stoppedReason: 'loop_cut'/);
  assert.match(src, /err\.usage = usage\.snapshot\(\)/);
  assert.match(src, /isTransientLlmError/);
  assert.match(src, /classifyLoopError/);
  assert.match(src, /createCheckpoint/);
});

test('3H16-BE-029 failing task recovery: unknown tool does not kill loop', async () => {
  const client = createScriptedClient([
    { toolCalls: [{ name: 'not_a_tool', args: {} }] },
    { content: 'recuperado' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'x' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 4,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.equal(out.finalText, 'recuperado');
  assert.equal(out.steps[0].ok, false);
});

test('3H16-BE-030 session resume checkpointId on successful tool turn', async () => {
  const client = createScriptedClient([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'ok' },
  ]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'ls' }],
    tools: [],
    executors: createMockExecutors(),
    maxIterations: 4,
  });
  assert.equal(out.stoppedReason, 'final');
  assert.ok(out.checkpointId);
  assert.equal(out.canResume, true);
});
