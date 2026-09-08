'use strict';

/**
 * SiraCode per-turn tool-round guard — Spanish stop, no OpenCode dump.
 * OpenCode agent.steps / last-step idea; deterministic SiraGPT rewrite.
 */

const { test, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const siraCode = require('../src/services/sira-code');
const {
  MAX_TOOL_ROUNDS_DEFAULT,
  MAX_TOOL_ROUNDS_HARD,
  TOOL_ROUNDS_STOP_REASON,
  TOOL_ROUNDS_STAGE,
  TOOL_ROUNDS_LABEL,
  resolveMaxToolRounds,
  isToolRoundsExceeded,
  buildToolRoundsStop,
} = require('../src/services/sira-code/tool-rounds');
const { FORBIDDEN_DISPLAY } = require('../src/services/sira-code/display');

beforeEach(() => {
  siraCode._resetForTests();
});

afterEach(() => {
  siraCode._resetForTests();
});

function stormLlm(callsPerStep = 3) {
  return async () => ({
    text: 'sigo',
    toolCalls: Array.from({ length: callsPerStep }, (_, i) => ({
      name: 'write',
      arguments: { path: `n${i}.txt`, content: `n${i}` },
    })),
  });
}

describe('resolveMaxToolRounds', () => {
  test('defaults, clamps and floors', () => {
    assert.equal(resolveMaxToolRounds(), MAX_TOOL_ROUNDS_DEFAULT);
    assert.equal(resolveMaxToolRounds(undefined), MAX_TOOL_ROUNDS_DEFAULT);
    assert.equal(resolveMaxToolRounds(0), MAX_TOOL_ROUNDS_DEFAULT);
    assert.equal(resolveMaxToolRounds(-4), MAX_TOOL_ROUNDS_DEFAULT);
    assert.equal(resolveMaxToolRounds(2.9), 2);
    assert.equal(resolveMaxToolRounds(1), 1);
    assert.equal(resolveMaxToolRounds(99), MAX_TOOL_ROUNDS_HARD);
  });

  test('isToolRoundsExceeded is inclusive of the cap', () => {
    assert.equal(isToolRoundsExceeded(1, 2), false);
    assert.equal(isToolRoundsExceeded(2, 2), true);
    assert.equal(isToolRoundsExceeded(3, 2), true);
  });

  test('buildToolRoundsStop is Spanish and vendor-free', () => {
    const stop = buildToolRoundsStop({ count: 2, max: 2 });
    assert.equal(stop.stopReason, TOOL_ROUNDS_STOP_REASON);
    assert.equal(stop.step, TOOL_ROUNDS_STAGE);
    assert.equal(stop.label, TOOL_ROUNDS_LABEL);
    assert.equal(stop.label, 'Límite de herramientas alcanzado');
    assert.match(stop.content, /Límite de herramientas alcanzado/);
    assert.equal(/deepseek|openrouter|model_id/i.test(JSON.stringify(stop)), false);
    assert.equal(FORBIDDEN_DISPLAY.test(JSON.stringify(stop)), false);
  });
});

describe('prompt loop', () => {
  test('stops after the cap and skips the rest of the batch', async () => {
    const session = await siraCode.create({ userId: 'u-rounds', agent: 'construir' });
    const result = await siraCode.prompt(session.id, 'escribe varios', {
      userId: 'u-rounds',
      maxToolRounds: 2,
      llmTurn: stormLlm(3),
    });
    assert.equal(result.status, 'stopped');
    assert.equal(result.stopReason, 'tool_rounds');
    assert.equal(result.toolRounds, 2);
    assert.equal(result.maxToolRounds, 2);
    const executed = result.toolResults.filter((row) => row.ok === true);
    const skipped = result.toolResults.filter((row) => row.skipped === true);
    assert.equal(executed.length, 2);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].code, 'tool_rounds');
    assert.match(skipped[0].content, /Límite de herramientas alcanzado/);

    const stored = siraCode.getSession(session.id);
    assert.equal(stored.status, 'stopped');
    assert.equal(stored.stopReason, 'tool_rounds');
    assert.ok(stored.events.some((ev) => (
      ev.step === TOOL_ROUNDS_STAGE || ev.label === TOOL_ROUNDS_LABEL
    )));
    assert.equal(stored.events.some((ev) => ev.label === 'Listo' && ev.step === 'done'), false);
    assert.equal(stored.events.some((ev) => ev.label === 'Presupuesto agotado'), false);

    const root = stored.workspace.root;
    assert.equal(fs.existsSync(path.join(root, 'n0.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'n1.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'n2.txt')), false);

    const summary = siraCode.summarize(session.id, 'u-rounds');
    assert.equal(summary.stopReason, 'tool_rounds');
    assert.equal(summary.lastStage && summary.lastStage.label, TOOL_ROUNDS_LABEL);
    assert.equal(/deepseek|openrouter|model_id/i.test(JSON.stringify(summary)), false);
  });

  test('under the cap still finishes with Listo', async () => {
    const session = await siraCode.create({ userId: 'u-under', agent: 'construir' });
    let calls = 0;
    const result = await siraCode.prompt(session.id, 'un archivo', {
      userId: 'u-under',
      maxToolRounds: 4,
      llmTurn: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: '',
            toolCalls: [{ name: 'write', arguments: { path: 'ok.txt', content: 'ok' } }],
          };
        }
        return { text: 'Hecho.', toolCalls: [] };
      },
    });
    assert.equal(result.status, 'idle');
    assert.equal(result.stopReason, undefined);
    assert.equal(result.toolRounds, 1);
    assert.equal(result.text, 'Hecho.');
    const stored = siraCode.getSession(session.id);
    assert.ok(stored.events.some((ev) => ev.label === 'Listo' && ev.step === 'done'));
    assert.equal(stored.events.some((ev) => ev.label === TOOL_ROUNDS_LABEL), false);
  });

  test('step budget still wins when the tool cap is not hit', async () => {
    const session = await siraCode.create({ userId: 'u-steps', agent: 'construir' });
    const result = await siraCode.prompt(session.id, 'lista archivos', {
      userId: 'u-steps',
      maxSteps: 1,
      maxToolRounds: 16,
      llmTurn: async () => ({
        text: '',
        toolCalls: [{ name: 'glob', arguments: { pattern: '*.txt' } }],
      }),
    });
    assert.equal(result.status, 'stopped');
    assert.equal(result.stopReason, 'step_budget');
    assert.equal(result.toolRounds, 1);
    const stored = siraCode.getSession(session.id);
    assert.ok(stored.events.some((ev) => ev.label === 'Presupuesto agotado'));
    assert.equal(stored.events.some((ev) => ev.label === TOOL_ROUNDS_LABEL), false);
  });
});
