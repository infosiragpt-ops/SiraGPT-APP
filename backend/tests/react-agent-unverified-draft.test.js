'use strict';

/**
 * react-agent — current date in the system prompt + honest unverified-draft
 * delivery when the finalize guard exhausts the repair allowance.
 *
 * Live failure (2026-09-18, «¿Qué precio tiene el bitcoin hoy…?»): the loop
 * had no notion of "today", searched «2025» / «October 2026» for 24 steps and
 * ended with «No pude verificar…» although it had a sourced draft.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const reactAgent = require('../src/services/react-agent');

function makeFinalizeOpenAI(answer) {
  const requests = [];
  let n = 0;
  return {
    requests,
    chat: {
      completions: {
        create: async (params) => {
          requests.push(params);
          n += 1;
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: 'thinking',
                tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer }) } }],
              },
            }],
          };
        },
      },
    },
  };
}

const SOURCED_DRAFT = 'El bitcoin cotiza hoy en torno a 80.800 USD (+5,5 % en 24 h) según Binance y CoinMarketCap; esta semana rebotó tras tocar mínimos de 2026. Fuentes: https://www.binance.com/en/price/bitcoin';

test('buildCurrentDateLine: real UTC date, disabled with null, robust to garbage', () => {
  const line = reactAgent.buildCurrentDateLine(Date.UTC(2026, 8, 18, 12));
  assert.match(line, /^Current date \(UTC\): Friday, September 18, 2026 — ISO 2026-09-18\./);
  assert.match(line, /"2026"/, 'the year is spelled out for search queries');
  assert.equal(reactAgent.buildCurrentDateLine(null), '');
  assert.equal(reactAgent.buildCurrentDateLine('not a date'), '');
  assert.match(reactAgent.buildCurrentDateLine(), /^Current date \(UTC\): /);
});

test('run(): the system prompt carries today\'s date by default and honours opts.now', async () => {
  const openai = makeFinalizeOpenAI(SOURCED_DRAFT);
  await reactAgent.run(openai, { query: 'precio del bitcoin hoy', tools: [], maxSteps: 2, model: 'test-model', now: Date.UTC(2026, 8, 18, 9) });
  assert.match(openai.requests[0].messages[0].content, /Current date \(UTC\): Friday, September 18, 2026/);
  assert.ok(openai.requests[0].messages[0].content.startsWith(reactAgent.SYSTEM_PROMPT), 'base rules stay first');

  const off = makeFinalizeOpenAI(SOURCED_DRAFT);
  await reactAgent.run(off, { query: 'precio del bitcoin hoy', tools: [], maxSteps: 2, model: 'test-model', now: null });
  assert.doesNotMatch(off.requests[0].messages[0].content, /Current date \(UTC\)/);
});

test('exhausted reviewer rejections deliver the sourced draft with an honest caveat', async () => {
  const openai = makeFinalizeOpenAI(SOURCED_DRAFT);
  const result = await reactAgent.run(openai, {
    query: '¿Qué precio tiene el bitcoin hoy y qué pasó esta semana con su cotización?',
    tools: [],
    maxSteps: 6,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, code: 'E_VERIFICATION_REJECTED', message: 'Quality check failed: unsupported figure' }),
  });
  assert.match(String(result.stoppedReason), /^verification_failed/);
  assert.equal(result.unverifiedDraft, true);
  assert.ok(result.finalAnswer.startsWith(SOURCED_DRAFT), 'the draft is delivered verbatim first');
  assert.match(result.finalAnswer, /No pude verificar automáticamente esta respuesta/);
  assert.ok(result.finalAnswer.endsWith(reactAgent.UNVERIFIED_DRAFT_CAVEAT));
  assert.doesNotMatch(result.finalAnswer, /No pude verificar que se haya completado lo solicitado/);
});

test('a required tool that never ran keeps the blunt failure (content may be invented)', async () => {
  const openai = makeFinalizeOpenAI(SOURCED_DRAFT);
  const result = await reactAgent.run(openai, {
    query: '¿Qué precio tiene el bitcoin hoy?',
    tools: [],
    maxSteps: 6,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'missing tools', missingTools: ['web_search'], requiredTools: ['web_search'] }),
  });
  assert.match(String(result.stoppedReason), /^verification_failed/);
  assert.equal(result.unverifiedDraft, false);
  assert.match(result.finalAnswer, /No pude verificar que se haya completado lo solicitado/);
  assert.doesNotMatch(result.finalAnswer, /80\.800/);
});

test('a draft claiming a side effect no tool performed is never salvaged', async () => {
  const claimed = `${SOURCED_DRAFT} Creé el documento PDF con el informe completo.`;
  const openai = makeFinalizeOpenAI(claimed);
  const result = await reactAgent.run(openai, {
    query: 'hazme un informe del bitcoin en pdf',
    tools: [],
    maxSteps: 6,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'Quality check failed: claims a file' }),
  });
  assert.equal(result.unverifiedDraft, false);
  assert.match(result.finalAnswer, /No pude verificar que se haya completado lo solicitado/);
  assert.doesNotMatch(result.finalAnswer, /Creé el documento/);
});

test('buildUnverifiedDraftAnswer: short drafts and missing-tool rejections return null', () => {
  assert.equal(reactAgent.buildUnverifiedDraftAnswer({ draft: 'Listo.', guard: {}, steps: [] }), null);
  assert.equal(reactAgent.buildUnverifiedDraftAnswer({ draft: SOURCED_DRAFT, guard: { missingTools: ['docintel_analyze'] }, steps: [] }), null);
  const ok = reactAgent.buildUnverifiedDraftAnswer({ draft: SOURCED_DRAFT, guard: { missingTools: [] }, steps: [{ actions: [{ tool: 'web_search', observation: { count: 3 } }] }] });
  assert.ok(ok && ok.startsWith(SOURCED_DRAFT) && ok.endsWith(reactAgent.UNVERIFIED_DRAFT_CAVEAT));
  const claimed = reactAgent.buildUnverifiedDraftAnswer({ draft: `${SOURCED_DRAFT} Busqué en la web y leí la página de Binance.`, guard: {}, steps: [{ actions: [{ tool: 'web_search', observation: { count: 3 } }] }] });
  assert.ok(claimed, 'a research claim backed by a real web_search observation is fine');
});
