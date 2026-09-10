'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { progressForStage, withProgress, isComplete } = require('../src/services/sira-code/progress');
const siraCode = require('../src/services/sira-code');
const { getSession } = require('../src/services/sira-code/session-store');

test('bands never claim 100 without proven run, preview and tests', () => {
  assert.equal(progressForStage('thinking'), 8);
  assert.equal(progressForStage('executing', { tool: 'ls' }), 22);
  assert.equal(progressForStage('executing', { tool: 'write' }), 48);
  assert.equal(progressForStage('executing', { tool: 'bash' }), 72);
  assert.equal(progressForStage('verifying'), 88);
  assert.equal(progressForStage('done'), 95);
  assert.equal(progressForStage('done', { proof: { executed: true, previewOk: true, testsOk: true } }), 100);
  assert.equal(isComplete({ executed: true, previewOk: true }), false);
});

test('withProgress is monotonic until a terminal failure', () => {
  const session = { progress: 0 };
  assert.equal(withProgress(session, 'thinking'), 8);
  assert.equal(withProgress(session, 'executing', { tool: 'read' }), 22);
  assert.equal(withProgress(session, 'thinking'), 22);
  assert.equal(withProgress(session, 'error'), 22);
});

test('sira-code thinking events expose progress without claiming completion', async () => {
  siraCode._resetForTests();
  try {
    const session = await siraCode.create({ userId: 'u-progress' });
    await siraCode.prompt(session.id, 'escribe hola.txt', {
      userId: 'u-progress',
      llmTurn: async () => ({ text: 'Hecho.', toolCalls: [] }),
    });
    const live = getSession(session.id);
    const thinking = live.events.find((ev) => ev.step === 'thinking');
    const done = live.events.filter((ev) => ev.step === 'done').at(-1);
    assert.equal(thinking.progress, 8);
    assert.equal(done.progress, 95);
    assert.notEqual(done.progress, 100);
  } finally {
    siraCode._resetForTests();
  }
});
