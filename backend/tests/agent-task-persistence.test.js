'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const dbPath = require.resolve('../src/config/database');
const persistencePath = require.resolve('../src/services/agents/agent-task-persistence');

function matchesWhere(row, where = {}) {
  if (Array.isArray(where.OR)) {
    return where.OR.some((clause) => matchesWhere(row, clause));
  }
  if (where.id != null && row.id !== where.id) return false;
  if (where.jobId != null && row.jobId !== where.jobId) return false;
  if (where.status && Array.isArray(where.status.notIn) && where.status.notIn.includes(row.status)) {
    return false;
  }
  return true;
}

function makePrismaMock(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  const calls = { create: 0, createMany: 0, findFirst: 0, updateMany: 0 };

  const findByJobId = (jobId) => {
    for (const row of rows.values()) {
      if (jobId != null && row.jobId === jobId) return row;
    }
    return null;
  };

  return {
    _rows: rows,
    _calls: calls,
    agentTask: {
      createMany: async ({ data, skipDuplicates }) => {
        calls.createMany += 1;
        let count = 0;
        for (const row of Array.isArray(data) ? data : [data]) {
          const duplicate = rows.has(row.id) || findByJobId(row.jobId);
          if (duplicate) {
            if (skipDuplicates) continue;
            const err = new Error('Unique constraint failed');
            err.code = 'P2002';
            throw err;
          }
          rows.set(row.id, { ...row });
          count += 1;
        }
        return { count };
      },
      create: async ({ data }) => {
        calls.create += 1;
        if (rows.has(data.id) || findByJobId(data.jobId)) {
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        rows.set(data.id, { ...data });
        return rows.get(data.id);
      },
      findFirst: async ({ where } = {}) => {
        calls.findFirst += 1;
        for (const row of rows.values()) {
          if (matchesWhere(row, where)) return { ...row };
        }
        return null;
      },
      updateMany: async ({ where, data }) => {
        calls.updateMany += 1;
        let count = 0;
        for (const [id, row] of rows.entries()) {
          if (!matchesWhere(row, where)) continue;
          rows.set(id, { ...row, ...data });
          count += 1;
        }
        return { count };
      },
    },
  };
}

function loadPersistenceWithPrisma(prisma) {
  const oldDb = require.cache[dbPath];
  const oldPersistence = require.cache[persistencePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: prisma,
  };
  delete require.cache[persistencePath];
  const persistence = require('../src/services/agents/agent-task-persistence');
  return {
    persistence,
    restore() {
      if (oldDb) require.cache[dbPath] = oldDb;
      else delete require.cache[dbPath];
      if (oldPersistence) require.cache[persistencePath] = oldPersistence;
      else delete require.cache[persistencePath];
    },
  };
}

test('upsertAgentTask uses duplicate-safe insert for concurrent first writes', async (t) => {
  const prisma = makePrismaMock();
  const { persistence, restore } = loadPersistenceWithPrisma(prisma);
  t.after(restore);

  const task = {
    taskId: 'task-1',
    userId: 'user-1',
    jobId: 'task-1',
    chatId: 'chat-1',
    displayGoal: 'Run durable task',
    status: 'queued',
  };

  await Promise.all([
    persistence.upsertAgentTask(task),
    persistence.upsertAgentTask(task),
    persistence.upsertAgentTask(task),
  ]);

  assert.equal(prisma._calls.create, 0, 'create() should not be used on duplicate-safe Prisma clients');
  assert.equal(prisma._rows.size, 1);
  assert.equal(prisma._rows.get('task-1').status, 'queued');
});

test('upsertAgentTask updates existing row found by jobId without changing immutable id', async (t) => {
  const prisma = makePrismaMock([{
    id: 'existing-task',
    userId: 'user-1',
    jobId: 'job-1',
    status: 'running',
    goal: 'old goal',
  }]);
  const { persistence, restore } = loadPersistenceWithPrisma(prisma);
  t.after(restore);

  await persistence.upsertAgentTask({
    taskId: 'new-task-id',
    userId: 'user-1',
    jobId: 'job-1',
    displayGoal: 'updated goal',
    status: 'completed',
  });

  assert.equal(prisma._rows.size, 1);
  assert.equal(prisma._rows.get('existing-task').id, 'existing-task');
  assert.equal(prisma._rows.get('existing-task').status, 'completed');
  assert.equal(prisma._rows.get('existing-task').goal, 'updated goal');
});

test('upsertAgentTask does not downgrade terminal rows with later running writes', async (t) => {
  const prisma = makePrismaMock([{
    id: 'terminal-task',
    userId: 'user-1',
    jobId: 'terminal-task',
    status: 'completed',
    goal: 'done',
  }]);
  const { persistence, restore } = loadPersistenceWithPrisma(prisma);
  t.after(restore);

  await persistence.upsertAgentTask({
    taskId: 'terminal-task',
    userId: 'user-1',
    jobId: 'terminal-task',
    displayGoal: 'late running update',
    status: 'running',
  });

  assert.equal(prisma._rows.get('terminal-task').status, 'completed');
  assert.equal(prisma._rows.get('terminal-task').goal, 'done');
});

test('appendAgentTaskEvent records verification failure before a later completed snapshot write', async (t) => {
  // Adapter contract test, not a real-Postgres durability/concurrency claim.
  const prisma = makePrismaMock();
  const eventWrites = [];
  prisma.agentTaskEvent = { upsert: async ({ create }) => { eventWrites.push(create); return create; } };
  const { persistence, restore } = loadPersistenceWithPrisma(prisma);
  t.after(restore);
  const task = { taskId: 'verify-failed', userId: 'user-1', status: 'running' };
  const event = { type: 'done', seq: 1, stoppedReason: 'verification_failed:missing_evidence' };
  await persistence.appendAgentTaskEvent(task, event);
  const first = prisma._rows.get(task.taskId);
  assert.equal(first.status, 'failed');
  assert.ok(first.failedAt);
  assert.equal(first.completedAt, null);
  assert.equal(eventWrites[0].payload.stoppedReason, event.stoppedReason);

  await persistence.upsertAgentTask({ ...task, status: 'completed', state: first.state });
  const after = prisma._rows.get(task.taskId);
  assert.equal(after.status, 'failed');
  assert.equal(after.completedAt, null);
});

test('appendAgentTaskEvent does not turn an existing failure/cancel into success on generic done', async (t) => {
  const prisma = makePrismaMock();
  prisma.agentTaskEvent = { upsert: async ({ create }) => create };
  const { persistence, restore } = loadPersistenceWithPrisma(prisma);
  t.after(restore);
  for (const status of ['failed', 'cancelled']) {
    const task = { taskId: status, userId: 'user-1', status };
    await persistence.appendAgentTaskEvent(task, { type: 'done', seq: 1 });
    assert.equal(prisma._rows.get(status).status, status);
  }
  await persistence.appendAgentTaskEvent({ taskId: 'explicit-cancel', userId: 'user-1', status: 'running' }, { type: 'done', seq: 1, stoppedReason: 'cancelled_by_user' });
  assert.equal(prisma._rows.get('explicit-cancel').status, 'cancelled');
});

// Prod 2026-09-27: the chat of a running task was deleted; the FK is ON DELETE
// SET NULL, so the row kept living with chatId null and every later snapshot
// write that still carried the old chatId failed with P2003 (28 in one
// second) — the task never reached a terminal status in Postgres.
test('updateExistingAgentTask drops a dangling chatId when the chat was deleted (P2003)', async (t) => {
  const prisma = makePrismaMock([{ id: 'task-fk', jobId: 'task-fk', userId: 'u1', chatId: null, status: 'running' }]);
  const seen = [];
  const original = prisma.agentTask.updateMany;
  prisma.agentTask.updateMany = async (args) => {
    seen.push(args.data);
    if (args.data.chatId) {
      const err = new Error('Foreign key constraint violated on the constraint: `agent_tasks_chatId_fkey`');
      err.code = 'P2003';
      throw err;
    }
    return original(args);
  };
  const { persistence, restore } = loadPersistenceWithPrisma(prisma);
  t.after(restore);
  const row = await persistence.upsertAgentTask({ taskId: 'task-fk', jobId: 'task-fk', userId: 'u1', chatId: 'deleted-chat', status: 'completed', goal: 'x' });
  assert.ok(row, 'the task must still be persisted');
  assert.equal(row.status, 'completed');
  assert.equal(row.chatId, null);
  assert.equal(seen.length, 2, 'one failed write with the old chatId, one retry without it');
  assert.equal(seen[1].chatId, null);
});
