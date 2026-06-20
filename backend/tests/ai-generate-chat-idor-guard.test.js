'use strict';

/**
 * Regression guard for the read-side IDOR fix in `/api/ai/generate`
 * (backend/src/routes/ai.js).
 *
 * The generate handler is ~5k lines and keys many chat/message reads on
 * `chatId` ALONE (context prefetch with the linked custom-GPT knowledge
 * files + project documents/memories, plus the conversation-history loads).
 * Without an early ownership gate, an authenticated user could pass another
 * user's `chatId` and have that victim's history + project docs + custom-GPT
 * knowledge injected into their own generation — a cross-user confidentiality
 * leak. The WRITE side was already owner-scoped (saveChatAndTrackUsage uses
 * `{ id, userId }`); this guards the matching READ-side fix.
 *
 * We don't load the route (it pulls in Prisma + dozens of services). Like
 * `ai-route-gateway-migration.test.js`, we assert the wiring on the source so
 * it can't silently regress.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const src = fs.readFileSync(ROUTE_PATH, 'utf8');

test('generate handler has an early chat-ownership (IDOR) gate', () => {
  // The gate must select only the owner column for a cheap PK lookup.
  assert.match(
    src,
    /prisma\.chat\.findUnique\(\{\s*where:\s*\{\s*id:\s*chatId\s*\},\s*select:\s*\{\s*userId:\s*true\s*\}/,
    'ownership gate must look up the chat owner by id (select userId only)',
  );
});

test('gate rejects a foreign chat with 404 and aborts the stream', () => {
  // Pull the gate block and assert it compares owners and bails on mismatch.
  const gateIdx = src.indexOf('IDOR guard');
  assert.ok(gateIdx > -1, 'IDOR guard comment must be present');
  const gateBlock = src.slice(gateIdx, gateIdx + 1200);

  assert.match(
    gateBlock,
    /__chatOwner\s*&&\s*__chatOwner\.userId\s*!==\s*userId/,
    'gate must block when the persisted chat owner is a different user',
  );
  assert.match(
    gateBlock,
    /controller\.abort\(\)/,
    'gate must abort the in-flight stream controller on rejection',
  );
  assert.match(
    gateBlock,
    /res\.status\(404\)\.json\(/,
    'gate must respond 404 (matches the chats.js "Chat not found" convention)',
  );
});

test('gate only runs for persistable (authenticated + chatId) turns', () => {
  const gateIdx = src.indexOf('IDOR guard');
  const pre = src.slice(Math.max(0, gateIdx - 200), gateIdx + 1000);
  assert.match(
    pre,
    /if\s*\(canPersist\s*&&\s*chatId\)\s*\{/,
    'gate must be guarded by `canPersist && chatId` so anonymous / no-chat turns are unaffected',
  );
});

test('gate fails open on a transient DB error (no broken chats on a blip)', () => {
  const gateIdx = src.indexOf('IDOR guard');
  const gateBlock = src.slice(gateIdx, gateIdx + 1200);
  assert.match(
    gateBlock,
    /catch\s*\(\s*ownerErr\s*\)/,
    'gate must wrap the lookup in try/catch so a DB hiccup does not break generation',
  );
  // The catch must NOT itself return/throw a failure response — it logs and
  // continues, so a transient DB error degrades to the pre-fix behavior
  // rather than turning every generation into a 404.
  const catchIdx = gateBlock.indexOf('catch (ownerErr)');
  const catchBody = gateBlock.slice(catchIdx, catchIdx + 200);
  assert.doesNotMatch(
    catchBody,
    /res\.status\(/,
    'the catch handler must not send a failure response (fail-open, log only)',
  );
});
