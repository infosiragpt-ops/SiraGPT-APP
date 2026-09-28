const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  providerFailureDiagnostic,
  logProviderFailure,
} = require('../src/services/agent-runner/provider-failure-diagnostics');
const { classifyLine } = require('../src/services/observability/live-logs/classify');

test('selected-model failure diagnostics distinguish upstream, preflight, and signed transcript failures', () => {
  assert.deepEqual(providerFailureDiagnostic({
    failureOrigin: 'upstream', failureTransport: 'aggregator', failureProvider: 'OpenRouter', status: 429,
  }, 3), {
    origin: 'upstream', transport: 'aggregator', provider: 'OpenRouter',
    category: 'quota_or_rate_limit', status: 429, iteration: 3,
  });
  assert.deepEqual(providerFailureDiagnostic({ failureOrigin: 'preflight' }), {
    origin: 'preflight', transport: 'unknown', provider: 'unknown',
    category: 'candidate_unavailable', status: null, iteration: null,
  });
  assert.deepEqual(providerFailureDiagnostic({
    failureOrigin: 'signed_call_changed', status: 400,
  }, 2), {
    origin: 'signed_call_changed', transport: 'unknown', provider: 'unknown',
    category: 'transcript', status: 400, iteration: 2,
  });
});

test('selected-model failure logs contain no raw provider body, prompt, or signature', () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    logProviderFailure({
      failureOrigin: 'upstream',
      failureTransport: 'direct',
      failureProvider: 'Gemini',
      status: 400,
      message: 'secret prompt and sk-test-secret',
      response: { status: 400, body: 'signed payload and Bearer secret' },
      extra_content: { google: { thought_signature: 'sensitive-signature' } },
    }, 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'selected_model_failure');
  assert.match(lines[0], /"status":400/);
  assert.doesNotMatch(lines[0], /secret|prompt|signed payload|Bearer|thought_signature|sensitive-signature/);
  const classified = classifyLine({ text: lines[0], method: 'console.warn' });
  assert.equal(classified.level, 'warn');
  assert.equal(classified.status, 400);
  assert.equal(classified.tag, 'agent-runner');
  assert.match(classified.msg, /selected_model_failure/);
});

test('planner provider failures produce one classified internal event without raw content', async () => {
  const { runOrchestrator } = require('../src/services/agent-runner/orchestrator');
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    const result = await runOrchestrator({
      instruction: 'Analiza los datos y genera un documento',
      client: { chat: { completions: { create: async () => ({ choices: [] }) } } },
      plannerFn: async () => {
        const error = new Error('private prompt, Bearer secret');
        error.code = 'E_PROVIDER';
        error.status = 429;
        error.failureOrigin = 'upstream';
        error.failureTransport = 'direct';
        error.failureProvider = 'Gemini';
        throw error;
      },
    });
    assert.equal(result.stoppedReason, 'E_PROVIDER');
  } finally {
    console.warn = originalWarn;
  }
  const failures = lines.map((line) => JSON.parse(line)).filter((line) => line.event === 'selected_model_failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].provider, 'Gemini');
  assert.equal(failures[0].category, 'quota_or_rate_limit');
  assert.equal(classifyLine({ text: lines[0], method: 'console.warn' }).status, 429);
  assert.doesNotMatch(lines.join(' '), /private prompt|Bearer secret/);
});
