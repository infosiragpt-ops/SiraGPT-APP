'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  isTrivialChatTurn,
  shouldForceDirectMode,
  shouldStartSiraCodeRun,
  resolveThinkingLevelForTurn,
  applyTrivialTurnGuards,
} = require('../src/services/trivial-turn');
const { isShortChitchatPrompt } = require('../src/services/agents/intent-triage');
const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
const { applyAnthropicThinkingControls } = require('../src/services/ai/first-party-chat-clients');
const { buildReasoningDirective } = require('../src/services/test-time-compute');
const siraCode = require('../src/services/sira-code');

const GREETINGS = ['hola', 'Hola', 'hola!'];

test('hola / Hola / hola! force direct non-agentic mode', () => {
  for (const prompt of GREETINGS) {
    assert.equal(isShortChitchatPrompt(prompt), true, prompt);
    assert.equal(isTrivialChatTurn(prompt), true, prompt);
    assert.equal(shouldForceDirectMode(prompt), true, prompt);
    assert.equal(shouldUseAgenticChat({ prompt }), false, prompt);
    assert.equal(shouldStartSiraCodeRun(prompt), false, prompt);
  }
  assert.equal(isTrivialChatTurn('hola necesito el reporte'), false);
  assert.equal(shouldStartSiraCodeRun('escribe app.py'), true);
});

test('trivial turns disable thinking and do not inject test-time-compute', () => {
  for (const prompt of GREETINGS) {
    assert.equal(
      resolveThinkingLevelForTurn({ userPrompt: prompt, fallback: 'high' }),
      'disabled',
      prompt,
    );
  }
  const extraCompute = {
    compute: { mode: 'extended', samples: 1, reasoningEffort: 'high', reflection: true },
  };
  const req = { body: { reasoningEffort: 'max' } };
  applyTrivialTurnGuards(req, 'hola');
  assert.equal(req.body.disableAgentic, true);
  assert.equal(req._thinkingLevel, 'disabled');
  assert.equal(req._trivialTurn, true);
  const forcedDirect = { compute: { mode: 'direct', samples: 1, reasoningEffort: 'low', reflection: false } };
  assert.equal(buildReasoningDirective(forcedDirect), '');
  assert.ok(buildReasoningDirective(extraCompute).length > 0);
});

test('generate path skips Extra/Max and TTC on trivial turns (source contract)', () => {
  const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(aiRoute, /applyTrivialTurnGuards\(req, prompt\)/);
  assert.match(aiRoute, /trivial turn kept on direct mode; Extra\/Max skipped/);
  assert.match(aiRoute, /skipped trivial turn/);
  assert.match(aiRoute, /req\._thinkingLevel = 'disabled'/);
  assert.match(aiRoute, /thinkingLevel: req\._thinkingLevel/);
  assert.match(aiRoute, /req\.body\.disableAgentic = true/);
});

test('Claude thinking toggle is disabled for trivial-turn payloads', () => {
  const body = { model: 'claude-sonnet-5', messages: [] };
  applyAnthropicThinkingControls(body, { thinking: { type: 'disabled' } }, 'claude-sonnet-5');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  const viaReasoning = { model: 'anthropic/claude-sonnet-5', messages: [] };
  applyAnthropicThinkingControls(viaReasoning, { reasoning: { exclude: true } }, 'claude-sonnet-5');
  assert.deepEqual(viaReasoning.thinking, { type: 'disabled' });
});

test('SiraCode does not start a tool run for hola / Hola / hola!', async () => {
  siraCode._resetForTests();
  try {
    for (const prompt of GREETINGS) {
      const session = await siraCode.create({ userId: 'u-trivial', agent: 'construir' });
      let llmCalls = 0;
      const result = await siraCode.prompt(session.id, prompt, {
        userId: 'u-trivial',
        llmTurn: async () => {
          llmCalls += 1;
          return { text: 'no-debes-correr', toolCalls: [{ name: 'write', arguments: { path: 'x.txt', content: 'x' } }] };
        },
      });
      assert.equal(shouldStartSiraCodeRun(prompt), false, prompt);
      assert.equal(result.skipped, true, prompt);
      assert.equal(result.reason, 'trivial_turn', prompt);
      assert.equal(llmCalls, 0, `llmTurn must not run for "${prompt}"`);
      assert.equal((result.toolResults || []).length, 0, prompt);
      const stored = siraCode.getSession(session.id);
      assert.equal(stored.events.some((ev) => ev.step === 'thinking' || ev.label === 'Pensando'), false, prompt);
    }
  } finally {
    siraCode._resetForTests();
  }
});
