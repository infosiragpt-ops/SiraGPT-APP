const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-artifacts-'));

const { saveArtifact, INTERNAL } = require('../src/services/agents/task-tools');

test('agent task artifacts: writes owner metadata next to each file', () => {
  const artifact = saveArtifact({
    filename: 'report.txt',
    base64: Buffer.from('private report').toString('base64'),
    mime: 'text/plain',
    ownerUserId: 'user-a',
    chatId: 'chat-a',
  });

  const metadataPath = INTERNAL.metadataPathFor(artifact.id);
  assert.equal(fs.existsSync(metadataPath), true);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.ownerUserId, 'user-a');
  assert.equal(metadata.chatId, 'chat-a');
  assert.equal(metadata.filename, 'report.txt');
});

test('agent task artifacts: ids are scoped per owner and chat', () => {
  const payload = Buffer.from('same bytes').toString('base64');
  const first = saveArtifact({ filename: 'same.txt', base64: payload, ownerUserId: 'user-a', chatId: 'chat-a' });
  const second = saveArtifact({ filename: 'same.txt', base64: payload, ownerUserId: 'user-b', chatId: 'chat-a' });

  assert.notEqual(first.id, second.id);
});
