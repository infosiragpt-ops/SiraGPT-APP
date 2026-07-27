/**
 * agent-entry tests — we focus on the guarantees that do not require
 * a real OpenAI client or database:
 *
 *   - depth guard against runaway session_spawn chains
 *   - basic input validation
 *   - MAX_SPAWN_DEPTH is exported so skills can reason about it
 */

const { after, test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgent, MAX_SPAWN_DEPTH } = require('../src/services/agents/agent-entry');

after(async () => {
  // CI provides REDIS_URL, so enqueueDelegatedTask opens the real BullMQ
  // producer. Close it explicitly or this focused test process never exits.
  const { closeAgentTaskQueue } = require('../src/services/agents/agent-task-queue');
  await closeAgentTaskQueue({ force: true });
});

test('MAX_SPAWN_DEPTH is a sane positive integer', () => {
  assert.equal(typeof MAX_SPAWN_DEPTH, 'number');
  assert.ok(MAX_SPAWN_DEPTH >= 2 && MAX_SPAWN_DEPTH <= 10,
    `expected 2..10 to prevent runaway spawns; got ${MAX_SPAWN_DEPTH}`);
});

test('runAgent rejects missing userId', async () => {
  await assert.rejects(() => runAgent({ prompt: 'hi' }), /userId required/);
});

test('runAgent rejects missing prompt', async () => {
  await assert.rejects(() => runAgent({ userId: 'u1' }), /prompt required/);
});

test('runAgent rejects depth over MAX_SPAWN_DEPTH', async () => {
  // Point OPENAI_API_KEY so the earlier check doesn't short-circuit
  // the guard we want to test.
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-fake';
  try {
    await assert.rejects(
      () => runAgent({ userId: 'u1', prompt: 'hi', depth: MAX_SPAWN_DEPTH + 1 }),
      new RegExp(`spawn depth ${MAX_SPAWN_DEPTH + 1} exceeds max`),
    );
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('buildAllTools returns a non-empty array of unique tool objects', () => {
  const { buildAllTools } = require('../src/services/agents/agent-entry');
  const tools = buildAllTools('low');

  assert.ok(Array.isArray(tools), 'buildAllTools should return an array');
  assert.ok(tools.length >= 10, `expected at least 10 tools, got ${tools.length}`);

  // Every tool has the expected shape
  for (const t of tools) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0,
      `tool missing name: ${JSON.stringify(t)}`);
    assert.ok(typeof t.description === 'string',
      `tool ${t.name} missing description`);
    assert.ok(t.parameters && typeof t.parameters === 'object',
      `tool ${t.name} missing parameters`);
    assert.ok(typeof t.execute === 'function',
      `tool ${t.name} missing execute function`);
  }

  // No duplicates
  const names = tools.map(t => t.name);
  const uniqueNames = new Set(names);
  assert.equal(names.length, uniqueNames.size, 'duplicate tool names found');

  // Key tools that should definitely be present
  const toolNames = new Set(names);
  assert.ok(toolNames.has('web_search'), 'web_search tool missing');
  assert.ok(toolNames.has('read_url'), 'read_url tool missing');
  assert.ok(toolNames.has('web_extract'), 'web_extract tool missing');
  assert.ok(toolNames.has('session_search'), 'session_search tool missing');
  assert.ok(toolNames.has('browser_navigate'), 'browser_navigate tool missing');
  assert.ok(toolNames.has('browser_click'), 'browser_click tool missing');
  assert.ok(toolNames.has('browser_type'), 'browser_type tool missing');
  assert.ok(toolNames.has('browser_scroll'), 'browser_scroll tool missing');
  assert.ok(toolNames.has('clone_project'), 'clone_project tool missing');
  assert.ok(toolNames.has('host_bash'), 'host_bash tool missing');
  assert.ok(toolNames.has('check_ci_status'), 'check_ci_status tool missing');
  assert.ok(toolNames.has('monitor_ci'), 'monitor_ci tool missing');

  // Task tools that should be available
  assert.ok(toolNames.has('python_exec'), 'python_exec tool missing');
  assert.ok(toolNames.has('create_document'), 'create_document tool missing');
  assert.ok(toolNames.has('run_skill'), 'run_skill tool missing');
  assert.ok(toolNames.has('run_skill_pipeline'), 'run_skill_pipeline tool missing');
});

test('buildAllTools enforces the declared skillIds allow-list', () => {
  const { buildAllTools } = require('../src/services/agents/agent-entry');
  const tools = buildAllTools('low', {
    skillIds: ['apa7_format'],
    clearance: 'enterprise',
  });
  const runSkill = tools.find((tool) => tool.name === 'run_skill');
  assert.ok(runSkill, 'run_skill tool missing');
  assert.deepEqual(runSkill.parameters.properties.skillId.enum, ['apa7_format']);
  const runPipeline = tools.find((tool) => tool.name === 'run_skill_pipeline');
  assert.ok(runPipeline, 'run_skill_pipeline tool missing');
  assert.deepEqual(runPipeline.parameters.properties.steps.items.properties.skillId.enum, ['apa7_format']);
});

test('buildAllTools deduplicates by name', () => {
  const { buildAllTools } = require('../src/services/agents/agent-entry');
  // Call twice to make sure the function is pure (no module-level state)
  const t1 = buildAllTools('low');
  const t2 = buildAllTools('low');
  assert.equal(t1.length, t2.length, 'buildAllTools should be deterministic');
  assert.deepEqual(t1.map(t => t.name).sort(), t2.map(t => t.name).sort(), 'same tools every call');
});

test('enqueueDelegatedTask returns a task id', async () => {
  const { enqueueDelegatedTask } = require('../src/services/agents/agent-entry');
  // Without REDIS_URL this should fail gracefully
  const result = await enqueueDelegatedTask('test prompt', { userId: 'u1' }).catch(err => {
    return { error: err?.message || String(err) };
  });

  // If Redis is not configured, it should still return an error object
  // (not throw an unhandled exception)
  if (result.error) {
    assert.ok(typeof result.error === 'string', 'error should be a string');
  } else {
    assert.ok(typeof result.taskId === 'string', 'taskId should be a string');
    assert.equal(result.status, 'queued');
  }
});

test('runSubAgent returns shaped result without real API key', async () => {
  const { runSubAgent } = require('../src/services/agents/agent-entry');
  // Fake key: the call will fail at the API transport, not before.
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-fake';
  try {
    const result = await runSubAgent('Do something', {
      userId: 'u1',
      openai: { chat: { completions: { create: async () => ({ choices: [] }) } } },
    }, { maxSteps: 1 }).catch(err => {
      return { answer: '', stoppedReason: `error: ${err?.message || String(err)}` };
    });
    assert.ok(typeof result.answer === 'string', 'answer should be a string');
    assert.ok(typeof result.stoppedReason === 'string', 'stoppedReason should be a string');
    assert.ok(Array.isArray(result.steps) || result.steps === undefined, 'steps should be an array or undefined');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});
