'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { run } = require('../src/services/react-agent');
const { readMediaDeliveryHandoff, resolveMediaDeliveryCompletion, createMediaDeliveryCompletionPolicy } = require('../src/services/agents/media-delivery-handoff');

const MESSAGE = 'Recibí «Clase de prueba». La transcripción está en cola; te aviso aquí cuando termine.';
const source = (id = 'one') => `https://youtu.be/${id}`;
const PROMPT = `Transcribir ${source()}`;
const queued = (suffix = 'one') => ({
  ok: true, deferred: true, fileId: `file_${suffix}`, delivery: `md_${suffix}`, source: source(suffix), userMessage: `${MESSAGE} ${suffix}`,
  durationSeconds: 1577, range: { start: 0, end: null },
});
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function fixture({ firstCalls = [call('t1', 'transcribe_url')], execute = async () => queued(), toolName = 'transcribe_url', query = PROMPT, laterCalls } = {}) {
  let requests = 0;
  let checks = 0;
  let executions = 0;
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: {
    role: 'assistant', content: '', tool_calls: requests++ === 0 ? firstCalls
      : (requests === 2 && laterCalls) || [call(`final_${requests}`, 'finalize', { answer: 'Resultado normal revisado por el verificador.' })],
  } }] }) } } };
  const options = {
    query, model: 'test-model', maxSteps: 3,
    tools: [{ name: toolName, description: 'Synthetic transcription fixture', parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: async (args) => { executions++; return execute(args); } }],
    finalizeGuard: async () => { checks++; return { ok: true }; },
    resolveToolCompletion: createMediaDeliveryCompletionPolicy({ prompt: query }),
  };
  return { client, options, counts: () => ({ requests, checks, executions }) };
}

test('a real deferred transcription ends with the stored acknowledgement, without another model call or content review', async () => {
  const f = fixture();
  const result = await run(f.client, f.options);
  assert.equal(result.finalAnswer, queued().userMessage);
  assert.equal(result.stoppedReason, 'media_delivery_handoff');
  assert.deepEqual(result.completionMetadata, { mediaDeliveryHandoff: 'md_one', transcriptionFileIds: ['file_one'] });
  assert.equal(result.unverifiedDraft, false);
  assert.deepEqual(f.counts(), { requests: 1, checks: 0, executions: 1 });
  assert.equal(result.steps[0].actions[0].observation.delivery, 'md_one');
});

test('a finalize proposed in the same batch cannot replace or review the server acknowledgement', async () => {
  const f = fixture({ firstCalls: [call('t1', 'transcribe_url'), call('f1', 'finalize', { answer: 'Ya transcribí todo el video y el archivo está completo.' })] });
  const result = await run(f.client, f.options);
  assert.equal(result.finalAnswer, queued().userMessage);
  assert.deepEqual(f.counts(), { requests: 1, checks: 0, executions: 1 });
  assert.equal(result.steps[0].actions.length, 1);
});

test('a batch of video hand-offs is completed before stopping and preserves every file reference', async () => {
  const f = fixture({ firstCalls: [call('t1', 'transcribe_url', { id: 'one' }), call('t2', 'transcribe_url', { id: 'two' })],
    query: `Transcribe ${source()} y ${source('two')}`,
    execute: async (args) => queued(args.id) });
  const result = await run(f.client, f.options);
  assert.deepEqual(f.counts(), { requests: 1, checks: 0, executions: 2 });
  assert.equal(result.finalAnswer, `${queued('one').userMessage}\n\n${queued('two').userMessage}`);
  assert.deepEqual(result.completionMetadata.transcriptionFileIds, ['file_one', 'file_two']);
});

test('missing job evidence, errors and unrelated tools retain the ordinary verification path', async (t) => {
  const invalid = [
    ['failed result', { ...queued(), ok: false }],
    ['missing file', { ...queued(), fileId: undefined }],
    ['missing delivery', { ...queued(), delivery: undefined }],
    ['missing acknowledgement', { ...queued(), userMessage: '' }],
    ['inline result', { ...queued(), deferred: false }],
    ['reported error', { ...queued(), error: 'queue_failed' }],
    ['text only', JSON.stringify(queued())],
  ];
  for (const [name, output] of invalid) await t.test(name, async () => {
    const f = fixture({ execute: async () => output });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(result.completionMetadata, undefined);
    assert.equal(f.counts().checks, 1);
  });
  await t.test('unrelated tool', async () => {
    const f = fixture({ toolName: 'read_url', firstCalls: [call('r1', 'read_url')], execute: async () => queued() });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(f.counts().checks, 1);
    assert.equal(result.completionMetadata, undefined);
  });
  await t.test('invented tool arguments', async () => {
    const f = fixture({ firstCalls: [call('t1', 'transcribe_url', queued())], execute: async () => ({ ok: false, code: 'queue_failed' }) });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(f.counts().checks, 1);
  });
});

test('one queued video does not conceal another failed transcription in the same batch', async () => {
  const f = fixture({ firstCalls: [call('t1', 'transcribe_url', { id: 'failed' }), call('t2', 'transcribe_url', { id: 'two' })],
    query: `Transcribe ${source('failed')} y ${source('two')}`,
    execute: async ({ id }) => id === 'failed' ? { ok: false, code: 'download_failed' } : queued(id) });
  const result = await run(f.client, f.options);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(f.counts().checks, 1);
  assert.equal(result.completionMetadata, undefined);
});

test('handoff recognition cannot stop an aborted turn or discard another scheduled operation', () => {
  const action = { tool: 'transcribe_url', observation: queued() };
  const payload = { toolName: action.tool, result: action.observation, steps: [{ actions: [action] }], expectedSources: [source()] };
  assert.equal(resolveMediaDeliveryCompletion({ ...payload, remainingToolNames: ['create_document'] }), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(resolveMediaDeliveryCompletion({ ...payload, ctx: { signal: controller.signal } }), null);
  assert.equal(readMediaDeliveryHandoff('transcribe_url', { ...queued(), fileId: '../file' }), null);
  assert.equal(readMediaDeliveryHandoff('transcribe_url', { ...queued(), delivery: 'md\nother' }), null);
});

test('a second requested URL remains required even when the model schedules it in a later step', async () => {
  const f = fixture({ query: `Transcribe ${source()} y ${source('two')}`,
    firstCalls: [call('t1', 'transcribe_url', { id: 'one' })],
    laterCalls: [call('t2', 'transcribe_url', { id: 'two' })], execute: async ({ id }) => queued(id) });
  const result = await run(f.client, f.options);
  assert.equal(result.stoppedReason, 'media_delivery_handoff');
  assert.deepEqual(f.counts(), { requests: 2, checks: 0, executions: 2 });
  assert.deepEqual(result.completionMetadata.transcriptionFileIds, ['file_one', 'file_two']);
});

test('a missing requested URL or a different source cannot turn one queued job into completed scope', async () => {
  for (const query of [`Transcribe ${source()} y ${source('two')}`, `Transcribe ${source('other')}`]) {
    const f = fixture({ query });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(f.counts().checks, 1);
    assert.equal(result.completionMetadata, undefined);
  }
});

test('mixed requests keep the normal verifier even if their primary brief deliverable is transcription', async () => {
  for (const query of [
    `Transcribe ${source()} y resume las ideas`,
    `Transcribe ${source()} y crea una presentación`,
    `Transcribe ${source()} y dime cuánto es 24 por 7`,
    `Transcribe ${source()} y luego tradúcelo al inglés`,
  ]) {
    assert.equal(createMediaDeliveryCompletionPolicy({ prompt: query, requestBrief: { deliverable: { kind: 'transcription' } } }), null);
    const f = fixture({ query });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(f.counts().checks, 1);
  }
});

test('a prior unrelated operation is never hidden by the next queued transcription', async () => {
  for (const output of [{ ok: false, error: 'lookup_failed' }, { ok: true, text: 'Other result' }]) {
    const f = fixture({ firstCalls: [call('r1', 'read_url')], laterCalls: [call('t1', 'transcribe_url')] });
    f.options.tools.push({ name: 'read_url', parameters: { type: 'object', properties: {} }, execute: async () => output });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(f.counts().checks, 1);
    assert.equal(result.completionMetadata, undefined);
  }
});

test('only simple transcription scope opts in, using the existing previous-link resolver', () => {
  assert.equal(typeof createMediaDeliveryCompletionPolicy({ prompt: 'Transcribe este enlace completo, por favor.', history: [{ role: 'user', content: source() }] }), 'function');
  assert.equal(createMediaDeliveryCompletionPolicy({ prompt: `Transcribe ${source()} del minuto 01:00 al 26:17.` }), null);
  assert.equal(typeof createMediaDeliveryCompletionPolicy({ prompt: 'Transcribir youtu.be/one' }), 'function');
  for (const verb of ['Trascribir', 'transcirbir', 'transcripción', 'subtítulos']) {
    assert.equal(typeof createMediaDeliveryCompletionPolicy({ prompt: `${verb} ${source()}` }), 'function', verb);
  }
  assert.equal(createMediaDeliveryCompletionPolicy({ prompt: PROMPT, files: ['attachment'] }), null);
  assert.equal(createMediaDeliveryCompletionPolicy({ prompt: PROMPT, requiredTools: ['create_document'] }), null);
  assert.equal(createMediaDeliveryCompletionPolicy({ prompt: PROMPT, requestBrief: { deliverable: { kind: 'presentation' } } }), null);
  assert.equal(createMediaDeliveryCompletionPolicy({ prompt: 'Transcribe este enlace' }), null);
});

test('a queued source with a different time range still requires ordinary verification', async () => {
  const query = `Transcribe ${source()} del minuto 01:00 al 26:17.`;
  const f = fixture({ query, execute: async () => ({ ...queued(), range: { start: 0, end: 3600 } }) });
  const result = await run(f.client, f.options);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.completionMetadata, undefined);
  assert.equal(f.counts().checks, 1);
  assert.equal(typeof createMediaDeliveryCompletionPolicy({ prompt: `Transcribe https://youtu.be/video123` }), 'function');
});

test('requesting the whole source cannot close early for a partial or unmeasured queued range', async (t) => {
  for (const [name, fields] of [
    ['starts late', { range: { start: 60, end: null } }],
    ['ends early', { range: { start: 0, end: 120 } }],
    ['range unknown', { range: undefined }],
    ['end unknown', { range: { start: 0 } }],
    ['duration unknown', { durationSeconds: undefined }],
    ['empty duration', { durationSeconds: 0 }],
  ]) await t.test(name, async () => {
    const f = fixture({ execute: async () => ({ ...queued(), ...fields }) });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(result.completionMetadata, undefined);
    assert.equal(f.counts().checks, 1);
  });
  await t.test('a measured end covering the whole source permits the stored acknowledgement', async () => {
    const f = fixture({ execute: async () => ({ ...queued(), range: { start: 0, end: 1577 } }) });
    const result = await run(f.client, f.options);
    assert.equal(result.stoppedReason, 'media_delivery_handoff');
    assert.equal(f.counts().checks, 0);
  });
});

test('without the opt-in policy the normal finalization contract is unchanged', async () => {
  const f = fixture();
  delete f.options.resolveToolCompletion;
  const result = await run(f.client, f.options);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(f.counts().checks, 1);
  assert.equal(result.completionMetadata, undefined);
});

test('the chat wrapper persists and streams real pending references independently of finalization', async (t) => {
  const agentic = require('../src/services/agentic-chat-stream');
  const planVerify = require('../src/services/agents/agent-plan-verify');
  let reviews = 0;
  t.mock.method(planVerify, 'createAnswerVerifier', () => async () => {
    reviews++;
    return { ok: false, code: 'test_rejected', allowUnverifiedDraft: false, repair: 'The remaining work was not done.' };
  });
  for (const [name, query, output, expectedHandoff] of [
    ['simple', PROMPT, queued(), true],
    ['mixed rejected', `Transcribe ${source()} y resume las ideas.`, queued(), true],
    ['range rejected', `Transcribe ${source()} del minuto 01:00 al 26:17.`, { ...queued(), range: { start: 0, end: 3600 } }, true],
    ['partial source rejected', PROMPT, { ...queued(), range: { start: 60, end: 120 } }, true],
    ['invalid evidence', PROMPT, { ...queued(), delivery: undefined }, false],
  ]) await t.test(name, async () => {
    const f = fixture({ query, execute: async () => output });
    const response = new PassThrough();
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk.toString()));
    response.setHeader = () => {};
    response.flushHeaders = () => {};
    const beforeReviews = reviews;
    const result = await agentic.runAgenticChat({
      openai: f.client, model: 'gpt-4o-mini', userQuery: query, history: [],
      res: response, toolsOverride: f.options.tools, maxSteps: 3,
    });
    if (expectedHandoff) {
      assert.equal(result.mediaDeliveryHandoff, 'md_one');
      assert.deepEqual(result.transcriptionFileIds, ['file_one']);
      const state = JSON.parse(result.persistedContent.match(/```agent-task-state\n([\s\S]*?)\n```/)[1]);
      assert.equal(state.meta.mediaDeliveryHandoff, 'md_one');
      assert.deepEqual(state.meta.transcriptionFileIds, ['file_one']);
      assert.match(chunks.join(''), /mediaDeliveryHandoff/);
    } else assert.equal(result.mediaDeliveryHandoff, undefined);
    if (name === 'simple') {
      assert.equal(result.stoppedReason, 'media_delivery_handoff');
      assert.equal(reviews, beforeReviews);
    } else {
      assert.notEqual(result.stoppedReason, 'media_delivery_handoff');
      assert.ok(reviews > beforeReviews);
    }
  });
});
