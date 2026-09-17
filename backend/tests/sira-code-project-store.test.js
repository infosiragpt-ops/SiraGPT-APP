'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const siraCode = require('../src/services/sira-code');
const { destroySession, getSession } = require('../src/services/sira-code/session-store');
const { projectDir } = require('../src/services/sira-code/project-store');

let persistRoot;

async function persistEnv() {
  if (!persistRoot) {
    persistRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-code-persist-'));
  }
  return { SIRAGPT_SIRACODE_PROJECTS_DIR: persistRoot };
}

after(async () => {
  siraCode._resetForTests();
  if (persistRoot) await fs.rm(persistRoot, { recursive: true, force: true });
});

test('files survive session destroy and restore on the same user+chat', async () => {
  siraCode._resetForTests();
  const env = await persistEnv();
  const first = await siraCode.create({ userId: 'owner-1', chatId: 'chat-web-1', persistEnv: env });
  await siraCode.prompt(first.id, 'escribe index.html', {
    userId: 'owner-1',
    persistEnv: env,
    llmTurn: async () => ({
      text: '',
      toolCalls: [{ name: 'write', arguments: { path: 'index.html', content: '<h1>hola</h1>' } }],
    }),
  });
  await destroySession(getSession(first.id));

  const second = await siraCode.create({ userId: 'owner-1', chatId: 'chat-web-1', persistEnv: env });
  const file = await siraCode.readFile(second.id, 'index.html', 'owner-1');
  assert.equal(file.content, '<h1>hola</h1>');
});

test('another user cannot restore the same chat key', async () => {
  siraCode._resetForTests();
  const env = await persistEnv();
  const first = await siraCode.create({ userId: 'owner-1', chatId: 'chat-web-2', persistEnv: env });
  await siraCode.prompt(first.id, 'escribe secret.txt', {
    userId: 'owner-1',
    llmTurn: async () => ({
      text: '',
      toolCalls: [{ name: 'write', arguments: { path: 'secret.txt', content: 'privado' } }],
    }),
  });
  await destroySession(getSession(first.id));

  const other = await siraCode.create({ userId: 'intruder', chatId: 'chat-web-2', persistEnv: env });
  await assert.rejects(() => siraCode.readFile(other.id, 'secret.txt', 'intruder'));
  assert.ok(!projectDir('intruder', 'chat-web-2', env).includes('owner-1'));
});
