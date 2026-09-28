'use strict';

// Owner policy on AgentRunner document turns: an E_PROVIDER failure shows the
// loop's exact cause (which model, sin saldo / clave rechazada / no responde /
// límite por minuto) without a visible «E_PROVIDER:» prefix; raw provider
// text never reaches the user. The loop is told the model's display name.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildAgentRunnerFailureMessage,
  runnerModelLabel,
} = require('../src/services/agent-runner');

const LOOP_COPY = 'El proveedor del modelo seleccionado (DeepSeek V4 Flash) no tiene saldo en este momento. No cambié de modelo: elige otro o vuelve a intentarlo más tarde.';

test('E_PROVIDER shows the loop\'s transparent cause without a code prefix', () => {
  const message = buildAgentRunnerFailureMessage('E_PROVIDER', LOOP_COPY);
  assert.equal(message, `No pude generar el documento. ${LOOP_COPY}`);
  assert.doesNotMatch(message, /E_PROVIDER/);
  assert.doesNotMatch(message, /Detalle técnico/);
});

test('raw provider text, URLs or keys fall back to the generic copy', () => {
  const generic = buildAgentRunnerFailureMessage('E_PROVIDER', null);
  assert.equal(generic, 'No pude generar el documento. El modelo seleccionado no está disponible. Reintenta o elige otro modelo.');
  for (const raw of [
    '402 Insufficient credits. Add more using https://openrouter.ai/credits',
    'Incorrect API key provided: sk-proj-abcdef',
    'Request failed with status code 500',
    `${'a'.repeat(420)} más`,
  ]) {
    assert.equal(buildAgentRunnerFailureMessage('E_PROVIDER', raw), generic, raw.slice(0, 40));
  }
});

test('other reasons keep their honest copy', () => {
  const m402 = buildAgentRunnerFailureMessage('llm_402', 'You requested up to 8192 tokens…');
  assert.match(m402, /créditos/);
  assert.match(m402, /plantilla genérica/);
});

test('runnerModelLabel names the picker model, never a raw id', () => {
  assert.equal(runnerModelLabel('DeepSeek:deepseek-v4-flash'), 'DeepSeek V4 Flash');
  assert.equal(runnerModelLabel('Unresolved:deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(runnerModelLabel('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(runnerModelLabel('Custom:acme-internal-x9'), null);
  assert.equal(runnerModelLabel(''), null);
});

test('both runAgentLoop calls pass the model\'s display name to the loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'index.js'), 'utf8');
  const calls = source.split('await runAgentLoop({').slice(1);
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.match(call.slice(0, 400), /modelLabel: runnerModelLabel\(pickedModel \|\| resolvedModel\),/);
  }
});
