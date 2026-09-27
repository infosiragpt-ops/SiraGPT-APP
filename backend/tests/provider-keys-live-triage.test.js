'use strict';

// Bugs surfaced by «Registros en vivo» (2026-09-27): provider clients frozen
// at module load, an unreadable admin-connection key logged as ERROR on every
// boot, and [models-dbg] printed as stderr on every picker open.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SDK_CTORS = /new\s+(OpenAI|AzureOpenAI|Anthropic|GoogleGenerativeAI|GoogleGenAI|Groq|Mistral|CohereClient|Replicate)\s*\(/;

test('keyedClient rebuilds only when the key changes; null without a key', () => {
  const { keyedClient } = require('../src/utils/env-keyed-client');
  let key = 'sk-a';
  let builds = 0;
  const get = keyedClient(() => key, (k) => { builds += 1; return { key: k }; });
  const a1 = get();
  const a2 = get();
  assert.equal(a1, a2);
  assert.equal(builds, 1);
  key = 'sk-b';
  const b = get();
  assert.notEqual(b, a1);
  assert.equal(b.key, 'sk-b');
  key = '';
  assert.equal(get(), null);
});

test('lazyClientProxy follows the current key, keeps `this`, and fails at call time without a key', async () => {
  const { lazyClientProxy } = require('../src/utils/env-keyed-client');
  let key = 'k1';
  class Fake {
    constructor(k) { this.k = k; this.chat = { completions: { create: async () => `answer:${k}` } }; }
    whoami() { return this.k; }
  }
  const client = lazyClientProxy(() => key, (k) => new Fake(k), { missingKeyMessage: 'OPENAI_API_KEY no configurada' });
  assert.equal(await client.chat.completions.create({}), 'answer:k1');
  assert.equal(client.whoami(), 'k1');
  key = 'k2';
  assert.equal(await client.chat.completions.create({}), 'answer:k2', 'a key swapped by the admin bridge is used on the next call');
  assert.equal(client.then, undefined, 'never a thenable');
  key = '';
  assert.throws(() => client.chat, (err) => err.code === 'provider_key_missing' && /no configurada/.test(err.message));
});

test('no provider SDK client is frozen at module load or in a singleton constructor', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/^(const|let|var)\s+\w+\s*=\s*/.test(line) || !SDK_CTORS.test(line)) return;
      // Lazy wrappers build the client per current key — that's the fix.
      if (/\b(lazyClientProxy|keyedClient)\(/.test(line)) return;
      const block = lines.slice(i, i + 8).join('\n');
      if (/process\.env\.[A-Z0-9_]*(API_KEY|_KEY)/.test(block)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
    });
    if (/module\.exports\s*=\s*new\s+\w+\s*\(/.test(src) && /this\.\w+\s*=\s*new\s+(OpenAI|Anthropic|GoogleGenerativeAI|GoogleGenAI)\s*\(\s*\{\s*apiKey:\s*process\.env/.test(src)) {
      offenders.push(`${path.relative(SRC, file)} (singleton constructor)`);
    }
  }
  assert.deepEqual(offenders, [], `clients built with the key present at require time: ${offenders.join(', ')}`);
});

test('first-use memoised clients are keyed by the current key (admin-connections bridge swaps keys at runtime)', () => {
  const memoised = [
    'services/agents/providers/openai-adapter.js',
    'services/agents/providers/gemini-adapter.js',
    'services/providers/anthropic-native.js',
    'services/providers/anthropic-citations.js',
  ];
  for (const rel of memoised) {
    const src = read(rel);
    assert.match(src, /let _clientKeyFp = null;/, rel);
    assert.match(src, /if \(_client && _clientKeyFp === fp\) return _client;/, rel);
    assert.match(src, /_clientKeyFp = fp;/, rel);
  }
  assert.match(read('services/ai-service.js'), /__anthropicSummarizerKeyFp === fp/);
  assert.match(read('services/ai/elevenlabs-tts.js'), /cachedClientKeyFp !== fp/);
  assert.match(read('services/searchBrain/llmClient.js'), /cachedClientSignature === signature/);
  assert.doesNotMatch(read('routes/ai.js'), /const __corefJudge = makeGeminiCorefJudge\(\);/);
  assert.match(read('routes/ai.js'), /judge: makeGeminiCorefJudge\(\),/);
});

test('searchBrain client really rebuilds when the key changes', () => {
  const llm = require('../src/services/searchBrain/llmClient');
  const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  try {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-first';
    llm.__resetClient();
    const first = llm.getClient();
    assert.equal(llm.getClient(), first, 'same key → same client');
    process.env.OPENAI_API_KEY = 'sk-test-second';
    const second = llm.getClient();
    assert.notEqual(second, first);
    assert.equal(second.apiKey, 'sk-test-second');
    delete process.env.OPENAI_API_KEY;
    assert.equal(llm.getClient(), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    llm.__resetClient();
  }
});

test('file uploads never wait for OpenAI Files, and a rejected key is skipped quietly', () => {
  const src = read('routes/files.js');
  assert.match(src, /const getFilesOpenAI = keyedClient\(\(\) => process\.env\.OPENAI_API_KEY/);
  assert.doesNotMatch(src, /^const openai = new OpenAI\(/m);
  // Not part of the awaited extraction/thumbnail race any more.
  assert.doesNotMatch(src, /uploadToOpenAiFiles\(file\),\s*\]\);/);
  assert.doesNotMatch(src, /const openaiFileId = await uploadToOpenAiFiles\(file\);/);
  assert.equal((src.match(/scheduleOpenAiFilesUpload\(prismaClient, fileRecord\.id, file\);/g) || []).length, 2, 'sync and async paths');
  assert.match(src, /providerKeyHealth\.isRejected\('openai', apiKey\)/);
  assert.match(src, /providerKeyHealth\.markRejected\('openai', apiKey, openaiError\)/);
  assert.doesNotMatch(src, /console\.error\('OpenAI file upload error:'/);
  for (const handler of ['getOrComputeFileSummary', 'decomposeQuery', 'deepAskFile']) {
    const idx = src.indexOf(handler);
    assert.ok(idx > 0, handler);
    assert.match(src.slice(idx, idx + 200), /openai: getFilesOpenAI\(\)/, handler);
  }
});

test('an undecryptable admin-connection key warns once per row — never an ERROR per boot', () => {
  if (!/^[0-9a-f]{64}$/i.test(String(process.env.ENCRYPTION_KEY || ''))) process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  const bridge = require('../src/services/admin-connections-bridge');
  const warnings = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    bridge.noteUndecryptableKey({ id: 'cmqcx5iq60086qu01reh6e8fk', providerKey: 'anthropic' });
    bridge.noteUndecryptableKey({ id: 'cmqcx5iq60086qu01reh6e8fk', providerKey: 'anthropic' });
    bridge.noteUndecryptableKey({ id: 'other-row', providerKey: 'openai' });
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  assert.equal(warnings.length, 2, 'once per row');
  assert.match(warnings[0], /clave ilegible en la conexión cmqcx5iq60086qu01reh6e8fk \(anthropic\)/);
  assert.equal(errors.length, 0);
  const bridgeSrc = read('services/admin-connections-bridge.js');
  assert.doesNotMatch(bridgeSrc, /console\.error\('\[admin-connections-bridge\] decrypt failed/);
  assert.match(bridgeSrc, /select: \{ id: true, providerKey: true, apiKey: true, updatedAt: true \}/);
});

test('Admin → Conexiones exposes keyReadable:false and «Probar» explains an unreadable key', () => {
  const route = read('routes/admin-connections.js');
  assert.match(route, /keyReadable: c\.apiKey \? plain != null : null,/);
  assert.match(route, /Clave ilegible — vuelve a guardarla\./);
  const testIdx = route.indexOf("router.post('/:id/test'");
  const guardIdx = route.indexOf('if (conn.apiKey && decryptKey(conn.apiKey, conn) == null)', testIdx);
  const syncIdx = route.indexOf('modelSyncService.syncConnectionModels', testIdx);
  assert.ok(guardIdx > testIdx && guardIdx < syncIdx, 'unreadable key answered before probing the provider');
  assert.doesNotMatch(route, /console\.error\('\[admin-connections\] decryptKey failed/);
  const page = fs.readFileSync(path.join(__dirname, '../../app/admin/connections/page.tsx'), 'utf8');
  assert.match(page, /c\.apiKeySet && c\.keyReadable === false \?/);
  assert.match(page, /Clave ilegible — vuelve a guardarla/);
});

test('[models-dbg] is opt-in debug output, never stderr on every picker open', () => {
  const ai = read('routes/ai.js');
  assert.doesNotMatch(ai, /console\.error\(`\[models-dbg\]/);
  assert.match(ai, /const __dbgOn = String\(process\.env\.SIRAGPT_MODELS_DEBUG \|\| ''\)\.trim\(\) === '1';/);
  assert.match(ai, /if \(!__dbgOn\) return; try \{ console\.debug\(`\[models-dbg\]/);
});
