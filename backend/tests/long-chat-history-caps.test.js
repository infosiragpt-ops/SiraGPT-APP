'use strict';

/**
 * Long chats: the prompt replayed to the model grew with the conversation
 * (every historical image inlined as base64 on every turn, every historical
 * attachment with its full text, the understanding stack over 80 uncapped
 * rows) and GET /api/chats/:id shipped the signed reasoning chain the client
 * never reads. Source contract for the caps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');

test('only the newest image rows keep their pixels; older rows become a named stub', () => {
  assert.match(route, /const HISTORY_INLINE_IMAGE_ROWS = Number\(process\.env\.SIRAGPT_HISTORY_INLINE_IMAGE_ROWS\) >= 0/);
  assert.match(route, /const inlineImageRows = historyRowsWithInlineImages\(historyMessages, isHistoryImageAttachment\);/);
  assert.match(route, /const imageFiles = currentTurnHasNonImageFiles \|\| !imagesInlineForRow \? \[\] : historicalImageFiles;/);
  assert.match(route, /imagen\(es\) adjunta\(s\) anteriormente/);
  // The loop iterates with the row index so the keep-set can be consulted.
  assert.match(route, /for \(const \[historyIndex, m\] of historyMessages\.entries\(\)\)/);
});

test('historical attachment text is capped on both the vision and the text branch', () => {
  const uses = route.match(/capHistoryAttachmentText\(preparedContent \|\| f\.extractedText \|\| messageAttachments\.describeUnextractedAttachment\(f\)\)/g) || [];
  assert.equal(uses.length, 2);
  assert.match(route, /SIRAGPT_HISTORY_ATTACHMENT_TEXT_MAX_CHARS/);
  assert.match(route, /texto recortado en el historial/);
});

test('the understanding stack sees capped rows (recent rows keep more than old ones)', () => {
  assert.match(route, /capUnderstandingHistoryContent\(m\.content \|\| '', __historyRows\.length - index <= UNDERSTANDING_RECENT_ROWS\)/);
  assert.match(route, /SIRAGPT_UNDERSTANDING_RECENT_MAX_CHARS/);
  assert.match(route, /SIRAGPT_UNDERSTANDING_OLD_MAX_CHARS/);
});

test('cap helpers: 0 disables, otherwise head + marker', () => {
  const helper = route.slice(route.indexOf('function capHistoryAttachmentText('), route.indexOf('function historyRowsWithInlineImages('));
  assert.match(helper, /if \(!HISTORY_ATTACHMENT_TEXT_MAX_CHARS \|\| value\.length <= HISTORY_ATTACHMENT_TEXT_MAX_CHARS\) return value;/);
  const rows = route.slice(route.indexOf('function historyRowsWithInlineImages('), route.indexOf('function historyRowsWithInlineImages(') + 700);
  assert.match(rows, /if \(!HISTORY_INLINE_IMAGE_ROWS\) return keep;/);
  assert.match(rows, /keep\.size < HISTORY_INLINE_IMAGE_ROWS/);
});

test('GET /api/chats/:id drops reasoningDetails before responding', () => {
  const chats = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chats.js'), 'utf8');
  const at = chats.indexOf("'reasoningDetails' in message) delete message.reasoningDetails;");
  assert.ok(at > 0);
  const block = chats.slice(at - 600, at + 400);
  assert.match(block, /const serializedChat = serializeChat\(chat\);/);
  assert.match(block, /hydrateChatMessageAttachments\(prisma, \{/);
});
