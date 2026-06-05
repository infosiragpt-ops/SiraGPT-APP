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
