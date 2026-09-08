'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-completion.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const comp = require('../src/services/agent-runner/engine-completion');

test('3H28-A-001 capToolStorm keeps max and marks overflow', () => {
  const calls = Array.from({ length: 20 }, (_, i) => ({ mapped: 'read_file', call: { function: { name: 'read_file' } }, i }));
  const out = comp.capToolStorm(calls, { max: 8 });
  assert.equal(out.keep.length, 8);
  assert.equal(out.overflow.length, 12);
  assert.equal(out.dropped, 12);
  assert.equal(out.code, 'tool_storm');
});

test('3H28-A-002 capToolStorm under max is a no-op', () => {
  const out = comp.capToolStorm([{ a: 1 }, { a: 2 }], { max: 8 });
  assert.equal(out.dropped, 0);
  assert.equal(out.code, null);
});

test('3H28-A-003 runToolStorm completes leftover as errors', async () => {
  const jobs = Array.from({ length: 12 }, (_, i) => ({ mapped: 'read_file', i }));
  const seen = [];
  const out = await comp.runToolStorm(jobs, async (p) => {
    seen.push(p.i);
    return { prepared: p, result: 'ok', f7Image: null };
  }, { maxParallel: 4, maxBatch: 8 });
  assert.equal(seen.length, 8);
  assert.equal(out.executed.length, 12);
  assert.equal(out.dropped, 4);
  assert.equal(out.executed.filter((e) => e.code === 'tool_storm').length, 4);
  assert.equal(out.code, 'tool_storm');
});

test('3H28-A-004 runToolStorm isolates a throw', async () => {
  const jobs = [{ mapped: 'a' }, { mapped: 'b' }];
  const out = await comp.runToolStorm(jobs, async (p) => {
    if (p.mapped === 'a') throw new Error('boom');
    return { prepared: p, result: 'ok' };
  }, { maxParallel: 2, maxBatch: 8 });
  assert.equal(out.executed[0].code, 'tool_isolated');
  assert.equal(out.executed[1].result, 'ok');
});

test('3H28-B-001 normalizePartialToolCall name/input shape', () => {
  const n = comp.normalizePartialToolCall({ name: 'read_file', input: { path: 'a.js' } }, 1, 0);
  assert.equal(n.function.name, 'read_file');
  assert.equal(n.__args.path, 'a.js');
  assert.equal(n.__parse_error, false);
});

test('3H28-B-002 normalizePartialToolCall streaming delta', () => {
  const n = comp.normalizePartialToolCall({
    delta: { function: { name: 'write_file', arguments: '{"path":"x"}' } },
  }, 2, 1);
  assert.equal(n.function.name, 'write_file');
  assert.equal(n.__partial, true);
});

test('3H28-B-003 repairReactFence trailing comma', () => {
  const out = comp.repairReactFence('{"name":"read_file","arguments":{"path":"a.js",}}');
  assert.equal(out.ok, true);
  assert.equal(out.value.name, 'read_file');
});

test('3H28-B-004 decodeGatewayFrame repairs truncated JSON', () => {
  const out = comp.decodeGatewayFrame('{"type":"req","id":"1","method":"status"');
  assert.equal(out.ok, true);
  assert.equal(out.frame.type, 'req');
  assert.equal(out.repaired, true);
});

test('3H28-C-001 waitDagReady blocks unmet deps', () => {
  const out = comp.waitDagReady([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
  ], []);
  assert.deepEqual(out.ready, ['a']);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.code, 'dag_wait');
});

test('3H28-C-002 waitDagReady dag_blocked when nothing ready', () => {
  const out = comp.waitDagReady([{ id: 'b', dependsOn: ['a'] }], []);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'dag_blocked');
});

test('3H28-C-003 pickReadyNode pops a ready node', () => {
  const remaining = [
    { id: 'b', dependsOn: ['a'] },
    { id: 'a', dependsOn: [] },
  ];
  const out = comp.pickReadyNode(remaining, []);
  assert.equal(out.ok, true);
  assert.equal(out.node.id, 'a');
  assert.equal(out.remaining.length, 1);
  assert.equal(out.remaining[0].id, 'b');
});

test('3H28-D-001 compactPreservingPairs keeps assistant/tool together', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1 ' + 'x'.repeat(8000) },
    { role: 'assistant', content: 'call', tool_calls: [{ id: 'c1', function: { name: 'read_file' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result1 ' + 'y'.repeat(100) },
    { role: 'assistant', content: 'done' },
  ];
  const out = comp.compactPreservingPairs(messages, { maxTokens: 200 });
  assert.equal(out.compressed, true);
  const asst = out.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  if (asst) {
    const idx = out.messages.indexOf(asst);
    assert.equal(out.messages[idx + 1].role, 'tool');
    assert.equal(out.messages[idx + 1].tool_call_id, 'c1');
  }
  assert.equal(out.code, 'compact_fidelity');
});

test('3H28-D-002 compact under budget is a no-op', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const out = comp.compactPreservingPairs(messages, { maxTokens: 4000 });
  assert.equal(out.compressed, false);
  assert.equal(out.code, null);
});

test('3H28-E-001 rollbackN pops then restores previous', () => {
  const ck = comp.createNDeepCheckpoint({ max: 8 });
  const msgs = [{ role: 'user', content: 'a' }];
  ck.save({ iteration: 1, messages: [{ role: 'user', content: 'one' }] });
  ck.save({ iteration: 2, messages: [{ role: 'user', content: 'two' }] });
  ck.save({ iteration: 3, messages: [{ role: 'user', content: 'three' }] });
  assert.equal(ck.depth(), 3);
  const restored = ck.restoreN(msgs, 1);
  assert.equal(restored.messages[0].content, 'two');
  assert.equal(msgs[0].content, 'two');
  assert.equal(ck.depth(), 2);
});

test('3H28-E-002 rollbackN 3-deep', () => {
  const ck = comp.createNDeepCheckpoint({ max: 8 });
  ck.save({ iteration: 1, messages: [{ role: 'user', content: 'one' }] });
  ck.save({ iteration: 2, messages: [{ role: 'user', content: 'two' }] });
  ck.save({ iteration: 3, messages: [{ role: 'user', content: 'three' }] });
  ck.save({ iteration: 4, messages: [{ role: 'user', content: 'four' }] });
  const msgs = [];
  ck.restoreN(msgs, 3);
  assert.equal(msgs[0].content, 'one');
});

test('3H28-F-001 git dirty refuse', () => {
  const out = comp.assertGitCleanForWrite({
    relPath: 'a.js',
    gitStatus: () => ({ dirty: true }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'git_apply_dirty');
});

test('3H28-F-002 git clean skipped without status fn', () => {
  const out = comp.assertGitCleanForWrite({ relPath: 'a.js' });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
});

test('3H28-G-001 sseDropUnderLoad drops when backpressured at high water', () => {
  const out = comp.sseDropUnderLoad({ pending: 80, highWater: 64, backpressured: true });
  assert.equal(out.drop, true);
  assert.equal(out.code, 'sse_backpressure');
});

test('3H28-G-002 sseDropUnderLoad emits when healthy', () => {
  const out = comp.sseDropUnderLoad({ pending: 2, backpressured: false });
  assert.equal(out.emit, true);
  assert.equal(out.drop, false);
});

test('3H28-H-001 stampMonotonicSeq reorders global seq', () => {
  const out = comp.stampMonotonicSeq(3, 999);
  assert.equal(out.seq, 4);
  assert.equal(out.reordered, true);
  assert.equal(out.code, 'event_order');
});

test('3H28-H-002 stampMonotonicSeq keeps in-order', () => {
  const out = comp.stampMonotonicSeq(3, 4);
  assert.equal(out.seq, 4);
  assert.equal(out.reordered, false);
});

test('3H28-H-003 nextSessionSeq is per session', () => {
  comp.resetSessionSeq();
  assert.equal(comp.nextSessionSeq('sA'), 1);
  assert.equal(comp.nextSessionSeq('sB'), 1);
  assert.equal(comp.nextSessionSeq('sA'), 2);
});

test('3H28-I-001 concurrent turn p50/p95', () => {
  comp.resetConcurrentTurns();
  const a = comp.beginConcurrentTurn();
  const b = comp.beginConcurrentTurn();
  comp.endConcurrentTurn(20, a);
  comp.endConcurrentTurn(40, b);
  const snap = comp.snapshotConcurrentTurns();
  assert.equal(snap.count, 2);
  assert.equal(snap.p50, 20);
  assert.ok(snap.p95 >= 20);
  assert.ok(snap.buckets['1'] || snap.buckets['2']);
});

test('3H28-J-001 completionSnapshot flags', () => {
  const s = comp.completionSnapshot();
  assert.equal(s.toolStormCap, true);
  assert.equal(s.dagWait, true);
  assert.equal(s.compactFidelity, true);
  assert.equal(s.rollbackNDeep, true);
  assert.equal(s.gitDirtyWriters, true);
  assert.equal(s.sseDropUnderLoad, true);
  assert.equal(s.eventOrderMonotonic, true);
  assert.equal(s.concurrentTurnLatency, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H28-K-001 live loop wires storm + restoreN + compact fidelity', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /engine-completion/);
  assert.match(src, /capToolStorm/);
  assert.match(src, /runToolStorm/);
  assert.match(src, /compactPreservingPairs/);
  assert.match(src, /restoreN/);
  assert.match(src, /beginConcurrentTurn/);
  assert.match(src, /normalizePartialToolCall/);
});

test('3H28-K-002 live tools refuse dirty on more writers', () => {
  const src = read('src/services/agent-runner/tools.js');
  assert.match(src, /assertGitCleanForWrite/);
  const n = (src.match(/assertGitCleanForWrite/g) || []).length;
  assert.ok(n >= 3, 'write_file + str_replace + edit_file');
});

test('3H28-K-003 planner/orchestrator wait DAG', () => {
  const planner = read('src/services/agent-runner/orchestrator/planner.js');
  const orch = read('src/services/agent-runner/orchestrator/index.js');
  assert.match(planner, /pickReadyNode/);
  assert.match(orch, /pickReadyNode|dag_blocked/);
});

test('3H28-K-004 event-log monotonic + protocol session seq', () => {
  const log = read('src/services/agent-gateway/event-log.js');
  const proto = read('src/services/agent-gateway/protocol.js');
  assert.match(log, /stampMonotonicSeq/);
  assert.match(proto, /nextSessionSeq/);
  assert.match(proto, /decodeGatewayFrame/);
});

test('3H28-K-005 sse writer drop under load', () => {
  const src = read('src/utils/sse-writer.js');
  assert.match(src, /sseDropUnderLoad/);
});

test('3H28-K-006 health exposes completion flags', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /engine-completion/);
  assert.match(src, /completionSnapshot/);
});

test('3H28-K-007 error codes include 3H28', () => {
  const codes = require('../src/services/error_codes');
  assert.equal(codes.CODES.TOOL_STORM, 'tool_storm');
  assert.equal(codes.CODES.DAG_BLOCKED, 'dag_blocked');
  assert.equal(codes.CODES.COMPACT_FIDELITY, 'compact_fidelity');
  assert.equal(codes.CODES.EVENT_ORDER, 'event_order');
  assert.equal(codes.CODES.CONCURRENT_TURN, 'concurrent_turn');
});

test('3H28-K-008 classifyLoopError maps 3H28 codes', () => {
  const { classifyLoopError } = require('../src/services/agent-runner/engine-reliability');
  assert.equal(classifyLoopError({ code: 'tool_storm' }).code, 'tool_storm');
  assert.equal(classifyLoopError({ code: 'dag_blocked' }).code, 'dag_blocked');
  assert.equal(classifyLoopError({ code: 'compact_fidelity' }).code, 'compact_fidelity');
  assert.equal(classifyLoopError({ code: 'event_order' }).code, 'event_order');
  assert.equal(classifyLoopError({ code: 'concurrent_turn' }).code, 'concurrent_turn');
});

test('3H28-K-009 public stream error has 3H28 ES messages', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.match(src, /tool_storm/);
  assert.match(src, /dag_blocked/);
  assert.match(src, /compact_fidelity/);
  assert.match(src, /event_order/);
});

test('3H28-K-010 no OpenRouter generate lock broken', () => {
  const src = read('src/services/agent-runner/engine-completion.js');
  assert.match(src, /openrouterGenerate: false/);
  assert.doesNotMatch(src, /openrouter\.ai/);
});

test('3H28-K-011 tool-scheduler caps parallel batch', () => {
  const src = read('src/services/codex/tool-scheduler.js');
  assert.match(src, /maxParallel/);
});

test('3H28-K-012 react fence uses repairReactFence', () => {
  const src = read('src/services/agent-runner/react.js');
  assert.match(src, /repairReactFence/);
});
