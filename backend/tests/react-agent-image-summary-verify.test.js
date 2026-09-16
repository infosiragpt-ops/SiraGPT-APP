'use strict';

/**
 * Production bug: image + "dame un resumen en un solo párrafo" ended in
 * verification_failed and the Spanish degraded message instead of a paragraph.
 *
 * Root cause: the chat finalize profile treated any fileId as private-context
 * (docintel/rag) when image metadata was missing, and the LLM answer judge
 * rejected a vision-only draft for having no tool observations. The repair
 * loop then exhausted and replaced the summary.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const reactAgent = require('../src/services/react-agent');
const {
  buildExecutionProfile,
  validateFinalize,
} = require('../src/services/agents/agentic-execution-profile');
const {
  createAnswerVerifier,
  composeFinalizeGuards,
} = require('../src/services/agents/agent-plan-verify');
const { buildChatFinalizeProfile } = require('../src/services/agentic-chat-stream')._internal;

const QUERY = 'dame un resumen en un solo párrafo';
const PARAGRAPH = (
  'La imagen es una tabla de competencia digital docente. '
  + 'Compromiso profesional aparece con indicadores CDD1 entre 4 y 5, '
  + 'lo que describe un desempeño alto y consistente en esa dimensión. '
).repeat(4);

function scriptedFinalize(answer) {
  let calls = 0;
  return {
    get calls() { return calls; },
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: `call_${calls}`,
                  type: 'function',
                  function: {
                    name: 'finalize',
                    arguments: JSON.stringify({ answer }),
                  },
                }],
              },
            }],
          };
        },
      },
    },
  };
}

function rejectingJudge() {
  let calls = 0;
  return {
    get calls() { return calls; },
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return {
            choices: [{
              message: {
                content: '{"pass":false,"problems":["no tool observations"],"fix":"call docintel then finalize"}',
              },
            }],
          };
        },
      },
    },
  };
}

test('legacy image fileId without metadata still requires docintel (reproduces the gate)', () => {
  const profile = buildExecutionProfile({
    goal: QUERY,
    fileIds: ['img-resultados'],
  });
  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
  assert.ok(profile.requiredTools.includes('rag_retrieve'));
  const blocked = validateFinalize(profile, [
    { actions: [{ tool: 'finalize', observation: { answer: PARAGRAPH } }] },
  ]);
  assert.equal(blocked.ok, false);
});

test('react-agent: that legacy gate + rejecting judge yields verification_failed degraded text', async () => {
  const profile = buildExecutionProfile({
    goal: QUERY,
    fileIds: ['img-resultados'],
  });
  const judge = rejectingJudge();
  const guard = composeFinalizeGuards([
    ({ steps, unavailableTools }) => validateFinalize(profile, steps, { unavailableTools }),
    createAnswerVerifier({ openai: judge, model: 'test-model', userQuery: QUERY }),
  ]);
  const result = await reactAgent.run(scriptedFinalize(PARAGRAPH), {
    query: QUERY,
    tools: [],
    maxSteps: 6,
    model: 'test-model',
    finalizeGuard: guard,
  });
  assert.match(String(result.stoppedReason), /^verification_failed/);
  assert.match(
    String(result.finalAnswer),
    /No pude verificar que se haya completado lo solicitado/,
  );
});

test('chat finalize profile: image metadata (or hasImageAttachment) drops the document gate', () => {
  const available = new Set(['docintel_analyze', 'rag_retrieve', 'create_document', 'verify_artifact']);
  const withMeta = buildChatFinalizeProfile({
    userQuery: QUERY,
    fileIds: ['img-resultados'],
    fileMetadata: [{ id: 'img-resultados', mimeType: 'image/png', name: 'RESULTADOS_CDD.png' }],
    availableToolNames: available,
  });
  assert.equal(withMeta.capabilities.needsPrivateContext, false);
  assert.deepEqual(withMeta.requiredTools, []);

  const viaFlag = buildChatFinalizeProfile({
    userQuery: QUERY,
    fileIds: ['img-resultados'],
    hasImageAttachment: true,
    availableToolNames: available,
  });
  assert.equal(viaFlag.capabilities.needsPrivateContext, false);
  assert.deepEqual(viaFlag.requiredTools, []);
});

test('react-agent: summarize-image with the fixed guards returns the paragraph', async () => {
  const profile = buildChatFinalizeProfile({
    userQuery: QUERY,
    fileIds: ['img-resultados'],
    fileMetadata: [{ id: 'img-resultados', mimeType: 'image/png', name: 'RESULTADOS_CDD.png' }],
    availableToolNames: new Set(['docintel_analyze', 'rag_retrieve', 'create_document', 'verify_artifact']),
  });
  const judge = rejectingJudge();
  const guard = composeFinalizeGuards([
    profile.requiredTools.length
      ? ({ steps, unavailableTools }) => validateFinalize(profile, steps, { unavailableTools })
      : null,
    createAnswerVerifier({ openai: judge, model: 'test-model', userQuery: QUERY }),
  ]);
  const result = await reactAgent.run(scriptedFinalize(PARAGRAPH), {
    query: QUERY,
    tools: [],
    maxSteps: 4,
    model: 'test-model',
    finalizeGuard: guard,
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(String(result.finalAnswer).trim(), PARAGRAPH.trim());
  assert.doesNotMatch(result.finalAnswer, /No pude verificar que se haya completado/);
  assert.equal(judge.calls, 0, 'fail-open must not spend judge calls on a vision summary');
});

test('react-agent: a file-creation claim without a tool still fails verification', async () => {
  const claimed = `${PARAGRAPH} Creé el documento PDF con el resumen solicitado.`;
  const judge = rejectingJudge();
  const guard = composeFinalizeGuards([
    createAnswerVerifier({ openai: judge, model: 'test-model', userQuery: QUERY }),
  ]);
  const result = await reactAgent.run(scriptedFinalize(claimed), {
    query: QUERY,
    tools: [],
    maxSteps: 6,
    model: 'test-model',
    finalizeGuard: guard,
  });
  assert.match(String(result.stoppedReason), /^verification_failed/);
  assert.match(
    String(result.finalAnswer),
    /No pude verificar que se haya completado lo solicitado/,
  );
});
