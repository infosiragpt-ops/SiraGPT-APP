'use strict';

/**
 * SiraCode session title — first real user message, no LLM.
 * OpenCode ensureTitle idea; deterministic SiraGPT rewrite.
 */

const { test, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const siraCode = require('../src/services/sira-code');
const {
  DEFAULT_TITLE,
  TITLE_MAX_CHARS,
  isDefaultTitle,
  titleFromUserMessage,
  ensureSessionTitle,
} = require('../src/services/sira-code/session-title');

beforeEach(() => {
  siraCode._resetForTests();
});

afterEach(() => {
  siraCode._resetForTests();
});

describe('titleFromUserMessage', () => {
  test('takes the first line and collapses whitespace', () => {
    assert.equal(
      titleFromUserMessage('  arregla el login  \nsegunda línea'),
      'arregla el login',
    );
  });

  test('strips plane slash commands and think tags', () => {
    assert.equal(
      titleFromUserMessage('/construir <think>oculto</think> parche el auth'),
      'parche el auth',
    );
  });

  test('caps at 100 chars with an ellipsis', () => {
    const long = `implementa ${'x'.repeat(200)}`;
    const titled = titleFromUserMessage(long);
    assert.equal(titled.length, TITLE_MAX_CHARS);
    assert.match(titled, /\.\.\.$/);
  });

  test('returns empty for whitespace-only input', () => {
    assert.equal(titleFromUserMessage('   \n\t'), '');
  });
});

describe('isDefaultTitle', () => {
  test('treats empty, Spanish default, and OpenCode-style stamps as default', () => {
    assert.equal(isDefaultTitle(''), true);
    assert.equal(isDefaultTitle(DEFAULT_TITLE), true);
    assert.equal(isDefaultTitle('New session - 2026-09-07T18:00:00.000Z'), true);
    assert.equal(isDefaultTitle('arregla el login'), false);
  });
});

describe('ensureSessionTitle', () => {
  test('writes once and never overwrites a custom title', () => {
    const session = { title: DEFAULT_TITLE, updatedAt: 1 };
    const first = ensureSessionTitle(session, 'arregla el login');
    assert.equal(first.changed, true);
    assert.equal(first.title, 'arregla el login');
    const second = ensureSessionTitle(session, 'otra cosa');
    assert.equal(second.changed, false);
    assert.equal(session.title, 'arregla el login');
  });

  test('trivial greetings do not lock the default title', () => {
    const session = { title: DEFAULT_TITLE };
    const hello = ensureSessionTitle(session, 'hola', { trivial: true });
    assert.equal(hello.changed, false);
    assert.equal(session.title, DEFAULT_TITLE);
    const real = ensureSessionTitle(session, 'añade tests al auth');
    assert.equal(real.changed, true);
    assert.equal(session.title, 'añade tests al auth');
  });
});

describe('SiraCode session public title', () => {
  test('create exposes the Spanish default title', async () => {
    const session = await siraCode.create({ userId: 'u-title' });
    assert.equal(session.title, DEFAULT_TITLE);
    assert.equal(siraCode.get(session.id, 'u-title').title, DEFAULT_TITLE);
  });

  test('keeps a caller-supplied title', async () => {
    const session = await siraCode.create({ userId: 'u-title', title: 'CRM inventario' });
    assert.equal(session.title, 'CRM inventario');
    await siraCode.prompt(session.id, 'ahora escribe README', {
      userId: 'u-title',
      llmTurn: async () => ({ text: 'Listo.', toolCalls: [] }),
    });
    assert.equal(siraCode.get(session.id, 'u-title').title, 'CRM inventario');
  });

  test('first real prompt names the session; hola does not', async () => {
    const session = await siraCode.create({ userId: 'u-title', agent: 'construir' });
    const hello = await siraCode.prompt(session.id, 'Hola', {
      userId: 'u-title',
      llmTurn: async () => ({ text: 'hola', toolCalls: [] }),
    });
    assert.equal(hello.skipped, true);
    assert.equal(siraCode.get(session.id, 'u-title').title, DEFAULT_TITLE);

    await siraCode.prompt(session.id, '/construir arregla el login del panel', {
      userId: 'u-title',
      llmTurn: async () => ({ text: 'Listo.', toolCalls: [] }),
    });
    const publicRow = siraCode.get(session.id, 'u-title');
    assert.equal(publicRow.title, 'arregla el login del panel');
    const stored = siraCode.getSession(session.id);
    assert.ok(stored.events.some((ev) => ev.type === 'title' && ev.title === 'arregla el login del panel'));
    assert.ok(!JSON.stringify(publicRow).includes('DeepSeek'));
    assert.ok(!JSON.stringify(publicRow).includes('model_id'));
  });
});
