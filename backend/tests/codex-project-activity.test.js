'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  listProjectActivity,
  normalizeLimit,
  projectActivityEvent,
} = require('../src/services/codex/project-activity');

test('projects a safe file-write event with its department', () => {
  const event = projectActivityEvent({
    id: 'event-1',
    seq: 4,
    type: 'action_start',
    payload: {
      kind: 'file_write',
      path: 'src/app.tsx',
      command: 'Authorization=private-token',
    },
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    run: {
      id: 'run-1',
      prompt: '[SWARM · Ingeniería] Implementar panel',
    },
  });
  assert.equal(event.title, 'Modificando código');
  assert.equal(event.detail, 'src/app.tsx');
  assert.equal(event.department, 'Ingeniería');
  assert.equal(event.tone, 'active');
});

test('redacts credentials from projected output', () => {
  const event = projectActivityEvent({
    id: 'event-2',
    seq: 5,
    type: 'action_end',
    payload: {
      status: 'done',
      outputSummary: 'token=super-secret password=hunter2',
    },
    run: { id: 'run-2', prompt: '' },
    createdAt: '2026-07-27T00:00:01.000Z',
  });
  assert.match(event.detail, /\[REDACTED\]/);
  assert.doesNotMatch(event.detail, /super-secret/);
  assert.doesNotMatch(event.detail, /hunter2/);
});

test('queries only safe event types and returns newest first', async () => {
  const calls = [];
  const findMany = async (args) => {
    calls.push(args);
    return [{
      id: 'event-3',
      runId: 'run-3',
      seq: 9,
      type: 'run_status',
      payload: { status: 'done' },
      createdAt: new Date('2026-07-27T00:00:02.000Z'),
      run: { id: 'run-3', prompt: '[PROACTIVO · QA] revisar', status: 'done' },
    }];
  };
  const activity = await listProjectActivity({
    prisma: { codexEvent: { findMany } },
    projectId: 'project-1',
    limit: 9999,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where.run, { projectId: 'project-1' });
  assert.equal(calls[0].take, 200);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].department, 'QA');
  assert.equal(activity[0].title, 'Run done');
});

test('bounds limits', () => {
  assert.equal(normalizeLimit('0'), 1);
  assert.equal(normalizeLimit('500'), 200);
  assert.equal(normalizeLimit('invalid'), 80);
});
