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
    validation: { passed: true, technicalScore: 100, qualityScore: 100 },
  });

  const metadataPath = INTERNAL.metadataPathFor(artifact.id);
  assert.equal(fs.existsSync(metadataPath), true);

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.ownerUserId, 'user-a');
  assert.equal(metadata.chatId, 'chat-a');
  assert.equal(metadata.filename, 'report.txt');
  assert.equal(metadata.validation.passed, true);
});

test('agent task artifacts: ids are scoped per owner and chat', () => {
  const payload = Buffer.from('same bytes').toString('base64');
  const first = saveArtifact({ filename: 'same.txt', base64: payload, ownerUserId: 'user-a', chatId: 'chat-a' });
  const second = saveArtifact({ filename: 'same.txt', base64: payload, ownerUserId: 'user-b', chatId: 'chat-a' });

  assert.notEqual(first.id, second.id);
});

test('agent task create_document: validates and returns artifact ids for downstream verification', async () => {
  const events = [];
  const result = await INTERNAL.createDocument.execute({
    filename: 'sources.csv',
    python: [
      'import os',
      'with open(os.environ["OUT_PATH"], "w", encoding="utf-8") as f:',
      '    f.write("Authors,Title,Year,DOI\\n")',
      '    f.write("A. Uno,Articulo real,2024,https://doi.org/10.1000/test\\n")',
    ].join('\n'),
    description: 'CSV verificable',
  }, {
    userId: 'user-a',
    chatId: 'chat-a',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifactId);
  assert.equal(result.id, result.artifactId);
  assert.equal(result.validation.passed, true);
  assert.ok(events.some((event) => event.type === 'file_artifact' && event.artifact.id === result.artifactId));

  const verify = await INTERNAL.verifyArtifact.execute({ artifactId: result.artifactId }, {
    onEvent: () => {},
  });
  assert.equal(verify.ok, true);
  assert.equal(verify.validation.passed, true);
  assert.deepEqual(verify.columns, ['Authors', 'Title', 'Year', 'DOI']);
});

test('agent task create_document: blocks invalid deliverables before artifact registration', async () => {
  const result = await INTERNAL.createDocument.execute({
    filename: 'broken.csv',
    python: [
      'import os',
      'with open(os.environ["OUT_PATH"], "w", encoding="utf-8") as f:',
      '    f.write("bad")',
    ].join('\n'),
  }, {
    userId: 'user-a',
    chatId: 'chat-a',
    onEvent: () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /artifact validation failed/);
  assert.equal(result.validation.passed, false);
});
