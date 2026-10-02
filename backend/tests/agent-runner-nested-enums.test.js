'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../src/services/agent-runner/engine-adapter');
const wave65 = require('../src/services/agent-runner/engine-3h65');
const wave66 = require('../src/services/agent-runner/engine-3h66');
const office = require('../src/services/agent-runner/tools.office');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const verifyDefinition = office.OFFICE_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'verify_visual');
const schema = verifyDefinition.function.parameters;
const chartTypes = schema.properties.expect.properties.charts.items.properties.type.enum;

function chartArgs(charts) {
  return { after: 'outputs/qa.xlsx', checklist: ['Verificar datos y las dos gráficas solicitadas.'], expect: { charts } };
}
function validate(args, selectedSchema = schema) {
  return wave65.applyToolArgHygieneClosed({
    args, schema: selectedSchema, name: 'verify_visual',
    enforceAdditionalPropertiesFalse: adapter.enforceAdditionalPropertiesFalse,
    validateEnumArgs: adapter.validateEnumArgs,
  });
}
async function callThroughLoop(args, definition = verifyDefinition) {
  let turns = 0;
  const executed = [];
  const events = [];
  const messages = [{ role: 'user', content: 'Comprueba el archivo existente con los requisitos indicados.' }];
  await runAgentLoop({
    model: 'deepseek-v4-flash', messages, tools: [definition], maxIterations: 2,
    client: { chat: { completions: { create: async () => ({ choices: [{ message: ++turns === 1 ? {
      content: null, tool_calls: [{ id: 'validate-chart-1', type: 'function', function: {
        name: definition.function.name, arguments: JSON.stringify(args),
      } }],
    } : { content: 'Fin de comprobación.' } }] }) } } },
    executors: { [definition.function.name]: async (actual) => { executed.push(actual); return 'VEREDICTO: VERIFICADO'; } },
    onEvent: (event) => events.push(event),
  });
  return { executed, events, feedback: messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n') };
}

test('verify_visual accepts omitted optional enums in each chart without modifying input', () => {
  const args = chartArgs([
    { sheet: 'Resumen', chart: 1, type: 'column', grouping: 'clustered', editable: true },
    { sheet: 'Resumen', chart: 2, type: 'line', editable: true },
    { sheet: 'Resumen', chart: 3, editable: true },
  ]);
  const original = JSON.stringify(args);
  assert.equal(validate(args).ok, true);
  assert.equal(JSON.stringify(args), original);
});

test('nested required enums, explicit nulls and invalid values remain rejected', () => {
  const nested = { type: 'object', properties: { rows: { type: 'array', items: {
    type: 'object', required: ['mode'], properties: { mode: { enum: ['read', 'write'] }, optional: { enum: ['yes', 'no'] } },
  } } } };
  for (const row of [{}, { mode: null }, { mode: 'delete' }, { mode: 'read', optional: 'invalid' }, { mode: 'read', optional: undefined }]) {
    assert.equal(validate({ rows: [row] }, nested).ok, false, JSON.stringify(row));
  }
  assert.equal(validate({ rows: [{ mode: 'read' }] }, nested).ok, true);
  assert.equal(validate(chartArgs([{ chart: 1, type: 'column', grouping: null }])).ok, false);
  assert.equal(validate({}, { type: 'object', properties: { optional: {
    type: 'object', required: ['mode'], properties: { mode: { enum: ['read', 'write'] } },
  } } }).ok, true);
});

test('enum rejection identifies the exact array item using only field and allowed schema values', () => {
  const args = chartArgs([{ chart: 1, type: 'column', grouping: 'clustered' }, { chart: 2, type: 'secret-rejected-value' }]);
  const result = validate(args);
  assert.equal(result.code, 'enum_rejected');
  assert.deepEqual(result.validation, { path: ['expect', 'charts', 1, 'type'], allowed: chartTypes });
  assert.equal(JSON.stringify(result.validation).includes('secret-rejected-value'), false);
  assert.deepEqual(adapter.validateEnumArgs(['read', 'invalid'], { type: 'array', items: { enum: ['read', 'write'] } }).validation,
    { path: [1], allowed: ['read', 'write'] });
});

test('agent loop executes valid chart verification instead of blocking a missing optional grouping', async () => {
  const args = chartArgs([{ sheet: 'Resumen', chart: 1, type: 'column', grouping: 'clustered' }, { sheet: 'Resumen', chart: 2, type: 'line' }]);
  const result = await callThroughLoop(args);
  assert.equal(result.executed.length, 1);
  assert.deepEqual(result.executed[0], args);
  assert.match(result.feedback, /VEREDICTO: VERIFICADO/);
  assert.equal(result.events.some((event) => event.type === 'retry'), false);
});

test('agent loop refuses invalid nested enum and returns repairable schema feedback without rejected input', async () => {
  const secret = 'Bearer rejected-user-secret';
  const result = await callThroughLoop(chartArgs([{ chart: 1, type: 'line', grouping: secret }]));
  assert.equal(result.executed.length, 0);
  assert.match(result.feedback, /expect\.charts\[0\]\.grouping/);
  assert.match(result.feedback, /clustered/);
  assert.match(result.feedback, /percentStacked/);
  assert.equal(result.feedback.includes(secret), false);
  assert.equal(result.events.some((event) => event.type === 'retry'), false);
});

test('first enum guard also reports a top-level field without leaking rejected input', async () => {
  const definition = { type: 'function', function: { name: 'verify_visual', parameters: {
    type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['read', 'write'] } },
  } } };
  const secret = 'sk-rejected-user-secret';
  const guarded = wave66.applyToolJsonCoerceClosed({ args: { mode: secret }, schema: definition.function.parameters,
    repairEnumCaseInsensitive: adapter.repairEnumCaseInsensitive,
  });
  assert.equal(guarded.refuse, true);
  assert.deepEqual(guarded.validation, { path: ['mode'], allowed: ['read', 'write'] });
  const result = await callThroughLoop({ mode: secret }, definition);
  assert.equal(result.executed.length, 0);
  assert.match(result.feedback, /mode/);
  assert.match(result.feedback, /read/);
  assert.match(result.feedback, /write/);
  assert.equal(result.feedback.includes(secret), false);
});

test('missing top-level required values still fail the existing required guard', () => {
  const result = wave66.applyToolJsonCoerceClosed({ args: { after: 'outputs/qa.xlsx' }, schema,
    repairEnumCaseInsensitive: adapter.repairEnumCaseInsensitive,
    repairMissingRequiredFromPriorTurn: adapter.repairMissingRequiredFromPriorTurn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_required');
});

test('unexpected enum traversal failures remain closed even when a getter throws null', () => {
  const brokenSchema = { get enum() { throw null; } };
  assert.equal(adapter.validateEnumArgs({}, brokenSchema).ok, false);
});
