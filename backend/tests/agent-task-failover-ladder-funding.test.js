'use strict';

/**
 * /agentes task failover ladder: same provider order as the chat failover,
 * unfunded / rejected providers skipped, and the runner (not react-agent)
 * feeds the memo with the real transport of each runtime — an undetected
 * Claude or a Grok without an xAI key runs on DeepSeek, so DeepSeek is what
 * gets memoised and excluded, never the picker's provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');
const {
  resolveAgentModelFailoverRuntimes,
  agentRunModelError,
  agentRuntimeTransport,
} = require('../src/services/agents/agent-task-runner');

const ENV = { CEREBRAS_API_KEY: 'cb-key', OPENAI_API_KEY: 'oa-key', GEMINI_API_KEY: 'g-key', DEEPSEEK_API_KEY: 'ds-key' };
const XAI_FAILED = { detected: { provider: 'xAI' }, runtimeModel: 'grok-4.7' };

test.beforeEach(() => billing.__resetForTests());
test.after(() => billing.__resetForTests());

test('the default order starts with DeepSeek and follows the chat failover ladder', () => {
  const chain = resolveAgentModelFailoverRuntimes(XAI_FAILED, ENV);
  assert.deepEqual(chain.map((r) => r.provider), ['DeepSeek', 'Cerebras', 'Gemini', 'OpenAI']);
  assert.equal(chain[0].model, 'deepseek-v4-flash');
  // The failed provider is never its own fallback.
  const dsFailed = resolveAgentModelFailoverRuntimes({ detected: { provider: 'DeepSeek' } }, ENV);
  assert.deepEqual(dsFailed.map((r) => r.provider), ['Cerebras', 'Gemini', 'OpenAI']);
});

test('SIRAGPT_BILLING_FAILOVER_ORDER is honoured; unknown providers keep their list order at the end', () => {
  const chain = resolveAgentModelFailoverRuntimes(XAI_FAILED, { ...ENV, SIRAGPT_BILLING_FAILOVER_ORDER: 'OpenAI,Gemini' });
  assert.deepEqual(chain.map((r) => r.provider), ['OpenAI', 'Gemini', 'Cerebras', 'DeepSeek']);
});

test('providers memoised «sin saldo» or with a billing key-health rejection are skipped', () => {
  billing.markOutOfCredit('DeepSeek', Object.assign(new Error('Insufficient Balance'), { status: 402 }), ENV);
  keyHealth.markRejected('cerebras', 'cb-key', Object.assign(new Error('no credits'), { status: 402 }), ENV, { reason: 'billing' });
  const chain = resolveAgentModelFailoverRuntimes(XAI_FAILED, ENV);
  assert.deepEqual(chain.map((r) => r.provider), ['Gemini', 'OpenAI']);
  // A rotated key re-arms the provider.
  const rotated = resolveAgentModelFailoverRuntimes(XAI_FAILED, { ...ENV, DEEPSEEK_API_KEY: 'ds-new', CEREBRAS_API_KEY: 'cb-new' });
  assert.deepEqual(rotated.map((r) => r.provider), ['DeepSeek', 'Cerebras', 'Gemini', 'OpenAI']);
});

test('agentRuntimeTransport: the provider that really ran, else the detected one, else OpenAI', () => {
  assert.equal(agentRuntimeTransport({ detected: null, runtimeProvider: 'DeepSeek' }), 'DeepSeek');
  assert.equal(agentRuntimeTransport({ detected: { provider: 'xAI' }, runtimeProvider: 'DeepSeek' }), 'DeepSeek');
  assert.equal(agentRuntimeTransport({ detected: { provider: 'OpenRouter' }, runtimeProvider: 'OpenRouter' }), 'OpenRouter');
  // Before resolution the field holds a label, not a provider.
  assert.equal(agentRuntimeTransport({ detected: { provider: 'xAI' }, runtimeProvider: 'selected-xai' }), 'xAI');
  assert.equal(agentRuntimeTransport({ detected: null, runtimeProvider: 'openai-fallback' }), 'OpenAI');
  assert.equal(agentRuntimeTransport({ detected: null, runtimeProvider: 'unconfigured' }), 'OpenAI');
  assert.equal(agentRuntimeTransport(null), 'OpenAI');
});

test('the transport that failed is excluded from the ladder, not only the picker provider', () => {
  // Grok picked without an xAI key: it ran on DeepSeek, which just failed.
  const grokOnDeepSeek = { detected: { provider: 'xAI' }, runtimeProvider: 'DeepSeek', runtimeModel: 'deepseek-v4-flash' };
  assert.deepEqual(resolveAgentModelFailoverRuntimes(grokOnDeepSeek, ENV).map((r) => r.provider), ['Cerebras', 'Gemini', 'OpenAI']);
  // Claude (undetected) on DeepSeek: OpenAI is a valid fallback, DeepSeek is not.
  const claudeOnDeepSeek = { detected: null, runtimeProvider: 'DeepSeek', runtimeModel: 'deepseek-v4-flash' };
  assert.deepEqual(resolveAgentModelFailoverRuntimes(claudeOnDeepSeek, ENV).map((r) => r.provider), ['Cerebras', 'Gemini', 'OpenAI']);
});

test('agentRunModelError reads modelError, else parses the stoppedReason', () => {
  assert.deepEqual(agentRunModelError({ modelError: { status: 403, message: 'used all credits' } }), { status: 403, message: 'used all credits' });
  assert.deepEqual(agentRunModelError({ stoppedReason: 'model_error: 402 Insufficient credits' }), { status: 402, message: '402 Insufficient credits' });
  assert.deepEqual(agentRunModelError({ stoppedReason: 'model_error: step_timeout_60000ms' }), { status: null, message: 'step_timeout_60000ms' });
  assert.equal(billing.failoverReasonFor(agentRunModelError({ stoppedReason: 'model_error: step_timeout_60000ms' })), null, 'a timeout is never recorded');
  assert.equal(billing.failoverReasonFor(agentRunModelError({ stoppedReason: 'model_error: 429 insufficient_quota' })), 'billing');
  assert.equal(agentRunModelError({ stoppedReason: 'completed' }), null);
  assert.equal(agentRunModelError(null), null);
});

test('source contract: the failover loop feeds the memo for the original runtime and each failed rung', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agents', 'agent-task-runner.js'), 'utf8');
  assert.doesNotMatch(src, /result\.error \|\| result\.errorMessage \|\| result\.lastError/, 'react-agent never set those fields');
  assert.match(src, /require\('\.\.\/ai\/billing-failover'\)\.recordProviderFailure\(provider, detail\)/);
  assert.match(src, /const runtimeTransport = agentRuntimeTransport\(runtimeModelProfile\);/);
  assert.match(src, /recordAgentRunFailure\(runtimeTransport, result\)/);
  assert.doesNotMatch(src, /recordAgentRunFailure\(runtimeModelProfile\?\.detected/, 'never the picker provider');
  assert.match(src, /recordAgentRunFailure\(failoverRuntime\.provider, result\)/);
  // The checkpoint names a display model, never a raw id.
  assert.doesNotMatch(src, /Modelo de respaldo activado: \$\{failoverRuntime\.model\}/);
  // The runner owns the memo: react-agent would guess the provider from the model id.
  assert.match(src, /reactRunArgs\.recordProviderFailures = false;/);
  // Each hop is logged from the previous rung.
  assert.match(src, /model failover: \$\{previousRung\} → \$\{failoverRuntime\.provider\}:\$\{failoverRuntime\.model\}/);
  assert.match(src, /billing\.isOutOfCredit\(target\.provider, env\)/);
});

// ── Real worker (react-agent and persistence are synthetic) ─────────────

async function runJob(t, { model, env, run }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-agent-transport-'));
  const fullEnv = {
    NODE_ENV: 'test',
    AGENT_TASK_STORE_DIR: path.join(dir, 'tasks'),
    ENTERPRISE_EXECUTION_STORE_DIR: path.join(dir, 'execution'),
    AGENT_TASK_PRISMA_SYNC: '0', AGENT_TASK_ATTACHMENT_FASTPATH: '0', AGENT_TASK_LLM_RECOVERY: '0',
    ...env,
  };
  const keys = [...new Set([...Object.keys(fullEnv), 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, fullEnv);
  const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
  const cached = require.cache[runnerPath];
  delete require.cache[runnerPath];
  t.after(() => {
    t.mock.restoreAll();
    if (cached) require.cache[runnerPath] = cached; else delete require.cache[runnerPath];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network prohibited in this test'); });
  const persistence = require('../src/services/agents/agent-task-persistence');
  const events = [];
  t.mock.method(persistence, 'upsertAgentTask', async () => null);
  t.mock.method(persistence, 'appendAgentTaskEvent', async (_task, event) => { events.push(event); return null; });
  t.mock.method(require('../src/services/agents/task-contract-resolver'), 'resolveTaskContract', async ({ fallback }) => ({ contract: fallback(), source: 'synthetic-test' }));
  const models = [];
  t.mock.method(require('../src/services/react-agent'), 'run', async (_client, args) => {
    models.push(args.model);
    return run(models.length, args);
  });
  const { runAgentTaskJob } = require(runnerPath);
  const taskId = `transport-${Math.random().toString(36).slice(2, 10)}`;
  const result = await runAgentTaskJob({
    taskId,
    user: { id: 'transport-owner' },
    goal: 'Redacta una respuesta breve y responde solo en el chat.',
    displayGoal: 'Redacta una respuesta breve y responde solo en el chat.',
    files: [], fileMetadata: [],
    model,
    documentPolicy: { mode: 'chat_only', autoGenerate: false },
    maxSteps: 4, maxRuntimeMs: 60_000,
  });
  return { result, models, events };
}

const DRY = { finalAnswer: '', steps: [], stoppedReason: 'model_error: 402 Insufficient Balance' };

test('Claude (undetected) running on DeepSeek: a 402 memoises DeepSeek, never OpenAI', async (t) => {
  const env = { DEEPSEEK_API_KEY: 'ds-key', OPENAI_API_KEY: 'oa-key', AGENT_TASK_MODEL_FAILOVER: '0' };
  const { result, models } = await runJob(t, { model: 'claude-sonnet-4-6', env, run: () => DRY });
  assert.deepEqual(models, ['deepseek-v4-flash'], 'the undetected pick ran on the DeepSeek transport');
  assert.equal(result.status, 'failed');
  assert.equal(billing.isOutOfCredit('DeepSeek', env), true);
  assert.equal(billing.isOutOfCredit('OpenAI', env), false, 'the picker must not show OpenAI «Sin saldo»');
  assert.equal(keyHealth.isRejected('openai', 'oa-key'), false);
});

test('Grok without an xAI key runs on DeepSeek: the ladder skips DeepSeek, memoises each dry rung and names models by display name', async (t) => {
  const env = {
    DEEPSEEK_API_KEY: 'ds-key', CEREBRAS_API_KEY: 'cb-key', GEMINI_API_KEY: 'g-key', OPENAI_API_KEY: 'oa-key',
    AGENT_TASK_MODEL_FAILOVER: '1',
  };
  const { result, models, events } = await runJob(t, {
    model: 'grok-4.7',
    env,
    run: (n) => (n < 3 ? DRY : { finalAnswer: 'Respuesta breve lista.', steps: [], stoppedReason: 'completed' }),
  });
  assert.deepEqual(models, ['deepseek-v4-flash', 'gpt-oss-120b', 'gemini-2.5-flash'], 'the dry DeepSeek transport is not retried');
  assert.equal(result.status, 'completed');
  assert.equal(billing.isOutOfCredit('DeepSeek', env), true);
  assert.equal(billing.isOutOfCredit('Cerebras', env), true);
  assert.equal(billing.isOutOfCredit('xAI', env), false);
  const labels = events.filter((e) => e && e.type === 'checkpoint' && /respaldo/i.test(String(e.label || ''))).map((e) => e.label);
  assert.deepEqual(labels, ['Modelo de respaldo activado', 'Modelo de respaldo activado: Gemini 2.5 Flash']);
  for (const label of labels) assert.doesNotMatch(label, /gpt-oss|gemini-2\.5-flash|deepseek-v4/);
});
