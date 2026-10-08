'use strict';

/**
 * GET /api/chats and GET /api/chats/:id — payload diet (2026-10-08).
 *
 *  - detail: the GPT knowledge base text is never read (gpts.js forbids
 *    exposing it to non-owners; no client reads it), and `reasoningDetails`
 *    is omitted at the query instead of deleted after transfer;
 *  - list: server-only Text/Json chat columns are omitted, the preview
 *    message is a narrow `select`, and the active-task index is read ONCE per
 *    page instead of once per listed chat.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const prisma = require('../src/config/database');
const taskStore = require('../src/services/agents/task-store');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

const SECRET_KB_TEXT = 'KNOWLEDGE-BASE-SECRET-TEXT-9f2a';
const SECRET_REASONING = 'SIGNED-REASONING-CHAIN-7c1d';

describe('GET /chats/:id · slim detail', () => {
  let auth;
  let originals;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'slim-detail-user' });
    originals = { chatFindFirst: prisma.chat.findFirst };
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    prisma.chat.findFirst = originals.chatFindFirst;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  test('never selects the GPT knowledge text and omits reasoningDetails at the query', async () => {
    const calls = [];
    prisma.chat.findFirst = async (args) => {
      calls.push(args);
      // First call is the ETag fingerprint (select); second is the full read.
      if (args.select) return null;
      return {
        id: 'chat-1',
        userId: auth.user.id,
        title: 'Chat',
        model: 'deepseek-v4-flash',
        messages: [
          { id: 'm1', role: 'user', content: 'hola', timestamp: new Date(), files: null, metadata: null },
          // A row another code path could still attach: the JS delete stays.
          { id: 'm2', role: 'assistant', content: 'hola!', timestamp: new Date(), files: null, metadata: null, reasoningDetails: SECRET_REASONING },
        ],
        customGpt: {
          id: 'gpt-1',
          name: 'Tutor',
          knowledgeFiles: [{ id: 'f1', originalName: 'apuntes.pdf', mimeType: 'application/pdf', size: 1024 }],
        },
        project: null,
      };
    };

    const res = await request(buildRouteTestApp('/chats', reloadModule('../src/routes/chats')))
      .get('/chats/chat-1')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    const fullRead = calls.find((args) => args.include);
    assert.ok(fullRead, 'the full read runs');
    const kb = fullRead.include.customGpt.select.knowledgeFiles.select;
    assert.deepEqual(kb, { id: true, originalName: true, mimeType: true, size: true });
    assert.equal(Object.prototype.hasOwnProperty.call(kb, 'extractedText'), false);
    assert.deepEqual(fullRead.include.messages.omit, { reasoningDetails: true });
    assert.deepEqual(fullRead.include.messages.where, { deletedAt: null });

    const body = JSON.stringify(res.body);
    assert.equal(body.includes(SECRET_REASONING), false, 'reasoningDetails never reaches the client');
    assert.equal(body.includes(SECRET_KB_TEXT), false);
    assert.equal(res.body.chat.customGpt.knowledgeFiles[0].originalName, 'apuntes.pdf');
    assert.equal(res.body.chat.customGpt.knowledgeFiles[0].size, 1024);
  });
});

describe('GET /chats · slim list', () => {
  let auth;
  let originals;
  let restoreEnv;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'slim-list-user' });
    originals = {
      chatFindMany: prisma.chat.findMany,
      chatCount: prisma.chat.count,
    };
    const previous = process.env.AGENT_TASK_STORE_DIR;
    process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-chats-slim-'));
    restoreEnv = () => {
      if (previous === undefined) delete process.env.AGENT_TASK_STORE_DIR;
      else process.env.AGENT_TASK_STORE_DIR = previous;
    };
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  afterEach(() => {
    prisma.chat.findMany = originals.chatFindMany;
    prisma.chat.count = originals.chatCount;
    restoreEnv();
    auth.restore();
    delete require.cache[require.resolve('../src/routes/chats')];
  });

  test('omits server-only chat columns, narrows the preview and reads the task index once', async () => {
    const chatRows = ['chat-a', 'chat-b', 'chat-c'].map((id, i) => ({
      id,
      userId: auth.user.id,
      title: `Chat ${i}`,
      model: 'deepseek-v4-flash',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [{ id: `${id}-m1`, chatId: id, role: 'user', timestamp: new Date(), content: 'x'.repeat(500) }],
      customGpt: null,
      project: null,
    }));
    let findManyArgs = null;
    prisma.chat.findMany = async (args) => { findManyArgs = args; return chatRows; };
    prisma.chat.count = async () => chatRows.length;

    // One running task on chat-b, a finished one on chat-c, another user's on chat-a.
    taskStore.writeTaskSnapshot({ taskId: 't-b', userId: auth.user.id, chatId: 'chat-b', status: 'running', displayGoal: 'Excel' });
    taskStore.writeTaskSnapshot({ taskId: 't-c', userId: auth.user.id, chatId: 'chat-c', status: 'completed', displayGoal: 'Done' });
    taskStore.writeTaskSnapshot({ taskId: 't-a', userId: 'someone-else', chatId: 'chat-a', status: 'running', displayGoal: 'Ajeno' });

    const indexFile = path.join(process.env.AGENT_TASK_STORE_DIR, '_index.json');
    assert.ok(fs.existsSync(indexFile), 'the task index exists');
    const realReadFileSync = fs.readFileSync;
    let indexReads = 0;
    fs.readFileSync = function patched(file, ...rest) {
      if (String(file) === indexFile) indexReads++;
      return realReadFileSync.call(fs, file, ...rest);
    };
    let res;
    try {
      res = await request(buildRouteTestApp('/chats', reloadModule('../src/routes/chats')))
        .get('/chats?limit=20')
        .set('Authorization', auth.authHeader);
    } finally {
      fs.readFileSync = realReadFileSync;
    }

    assert.equal(res.status, 200);
    assert.equal(indexReads, 1, 'the task index is read once for the whole page, not once per chat');

    assert.deepEqual(findManyArgs.omit, {
      contextSummary: true, contextSummaryMeta: true, googleCalendarContext: true, draftText: true,
    });
    assert.deepEqual(findManyArgs.include.messages.select, {
      id: true, chatId: true, role: true, timestamp: true, content: true,
    });
    assert.equal(findManyArgs.include.messages.take, 1);

    const byId = Object.fromEntries(res.body.chats.map((row) => [row.id, row]));
    assert.equal(byId['chat-b'].activeTask.taskId, 't-b');
    assert.equal(byId['chat-b'].activeTask.status, 'running');
    assert.equal(byId['chat-c'].activeTask, null, 'a completed task is not active');
    assert.equal(byId['chat-a'].activeTask, null, "another user's task never leaks");
    assert.equal(byId['chat-a'].messages[0].content.length, 240, 'preview content stays capped');
  });
});

describe('taskStore.listActiveTasksForChats', () => {
  let restoreEnv;
  beforeEach(() => {
    const previous = process.env.AGENT_TASK_STORE_DIR;
    process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-task-batch-'));
    restoreEnv = () => {
      if (previous === undefined) delete process.env.AGENT_TASK_STORE_DIR;
      else process.env.AGENT_TASK_STORE_DIR = previous;
    };
  });
  afterEach(() => restoreEnv());

  test('matches the singular helper chat by chat and honours limitPerChat', () => {
    const user = 'batch-user';
    taskStore.writeTaskSnapshot({ taskId: 'old', userId: user, chatId: 'c1', status: 'queued', displayGoal: 'a', updatedAt: '2026-10-01T00:00:00.000Z' });
    taskStore.writeTaskSnapshot({ taskId: 'new', userId: user, chatId: 'c1', status: 'executing', displayGoal: 'b', updatedAt: '2026-10-02T00:00:00.000Z' });
    taskStore.writeTaskSnapshot({ taskId: 'done', userId: user, chatId: 'c1', status: 'failed', displayGoal: 'c' });
    taskStore.writeTaskSnapshot({ taskId: 'c2-run', userId: user, chatId: 'c2', status: 'running', displayGoal: 'd' });
    taskStore.writeTaskSnapshot({ taskId: 'other', userId: 'intruder', chatId: 'c2', status: 'running', displayGoal: 'e' });

    const batch = taskStore.listActiveTasksForChats(['c1', 'c2', 'c3'], user, { limitPerChat: 1 });
    assert.deepEqual(batch.get('c1').map((t) => t.taskId), ['new']);
    assert.deepEqual(batch.get('c2').map((t) => t.taskId), ['c2-run']);
    assert.equal(batch.has('c3'), false, 'chats without active tasks have no entry');

    for (const chatId of ['c1', 'c2']) {
      const singular = taskStore.listActiveTasksForChat(chatId, user, { limit: 1 }).map((t) => t.taskId);
      assert.deepEqual(batch.get(chatId).map((t) => t.taskId), singular, `parity with listActiveTasksForChat for ${chatId}`);
    }

    const two = taskStore.listActiveTasksForChats(['c1'], user, { limitPerChat: 2 });
    assert.deepEqual(two.get('c1').map((t) => t.taskId), ['new', 'old'], 'most recent first');

    assert.equal(taskStore.listActiveTasksForChats([], user).size, 0);
    assert.equal(taskStore.listActiveTasksForChats(null, user).size, 0);
  });
});
