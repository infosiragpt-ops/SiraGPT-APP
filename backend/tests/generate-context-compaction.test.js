'use strict';

// Source contract: the generate route must (1) replay only live rows after the
// summary cut, (2) fold older turns BEFORE assembling the prompt, (3) inject
// the summary as a protected system block, (4) persist the compaction on the
// assistant message, (5) schedule the pre-emptive pass, and message
// edit/delete must invalidate a summary that covered them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const ai = read('src', 'routes', 'ai.js');
const chats = read('src', 'routes', 'chats.js');
const kernel = read('src', 'services', 'prompt-kernel.js');
const allocator = read('src', 'services', 'prompt-budget-allocator.js');
const schema = read('prisma', 'schema.prisma');
const migration = read('prisma', 'migrations', '20260902030000_add_chat_context_summary', 'migration.sql');

test('history replay filters soft-deleted rows and everything the summary already covers', () => {
  assert.match(ai, /__chatContextState = await conversationCompactor\.loadChatSummaryState\(prisma, chatId\);/);
  assert.match(ai, /where: conversationCompactor\.historyWhere\(chatId, __chatContextState\),/);
  assert.match(ai, /select: \{ id: true, role: true, content: true, files: true, reasoningDetails: true, timestamp: true \}/);
});

test('compaction runs before the prompt is assembled and announces itself on the timeline', () => {
  const planAt = ai.indexOf('const __compactionPlan = conversationCompactor.planCompaction({');
  const loopAt = ai.indexOf('let messages = [systemInstruction];');
  assert.ok(planAt > 0 && loopAt > planAt, 'planning happens before the history is mapped into messages');
  assert.match(ai, /emitStage\(`Comprimiendo el contexto \(\$\{__compactionPlan\.rowsToCompact\.length\} mensajes\)`, \{ tool: 'compact' \}\);/);
  assert.match(ai, /emitStage\(`Contexto comprimido · \$\{__result\.coveredMessages\} mensajes resumidos`, \{ tool: 'compact' \}\);/);
  assert.match(ai, /historyMessages = __compactionPlan\.rowsToKeep;/);
  assert.match(ai, /if \(canPersist && !req\._miniShortChitchat && historyMessages\.length > 0\) \{/);
});

test('the summary is injected as a cacheable, protected system block', () => {
  assert.match(ai, /systemInstruction\.content \+= __summaryBlock;\s*systemBlocks\.push\(\{ kind: 'context-summary', text: __summaryBlock, cacheable: true \}\);/);
  assert.match(kernel, /'context-summary',\n\]\);/);
  assert.match(allocator, /'context-summary': 0,/);
});

test('the summariser is a non-streaming call on the request-scoped provider client', () => {
  assert.match(ai, /function buildCompactionCompletion\(runtime, req\) \{/);
  assert.match(ai, /createProviderClientForRequest\(runtime\.provider, req, \{ model: runtime\.model \}\)/);
  assert.match(ai, /stream: false,\s*\/\/ Meta reasoning tokens count against max_tokens/);
});

test('the compaction is persisted on the assistant message and a pre-emptive pass is scheduled', () => {
  assert.match(ai, /\.\.\.\(req\._contextCompaction \? \{ contextCompaction: req\._contextCompaction \} : \{\}\),/);
  assert.match(ai, /if \(canPersist && req\._contextCompactionPlan\?\.preemptive && !req\._contextCompaction\) \{[\s\S]{0,400}conversationCompactor\.maybeCompactInBackground\(\{/);
});

test('editing, deleting or clearing messages invalidates a summary that covered them', () => {
  assert.match(chats, /await conversationCompactor\.invalidateSummaryIfCovered\(\{ prisma: tx, chatId: messageToEdit\.chatId, timestamp: messageToEdit\.timestamp \}\);/);
  assert.match(chats, /await conversationCompactor\.invalidateSummaryIfCovered\(\{ prisma, chatId: message\.chatId, timestamp: message\.timestamp \}\);/);
  assert.match(chats, /title: 'New Chat',\s*updatedAt: new Date\(\),\s*contextSummary: null,\s*contextSummaryUntil: null,\s*contextSummaryMeta: null,/);
});

test('schema + migration carry the three nullable columns', () => {
  assert.match(schema, /contextSummary\s+String\?\s+@db\.Text @map\("context_summary"\)/);
  assert.match(schema, /contextSummaryUntil DateTime\? @map\("context_summary_until"\)/);
  assert.match(schema, /contextSummaryMeta\s+Json\?\s+@map\("context_summary_meta"\)/);
  assert.match(migration, /ALTER TABLE "chats" ADD COLUMN "context_summary" TEXT;/);
  assert.match(migration, /ALTER TABLE "chats" ADD COLUMN "context_summary_until" TIMESTAMP\(3\);/);
  assert.match(migration, /ALTER TABLE "chats" ADD COLUMN "context_summary_meta" JSONB;/);
});
