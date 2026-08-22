'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H7-BE-001 searchBrain llmClient is native DeepSeek, never OpenRouter', () => {
  const src = read('src/services/searchBrain/llmClient.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /hasUsableDeepSeekKey/);
  assert.match(src, /FLASH/);
  assert.doesNotMatch(src, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(src, /openrouter\.ai/);
  assert.doesNotMatch(src, /moonshotai\/kimi-k2\.6/);
  assert.doesNotMatch(src, /gpt-4o-mini/);
});

test('3H7-BE-002 grok-voice leftover OpenRouter generate is gone', () => {
  const src = read('src/services/grok-voice-model.js');
  assert.match(src, /hasUsableDeepSeekKey/);
  assert.match(src, /id: 'deepseek'/);
  assert.doesNotMatch(src, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(src, /openrouter\.ai/);
  assert.doesNotMatch(src, /DEFAULT_OPENROUTER_MODEL/);
  assert.match(src, /DEEPSEEK_API_KEY/);
});

test('3H7-BE-003 project-memory extract uses native DeepSeek', () => {
  const src = read('src/services/project-memory.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /hasUsableDeepSeekKey/);
  assert.match(src, /const MODEL = FLASH/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.doesNotMatch(src, /const MODEL = 'gpt-4o-mini'/);
});

test('3H7-BE-004 ai.js LTM/lexicon client is DeepSeek', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /memoryOpenAI = hasUsableDeepSeekKey\(\) \? createNativeDeepSeekClient\(\)/);
  assert.doesNotMatch(src, /const memoryOpenAI = new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
});

test('3H7-BE-005/006 LTM and lexicon models are Flash', () => {
  const ltm = read('src/services/long-term-memory.js');
  const lex = read('src/services/personal-lexicon.js');
  assert.match(ltm, /native-llm'\)\.FLASH/);
  assert.match(lex, /native-llm'\)\.FLASH/);
  assert.doesNotMatch(ltm, /model: 'gpt-4o-mini'/);
  assert.doesNotMatch(lex, /model: 'gpt-4o-mini'/);
});

test('3H7-BE-007 paraphrase charged path is DeepSeek', () => {
  const src = read('src/services/paraphrase-provider.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /provider: 'DeepSeek'/);
  assert.doesNotMatch(src, /cleanString\(env\.OPENAI_API_KEY\)/);
  assert.doesNotMatch(src, /provider: 'OpenAI'/);
});

test('3H7-BE-008 figma mermaid generate is DeepSeek', () => {
  const src = read('src/services/figma-service.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /model: FLASH/);
  assert.doesNotMatch(src, /new OpenAI\(\{/);
  assert.doesNotMatch(src, /model: 'gpt-4o'/);
});

test('3H7-BE-009 google-mcp live completions are DeepSeek', () => {
  const src = read('src/services/google-mcp.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /model: FLASH/);
  assert.match(src, /model: PRO/);
  assert.doesNotMatch(src, /require\('openai'\)/);
  assert.doesNotMatch(src, /model: "gpt-4o"/);
  assert.doesNotMatch(src, /model: "gpt-4o-mini"/);
});

test('3H7-BE-010 llm-reranker uses native DeepSeek', () => {
  const src = read('src/services/llm-reranker.js');
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /resolveNativeDeepSeekModel/);
  assert.doesNotMatch(src, /gpt-4o-mini/);
});

test('3H7-BE-011 triple-extractor defaults to Flash', () => {
  const src = read('src/services/triple-extractor.js');
  assert.equal((src.match(/native-llm'\)\.FLASH/g) || []).length >= 2, true);
  assert.doesNotMatch(src, /model = 'gpt-4o-mini'/);
});

test('3H7-BE-012 files/auto-file intent LLM is wired', () => {
  const files = read('src/routes/files.js');
  const bridge = read('src/services/auto-file-bridge.js');
  const intent = read('src/services/document-intent-analyzer.js');
  assert.match(files, /function makeIntentLlm/);
  assert.match(files, /analyzeBatch\(docs, intentLlm \? \{ llm: intentLlm \}/);
  assert.match(bridge, /analyzeSingleDocument\(/);
  assert.match(bridge, /intentLlm \? \{ llm: intentLlm \}/);
  assert.match(intent, /native-llm'\)\.FLASH/);
});

test('3H7-BE-013 vector-ppt generate is DeepSeek only', () => {
  const src = read('src/services/vector-ppt-service.js');
  assert.match(src, /createNativeDeepSeekClient/);
  assert.match(src, /resolveNativeDeepSeekModel/);
  assert.doesNotMatch(src, /generativelanguage\.googleapis\.com/);
  assert.doesNotMatch(src, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.doesNotMatch(src, /gemini-2\.0-flash-exp/);
  assert.doesNotMatch(src, /model = "gpt-4o"/);
});

test('3H7-BE-014/015 vision OCR/fileProcessor use DeepSeek', () => {
  const fp = read('src/services/fileProcessor.js');
  const ocr = read('src/services/ocr-engine.js');
  assert.match(fp, /hasUsableDeepSeekKey/);
  assert.match(fp, /createNativeDeepSeekClient/);
  assert.match(fp, /deepseek-vision/);
  assert.doesNotMatch(fp, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
  assert.match(ocr, /hasUsableDeepSeekKey/);
  assert.match(ocr, /createNativeDeepSeekClient/);
  assert.match(ocr, /native-llm'\)\.FLASH/);
  assert.doesNotMatch(ocr, /new OpenAI\(\{ apiKey: process\.env\.OPENAI_API_KEY \}\)/);
});

test('3H7-BE-016/017 rate-limit leftover generate + video cancel skip', () => {
  const src = read('src/middleware/rate-limit-policy.js');
  assert.match(src, /\/api\/projects/);
  assert.match(src, /\/api\/video/);
  assert.match(src, /\/api\/free-ia/);
  assert.match(src, /\/api\/builder/);
  assert.match(src, /\/api\/video\/cancel/);
});

test('3H7-BE-018/019 PII logger + health secret leftovers', () => {
  const log = read('src/services/observability/structured-logger.js');
  const health = read('src/services/observability/health-check.js');
  assert.match(log, /ruc/);
  assert.match(log, /dni/);
  assert.match(log, /cpf/);
  assert.match(log, /curp/);
  assert.match(log, /rfc/);
  assert.match(health, /AWS_SECRET/);
  assert.match(health, /DATABASE_URL/);
  assert.match(health, /REDIS_URL/);
  assert.match(health, /AKIA/);
});

test('3H7-BE-020/021 leftover audit console.warn uses ids not emails', () => {
  const auth = read('src/routes/auth.js');
  const pay = read('src/routes/payments.js');
  assert.match(auth, /impersonate_granted admin=\$\{req\.user\.id\} target=\$\{targetUser\.id\}/);
  assert.doesNotMatch(auth, /impersonate_granted admin=\$\{req\.user\.email\}/);
  assert.match(pay, /instant_subscription admin=\$\{req\.user\.id\} target=\$\{dbUser\.id\}/);
  assert.doesNotMatch(pay, /instant_subscription admin=\$\{req\.user\.email\}/);
});
