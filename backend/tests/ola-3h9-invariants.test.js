'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H9-BE-001 se-agents requireOpenAI is native DeepSeek', () => {
  const src = read('src/routes/se-agents.js');
  assert.match(src, /3H9 leftover candado: live se-agents generate is native DeepSeek/);
  assert.match(src, /return requireDeepSeek\(res\)/);
  assert.doesNotMatch(src, /error: 'OPENAI_API_KEY not configured — agents unavailable'/);
});

test('3H9-BE-002 se-agents leftover generate handlers use requireDeepSeek', () => {
  const src = read('src/routes/se-agents.js');
  assert.match(src, /agent-coder/);
  assert.match(src, /resolveNativeDeepSeekModel\(req\.body\.model\)/);
  assert.equal(src.includes('OPENAI_API_KEY not configured'), false);
});

test('3H9-BE-003 maybeAlign leftover LLM is DeepSeek', () => {
  const src = read('src/routes/se-agents.js');
  assert.match(src, /const openai = requireDeepSeek\(res\)/);
  assert.doesNotMatch(src, /const openai = rag\.getOpenAI\(\);\n    const aligned/);
});

test('3H9-BE-004 agent-core leftover default is Flash', () => {
  const src = read('src/services/agents/agent-core.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.doesNotMatch(src, /DEFAULT_MODEL = 'gpt-4o-mini'/);
});

test('3H9-BE-005 planner leftover default is Flash', () => {
  const src = read('src/services/agents/planner.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H9-BE-006 executor leftover planner\/executor models are Flash', () => {
  const src = read('src/services/agents/executor.js');
  assert.match(src, /plannerModel = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.match(src, /executorModel = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H9-BE-007 agent.js leftover passes plannerModel', () => {
  const src = read('src/routes/agent.js');
  assert.match(src, /plannerModel: lockedModel/);
});

test('3H9-BE-008 task-tools leftover self_rag is Flash', () => {
  const src = read('src/services/agents/task-tools.js');
  assert.match(src, /model: require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.doesNotMatch(src, /model: 'gpt-4o-mini'/);
});

test('3H9-BE-009 boot-recovery leftover remaps snapshot model', () => {
  const src = read('src/services/agents/agent-task-boot-recovery.js');
  assert.match(src, /resolveNativeDeepSeekModel\(snapshot\.model\)/);
  assert.doesNotMatch(src, /snapshot\.model \|\| 'gpt-4o'/);
});

test('3H9-BE-010 intent-clarifier leftover default is Flash', () => {
  const src = read('src/services/agents/intent-clarifier.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H9-BE-011 opencode leftover defaults DeepSeek Flash', () => {
  const { getOpencodeModel } = require('../src/services/opencode/opencode-config');
  const m = getOpencodeModel({ env: {} });
  assert.equal(m.providerID, 'deepseek');
  assert.equal(m.modelID, 'deepseek-v4-flash');
});

test('3H9-BE-012 hermes leftover defaults are Flash', () => {
  const agent = read('src/services/agents/hermes-agent-bridge.js');
  const cli = read('src/services/agents/hermes-cli-bridge.js');
  const del = read('src/services/agents/hermes-delegate-bridge.js');
  assert.match(agent, /native-llm'\)\.FLASH/);
  assert.match(cli, /native-llm'\)\.FLASH/);
  assert.match(del, /native-llm'\)\.FLASH/);
});

test('3H9-BE-013 HTTP gateway agent fail-closed without user', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /code: 'user_required'/);
  assert.match(src, /if \(!userId\) return json\(res, 401/);
});

test('3H9-BE-014 gateway leftover turn timeout + abort race', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /SIRAGPT_GATEWAY_TURN_TIMEOUT_MS/);
  assert.match(src, /Promise\.race\(\[runPromise, abortPromise\]\)/);
  assert.match(src, /rec\.abortController && rec\.abortController\.abort\(\)/);
  assert.match(src, /turn_timeout/);
  assert.match(src, /turnTimeoutMs/);
});

test('3H9-BE-015 rate-limit leftover generate paths', () => {
  const { isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/hermes/cli'), true);
  assert.equal(isSharedGenerateAgentPath('/api/library/items'), true);
  assert.equal(isSharedGenerateAgentPath('/api/compute/run'), true);
  assert.equal(isSharedGenerateAgentPath('/api/sandbox/exec'), true);
  assert.equal(isSharedGenerateAgentPath('/api/document-ai/generate-word'), true);
  assert.equal(isSharedGenerateAgentPath('/api/elevenlabs/tts'), true);
  assert.equal(isSharedGenerateAgentPath('/api/memory/recall'), true);
  assert.equal(isSharedGenerateAgentPath('/api/se-agents/review'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
});

test('3H9-BE-016 rate-limit leftover stop skips', () => {
  const { isStopStreamPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isStopStreamPath('/api/sandbox/abc/stop'), true);
  assert.equal(isStopStreamPath('/api/sandbox/abc/destroy'), true);
  assert.equal(isStopStreamPath('/api/compute/1/cancel'), true);
  assert.equal(isStopStreamPath('/api/elevenlabs/1/stop'), true);
  assert.equal(isStopStreamPath('/api/hermes/session/abort'), true);
  assert.equal(isStopStreamPath('/api/document-ai/abort'), true);
  assert.equal(isStopStreamPath('/api/ai/generate'), false);
});

test('3H9-BE-017 PII leftover jwt\/csrf\/bearer\/sessionid', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /bearer/);
  assert.match(src, /jwt/);
  assert.match(src, /csrf/);
  assert.match(src, /sessionid/);
});

test('3H9-BE-018 health leftover bearer\/csrf', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /bearer\|csrf/);
});

test('3H9-BE-019 generate-word leftover abort-hold on live handler', () => {
  const src = read('src/routes/generate-document.js');
  assert.match(src, /3H9 leftover credit cancel/);
  assert.match(src, /attachAbortHoldOnClose\(req, res\)/);
});

test('3H9-BE-020 specialist leftover defaults are Flash', () => {
  const src = read('src/services/agents/code-review-agent.js');
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.doesNotMatch(src, /model = 'gpt-4o-mini'/);
});

test('3H9-BE native-llm still remaps leftover gpt-4o', () => {
  const native = require('../src/services/agent-runner/native-llm');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(native.FLASH, 'deepseek-v4-flash');
});
