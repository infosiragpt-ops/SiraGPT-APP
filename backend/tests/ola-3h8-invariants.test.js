'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H8-BE-001 lockTextGenerationToNativeDeepSeek remaps leftover OpenAI/Gemini', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /3H8 leftover candado: text generate is native DeepSeek/);
  assert.match(src, /resolveNativeDeepSeekModel\(model\)/);
  assert.doesNotMatch(src, /looksOpenRouter = \/\^openrouter\$\/i/);
});

test('3H8-BE-002 artifact branch uses native DeepSeek, never OPENAI_API_KEY', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /artifact generate is native DeepSeek/);
  assert.match(src, /createNativeDeepSeekClient\(\)/);
  assert.doesNotMatch(src, /const artifactOpenai = new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
});

test('3H8-BE-003 artifact-generator defaults are Flash', () => {
  const src = read('src/services/artifacts/artifact-generator.js');
  assert.match(src, /const DEFAULT_MODEL = 'deepseek-v4-flash'/);
  assert.match(src, /const DEFAULT_VISION_MODEL = 'deepseek-v4-flash'/);
  assert.doesNotMatch(src, /DEFAULT_MODEL = 'gpt-4o-mini'/);
  assert.doesNotMatch(src, /DEFAULT_VISION_MODEL = 'gpt-4o'/);
});

test('3H8-BE-004/005/006 excel/ppt/webdev live generate lock to DeepSeek', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /Excel Workbook generation request/);
  assert.equal(src.includes("provider = 'OpenAI', model = 'gpt-4o', files } = req.body"), false);
  assert.match(src, /excel generate is native DeepSeek/);
  assert.match(src, /Web development streaming request/);
  assert.match(src, /attachSseIds\(res, req\)/);
});

test('3H8-BE-007 generatePPT live client is native DeepSeek', () => {
  const src = read('src/services/ai-service.js');
  assert.match(src, /PPT structure generate is native DeepSeek only/);
  assert.match(src, /async generatePPT\(prompt, provider = "DeepSeek", model = "deepseek-v4-flash"\)/);
  assert.doesNotMatch(src, /async generatePPT\(prompt, provider = "OpenAI", model = "gpt-4o"\)/);
});

test('3H8-BE-008 agent-task requires DeepSeek, not OpenAI', () => {
  const src = read('src/services/agents/agent-task-runner.js');
  assert.match(src, /throw new Error\('DEEPSEEK_API_KEY not configured'\)/);
  assert.doesNotMatch(src, /throw new Error\('OPENAI_API_KEY not configured'\)/);
  assert.match(src, /model = 'deepseek-v4-flash'/);
});

test('3H8-BE-009 leftover gpt-\* agent runtime is DeepSeek', () => {
  const src = read('src/services/agents/agent-task-runner.js');
  assert.match(src, /leftover gpt-\* ids are native DeepSeek/);
  assert.doesNotMatch(src, /return \{ provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null \}/);
});

test('3H8-BE-010 attachment recovery is DeepSeek only', () => {
  const src = read('src/services/agents/agent-task-runner.js');
  assert.match(src, /attachment recovery generate is DeepSeek only/);
  assert.doesNotMatch(src, /AGENT_TASK_RECOVERY_MODEL \|\| 'gpt-4o-mini'/);
});

test('3H8-BE-011/012 agent-entry leftover generate is DeepSeek', () => {
  const src = read('src/services/agents/agent-entry.js');
  assert.match(src, /createNativeDeepSeekClient\(\)/);
  assert.match(src, /DEEPSEEK_API_KEY not configured/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.doesNotMatch(src, /model = 'gpt-4o'/);
  assert.doesNotMatch(src, /model: 'gpt-4o-mini'/);
});

test('3H8-BE-013 task-contract side-channel is DeepSeek', () => {
  const src = read('src/services/agents/task-contract-resolver.js');
  assert.match(src, /side-channel generate is native DeepSeek/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.doesNotMatch(src, /effectiveModel = model \|\| 'gpt-4o-mini'/);
});

test('3H8-BE-014 rate-limit leftover generate paths', () => {
  const { isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/gmail/sync'), true);
  assert.equal(isSharedGenerateAgentPath('/api/search-brain/query'), true);
  assert.equal(isSharedGenerateAgentPath('/api/telegram/webhook'), true);
  assert.equal(isSharedGenerateAgentPath('/api/intent/semantic'), true);
  assert.equal(isSharedGenerateAgentPath('/api/x-search'), true);
  assert.equal(isSharedGenerateAgentPath('/api/agent-harness'), true);
  assert.equal(isSharedGenerateAgentPath('/api/agent-runs'), true);
  assert.equal(isSharedGenerateAgentPath('/api/orchestration'), true);
  assert.equal(isSharedGenerateAgentPath('/api/context-intelligence'), true);
  assert.equal(isSharedGenerateAgentPath('/api/github/connected'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
});

test('3H8-BE-015 rate-limit leftover stop skips', () => {
  const { isStopStreamPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isStopStreamPath('/api/agent-runs/abc/cancel'), true);
  assert.equal(isStopStreamPath('/api/chats/x/run/y/cancel'), true);
  assert.equal(isStopStreamPath('/api/code-runner/r1/stop'), true);
  assert.equal(isStopStreamPath('/api/codex/runs/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/opencode/session/1/abort'), true);
  assert.equal(isStopStreamPath('/api/goals/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/hosting/deployments/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/github/connected/1/stop'), true);
  assert.equal(isStopStreamPath('/api/voice/sessions/1/stop'), true);
  assert.equal(isStopStreamPath('/api/ai/generate'), false);
});

test('3H8-BE-016 PII leftover LATAM keys', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /clabe/);
  assert.match(src, /cci/);
  assert.match(src, /cuit/);
  assert.match(src, /cuil/);
  assert.match(src, /nie/);
  assert.match(src, /nif/);
  assert.match(src, /nss/);
});

test('3H8-BE-017 health secrets leftover JWT/TWILIO/SENDGRID/R2', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /JWT_SECRET/);
  assert.match(src, /SESSION_SECRET/);
  assert.match(src, /TWILIO/);
  assert.match(src, /SENDGRID/);
  assert.match(src, /R2_SECRET/);
  assert.match(src, /RESEND_API/);
});

test('3H8-BE-018 EDIT_TOOLS leftover visual tables/charts', () => {
  const { EDIT_TOOLS } = require('../src/services/agent-runner/verify');
  assert.equal(EDIT_TOOLS.has('create_comparison_table'), true);
  assert.equal(EDIT_TOOLS.has('create_moscow_chart'), true);
  assert.equal(EDIT_TOOLS.has('create_radar_chart'), true);
});

test('3H8-BE native-llm still remaps leftover gpt-4o', () => {
  const native = require('../src/services/agent-runner/native-llm');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(native.resolveNativeDeepSeekModel('gemini-2.5-flash'), 'deepseek-v4-flash');
  assert.equal(native.resolveNativeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});
