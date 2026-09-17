'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H10-BE-001 task-contract leftover generate is native DeepSeek', () => {
  const src = read('src/services/agents/task-contract-resolver.js');
  assert.match(src, /3H10 leftover candado: live agent-task contract generate is native DeepSeek/);
  assert.match(src, /model = require\("\.\.\/agent-runner\/native-llm"\)\.FLASH/);
  assert.match(src, /createNativeDeepSeekClient\(\)/);
  assert.doesNotMatch(src, /model = "gpt-4o-mini"/);
});

test('3H10-BE-002 align-wrapper leftover default is Flash', () => {
  const src = read('src/services/agents/align-wrapper.js');
  assert.match(src, /DEFAULT_ALIGN_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.doesNotMatch(src, /DEFAULT_ALIGN_MODEL = 'gpt-4o-mini'/);
});

test('3H10-BE-003 prompt-taxonomy leftover default is Flash', () => {
  const src = read('src/services/agents/prompt-taxonomy.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H10-BE-004 best-of-n leftover default is Flash', () => {
  const src = read('src/services/agents/best-of-n.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H10-BE-005 collaboration leftover judge\/model is Flash', () => {
  const src = read('src/services/agents/agent-collaboration.js');
  assert.match(src, /judgeModel = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("judgeModel = 'gpt-4o-mini'"), false);
  assert.equal(src.includes("model = 'gpt-4o-mini'"), false);
});

test('3H10-BE-006 graphrag leftover defaults are Flash', () => {
  for (const rel of [
    'src/services/agents/graphrag/community-summaries.js',
    'src/services/agents/graphrag/map-reduce-qa.js',
    'src/services/agents/graphrag/eval-criteria.js',
    'src/services/agents/graphrag/adaptive-benchmark.js',
  ]) {
    const src = read(rel);
    assert.match(src, /native-llm'\)\.FLASH/, rel);
    assert.doesNotMatch(src, /DEFAULT_MODEL = 'gpt-4o-mini'/, rel);
  }
});

test('3H10-BE-007 mbpp\/humaneval leftover defaults are Flash', () => {
  const mbpp = read('src/services/agents/benchmarks/mbpp.js');
  const he = read('src/services/agents/benchmarks/humaneval.js');
  assert.match(mbpp, /model = require\('\.\.\/\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.match(he, /model = require\('\.\.\/\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(mbpp.includes("model = 'gpt-4o-mini'"), false);
  assert.equal(he.includes("model = 'gpt-4o-mini'"), false);
});

test('3H10-BE-008 appshots leftover capture model is DeepSeek', () => {
  const src = read('src/routes/appshots.js');
  assert.match(src, /3H10 leftover/);
  assert.match(src, /resolveNativeDeepSeekModel\(sanitiseModel/);
  assert.doesNotMatch(src, /\|\| 'gpt-4o-mini'/);
});

test('3H10-BE-009 duplicate-turn leftover SSE ids', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /3H10 leftover SSE ids/);
  assert.match(src, /duplicate_turn_replay/);
  const idx = src.indexOf('type: \'duplicate_turn_replay\'');
  const window = src.slice(Math.max(0, idx - 600), idx);
  assert.match(window, /attachSseIds/);
});

test('3H10-BE-010 public-web replay leftover SSE ids', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /3H10 leftover public-web replay SSE ids/);
});

test('3H10-BE-011 turn-events leftover end id', () => {
  const src = read('src/services/sira/turn-events.js');
  assert.match(src, /3H10 leftover SSE id on end/);
  assert.match(src, /id: \$\{sseSeq\}\\nevent: _end/);
});

test('3H10-BE-012 gateway events leftover attachSseIds', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /attachSseIds\(res, req, \{ resume: true \}\)/);
});

test('3H10-BE-013 waitForRun leftover user scoping', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /3H10 leftover: wait must not leak another user's in-flight generate/);
  assert.match(src, /waitForRun\(params\.runId, params\.timeoutMs, conn\.userId \|\| params\.userId\)/);
});

test('3H10-BE-014 HTTP wait leftover user_required', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /3H10 leftover: HTTP wait fail-closed/);
  assert.match(src, /waitForRun\(runId, body\.timeoutMs, userId\)/);
});

test('3H10-BE-015 HTTP events leftover user_required \+ owner', () => {
  const src = read('src/services/agent-gateway/http.js');
  assert.match(src, /3H10 leftover: SSE subscribe fail-closed/);
  assert.match(src, /gateway\.getSession && gateway\.getSession\(sessionKey\)/);
  assert.match(src, /code: 'forbidden'/);
});

test('3H10-BE-016 abort leftover DLQ', () => {
  const src = read('src/services/agent-gateway/index.js');
  assert.match(src, /3H10 leftover abort DLQ/);
  assert.match(src, /error: 'user_abort'/);
});

test('3H10-BE-017 rate-limit leftover generate paths', () => {
  const { isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/appshots/capture'), true);
  assert.equal(isSharedGenerateAgentPath('/api/code-runner/exec'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
});

test('3H10-BE-018 rate-limit leftover stop skips', () => {
  const { isStopStreamPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isStopStreamPath('/api/sandbox/session/abc/abort'), true);
  assert.equal(isStopStreamPath('/api/sandbox/session/abc/stop'), true);
  assert.equal(isStopStreamPath('/api/agent/task/abc/abort'), true);
  assert.equal(isStopStreamPath('/api/doc/xyz/abort'), true);
  assert.equal(isStopStreamPath('/api/ai/abort'), true);
  assert.equal(isStopStreamPath('/api/cowork/abort'), true);
  assert.equal(isStopStreamPath('/api/thesis/1/abort'), true);
  assert.equal(isStopStreamPath('/api/plan/1/abort'), true);
  assert.equal(isStopStreamPath('/api/apps-ai/stop'), true);
  assert.equal(isStopStreamPath('/api/ai/generate'), false);
});

test('3H10-BE-019 PII leftover camelCase \/ x-api-key \/ otp', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /accesstoken/);
  assert.match(src, /x\[_-]\?api\[_-]\?key/);
  assert.match(src, /xsrf/);
  assert.match(src, /otp/);
  assert.match(src, /totp/);
  const { PII_KEY_RE } = require('../src/services/observability/structured-logger');
  assert.equal(PII_KEY_RE.test('accessToken'), true);
  assert.equal(PII_KEY_RE.test('x-api-key'), true);
  assert.equal(PII_KEY_RE.test('otp'), true);
});

test('3H10-BE-020 health leftover secret shapes', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /xsrf\|otp\|totp/);
  assert.match(src, /3H10 leftover/);
});

test('3H10-BE-021 sandbox leftover owner check', () => {
  const src = read('src/routes/sandbox.js');
  assert.match(src, /3H10 leftover: live sandbox handlers must not leak/);
  assert.match(src, /function assertOwnedSession/);
  assert.match(src, /error: 'forbidden'/);
  assert.match(src, /error: 'user_required'/);
});

test('3H10-BE-022 sandbox leftover abort\/stop handlers', () => {
  const src = read('src/routes/sandbox.js');
  assert.match(src, /3H10 leftover sandbox abort/);
  assert.match(src, /router\.post\('\/session\/:id\/abort'/);
  assert.match(src, /router\.post\('\/session\/:id\/stop'/);
});

test('3H10-BE native-llm still remaps leftover gpt-4o', () => {
  const native = require('../src/services/agent-runner/native-llm');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(native.FLASH, 'deepseek-v4-flash');
});
