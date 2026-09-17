'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/codex/agent-loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const codexEngine = require('../src/services/agent-runner/engine-codex');
const engineControl = require('../src/services/agent-runner/engine-control');
const engineAdvance = require('../src/services/agent-runner/engine-advance');

test('3H25-A-001 live agent-loop imports engine-control and engine-codex', () => {
  const src = read('src/services/codex/agent-loop.js');
  assert.match(src, /engine-control/);
  assert.match(src, /engine-codex/);
  assert.match(src, /engine-advance/);
  assert.match(src, /evaluateStopConditions|codexControl\.evaluate/);
  const loop = require('../src/services/codex/agent-loop');
  assert.equal(loop.engineLive, true);
});

test('3H25-A-002 repairCodexToolCall coerces types', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, startLine: { type: 'integer' } },
    required: ['path'],
    additionalProperties: false,
  };
  const out = codexEngine.repairCodexToolCall({
    name: 'read_file',
    args: { path: 'src/App.tsx', startLine: '12' },
    schema,
  });
  assert.equal(out.ok, true);
  assert.equal(out.args.startLine, 12);
  assert.equal(out.repaired, true);
});

test('3H25-A-003 repairCodexToolCall unknown tool fail-closed', () => {
  const out = codexEngine.repairCodexToolCall({
    name: 'drop_database',
    args: {},
    schema: { type: 'object' },
    registryNames: new Set(['read_file', 'write_file']),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'unknown_tool');
});

test('3H25-A-004 alias bash to run_command when registry has it', () => {
  const out = codexEngine.mapCodexToolAlias('bash', {
    registryNames: new Set(['run_command', 'read_file']),
  });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'run_command');
  assert.equal(out.aliased, true);
});

test('3H25-A-005 alias does not remap known registry names', () => {
  const out = codexEngine.mapCodexToolAlias('edit_file', {
    registryNames: new Set(['edit_file', 'apply_patch']),
  });
  assert.equal(out.name, 'edit_file');
  assert.equal(out.aliased, false);
});

test('3H25-B-001 evaluate stop on token budget', () => {
  const ctl = codexEngine.createCodexLoopControl({ maxSteps: 8, tokenBudget: 100 });
  ctl.observeUsage({ tokensIn: 80, tokensOut: 30 });
  const stop = ctl.evaluate({ iteration: 1 });
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, 'token_budget');
});

test('3H25-B-002 evaluate stop on max iterations', () => {
  const ctl = codexEngine.createCodexLoopControl({ maxSteps: 2, tokenBudget: 999999 });
  const stop = ctl.evaluate({ iteration: 3 });
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, 'max_iterations');
});

test('3H25-B-003 evaluate does not stop under budget', () => {
  const ctl = codexEngine.createCodexLoopControl({ maxSteps: 8, tokenBudget: 10_000 });
  ctl.observeUsage({ tokensIn: 10, tokensOut: 10 });
  const stop = ctl.evaluate({ iteration: 1 });
  assert.equal(stop.stop, false);
});

test('3H25-B-004 firstByte records once', () => {
  const ctl = codexEngine.createCodexLoopControl({ maxSteps: 4, tokenBudget: 999999 });
  assert.equal(ctl.markFirstByte(12), 12);
  assert.equal(ctl.markFirstByte(99), 12);
  assert.equal(ctl.firstByteMs(), 12);
});

test('3H25-B-005 step telemetry records tool_call', () => {
  const ctl = codexEngine.createCodexLoopControl({ maxSteps: 4, tokenBudget: 999999 });
  ctl.recordStep({ stepIndex: 1, type: 'tool_call', toolName: 'read_file', status: 'completed', durationMs: 5 });
  const snap = ctl.snapshotSteps();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].toolName, 'read_file');
});

test('3H25-C-001 sleep compact skips under threshold', () => {
  const messages = [{ role: 'user', content: 'hola' }];
  const out = codexEngine.sleepCompactCodexMessages(messages, { thresholdTokens: 8000 });
  assert.equal(out.compacted, false);
  assert.equal(out.skipped, true);
});

test('3H25-C-002 sleep compact persists without extra user turn', () => {
  const saved = [];
  const messages = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: 'user', content: 'pedido importante numero ' + i + ' ' + 'x'.repeat(80) });
    messages.push({ role: 'assistant', content: 'decidí guardar el entregable app.tsx ' + 'y'.repeat(80) });
  }
  const out = codexEngine.sleepCompactCodexMessages(messages, {
    persistMemory: (ep) => saved.push(ep),
    userId: 'u1',
    chatId: 'code-1',
    thresholdTokens: 200,
  });
  assert.equal(out.compacted, true);
  assert.equal(out.persisted, 1);
  assert.equal(saved[0].source, 'sleep_compact');
});

test('3H25-C-003 capCodexToolObservation truncates long string', () => {
  const out = codexEngine.capCodexToolObservation('z'.repeat(50_000), 1000);
  assert.ok(typeof out === 'string');
  assert.ok(out.length < 50_000);
});

test('3H25-D-001 catalog injection for CRM on /code', () => {
  const out = codexEngine.injectCatalogIntoCodexSystem('sys', {
    query: 'arma un CRM para leads',
    surface: 'code',
  });
  assert.equal(typeof out.system, 'string');
  if (out.injected) {
    assert.match(out.system, /AGENTE DE CATALOGO/);
    assert.equal(out.matched.id, 'crm-builder');
  }
});

test('3H25-D-002 catalog injection skips small talk', () => {
  const out = codexEngine.injectCatalogIntoCodexSystem('sys', { query: 'hola', surface: 'code' });
  assert.equal(out.injected, false);
  assert.equal(out.system, 'sys');
});

test('3H25-D-003 subagent kind map qa_reviewer is review', () => {
  const out = codexEngine.mapCodexSubagentKind('qa_reviewer');
  assert.equal(out.type, 'review');
});

test('3H25-D-004 recall subagent cannot write_file', () => {
  const out = codexEngine.assertCodexSubagentTool('planner', 'write_file');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'subagent_tool_denied');
});

test('3H25-D-005 debugger subagent can apply_patch', () => {
  const out = codexEngine.assertCodexSubagentTool('debugger', 'apply_patch');
  assert.equal(out.ok, true);
});

test('3H25-E-001 live loop executeCall repairs tools', () => {
  const src = read('src/services/codex/agent-loop.js');
  assert.match(src, /repairCodexToolCall/);
  assert.match(src, /createCodexLoopControl/);
  assert.match(src, /capCodexToolObservation/);
  assert.match(src, /sleepCompactCodexMessages/);
  assert.match(src, /injectCatalogIntoCodexSystem/);
});

test('3H25-E-002 Promise.allSettled isolate parallel tools', () => {
  const src = read('src/services/codex/agent-loop.js');
  assert.match(src, /allSettled/);
  assert.match(src, /tool_isolated/);
});

test('3H25-E-003 apply_patch is a file-write in scheduler', () => {
  const sched = require('../src/services/codex/tool-scheduler');
  assert.equal(sched.FILE_WRITE_TOOLS.has('apply_patch'), true);
  const access = sched.accessFor({ name: 'apply_patch', args: { path: 'a.js' } });
  assert.equal(access.kind, 'file-write');
});

test('3H25-F-001 llm-turn prefers DeepSeek native and skips OpenRouter in production', () => {
  const src = read('src/services/codex/llm-turn.js');
  assert.match(src, /native-llm/);
  assert.match(src, /deepseek/i);
  const prov = read('src/services/codex/llm-provider.js');
  assert.match(prov, /openrouterGenerateDenied|skipOpenRouter|NODE_ENV === 'production'/);
  assert.doesNotMatch(src, /openrouter\.ai/i);
});

test('3H25-F-002 resolveCodexDeepSeekModel flash/pro only', () => {
  assert.equal(codexEngine.resolveCodexDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(codexEngine.resolveCodexDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});

test('3H25-G-001 error codes 3H25', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.CODEX_ENGINE_STOP, 'codex_engine_stop');
  assert.equal(CODES.CODEX_OPENROUTER_DENIED, 'codex_openrouter_denied');
  assert.equal(CODES.CODEX_FIRST_BYTE, 'codex_first_byte');
});

test('3H25-G-002 public stream errors include 3H25 codes', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.match(src, /codex_engine_stop/);
  assert.match(src, /codex_openrouter_denied/);
  assert.match(src, /git_hunk_ambiguous/);
});

test('3H25-G-003 snapshot flags', () => {
  const snap = codexEngine.codexEngineSnapshot();
  assert.equal(snap.engineControlWired, true);
  assert.equal(snap.openrouterGenerate, false);
  assert.equal(snap.deepseekGenerateLock, true);
  assert.equal(snap.stopConditions, true);
  assert.equal(snap.toolRepairFeedback, true);
});

test('3H25-X-001 no openrouter.ai in engine-codex or agent-loop', () => {
  const src = read('src/services/agent-runner/engine-codex.js');
  const loopSrc = read('src/services/codex/agent-loop.js');
  assert.doesNotMatch(src, /openrouter\.ai/i);
  assert.doesNotMatch(loopSrc, /openrouter\.ai/i);
});

test('3H25-X-002 health-check reports codex engine live', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /codexEngineLive/);
  assert.match(src, /engine-codex/);
});
