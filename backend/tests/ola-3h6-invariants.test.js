'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H6-BE research generate is DeepSeek; no OPENAI key gate', () => {
  const src = read('src/routes/research.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /DEEPSEEK_API_KEY not configured/);
  assert.doesNotMatch(src, /OPENAI_API_KEY not configured/);
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.match(src, /native-llm'\)\.PRO/);
  assert.match(src, /searchClient/);
});

test('3H6-BE thesis generate uses native DeepSeek client', () => {
  const src = read('src/routes/thesis.js');
  assert.match(src, /function getThesisClient/);
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /deepseek-v4-flash/);
  assert.match(src, /deepseek-v4-pro/);
  assert.doesNotMatch(src, /const openai = new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
});

test('3H6-BE api /chat/completions DeepSeek only, no Gemini hop', () => {
  const src = read('src/routes/api.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /resolveNativeDeepSeekModel/);
  assert.doesNotMatch(src, /gemini-2\.5-pro/);
  assert.doesNotMatch(src, /generativelanguage\.googleapis\.com/);
});

test('3H6-BE gpts preview never OpenAI/OpenRouter', () => {
  const src = read('src/routes/gpts.js');
  assert.match(src, /function resolvePreviewClient/);
  assert.match(src, /createNativeDeepSeekClient/);
  assert.doesNotMatch(src, /openrouter\.ai/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.doesNotMatch(src, /OPENROUTER_API_KEY/);
});

test('3H6-BE cowork headless default is DeepSeek', () => {
  const src = read('src/services/cowork/headless-runner.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /provider: 'DeepSeek'/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.doesNotMatch(src, /gpt-4o-mini/);
});

test('3H6-BE cowork scheduler chat model is Flash', () => {
  const src = read('src/services/cowork/scheduler.js');
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.doesNotMatch(src, /gpt-4o-mini/);
});

test('3H6-BE se-agents live completions use DeepSeek client', () => {
  const src = read('src/routes/se-agents.js');
  assert.match(src, /function requireDeepSeek/);
  assert.match(src, /ds\.chat\.completions\.create/);
  assert.equal((src.match(/model: 'gpt-4o-mini'/g) || []).length, 0);
  assert.doesNotMatch(src, /openai\.chat\.completions\.create\(\{\s*model: require\('\.\.\/services\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H6-BE summarizer/decomposer default Flash', () => {
  const sum = read('src/services/document-summarizer.js');
  const dec = read('src/services/rag/query-decomposer.js');
  assert.match(sum, /SIRAGPT_DOC_SUMMARIZER_MODEL/);
  assert.match(sum, /native-llm'\)\.FLASH/);
  assert.match(dec, /SIRAGPT_DECOMPOSER_MODEL/);
  assert.match(dec, /native-llm'\)\.FLASH/);
  assert.match(sum, /DEFAULT_MODEL = process\.env\.SIRAGPT_DOC_SUMMARIZER_MODEL/);
  assert.match(dec, /DEFAULT_MODEL = process\.env\.SIRAGPT_DECOMPOSER_MODEL/);
});

test('3H6-BE files summary/decompose pass DeepSeek client', () => {
  const src = read('src/routes/files.js');
  assert.match(src, /function getFileLlm/);
  assert.match(src, /openai: getFileLlm\(\)/);
  assert.match(src, /createNativeDeepSeekClient/);
});

test('3H6-BE computer-use generate is DeepSeek', () => {
  const src = read('src/routes/computer-use.js');
  assert.match(src, /function getComputerUseClient/);
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.match(src, /native-llm'\)\.PRO/);
  assert.doesNotMatch(src, /apiKey: process\.env\.OPENAI_API_KEY/);
});

test('3H6-BE rag /rgb generate is DeepSeek', () => {
  const src = read('src/routes/rag.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /DEEPSEEK_API_KEY not configured/);
  assert.match(src, /resolveNativeDeepSeekModel\(req\.body\.model\)/);
});

test('3H6-BE projects chat default clamps to DeepSeek', () => {
  const src = read('src/routes/projects.js');
  assert.match(src, /resolveNativeDeepSeekModel\(req\.body\.model\)/);
  assert.doesNotMatch(src, /req\.body\.model \|\| 'gpt-4o'/);
});

test('3H6-BE synthetic-ping defaults to native DeepSeek', () => {
  const src = read('src/health/probes/synthetic-ping.js');
  assert.match(src, /api\.deepseek\.com/);
  assert.match(src, /deepseek-v4-flash/);
  assert.match(src, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(src, /api\.openai\.com\/v1/);
});

test('3H6-BE rate-limit leftover generate-adjacent paths', () => {
  const src = read('src/middleware/rate-limit-policy.js');
  assert.match(src, /\/api\/files/);
  assert.match(src, /\/api\/rag/);
  assert.match(src, /\/api\/scientific-search/);
});

test('3H6-BE structured-logger leftover PII keys', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /tax\[_-]\?id/);
  assert.match(src, /driver\[_-]\?license/);
  assert.match(src, /bank\[_-]\?account/);
  assert.match(src, /swift/);
});

test('3H6-BE health secrets leftover vendor keys', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /ANTHROPIC_API_KEY/);
  assert.match(src, /HUGGINGFACE_API_TOKEN/);
  assert.match(src, /ELEVENLABS_API_KEY/);
  assert.match(src, /elevenlabs/);
});

test('3H6-BE EDIT_TOOLS leftover live office tools', () => {
  const src = read('src/services/agent-runner/verify.js');
  assert.match(src, /set_slide_notes/);
  assert.match(src, /insert_textbox/);
  assert.match(src, /insert_shape/);
  assert.match(src, /delete_row/);
  assert.match(src, /delete_column/);
});

test('3H6-BE native-llm still remaps leftover gpt-4o', () => {
  const native = require('../src/services/agent-runner/native-llm');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o'), 'deepseek-v4-flash');
  assert.equal(native.resolveNativeDeepSeekModel('gpt-4o-mini'), 'deepseek-v4-flash');
  assert.equal(native.resolveNativeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});

test('3H6-BE rate-limit helper still classifies leftover paths', () => {
  const { isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/files/abc/summary'), true);
  assert.equal(isSharedGenerateAgentPath('/api/rag/rgb'), true);
  assert.equal(isSharedGenerateAgentPath('/api/scientific-search'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
});
