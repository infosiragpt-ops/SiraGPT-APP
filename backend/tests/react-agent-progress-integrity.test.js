'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../src/services/react-agent');

const tool = (name, execute) => ({
  name,
  description: name,
  parameters: { type: 'object', additionalProperties: true },
  execute,
});

// Drive the real loop with deterministic responses; no provider, database,
// filesystem mutation, or tool implementation outside this fixture is used.
async function rejectedFinalizations({ names = ['host_file'], argsAt, resultAt }) {
  let modelCalls = 0;
  let executed = 0;
  let guardCalls = 0;
  const client = { chat: { completions: { create: async params => {
    const index = modelCalls++;
    const forceFinalize = params.tool_choice?.function?.name === 'finalize';
    const attempt = Math.floor(index / 2);
    const name = forceFinalize || index % 2 === 0 ? 'finalize' : names[attempt % names.length];
    const args = name === 'finalize'
      ? { answer: 'El cambio solicitado sigue sin evidencia suficiente.' }
      : argsAt?.(attempt) || { path: '/fixture/document.txt' };
    return { choices: [{ message: {
      role: 'assistant', content: '', tool_calls: [{
        id: `progress_${index}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    } }] };
  } } } };
  const result = await run(client, {
    query: 'Modifica el documento y verifica el cambio antes de afirmar que está terminado.',
    model: 'test-model', maxSteps: 30,
    tools: names.map(name => tool(name, async args => resultAt(++executed, name, args))),
    finalizeGuard: () => { guardCalls++; return { ok: false, message: 'No hay cambios verificables.' }; },
  });
  return { result, guardCalls, executed };
}

test('the first explicit no-op is evidence but repeating it does not reset finalization progress', async () => {
  const outcome = { ok: true, changed: false, revision: 7, path: '/fixture/document.txt' };
  const { guardCalls, executed, result } = await rejectedFinalizations({ resultAt: () => outcome });
  // First result may teach the model something new. Only later equal explicit
  // no-ops cease to reset the existing three-consecutive-rejection budget.
  assert.equal(guardCalls, 4);
  assert.equal(executed, 3);
  assert.deepEqual(result.steps[1].actions[0].observation, outcome, 'do not turn an honest no-op into a tool error');
});

test('argument spelling changes do not turn the same explicit no-op evidence into progress', async () => {
  const { guardCalls, executed } = await rejectedFinalizations({
    argsAt: attempt => ({ path: '/fixture/document.txt', encoding: attempt % 2 ? 'utf-8' : 'utf8' }),
    resultAt: () => ({ ok: true, changed: false, revision: 7, path: '/fixture/document.txt' }),
  });
  assert.equal(guardCalls, 4);
  assert.equal(executed, 3);
});

test('alternating tools may each add first evidence but repeated explicit no-ops are not new progress', async () => {
  const { guardCalls, executed } = await rejectedFinalizations({
    names: ['host_file', 'propose_patch'],
    resultAt: () => ({ ok: true, changed: false, revision: 7, path: '/fixture/document.txt' }),
  });
  // Tool identities must stay independent: the first result from the second
  // tool is not suppressed simply because it resembles the first tool's data.
  assert.equal(guardCalls, 5);
  assert.equal(executed, 4);
});

test('a no-op that observes a newer revision continues to count as evidence', async () => {
  const { guardCalls, executed } = await rejectedFinalizations({
    resultAt: revision => ({ ok: true, changed: false, revision }),
  });
  assert.equal(guardCalls, 8, 'new evidence must not trip the soft consecutive guard');
  assert.equal(executed, 7);
});

for (const [name, outcome] of [
  ['generic success', { ok: true }],
  ['explicit successful mutation', { ok: true, changed: true }],
  ['nested document data', { ok: true, record: { changed: false } }],
]) {
  test(`identical ${name} is not automatically classified as no progress`, async () => {
    const { guardCalls, executed } = await rejectedFinalizations({ resultAt: () => outcome });
    assert.equal(guardCalls, 8, 'result equality alone must not retire legitimate operations');
    assert.equal(executed, 7);
  });
}

test('different documents that report their identity are not collapsed as repeated no-op evidence', async () => {
  const { guardCalls, executed } = await rejectedFinalizations({
    argsAt: attempt => ({ path: `/fixture/document-${attempt}.txt` }),
    resultAt: (_attempt, _name, args) => ({ ok: true, changed: false, path: args.path }),
  });
  assert.equal(guardCalls, 8);
  assert.equal(executed, 7);
});
