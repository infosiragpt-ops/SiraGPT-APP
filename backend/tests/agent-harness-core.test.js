'use strict';

/**
 * agent-harness core — model capability registry, tool registry, typed
 * event stream and the interactive permission gate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveModelCapabilities,
  supportsNativeTools,
  normalizeModelId,
  CONSERVATIVE_DEFAULTS,
} = require('../src/services/agent-harness/model-capabilities');
const { createToolRegistry } = require('../src/services/agent-harness/tool-registry');
const { createAgentEventStream, truncateForRecord, RESULT_PERSIST_MAX_CHARS } = require('../src/services/agent-harness/event-stream');
const permissionManager = require('../src/services/agent-harness/permission-manager');
const { z } = require('zod');

// ── model-capabilities ──────────────────────────────────────────────────────

test('capabilities: known families resolve native tools + reasoning + sane windows', () => {
  const claude = resolveModelCapabilities('anthropic/claude-opus-4.7');
  assert.equal(claude.supportsNativeTools, true);
  assert.equal(claude.supportsParallelToolCalls, true);
  assert.equal(claude.supportsReasoning, true);
  assert.equal(claude.reasoningParamStyle, 'openrouter-effort');
  assert.equal(claude.supportsPromptCaching, true);
  assert.ok(claude.contextWindow >= 200_000);

  const o3 = resolveModelCapabilities('openai/o3-mini');
  assert.equal(o3.supportsNativeTools, true);
  assert.equal(o3.supportsParallelToolCalls, false); // o-series rejects parallel
  assert.equal(o3.supportsReasoning, true);

  const deepseek = resolveModelCapabilities('deepseek/deepseek-r1');
  assert.equal(deepseek.reasoningParamStyle, 'deepseek');

  const gemini = resolveModelCapabilities('gemini-2.5-pro', { provider: 'gemini' });
  assert.equal(gemini.supportsNativeTools, true);
  assert.equal(gemini.supportsImages, true);
});

test('capabilities: unknown models get conservative defaults (prompted ladder)', () => {
  const caps = resolveModelCapabilities('totally-unknown-model-9000');
  assert.equal(caps.supportsNativeTools, false);
  assert.equal(caps.supportsReasoning, false);
  assert.equal(caps.contextWindow, CONSERVATIVE_DEFAULTS.contextWindow);
  assert.equal(caps.family, null);
});

test('capabilities: provider folds into bare ids; slugs pass through', () => {
  assert.equal(normalizeModelId('gpt-4o', 'openai'), 'openai/gpt-4o');
  assert.equal(normalizeModelId('anthropic/claude-3.5-sonnet', 'OpenRouter'), 'anthropic/claude-3.5-sonnet');
  assert.equal(normalizeModelId('llama-3.1-8b', 'Cerebras'), 'cerebras/llama-3.1-8b');
});

test('capabilities: legacy native-allowlist parity — every family the chat routed natively stays native', () => {
  const agenticStream = require('../src/services/agentic-chat-stream');
  const matrix = [
    ['openai', 'gpt-4o'],
    ['openai', 'gpt-4o-mini'],
    ['gemini', 'gemini-2.5-pro'],
    ['deepseek', 'deepseek-chat'],
    ['Cerebras', 'llama-3.1-8b'],
    ['openrouter', 'anthropic/claude-opus-4.7'],
    ['openrouter', 'x-ai/grok-4'],
    ['openrouter', 'moonshotai/kimi-k2.6'],
    ['openrouter', 'qwen/qwen-2.5-72b-instruct'],
    ['openrouter', 'openai/gpt-oss-120b'],
  ];
  for (const [provider, model] of matrix) {
    assert.equal(
      agenticStream.resolveToolCallMode(provider, model),
      'native',
      `${provider}/${model} must stay on the native loop`,
    );
    assert.equal(supportsNativeTools(provider, model), true, `${provider}/${model} capability row`);
  }
});

test('capabilities: env + caller overrides win over the family table', () => {
  const env = { SIRAGPT_MODEL_CAPS_OVERRIDES: JSON.stringify({ 'anthropic/claude': { supportsImages: false } }) };
  const viaEnv = resolveModelCapabilities('anthropic/claude-opus-4.7', { env });
  assert.equal(viaEnv.supportsImages, false);

  const viaSettings = resolveModelCapabilities('anthropic/claude-opus-4.7', {
    env: {},
    overrides: { 'anthropic/claude-opus-4.7': { supportsNativeTools: false, contextWindow: 1234 } },
  });
  assert.equal(viaSettings.supportsNativeTools, false);
  assert.equal(viaSettings.contextWindow, 1234);
});

// ── tool-registry ───────────────────────────────────────────────────────────

function sampleRegistry() {
  const registry = createToolRegistry();
  registry.register({
    name: 'echo_tool',
    description: 'echoes',
    inputSchema: z.object({ text: z.string().min(1) }).strict(),
    humanDescription: (args) => `Eco de ${args.text || ''}`,
    execute: async (args) => ({ echoed: args.text }),
  });
  registry.register({
    name: 'guarded_tool',
    description: 'guarded',
    inputSchema: z.object({}).strict(),
    permissionTier: 'confirm',
    execute: async () => ({ ok: true }),
  });
  return registry;
}

test('tool-registry: registration, zod validation and OpenAI projection', async () => {
  const registry = sampleRegistry();
  assert.deepEqual(registry.list().map((t) => t.name), ['echo_tool', 'guarded_tool']);

  const bad = registry.validateArgs('echo_tool', { nope: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid_tool_args/);

  const good = registry.validateArgs('echo_tool', { text: 'hola' });
  assert.equal(good.ok, true);

  const openai = registry.toOpenAITools();
  assert.equal(openai[0].type, 'function');
  assert.equal(openai[0].function.name, 'echo_tool');
  assert.equal(openai[0].function.parameters.type, 'object');
  assert.ok(!('$schema' in openai[0].function.parameters));

  // toAgentTool runs Zod inside execute so prompted-mode args get typed errors
  const agentTool = registry.toAgentTool('echo_tool');
  await assert.rejects(() => agentTool.execute({}, {}), /invalid_tool_args/);
  assert.deepEqual(await agentTool.execute({ text: 'x' }, {}), { echoed: 'x' });
});

test('tool-registry: duplicate names and bad tiers are rejected', () => {
  const registry = sampleRegistry();
  assert.throws(() => registry.register({
    name: 'echo_tool', description: '', inputSchema: z.object({}), execute: async () => ({}),
  }), /duplicate/);
  assert.throws(() => registry.register({
    name: 'tier_tool', description: '', inputSchema: z.object({}), permissionTier: 'sometimes', execute: async () => ({}),
  }), /permissionTier/);
});

test('tool-registry: metaFor — tiers for registry, host overlays and MCP defaults', () => {
  const registry = sampleRegistry();
  assert.equal(registry.metaFor('guarded_tool').permissionTier, 'confirm');
  assert.equal(registry.metaFor('echo_tool', { text: 'hola' }).humanDescription, 'Eco de hola');
  // host tools carry the confirm tier by default (DEFAULT_TIER_OVERRIDES)
  assert.equal(registry.metaFor('host_bash').permissionTier, 'confirm');
  // any mcp__ tool is confirm unless explicitly relaxed
  const mcpMeta = registry.metaFor('mcp__docs__search');
  assert.equal(mcpMeta.permissionTier, 'confirm');
  assert.match(mcpMeta.humanDescription, /docs · search/);
});

// ── event-stream ────────────────────────────────────────────────────────────

test('event-stream: start→executing→result ordering, monotonic seq, agent_done totals', async () => {
  const registry = sampleRegistry();
  const frames = [];
  const events = createAgentEventStream({ write: async (f) => frames.push(f), registry });
  const [echo] = events.wrapTools([registry.toAgentTool('echo_tool')]);

  events.onStepStart({ thought: 'pienso', actions: [{ tool: 'echo_tool', args: '{"text":"hola"}' }] });
  await echo.execute({ text: 'hola' }, {});
  events.onStepDone({ actions: [{ tool: 'echo_tool', args: '{"text":"hola"}', observation: { echoed: 'hola' } }] });
  const run = events.finish({ stoppedReason: 'finalized', finalAnswer: 'listo' });

  const types = frames.map((f) => f.type);
  assert.deepEqual(types, ['tool_call_start', 'tool_executing', 'tool_result', 'agent_done']);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].seq > frames[i - 1].seq, 'seq must be monotonic');
  assert.equal(frames[0].humanDescription, 'Eco de hola');
  assert.equal(frames[2].isError, false);
  assert.equal(frames[3].toolCalls, 1);
  assert.equal(frames[3].interrupted, false);

  assert.equal(run.steps.length, 2); // reasoning + tool_call
  assert.equal(run.steps[0].type, 'reasoning');
  assert.equal(run.steps[1].status, 'completed');
});

test('event-stream: calls that never reach execute() settle from onStepDone observations', () => {
  const registry = sampleRegistry();
  const frames = [];
  const events = createAgentEventStream({ write: async (f) => frames.push(f), registry });
  events.wrapTools([registry.toAgentTool('echo_tool')]);

  events.onStepStart({ actions: [{ tool: 'echo_tool', args: '{"text":"x"}' }] });
  // dispatchTool denied the call (e.g. duplicate cache) — execute never ran
  events.onStepDone({ actions: [{ tool: 'echo_tool', args: '{"text":"x"}', observation: { error: 'duplicate_tool_call' } }] });
  const run = events.finish({});

  const result = frames.find((f) => f.type === 'tool_result');
  assert.equal(result.isError, true);
  assert.equal(run.steps.find((s) => s.type === 'tool_call').isError, true);
});

test('event-stream: interrupted runs settle dangling calls and flag agent_done', async () => {
  const registry = sampleRegistry();
  const frames = [];
  const events = createAgentEventStream({ write: async (f) => frames.push(f), registry });
  events.onStepStart({ actions: [{ tool: 'echo_tool', args: '{"text":"y"}' }] });
  const run = events.finish({ stoppedReason: 'aborted', interrupted: true });

  const done = frames.find((f) => f.type === 'agent_done');
  assert.equal(done.interrupted, true);
  assert.equal(run.steps.find((s) => s.type === 'tool_call').status, 'interrupted');
});

test('event-stream: persisted results are capped at 30k chars with an explicit marker', () => {
  const big = 'x'.repeat(RESULT_PERSIST_MAX_CHARS * 2);
  const { json, truncated } = truncateForRecord(big, RESULT_PERSIST_MAX_CHARS);
  assert.equal(truncated, true);
  assert.ok(json.length <= RESULT_PERSIST_MAX_CHARS);
  assert.match(json, /\[truncated 30000 of \d+ chars\]$/);
});

// ── permission gate ─────────────────────────────────────────────────────────

test('permission gate: confirm tool pauses, allow resumes, always_allow caches per chat', async (t) => {
  t.after(() => permissionManager.resetForTests());
  permissionManager.resetForTests();
  const registry = sampleRegistry();
  const frames = [];
  const events = createAgentEventStream({
    write: async (f) => frames.push(f),
    registry,
    permission: permissionManager,
    ctxInfo: { chatId: 'chat1', userId: 'user1' },
  });
  const [guarded] = events.wrapTools([registry.toAgentTool('guarded_tool')]);

  const pendingRun = guarded.execute({}, {});
  await new Promise((r) => setTimeout(r, 20));
  const request = frames.find((f) => f.type === 'permission_request');
  assert.ok(request, 'permission_request must be emitted');
  assert.equal(request.name, 'guarded_tool');

  // Wrong user cannot answer someone else's stream
  const stranger = permissionManager.resolvePermission({ permissionId: request.permissionId, decision: 'allow', userId: 'attacker' });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.status, 403);

  const answer = permissionManager.resolvePermission({ permissionId: request.permissionId, decision: 'always_allow_in_chat', userId: 'user1' });
  assert.equal(answer.ok, true);
  assert.deepEqual(await pendingRun, { ok: true });
  assert.equal(permissionManager.isAlwaysAllowed('chat1', 'guarded_tool'), true);

  // Second call skips the card entirely (cached allow)
  const before = frames.filter((f) => f.type === 'permission_request').length;
  await guarded.execute({}, {});
  assert.equal(frames.filter((f) => f.type === 'permission_request').length, before);
});

test('permission gate: deny feeds an is_error result and unknown ids 404', async (t) => {
  t.after(() => permissionManager.resetForTests());
  permissionManager.resetForTests();
  const registry = sampleRegistry();
  const frames = [];
  const events = createAgentEventStream({
    write: async (f) => frames.push(f),
    registry,
    permission: permissionManager,
    ctxInfo: { chatId: 'chat2', userId: 'user1' },
  });
  const [guarded] = events.wrapTools([registry.toAgentTool('guarded_tool')]);

  const pendingRun = guarded.execute({}, {});
  await new Promise((r) => setTimeout(r, 20));
  const request = frames.find((f) => f.type === 'permission_request');
  permissionManager.resolvePermission({ permissionId: request.permissionId, decision: 'deny', userId: 'user1' });
  await assert.rejects(() => pendingRun, /permission_denied/);

  const result = frames.find((f) => f.type === 'tool_result');
  assert.equal(result.isError, true);
  assert.equal(events.run.steps[0].status, 'denied');

  const missing = permissionManager.resolvePermission({ permissionId: 'nope-nope-nope', decision: 'allow' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
});

test('permission gate: timeout denies on its own', async (t) => {
  t.after(() => permissionManager.resetForTests());
  permissionManager.resetForTests();
  const outcome = await permissionManager.requestPermission({
    chatId: 'chat3',
    userId: 'user1',
    toolName: 'guarded_tool',
    humanDescription: 'x',
    onRequest: () => {},
    ttlMs: 30,
  });
  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.reason, 'timeout');
});

// ── attachHarness (integration) ─────────────────────────────────────────────

test('attachHarness: merges harness tools, wraps existing ones, kill switch respected', async (t) => {
  const { attachHarness } = require('../src/services/agent-harness/run-agent-turn');

  const baseTool = {
    name: 'existing_tool',
    description: 'pre-existing',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ done: true }),
  };
  const frames = [];
  const harness = await attachHarness({
    tools: [baseTool],
    write: async (f) => frames.push(f),
    chatId: 'c',
    userId: null, // no MCP discovery
    prisma: null,
    describeTool: (name) => `Etiqueta ${name}`,
  });
  const names = harness.tools.map((tool) => tool.name);
  assert.ok(names.includes('existing_tool'));
  assert.ok(names.includes('web_fetch'));
  assert.ok(names.includes('run_javascript'));
  assert.ok(names.includes('create_artifact'));
  assert.ok(names.includes('web_search'));

  // wrapped existing tool emits typed frames with the chat's stage label
  harness.onStepStart({ actions: [{ tool: 'existing_tool', args: '{}' }] });
  const wrapped = harness.tools.find((tool) => tool.name === 'existing_tool');
  await wrapped.execute({}, {});
  assert.equal(frames.find((f) => f.type === 'tool_call_start').humanDescription, 'Etiqueta existing_tool');
  assert.ok(frames.find((f) => f.type === 'tool_result'));

  // env kill switch
  process.env.SIRAGPT_AGENT_HARNESS = '0';
  t.after(() => { delete process.env.SIRAGPT_AGENT_HARNESS; });
  assert.equal(await attachHarness({ tools: [baseTool], write: async () => {} }), null);
});

// ── cost estimate + parallel_tool_calls (Phase 1b) ──────────────────────────

test('cost estimate: provider list prices blended 75/25, null when unpriced', () => {
  const { estimateCostUsd } = require('../src/services/agent-harness/event-stream');
  // openai manifest: { input: 2.5, output: 10 } → 2.5*0.75 + 10*0.25 = 4.375/M
  assert.equal(estimateCostUsd('OpenAI', 1_000_000), 4.375);
  assert.ok(estimateCostUsd('deepseek', 500_000) > 0);
  assert.equal(estimateCostUsd('Cerebras', 1_000_000), null); // no published rate
  assert.equal(estimateCostUsd('OpenAI', 0), null);
  assert.equal(estimateCostUsd(null, 1000), null);
});

test('agent_done: carries the USD estimate when the provider is priced', () => {
  const registry = sampleRegistry();
  const frames = [];
  const events = createAgentEventStream({ write: async (f) => frames.push(f), registry, provider: 'OpenAI' });
  events.onStepStart({ thought: 'x'.repeat(4000), actions: [] });
  const run = events.finish({ stoppedReason: 'finalized', finalAnswer: 'y'.repeat(4000) });
  const done = frames.find((f) => f.type === 'agent_done');
  assert.ok(run.costUsdEstimate > 0, 'estimate must be computed');
  assert.equal(done.costUsdEstimate, run.costUsdEstimate);
});

test('react-agent: parallel_tool_calls sent only when capability-enabled', async () => {
  const reactAgent = require('../src/services/react-agent');
  const payloads = [];
  const fakeOpenAI = {
    chat: {
      completions: {
        create: async (payload) => {
          payloads.push(payload);
          return {
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: 'ok' }) } }],
              },
            }],
          };
        },
      },
    },
  };
  await reactAgent.run(fakeOpenAI, { query: 'q', tools: [], maxSteps: 2, parallelToolCalls: true });
  assert.equal(payloads[0].parallel_tool_calls, true);

  payloads.length = 0;
  await reactAgent.run(fakeOpenAI, { query: 'q', tools: [], maxSteps: 2 });
  assert.equal('parallel_tool_calls' in payloads[0], false, 'param must be OMITTED (not false) by default');
});
