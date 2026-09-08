'use strict';

/**
 * SiraCode session transcript summary — reconnect snapshot, no LLM.
 * OpenCode SessionSummary idea; deterministic SiraGPT rewrite.
 */

const { test, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const siraCode = require('../src/services/sira-code');
const {
  MAX_SUMMARY_MESSAGES,
  PREVIEW_CHARS,
  redactPreview,
  previewText,
  inferStopReason,
  lastStage,
  lastEventId,
  summarizeMessages,
  summarizeTools,
  buildSessionSummary,
} = require('../src/services/sira-code/session-summary');
const { FORBIDDEN_DISPLAY } = require('../src/services/sira-code/display');

beforeEach(() => {
  siraCode._resetForTests();
});

afterEach(() => {
  siraCode._resetForTests();
});

function scriptedWriteLlm(relPath = 'hola.txt', content = 'hola') {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        toolCalls: [{ name: 'write', arguments: { path: relPath, content } }],
      };
    }
    return { text: 'Hecho.', toolCalls: [] };
  };
}

describe('preview helpers', () => {
  test('previewText collapses whitespace and caps length', () => {
    const long = `arregla  el   login\n${'x'.repeat(800)}`;
    const preview = previewText(long);
    assert.ok(preview.length <= PREVIEW_CHARS);
    assert.match(preview, /^arregla el login /);
    assert.match(preview, /…$/);
  });

  test('redactPreview strips key-shaped tokens', () => {
    assert.match(redactPreview('token sk-abcdefghijklmnopqrstuv'), /sk-…/);
    assert.match(redactPreview('Authorization: Bearer abc.def.ghi'), /Bearer …/);
    assert.match(redactPreview('id AKIAIOSFODNN7EXAMPLE'), /AKIA…/);
    assert.equal(
      redactPreview('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
      '[clave omitida]',
    );
  });
});

describe('pure session snapshot', () => {
  test('empty session is idle with no messages or tools', () => {
    const summary = buildSessionSummary({
      id: 'sc_empty',
      userId: 'u-1',
      agentId: 'construir',
      title: 'Nueva sesión',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      events: [{ id: 'sc_empty:1', type: 'session' }],
      pendingPermissions: new Map(),
    });
    assert.equal(summary.stopReason, 'idle');
    assert.equal(summary.lastEventId, 'sc_empty:1');
    assert.equal(summary.lastStage, null);
    assert.equal(summary.messages.items.length, 0);
    assert.equal(summary.messages.omitted, 0);
    assert.equal(summary.tools.count, 0);
    assert.equal(summary.tools.last, null);
  });

  test('inferStopReason maps status to a stable reconnect reason', () => {
    assert.equal(inferStopReason({ status: 'cancelled', messages: [] }), 'cancelled');
    assert.equal(inferStopReason({ status: 'error', messages: [] }), 'error');
    assert.equal(inferStopReason({ status: 'running', messages: [] }), 'running');
    assert.equal(inferStopReason({ status: 'stopped', messages: [] }), 'step_budget');
    assert.equal(inferStopReason({
      status: 'stopped',
      stopReason: 'tool_rounds',
      messages: [],
    }), 'tool_rounds');
    assert.equal(inferStopReason({ status: 'idle', messages: [] }), 'idle');
    assert.equal(inferStopReason({
      status: 'idle',
      messages: [{ role: 'assistant', content: 'Listo.' }],
    }), 'done');
  });

  test('summarizeMessages keeps the tail and counts omitted turns', () => {
    const messages = [];
    for (let i = 0; i < MAX_SUMMARY_MESSAGES + 5; i += 1) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, ts: i });
    }
    const packed = summarizeMessages({ messages });
    assert.equal(packed.items.length, MAX_SUMMARY_MESSAGES);
    assert.equal(packed.omitted, 5);
    assert.equal(packed.items[0].preview, 'm5');
    assert.equal(packed.items.at(-1).preview, `m${MAX_SUMMARY_MESSAGES + 4}`);
  });

  test('lastStage and tools read only the event log', () => {
    const session = {
      events: [
        { id: 'a:1', type: 'stage', step: 'thinking', label: 'Pensando' },
        { id: 'a:2', type: 'tool_result', tool: 'write', ok: true },
        { id: 'a:3', type: 'stage', step: 'done', label: 'Listo' },
      ],
    };
    assert.deepEqual(lastStage(session), { step: 'done', label: 'Listo' });
    assert.equal(lastEventId(session), 'a:3');
    assert.deepEqual(summarizeTools(session), {
      count: 1,
      last: { tool: 'write', ok: true },
    });
  });
});

describe('engine summarize', () => {
  test('create + prompt hydrates title, last stage, tools and lastEventId', async () => {
    const session = await siraCode.create({ userId: 'u-sum', agent: 'construir' });
    await siraCode.prompt(session.id, 'escribe hola.txt', {
      userId: 'u-sum',
      llmTurn: scriptedWriteLlm('hola.txt', 'hola mundo'),
    });
    const summary = siraCode.summarize(session.id, 'u-sum');
    assert.equal(summary.session.id, session.id);
    assert.equal(summary.session.title, 'escribe hola.txt');
    assert.equal(summary.stopReason, 'done');
    assert.equal(summary.lastStage && summary.lastStage.label, 'Listo');
    assert.ok(summary.lastEventId);
    assert.ok(summary.messages.items.some((row) => row.role === 'user' && row.preview === 'escribe hola.txt'));
    assert.ok(summary.messages.items.some((row) => row.role === 'assistant' && row.preview === 'Hecho.'));
    assert.equal(summary.tools.count, 1);
    assert.deepEqual(summary.tools.last, { tool: 'write', ok: true });
    assert.equal(/deepseek|openrouter|model_id/i.test(JSON.stringify(summary)), false);
    assert.equal(FORBIDDEN_DISPLAY.test(JSON.stringify(summary)), false);
  });

  test('step budget surfaces stopReason and Presupuesto agotado', async () => {
    const session = await siraCode.create({ userId: 'u-budget', agent: 'construir' });
    await siraCode.prompt(session.id, 'lista archivos', {
      userId: 'u-budget',
      maxSteps: 1,
      llmTurn: async () => ({
        text: '',
        toolCalls: [{ name: 'glob', arguments: { pattern: '*.txt' } }],
      }),
    });
    const summary = siraCode.summarize(session.id, 'u-budget');
    assert.equal(summary.stopReason, 'step_budget');
    assert.equal(summary.lastStage && summary.lastStage.label, 'Presupuesto agotado');
    assert.equal(summary.session.status, 'stopped');
  });

  test('refuses a session that belongs to someone else', async () => {
    const session = await siraCode.create({ userId: 'u-owner' });
    assert.throws(
      () => siraCode.summarize(session.id, 'u-other'),
      (err) => err && err.status === 404 && err.code === 'session_not_found',
    );
  });

  test('redacts secret-shaped text in the reconnect preview', async () => {
    const session = await siraCode.create({ userId: 'u-secret' });
    await siraCode.prompt(session.id, 'usa sk-abcdefghijklmnopqrstuvwxyz012345 Bearer tok.en AKIAIOSFODNN7EXAMPLE', {
      userId: 'u-secret',
      llmTurn: async () => ({ text: 'ok', toolCalls: [] }),
    });
    const summary = siraCode.summarize(session.id, 'u-secret');
    const blob = JSON.stringify(summary);
    assert.equal(blob.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), false);
    assert.equal(blob.includes('Bearer tok.en'), false);
    assert.equal(blob.includes('AKIAIOSFODNN7EXAMPLE'), false);
    assert.match(blob, /sk-…/);
  });
});
