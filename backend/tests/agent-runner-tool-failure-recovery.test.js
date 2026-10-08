'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { deadLetterSameToolAfterN } = require('../src/services/agent-runner/engine-adapter');
const { BASE_TOOL_DEFINITIONS, OFFICE_TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');
const { OUTPUTS_SNAPSHOT } = require('../src/services/agent-runner/tools.office');

const OUTPUT = 'outputs/qa.xlsx';
const definitions = [...BASE_TOOL_DEFINITIONS, ...OFFICE_TOOL_DEFINITIONS]
  .filter((tool) => ['execute_python', 'inspect_document', 'verify_visual'].includes(tool.function.name));

// Keep the real loop, schemas, anti-loop guards, output diff and verification
// gate. Only the model and sandbox boundaries are deterministic test doubles.
async function runSequence(sequence, { maxIterations = 25 } = {}) {
  let turn = 0;
  let revision = 0;
  const executed = [];
  const events = [];
  const messages = [{ role: 'user', content: 'Comprueba los datos y las gráficas del Excel antes de entregarlo.' }];
  const executors = Object.fromEntries(definitions.map((tool) => [tool.function.name, async (args) => {
    const item = sequence[turn - 1];
    executed.push({ tool: tool.function.name, turn, args });
    if (item.mutates) revision += 1;
    return item.result || (tool.function.name === 'verify_visual'
      ? `VEREDICTO: VERIFICADO\nComprobación ${turn}`
      : `Comprobación ${turn}: datos correctos`);
  }]));
  executors[OUTPUTS_SNAPSHOT] = async () => revision ? { [OUTPUT]: `100 ${revision}` } : {};
  const result = await runAgentLoop({
    model: 'deepseek-v4-flash', messages, tools: definitions, executors, maxIterations,
    client: { chat: { completions: { create: async () => {
      const item = sequence[turn++];
      const name = item?.tool || 'execute_python';
      const args = name === 'verify_visual'
        ? { after: OUTPUT, checklist: [`Comprobación ${turn}`] }
        : name === 'inspect_document'
          ? { path: OUTPUT, query: `datos ${turn}` }
          : { code: `print("comprobación ${turn}")` };
      return { choices: [{ message: item ? {
        content: null,
        tool_calls: [{ id: `qa-tool-${turn}`, type: 'function', function: {
          name, arguments: JSON.stringify(args),
        } }],
      } : { content: 'Listo: documento comprobado.' } }] };
    } } } },
    onEvent: (event) => events.push(event),
  });
  return { result, executed, events };
}

function failed(index) {
  return { result: `ERROR: AttributeError en comprobación ${index}` };
}

test('successful Python work clears earlier failures before the later QA readback error', async () => {
  // Live QA ordering: Python errors at 6/7, successes at 8/9/11/14/15/16,
  // verified render at 18, then an independent XML readback error at 19.
  const sequence = Array.from({ length: 20 }, () => ({}));
  sequence[0] = { mutates: true };
  sequence[5] = failed(6);
  sequence[6] = failed(7);
  sequence[16] = { tool: 'inspect_document' };
  sequence[17] = { tool: 'verify_visual' };
  sequence[18] = failed(19);
  const { result, executed, events } = await runSequence(sequence);
  assert.equal(result.stoppedReason, 'final');
  assert.equal(executed.length, 20, 'the corrective readback must execute after the third non-consecutive error');
  assert.equal(result.steps.filter((step) => step.ok === false).length, 3);
  assert.equal(result.steps[17].tool, 'verify_visual');
  assert.equal(result.steps[17].ok, true);
  assert.equal(events.some((event) => event.code === 'tool_dead_letter'), false);
});

test('three consecutive Python failures: one recovery nudge, then the dead letter halts before a fourth execution', async () => {
  const { result, executed, events } = await runSequence([failed(1), failed(2), failed(3), {}]);
  // The no-progress guard speaks once after the third failed result
  // (no-progress-nudge.js: change approach, verify what exists). The model
  // asks for execute_python again and the same-tool dead letter refuses it
  // before any fourth execution.
  assert.equal(result.stoppedReason, 'tool_dead_letter');
  assert.equal(executed.length, 3);
  assert.equal(events.filter((event) => event.type === 'no_progress_recovery').length, 1);
  const history = result.steps.map((step) => ({ tool: step.tool, code: 'tool_error' }));
  assert.equal(deadLetterSameToolAfterN(history.slice(0, 2)).halt, false);
  assert.equal(deadLetterSameToolAfterN(history).code, 'tool_dead_letter');
});

test('success of another tool does not clear unresolved Python failures', async () => {
  const { result, executed } = await runSequence([
    failed(1), failed(2), { tool: 'inspect_document' }, failed(4), {},
  ]);
  assert.equal(result.stoppedReason, 'tool_dead_letter');
  assert.equal(executed.length, 4);
});

test('recovery cannot deliver a changed Office file without visual verification', async () => {
  const { result, events } = await runSequence([
    failed(1), failed(2), { mutates: true }, { tool: 'inspect_document' },
  ]);
  assert.equal(result.stoppedReason, 'verification_failed');
  assert.equal(result.verificationAttempts, 3);
  assert.equal(events.some((event) => event.code === 'tool_dead_letter'), false);
});

test('recovered calls remain subject to the original iteration budget', async () => {
  const { result, executed } = await runSequence([failed(1), {}, failed(3), {}], { maxIterations: 3 });
  assert.equal(result.stoppedReason, 'max_iterations');
  assert.equal(result.iterations, 3);
  assert.equal(executed.length, 3);
});


test('recovering Python preserves another tool failure streak', async () => {
  const { result, executed } = await runSequence([
    failed(1),
    { ...failed(2), tool: 'inspect_document' },
    { tool: 'verify_visual' },
    failed(4),
    { ...failed(5), tool: 'inspect_document' },
    {},
    {},
    { ...failed(8), tool: 'inspect_document' },
    {},
  ]);
  assert.equal(result.stoppedReason, 'tool_dead_letter');
  assert.equal(executed.length, 8);
});

test('success within a batch cannot reopen a tool that already reached three failures', async () => {
  let turn = 0;
  let executed = 0;
  const call = (index) => ({ id: `batch-${index}`, type: 'function', function: {
    name: 'execute_python', arguments: JSON.stringify({ code: `print(${index})` }),
  } });
  const result = await runAgentLoop({
    model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Revisa los datos existentes.' }],
    tools: definitions, maxIterations: 3,
    client: { chat: { completions: { create: async () => ({ choices: [{ message: {
      content: null, tool_calls: ++turn === 1 ? [1, 2, 3, 4].map(call) : [call(5)],
    } }] }) } } },
    executors: {
      execute_python: async () => ++executed <= 3 ? `ERROR: lectura fallida ${executed}` : 'Lectura recuperada',
      [OUTPUTS_SNAPSHOT]: async () => ({}),
    },
  });
  assert.equal(result.stoppedReason, 'tool_dead_letter');
  assert.equal(executed, 4, 'the existing batch may finish but must not execute a fifth call');
});
