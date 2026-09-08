'use strict';

/**
 * SiraCode native `question` / user-ask — OpenCode contract, no vendor dump.
 * Offline: scripted LLM, temp workspace, existing permission-resume card.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const siraCode = require('../src/services/sira-code');
const { authorizeTool } = require('../src/services/sira-code/permissions');
const { executeTool, TOOL_DEFINITIONS } = require('../src/services/sira-code/tools');
const {
  ERRORS,
  MAX_HEADER,
  MAX_QUESTIONS,
  isQuestionTool,
  normalizeQuestionArgs,
  validateAnswers,
  publicQuestions,
  runQuestion,
} = require('../src/services/sira-code/question-tool');

beforeEach(() => {
  siraCode._resetForTests();
});

afterEach(() => {
  siraCode._resetForTests();
});

const SAMPLE_QUESTIONS = [
  {
    question: '¿Qué framework usamos para la API?',
    header: 'Framework',
    options: [
      { label: 'Express', description: 'El stack actual' },
      { label: 'Fastify', description: 'Más rápido' },
    ],
  },
];

function scriptedQuestionLlm(questions = SAMPLE_QUESTIONS, extraCalls = []) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        toolCalls: [
          { name: 'question', arguments: { questions } },
          ...extraCalls,
        ],
      };
    }
    return { text: 'Sigo.', toolCalls: [] };
  };
}

test('isQuestionTool maps question / user_ask / ask_user only', () => {
  assert.equal(isQuestionTool('question'), true);
  assert.equal(isQuestionTool('user_ask'), true);
  assert.equal(isQuestionTool('ask_user'), true);
  assert.equal(isQuestionTool('ask'), false);
  assert.equal(isQuestionTool('write'), false);
});

test('TOOL_DEFINITIONS expose the OpenCode-style question schema', () => {
  const def = TOOL_DEFINITIONS.find((item) => item.function.name === 'question');
  assert.ok(def, 'question must be registered');
  assert.deepEqual(def.function.parameters.required, ['questions']);
  assert.ok(def.function.description.includes('español'));
  assert.ok(def.function.description.includes('user_ask'));
});

test('normalizeQuestionArgs requires at least one prompt', () => {
  const empty = normalizeQuestionArgs({ questions: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, ERRORS.empty);
  const blank = normalizeQuestionArgs({ questions: [{ header: 'x' }] });
  assert.equal(blank.ok, false);
  assert.equal(blank.error, ERRORS.blank);
});

test('normalizeQuestionArgs caps the question list', () => {
  const tooMany = normalizeQuestionArgs({
    questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ question: `¿n${i}?` })),
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, ERRORS.tooMany);
});

test('normalizeQuestionArgs trims the header to 30 characters', () => {
  const out = normalizeQuestionArgs({
    question: '¿Confirmamos el despliegue a producción esta noche o esperamos al lunes?',
    header: 'Esta etiqueta es demasiado larga para el chip de permiso',
  });
  assert.equal(out.ok, true);
  assert.ok(out.questions[0].header.length <= MAX_HEADER);
});

test('normalizeQuestionArgs accepts a bare string and option strings', () => {
  const out = normalizeQuestionArgs({
    questions: ['¿Seguimos?'],
    // also via single object with choices
  });
  assert.equal(out.ok, true);
  assert.equal(out.questions[0].question, '¿Seguimos?');
  const withChoices = normalizeQuestionArgs({
    text: '¿Tema?',
    choices: ['Claro', { label: 'Oscuro', description: 'menos brillo' }],
    multiple: true,
  });
  assert.equal(withChoices.ok, true);
  assert.equal(withChoices.questions[0].multiple, true);
  assert.equal(withChoices.questions[0].options.length, 2);
  assert.equal(withChoices.questions[0].options[1].description, 'menos brillo');
});

test('validateAnswers accepts labels and custom text by default', () => {
  const prompts = normalizeQuestionArgs({ questions: SAMPLE_QUESTIONS }).questions;
  const ok = validateAnswers(prompts, [['Express']]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.answers, [['Express']]);
  const custom = validateAnswers(prompts, [['Nest']]);
  assert.equal(custom.ok, true);
  assert.deepEqual(custom.answers, [['Nest']]);
});

test('validateAnswers rejects unknown labels when custom is false', () => {
  const prompts = normalizeQuestionArgs({
    questions: [{ ...SAMPLE_QUESTIONS[0], custom: false }],
  }).questions;
  const bad = validateAnswers(prompts, [['Nest']]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, ERRORS.unknownOption);
});

test('validateAnswers rejects several picks unless multiple is true', () => {
  const single = normalizeQuestionArgs({ questions: SAMPLE_QUESTIONS }).questions;
  const tooMany = validateAnswers(single, [['Express', 'Fastify']]);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, ERRORS.singleOnly);
  const multi = normalizeQuestionArgs({
    questions: [{ ...SAMPLE_QUESTIONS[0], multiple: true }],
  }).questions;
  const ok = validateAnswers(multi, [['Express', 'Fastify']]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.answers, [['Express', 'Fastify']]);
});

test('publicQuestions stays free of vendor and model_id keys', () => {
  const prompts = normalizeQuestionArgs({ questions: SAMPLE_QUESTIONS }).questions;
  const pub = publicQuestions(prompts);
  const blob = JSON.stringify(pub);
  assert.ok(!blob.includes('model_id'));
  assert.ok(!blob.includes('DeepSeek'));
  assert.ok(!blob.includes('OpenRouter'));
  assert.equal(pub[0].header, 'Framework');
});

test('runQuestion formats a Spanish answered result', () => {
  const result = runQuestion(null, { questions: SAMPLE_QUESTIONS }, { answers: [['Express']] });
  assert.equal(result.ok, true);
  assert.match(result.content, /El usuario respondió/);
  assert.match(result.content, /Express/);
  assert.ok(!result.content.includes('User has answered'));
});

test('aliases user_ask and ask_user authorize as question', () => {
  assert.equal(authorizeTool('construir', 'user_ask').tool, 'question');
  assert.equal(authorizeTool('construir', 'ask_user').needsPermission, true);
  assert.equal(authorizeTool('construir', 'ask_user').reason, 'question_required');
});

test('construir question parks a permission-resume card', async () => {
  const session = await siraCode.create({ userId: 'u-q', agent: 'construir' });
  const result = await siraCode.prompt(session.id, 'elige stack', {
    userId: 'u-q',
    llmTurn: scriptedQuestionLlm(),
  });
  const asked = result.toolResults.find((row) => row.tool === 'question');
  assert.ok(asked);
  assert.equal(asked.ok, false);
  assert.equal(asked.code, 'permission_required');
  const stored = siraCode.get(session.id, 'u-q');
  assert.equal(stored.pendingPermissions.length, 1);
  assert.equal(stored.pendingPermissions[0].tool, 'question');
  assert.equal(stored.pendingPermissions[0].label, 'Esperando respuesta');
  assert.equal(stored.pendingPermissions[0].kind, 'question');
  assert.equal(stored.pendingPermissions[0].header, 'Framework');
  const ev = siraCode.getSession(session.id).events.find((row) => row.type === 'permission');
  assert.ok(ev);
  assert.equal(ev.label, 'Esperando respuesta');
  assert.equal(ev.kind, 'question');
});

test('construir question pauses later writes in the same turn', async () => {
  const session = await siraCode.create({ userId: 'u-pause', agent: 'construir' });
  const result = await siraCode.prompt(session.id, 'pregunta y escribe', {
    userId: 'u-pause',
    llmTurn: scriptedQuestionLlm(SAMPLE_QUESTIONS, [
      { name: 'write', arguments: { path: 'no.txt', content: 'no-debes' } },
    ]),
  });
  assert.ok(result.toolResults.some((row) => row.tool === 'question'));
  assert.ok(!result.toolResults.some((row) => row.tool === 'write'));
  const root = siraCode.getSession(session.id).workspace.root;
  assert.equal(fs.existsSync(path.join(root, 'no.txt')), false);
});

test('planificar may ask a read-only clarifying question', async () => {
  const session = await siraCode.create({ userId: 'u-plan', agent: 'planificar' });
  const result = await siraCode.prompt(session.id, 'aclara el alcance', {
    userId: 'u-plan',
    llmTurn: scriptedQuestionLlm(),
  });
  const asked = result.toolResults.find((row) => row.tool === 'question');
  assert.equal(asked.code, 'permission_required');
  const auth = authorizeTool('planificar', 'question');
  assert.equal(auth.denied, false);
  assert.equal(auth.needsPermission, true);
});

test('answering a planificar question does not unlock write', async () => {
  const session = await siraCode.create({ userId: 'u-plan2', agent: 'planificar' });
  await siraCode.prompt(session.id, 'aclara', {
    userId: 'u-plan2',
    llmTurn: scriptedQuestionLlm(),
  });
  const pending = siraCode.get(session.id, 'u-plan2').pendingPermissions[0];
  const resolved = await siraCode.resolvePermission(
    session.id,
    pending.permissionId,
    'always',
    'u-plan2',
    { answers: [['Express']] },
  );
  assert.equal(resolved.executed, true);
  assert.equal(resolved.remembered, false);
  const write = authorizeTool('planificar', 'write', {
    approved: true,
    grants: siraCode.getSession(session.id).permissionGrants,
  });
  assert.equal(write.denied, true);
});

test('general subagent cannot ask the user', () => {
  const auth = authorizeTool('general', 'question');
  assert.equal(auth.denied, true);
  assert.equal(auth.needsPermission, false);
});

test('resolve allow records structured Spanish answers', async () => {
  const session = await siraCode.create({ userId: 'u-ans', agent: 'construir' });
  await siraCode.prompt(session.id, 'elige', {
    userId: 'u-ans',
    llmTurn: scriptedQuestionLlm(),
  });
  const pending = siraCode.get(session.id, 'u-ans').pendingPermissions[0];
  const resolved = await siraCode.resolvePermission(
    session.id,
    pending.permissionId,
    'allow',
    'u-ans',
    { answers: [['Express']] },
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.executed, true);
  assert.deepEqual(resolved.answers, [['Express']]);
  assert.match(resolved.result.preview, /Express/);
  assert.match(resolved.result.preview, /El usuario respondió/);
  assert.equal(siraCode.get(session.id, 'u-ans').pendingPermissions.length, 0);
  const ev = siraCode.getSession(session.id).events.find((row) => row.type === 'permission_resolved');
  assert.equal(ev.label, 'Respuesta registrada');
});

test('resolve deny dismisses the question without assuming an option', async () => {
  const session = await siraCode.create({ userId: 'u-den', agent: 'construir' });
  await siraCode.prompt(session.id, 'elige', {
    userId: 'u-den',
    llmTurn: scriptedQuestionLlm(),
  });
  const pending = siraCode.get(session.id, 'u-den').pendingPermissions[0];
  const resolved = await siraCode.resolvePermission(session.id, pending.permissionId, 'reject', 'u-den');
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.executed, false);
  assert.equal(resolved.dismissed, true);
  assert.match(resolved.result.preview, /descartó/);
  assert.ok(!resolved.result.preview.includes('Express'));
});

test('invalid answers on resume keep the pending card', async () => {
  const session = await siraCode.create({ userId: 'u-bad', agent: 'construir' });
  await siraCode.prompt(session.id, 'elige', {
    userId: 'u-bad',
    llmTurn: scriptedQuestionLlm([{
      question: '¿Uno?',
      header: 'Uno',
      options: [{ label: 'Sí' }, { label: 'No' }],
      custom: false,
    }]),
  });
  const pending = siraCode.get(session.id, 'u-bad').pendingPermissions[0];
  await assert.rejects(
    () => siraCode.resolvePermission(
      session.id,
      pending.permissionId,
      'allow',
      'u-bad',
      { answers: [['Tal vez']] },
    ),
    /opción desconocida/,
  );
  assert.equal(siraCode.get(session.id, 'u-bad').pendingPermissions.length, 1);
});

test('allow without answers still resumes (existing permission card)', async () => {
  const session = await siraCode.create({ userId: 'u-card', agent: 'construir' });
  await siraCode.prompt(session.id, 'elige', {
    userId: 'u-card',
    llmTurn: scriptedQuestionLlm(),
  });
  const pending = siraCode.get(session.id, 'u-card').pendingPermissions[0];
  const resolved = await siraCode.resolvePermission(session.id, pending.permissionId, 'once', 'u-card');
  assert.equal(resolved.executed, true);
  assert.match(resolved.result.preview, /Sin respuesta/);
});

test('always on a question does not remember a grant', async () => {
  const session = await siraCode.create({ userId: 'u-alw', agent: 'construir' });
  await siraCode.prompt(session.id, 'elige', {
    userId: 'u-alw',
    llmTurn: scriptedQuestionLlm(),
  });
  const pending = siraCode.get(session.id, 'u-alw').pendingPermissions[0];
  const resolved = await siraCode.resolvePermission(
    session.id,
    pending.permissionId,
    'always',
    'u-alw',
    { answers: [['Fastify']] },
  );
  assert.equal(resolved.remembered, false);
  assert.equal(siraCode.getSession(session.id).permissionGrants.has('question'), false);
  assert.equal(authorizeTool('construir', 'question').needsPermission, true);
});

test('composer Solo lectura still allows question', () => {
  const auth = authorizeTool('construir', 'question', { permission: 'read' });
  assert.equal(auth.denied, false);
  assert.equal(auth.needsPermission, true);
  assert.equal(auth.reason, 'question_required');
});

test('composer Acceso completo still pauses for question', () => {
  const auth = authorizeTool('construir', 'question', { permission: 'full' });
  assert.equal(auth.allowed, false);
  assert.equal(auth.needsPermission, true);
  assert.equal(auth.reason, 'question_required');
});

test('executeTool(question) without answers returns permission_required', async () => {
  const session = await siraCode.create({ userId: 'u-exec' });
  const live = siraCode.getSession(session.id);
  const result = await executeTool(live, 'question', { questions: SAMPLE_QUESTIONS });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission_required');
});

test('invalid question args fail in the loop without parking', async () => {
  const session = await siraCode.create({ userId: 'u-inv', agent: 'construir' });
  const result = await siraCode.prompt(session.id, 'pregunta vacía', {
    userId: 'u-inv',
    llmTurn: async () => ({
      text: '',
      toolCalls: [{ name: 'question', arguments: { questions: [] } }],
    }),
  });
  const asked = result.toolResults.find((row) => row.tool === 'question');
  assert.equal(asked.ok, false);
  assert.equal(asked.code, 'validation');
  assert.equal(siraCode.get(session.id, 'u-inv').pendingPermissions.length, 0);
});

test('approved question with answers does not write files', async () => {
  const session = await siraCode.create({ userId: 'u-ro' });
  const live = siraCode.getSession(session.id);
  const result = await executeTool(
    live,
    'question',
    { questions: SAMPLE_QUESTIONS },
    { approved: true, answers: [['Express']] },
  );
  assert.equal(result.ok, true, result.error);
  const files = await live.workspace.listFiles('.');
  assert.equal(files.length, 0);
});
