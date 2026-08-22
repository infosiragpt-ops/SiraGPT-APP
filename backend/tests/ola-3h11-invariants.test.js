'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('3H11-BE-001 rag route leftover generate is native DeepSeek', () => {
  const src = read('src/routes/rag.js');
  assert.match(src, /3H11 leftover candado: live RAG generate is native DeepSeek/);
  assert.match(src, /function requireDeepSeek\(res\)/);
  assert.match(src, /createNativeDeepSeekClient\(\)/);
  assert.match(src, /function clampRagModel\(model\)/);
  assert.equal(src.includes("error: 'OPENAI_API_KEY not configured'"), false);
  assert.match(src, /rerankOpenAI = req\.body\.rerank \? rag\.getOpenAI\(\)/);
  assert.match(src, /graphOpenAI: req\.body\.useGraph \? rag\.getOpenAI\(\)/);
});

test('3H11-BE-002 query-transforms leftover default is Flash', () => {
  const src = read('src/services/rag/query-transforms.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("model = 'gpt-4o-mini'"), false);
});

test('3H11-BE-003 rewrite-retrieve-read leftover default is Flash', () => {
  const src = read('src/services/rag/rewrite-retrieve-read.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("DEFAULT_MODEL = 'gpt-4o-mini'"), false);
});

test('3H11-BE-004 generate-then-read leftover default is Flash', () => {
  const src = read('src/services/rag/generate-then-read.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-005 abstractive-compressor leftover default is Flash', () => {
  const src = read('src/services/rag/abstractive-compressor.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-006 raptor-tree leftover default is Flash', () => {
  const src = read('src/services/rag/raptor-tree.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("model = 'gpt-4o-mini'"), false);
});

test('3H11-BE-007 factscore leftover default is Flash', () => {
  const src = read('src/services/rag/factscore.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("model = 'gpt-4o-mini'"), false);
});

test('3H11-BE-008 ares-eval leftover default is Flash', () => {
  const src = read('src/services/rag/ares-eval.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-009 metadata-router leftover default is Flash', () => {
  const src = read('src/services/rag/metadata-router.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-010 proposition-indexer leftover default is Flash', () => {
  const src = read('src/services/rag/proposition-indexer.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-011 citation-metrics leftover default is Flash', () => {
  const src = read('src/services/rag/citation-metrics.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-012 self-rag-engine leftover default is Flash', () => {
  const src = read('src/services/rag/self-rag-engine.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("model = 'gpt-4o-mini'"), false);
});

test('3H11-BE-013 self-rag-critic leftover default is Flash', () => {
  const src = read('src/services/rag/self-rag-critic.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-014 iterative-retgen leftover default is Flash', () => {
  const src = read('src/services/rag/iterative-retgen.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-015 advanced-patterns leftover default is Flash', () => {
  const src = read('src/services/rag/advanced-patterns.js');
  assert.match(src, /model = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
});

test('3H11-BE-016 context-curation leftover default is Flash', () => {
  const src = read('src/services/rag/context-curation.js');
  assert.match(src, /DEFAULT_NOTE_MODEL = require\('\.\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("DEFAULT_NOTE_MODEL = 'gpt-4o-mini'"), false);
});

test('3H11-BE-017 nli-faithfulness leftover default is Flash', () => {
  const src = read('src/services/rag/nli-faithfulness.js');
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.equal(src.includes("|| 'gpt-4o-mini'"), false);
});

test('3H11-BE-018 gear-agent leftover default is Flash', () => {
  const src = read('src/services/gear-agent.js');
  assert.match(src, /model = require\('\.\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("model = 'gpt-4o-mini'"), false);
});

test('3H11-BE-019 remaining se-agents benchmarks leftover defaults are Flash', () => {
  for (const rel of [
    'src/services/agents/benchmarks/closed-domain-hallucination.js',
    'src/services/agents/benchmarks/bias-eval.js',
    'src/services/agents/benchmarks/real-toxicity.js',
    'src/services/agents/benchmarks/alignment-tax.js',
    'src/services/agents/benchmarks/truthful-qa.js',
  ]) {
    const src = read(rel);
    assert.match(src, /DEFAULT_MODEL = require\('\.\.\/\.\.\/agent-runner\/native-llm'\)\.FLASH/, rel);
    assert.equal(src.includes("DEFAULT_MODEL = 'gpt-4o-mini'"), false, rel);
  }
});

test('3H11-BE-020 session_spawn leftover default is Flash', () => {
  const src = read('src/skills/session_spawn/handler.js');
  assert.match(src, /DEFAULT_MODEL = require\('\.\.\/\.\.\/services\/agent-runner\/native-llm'\)\.FLASH/);
  assert.equal(src.includes("DEFAULT_MODEL = 'gpt-4o'"), false);
});

test('3H11-BE-021 summarize skill leftover default is Flash', () => {
  const src = read('src/skills/summarize/handler.js');
  assert.match(src, /native-llm'\)\.FLASH/);
  assert.equal(src.includes("|| 'gpt-4o-mini'"), false);
});

test('3H11-BE-022 rate-limit leftover generate paths', () => {
  const { isSharedGenerateAgentPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isSharedGenerateAgentPath('/api/chats/abc/messages'), true);
  assert.equal(isSharedGenerateAgentPath('/api/social-posts/generate'), true);
  assert.equal(isSharedGenerateAgentPath('/api/dept-computer/run'), true);
  assert.equal(isSharedGenerateAgentPath('/api/skills/summarize'), true);
  assert.equal(isSharedGenerateAgentPath('/api/document-collections/ingest'), true);
  assert.equal(isSharedGenerateAgentPath('/api/project-documents/x'), true);
  assert.equal(isSharedGenerateAgentPath('/api/cowork-ai/control'), true);
  assert.equal(isSharedGenerateAgentPath('/api/attribution/explain'), true);
  assert.equal(isSharedGenerateAgentPath('/api/scheduler/tick'), true);
  assert.equal(isSharedGenerateAgentPath('/api/rag/self-rag-engine'), true);
  assert.equal(isSharedGenerateAgentPath('/api/ai/generate'), true);
});

test('3H11-BE-023 rate-limit leftover stop skips', () => {
  const { isStopStreamPath } = require('../src/middleware/rate-limit-policy');
  assert.equal(isStopStreamPath('/api/social-posts/abc/cancel'), true);
  assert.equal(isStopStreamPath('/api/se-agents/x/abort'), true);
  assert.equal(isStopStreamPath('/api/memory/abort'), true);
  assert.equal(isStopStreamPath('/api/research/1/abort'), true);
  assert.equal(isStopStreamPath('/api/orchestration/stop'), true);
  assert.equal(isStopStreamPath('/api/builder/abort'), true);
  assert.equal(isStopStreamPath('/api/design/abort'), true);
  assert.equal(isStopStreamPath('/api/gpts/abort'), true);
  assert.equal(isStopStreamPath('/api/figma/stop'), true);
  assert.equal(isStopStreamPath('/api/rag/abort'), true);
  assert.equal(isStopStreamPath('/api/search/abort'), true);
  assert.equal(isStopStreamPath('/api/dept-computer/stop'), true);
  assert.equal(isStopStreamPath('/api/skills/abort'), true);
  assert.equal(isStopStreamPath('/api/ai/generate'), false);
});

test('3H11-BE-024 PII leftover privatekey \/ mfa \/ oauth \/ fal', () => {
  const src = read('src/services/observability/structured-logger.js');
  assert.match(src, /privatekey/);
  assert.match(src, /apikey/);
  assert.match(src, /setcookie/);
  assert.match(src, /mfa/);
  assert.match(src, /2fa/);
  assert.match(src, /oauth\[_-]\?token/);
  assert.match(src, /fal\[_-]\?key/);
  assert.match(src, /3H11 leftover PII/);
});

test('3H11-BE-025 health secrets leftover privatekey \/ mfa \/ fal', () => {
  const src = read('src/services/observability/health-check.js');
  assert.match(src, /3H11 leftover/);
  assert.match(src, /privatekey/);
  assert.match(src, /fal\[_-]\?key/);
  assert.match(src, /r2\[_-]\?access/);
});
