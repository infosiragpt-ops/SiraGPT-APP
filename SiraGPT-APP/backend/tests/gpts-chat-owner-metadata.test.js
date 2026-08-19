const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readBackendSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('custom GPT chat responses include creator metadata for owner-only UI gates', () => {
  const gptsRoutes = readBackendSource('src/routes/gpts.js');
  const chatsRoutes = readBackendSource('src/routes/chats.js');

  assert.match(
    gptsRoutes,
    /customGpt:\s*\{\s*select:\s*\{[\s\S]*creatorId:\s*true[\s\S]*visibility:\s*true[\s\S]*shareId:\s*true/,
    'new GPT chats should include creatorId, visibility, and shareId'
  );

  assert.match(
    chatsRoutes,
    /customGpt:\s*\{\s*select:\s*\{[\s\S]*creatorId:\s*true[\s\S]*visibility:\s*true[\s\S]*shareId:\s*true/,
    'chat fetches should include creatorId, visibility, and shareId'
  );
});
