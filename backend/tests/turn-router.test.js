'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  PLANES,
  RULES,
  OFFER_CONSTRUIR,
  OFFER_CHIP,
  routeTurn,
  allowsSiraCode,
  isTrivialPhrase,
} = require('../src/services/turn-router');
const {
  isTrivialChatTurn,
  shouldStartSiraCodeRun,
  applyTrivialTurnGuards,
} = require('../src/services/trivial-turn');
const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
const siraCode = require('../src/services/sira-code');
const fixture = require('./fixtures/turn-router-cases');

function planesOf(decision) {
  return [decision.plane];
}

test('I1: greetings never produce a tool.call / SiraCode run (toggle stays on)', async () => {
  siraCode._resetForTests();
  try {
    for (const prompt of fixture.greetings) {
      const decision = routeTurn({
        text: prompt,
        toggleConstruir: true,
        togglePlanificar: true,
      });
      assert.equal(decision.plane, PLANES.CONVERSAR, prompt);
      assert.equal(decision.rule_id, RULES.R_TRIVIAL, prompt);
      assert.equal(decision.trivial, true, prompt);
      assert.equal(decision.toggleIgnored, true, prompt);
      assert.equal(decision.disableAgentic, true, prompt);
      assert.equal(decision.think, false, prompt);
      assert.equal(decision.toolChoice, 'none', prompt);
      assert.ok(decision.maxTokens <= 256, prompt);
      assert.equal(allowsSiraCode(decision), false, prompt);
      assert.equal(shouldStartSiraCodeRun(prompt, { toggleConstruir: true }), false, prompt);
      assert.equal(shouldUseAgenticChat({ prompt }), false, prompt);

      const session = await siraCode.create({ userId: 'u-router', agent: 'construir' });
      let llmCalls = 0;
      const result = await siraCode.prompt(session.id, prompt, {
        userId: 'u-router',
        llmTurn: async () => {
          llmCalls += 1;
          return { text: 'no-debes-correr', toolCalls: [{ name: 'write', arguments: { path: 'x.txt', content: 'x' } }] };
        },
      });
      assert.equal(result.skipped, true, prompt);
      assert.equal(result.reason, 'trivial_turn', prompt);
      assert.equal(llmCalls, 0, prompt);
      assert.equal((result.toolResults || []).length, 0, prompt);
      const stored = siraCode.getSession(session.id);
      assert.equal(stored.agentId, 'construir', 'toggle must stay on');
    }
  } finally {
    siraCode._resetForTests();
  }
});

test('I7: one turn = one plane', () => {
  const cases = [
    { text: 'hola' },
    { text: 'implementa el fix', toggleConstruir: true, togglePlanificar: true },
    { text: 'explica este código' },
    { text: 'mira app.py', attachments: [{ name: 'app.py' }] },
    { text: 'haz algo con esto' },
    { text: 'hola', chip: 'image', toggleConstruir: true },
    { text: '/construir ahora' },
    { text: '/planificar el informe' },
    { text: 'redacta un párrafo' },
  ];
  const allowed = new Set([PLANES.CONVERSAR, PLANES.PLANIFICAR, PLANES.CONSTRUIR]);
  for (const input of cases) {
    const once = routeTurn(input);
    const again = routeTurn(input);
    assert.equal(planesOf(once).length, 1, JSON.stringify(input));
    assert.ok(allowed.has(once.plane), once.plane);
    assert.deepEqual(once, again);
    assert.equal(typeof once.rule_id, 'string');
  }
});

test('I8: Construir + Planificar on → CONSTRUIR', () => {
  const decision = routeTurn(fixture.bothToggles);
  assert.equal(decision.plane, PLANES.CONSTRUIR);
  assert.equal(decision.rule_id, RULES.R_TOGGLE_CONSTRUIR);
  assert.equal(decision.lane, null);
  assert.equal(allowsSiraCode(decision), true);
});

test('I9: H1 never enters CONSTRUIR without the ask', () => {
  for (const text of [fixture.h1Implement, fixture.h1Arregla]) {
    const decision = routeTurn({ text });
    assert.equal(decision.plane, PLANES.CONVERSAR, text);
    assert.equal(decision.rule_id, RULES.H1, text);
    assert.equal(decision.offer, OFFER_CONSTRUIR, text);
    assert.equal(allowsSiraCode(decision), false, text);
  }
  const withFile = routeTurn(fixture.h1NoAsk);
  assert.equal(withFile.plane, PLANES.CONVERSAR);
  assert.equal(withFile.rule_id, RULES.H1);
  assert.equal(withFile.offer, OFFER_CONSTRUIR);
  assert.equal(allowsSiraCode(withFile), false);
  assert.equal(shouldStartSiraCodeRun(fixture.h1NoAsk.text, {
    attachments: fixture.h1NoAsk.attachments,
  }), false);

  const confirmed = routeTurn(fixture.h1Confirmed);
  assert.equal(confirmed.plane, PLANES.CONSTRUIR);
  assert.equal(confirmed.rule_id, RULES.H1);
  assert.equal(allowsSiraCode(confirmed), true);

  const viaToggle = routeTurn({
    text: fixture.h1Implement,
    toggleConstruir: true,
  });
  assert.equal(viaToggle.plane, PLANES.CONSTRUIR);
  assert.equal(viaToggle.rule_id, RULES.R_TOGGLE_CONSTRUIR);
});

test('H2: plan request → PLANIFICAR, never a CONSTRUIR label', () => {
  const decision = routeTurn({ text: fixture.h2Plan });
  assert.equal(decision.plane, PLANES.PLANIFICAR);
  assert.equal(decision.rule_id, RULES.H2);
  assert.notEqual(decision.rule_id, RULES.H1);
  assert.equal(allowsSiraCode(decision), true);
});

test('H3: multi-step / deliverable → PLANIFICAR (not H4)', () => {
  const multi = routeTurn({ text: fixture.h3MultiStep });
  assert.equal(multi.plane, PLANES.PLANIFICAR);
  assert.equal(multi.rule_id, RULES.H3);
  const docs = routeTurn({
    text: 'compara estos archivos',
    attachments: [
      { name: 'a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { name: 'b.pdf', mimeType: 'application/pdf' },
    ],
  });
  assert.equal(docs.plane, PLANES.PLANIFICAR);
  assert.equal(docs.rule_id, RULES.H3);
});

test('H4: gen-lane request without chip → CONVERSAR + offer, lane unmarked', () => {
  const decision = routeTurn({ text: fixture.h4Image });
  assert.equal(decision.plane, PLANES.CONVERSAR);
  assert.equal(decision.rule_id, RULES.H4);
  assert.equal(decision.lane, null);
  assert.equal(decision.offer, OFFER_CHIP.image);
  assert.notEqual(decision.plane, PLANES.PLANIFICAR);
  assert.notEqual(decision.plane, PLANES.CONSTRUIR);
  assert.equal(allowsSiraCode(decision), false);
});

test('H5: explica este código → CONVERSAR', () => {
  const decision = routeTurn({ text: fixture.explainCode });
  assert.equal(decision.plane, PLANES.CONVERSAR);
  assert.equal(decision.rule_id, RULES.H5);
  assert.equal(allowsSiraCode(decision), false);
});

test('H6: ambiguous → CONVERSAR + offer, not silent CONSTRUIR', () => {
  const decision = routeTurn({ text: fixture.ambiguous });
  assert.equal(decision.plane, PLANES.CONVERSAR);
  assert.equal(decision.rule_id, RULES.H6);
  assert.ok(decision.offer);
  assert.notEqual(decision.plane, PLANES.CONSTRUIR);
  assert.equal(allowsSiraCode(decision), false);
});

test('R_CHIP beats toggle', () => {
  const decision = routeTurn(fixture.chipBeatsToggle);
  assert.equal(decision.plane, PLANES.CONVERSAR);
  assert.equal(decision.rule_id, RULES.R_CHIP);
  assert.equal(decision.lane, 'image');
  assert.equal(decision.toggleIgnored, true);
  assert.equal(allowsSiraCode(decision), false);
});

test('R_TRIVIAL ignored when there is an attachment or chip', () => {
  const withFile = routeTurn(fixture.trivialWithAttachment);
  assert.notEqual(withFile.rule_id, RULES.R_TRIVIAL);
  assert.equal(withFile.trivial, false);
  assert.equal(isTrivialChatTurn('hola', { attachments: fixture.trivialWithAttachment.attachments }), false);

  const withChip = routeTurn(fixture.trivialWithChip);
  assert.equal(withChip.rule_id, RULES.R_CHIP);
  assert.equal(withChip.trivial, false);
  assert.equal(isTrivialPhrase('hola'), true);
});

test('slash plane commands and generate guards keep tools schema', () => {
  assert.equal(routeTurn({ text: '/construir el hook' }).plane, PLANES.CONSTRUIR);
  assert.equal(routeTurn({ text: '/construir el hook' }).rule_id, RULES.R_CMD);
  assert.equal(routeTurn({ text: '/planificar el informe' }).plane, PLANES.PLANIFICAR);
  assert.equal(routeTurn({ text: '/conversar' }).plane, PLANES.CONVERSAR);

  const req = {
    body: {
      reasoningEffort: 'max',
      tools: [{ type: 'function', function: { name: 'web_search' } }],
    },
  };
  applyTrivialTurnGuards(req, 'hola');
  assert.equal(req._trivialTurn, true);
  assert.equal(req.body.disableAgentic, true);
  assert.equal(req.body.tool_choice, 'none');
  assert.ok(req.body.max_tokens <= 256);
  assert.ok(Array.isArray(req.body.tools));
  assert.equal(req.body.tools.length, 1);
  assert.equal(req._turnDecision.plane, PLANES.CONVERSAR);
  assert.equal(req._turnDecision.rule_id, RULES.R_TRIVIAL);
});

test('generate path still applies trivial guards and logs plane/rule_id', () => {
  const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(aiRoute, /applyTrivialTurnGuards\(req, prompt\)/);
  assert.match(aiRoute, /trivial turn kept on direct mode; Extra\/Max skipped/);
  const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'turn-router.js'), 'utf8');
  assert.match(routerSrc, /\[turn-router\] plane=\$\{plane\} rule_id=\$\{rule_id\}/);
  const loopSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sira-code', 'loop.js'), 'utf8');
  assert.match(loopSrc, /\[turn-router\] plane=\$\{turnDecision\.plane\} rule_id=\$\{turnDecision\.rule_id\}/);
});
