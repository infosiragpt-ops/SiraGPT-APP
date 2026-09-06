'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { setImmediate: nextImmediate } = require('node:timers/promises');
const { APIError } = require('@anthropic-ai/sdk');
const PizZip = require('pizzip');
const { AnthropicSandboxEngine, providerContainerRetentionDeadline } = require('../dist/doc-sandbox/engine/anthropic-engine');
const { AnthropicDocumentProviderClient } = require('../dist/doc-sandbox/engine/provider-client');
const { EDITOR_PROMPT_VERSION, loadEditorPrompt } = require('../dist/doc-sandbox/agent/prompt');
const { hostedSkillsForFormats } = require('../dist/doc-sandbox/agent/skills');
const { calculateUsage, addUsage, emptyUsage, totalTokens, assertPriceTable } = require('../dist/doc-sandbox/engine/cost');
const { sha256, isSafeFilename, parseJsonArtifact, extractGeneratedFileIds, readBoundedResponse } = require('../dist/doc-sandbox/engine/artifacts');
const { createConservativeBundle } = require('../dist/doc-sandbox/queue/conservative-result');

// SDK transport mocks only. These tests do not replace or claim execution of the
// independent document validators; that integration suite runs separately.
const prices = { version: 'unit-price-v1', inputPerMillionUsd: 3, outputPerMillionUsd: 15,
  cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75,
  executionPerHourUsd: 0.05, minimumExecutionSeconds: 300 };
function config(overrides = {}) {
  return { models: { mechanical: { id: 'test-selected-model', prices, maxOutputTokensPerTurn: 2048, reservationUsdPerTurn: 0.1 },
    academic: { id: 'test-academic-model', prices, maxOutputTokensPerTurn: 2048, reservationUsdPerTurn: 0.1 } },
  skillVersions: { docx: 'catalog-test-1', pdf: 'catalog-test-2', pptx: 'catalog-test-3', xlsx: 'catalog-test-4' },
  maxFileBytes: 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxSessionMs: 60_000,
  apiTimeoutMs: 1000, cleanupTimeoutMs: 1000, ...overrides };
}
function input(name = 'Informe.txt', content = 'El informe dice 2026.\r\n', id = 'input-1', format = 'txt') {
  const data = Buffer.from(content);
  return { id, name, format, mime: 'text/plain', data, sha256: sha256(data) };
}
function planFor(file, edits = []) {
  return { schemaVersion: 1, mode: 'preserve', outputName: file.name, inputHashes: { [file.id]: file.sha256 }, edits, notPossible: [] };
}
function request(stage = 'plan', approvedPlan, overrides = {}) {
  return { stage, instructions: 'No cambies nada; solo confirma que puedes leer el documento', mode: 'preserve', formats: ['txt'], skills: [],
    modelTier: 'mechanical', requestedModel: 'test-selected-model', budget: { maxTurns: 8, maxTokens: 100_000, timeoutMs: 60_000, maxCostUsd: 5 }, approvedPlan, ...overrides };
}
function hooks(overrides = {}) {
  const events = [];
  const persistence = Object.fromEntries(['sessionCreated', 'containerCreated', 'fileChanged', 'reserve', 'settle', 'usageChanged']
    .map((name) => [name, async (...args) => { events.push([name, ...structuredClone(args)]); }]));
  return { events, persistence: { ...persistence, ...overrides } };
}
function recipe() {
  const zip = new PizZip();
  zip.file('01_copy.py', 'import shutil\nshutil.copyfile("input-0.txt", "out/Informe.txt")\n');
  zip.file('commands.json', JSON.stringify({ commands: ['python 01_copy.py'] }));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
class ProviderMock {
  files = new Map(); uploads = []; messages = []; deletions = []; metadataCalls = []; downloads = [];
  next = 1; messageOverride; deleteFailure; metadataOverride; downloadOverride; bundleMutator;
  add(name, data, downloadable = true) {
    const id = `file_test${this.next++}`;
    this.files.set(id, { id, filename: name, size_bytes: data.length, mime_type: 'application/octet-stream', downloadable, data });
    return id;
  }
  async upload(bytes, name, mime, options) {
    this.uploads.push({ bytes: Buffer.from(bytes), name, mime, options });
    const id = this.add(name, Buffer.from(bytes), false);
    return this.files.get(id);
  }
  async message(params, options) {
    this.messages.push({ params: structuredClone(params), options });
    if (this.messageOverride) return this.messageOverride(params, options, this);
    const payload = JSON.parse(params.messages[0].content.find((block) => block.type === 'text').text);
    const primary = payload.inputs[0];
    const plan = payload.approvedPlan ?? { schemaVersion: 1, mode: 'preserve', outputName: primary.originalName,
      inputHashes: Object.fromEntries(payload.inputs.map((file) => [file.inputId, file.sha256])), edits: [], notPossible: [] };
    const output = this.uploads[0].bytes;
    const result = { schemaVersion: 1, outputName: primary.originalName, editsApplied: plan.edits.map((edit) => edit.id), editsFailed: [],
      partsModified: [], pagesAffected: [], warnings: [], selfCheck: { openedOk: true, textDiffMatchesPlan: true } };
    const bundle = [{ filename: 'edit_plan.json', kind: 'edit_plan', data: Buffer.from(JSON.stringify(plan)) }];
    if (payload.stage === 'edit') bundle.push({ filename: 'result.json', kind: 'agent_result', data: Buffer.from(JSON.stringify(result)) },
      { filename: 'recipe.zip', kind: 'recipe', data: recipe() },
      { filename: payload.output.captureAlias, kind: 'output', inputId: primary.inputId, data: output });
    if (this.bundleMutator) this.bundleMutator(bundle, payload);
    const manifest = { schemaVersion: 1, stage: payload.stage, files: bundle.map(({ data, ...entry }) => ({ ...entry, sha256: sha256(data) })) };
    const ids = bundle.map((entry) => this.add(entry.filename, entry.data));
    ids.push(this.add('manifest.json', Buffer.from(JSON.stringify(manifest))));
    return this.response(ids, `container-${this.messages.length}`);
  }
  response(ids = [], containerId = 'container-1', stopReason = 'end_turn') {
    return { id: `msg_${this.messages.length}`, role: 'assistant', model: 'test-selected-model', type: 'message', stop_reason: stopReason,
      container: { id: containerId, expires_at: '2026-10-04T00:00:00Z', skills: [] },
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 },
      content: [{ type: 'bash_code_execution_tool_result', tool_use_id: 'srvtoolu_test', content: { type: 'bash_code_execution_result',
        return_code: 0, stdout: '', stderr: '', content: ids.map((file_id) => ({ type: 'bash_code_execution_output', file_id })) } }] };
  }
  async metadata(id, options) {
    this.metadataCalls.push({ id, options });
    if (this.metadataOverride) return this.metadataOverride(id, this);
    return this.files.get(id);
  }
  async download(id, options) {
    this.downloads.push({ id, options });
    if (this.downloadOverride) return this.downloadOverride(id, this);
    return new Response(this.files.get(id).data);
  }
  async delete(id, options) {
    this.deletions.push({ id, options });
    if (this.deleteFailure?.(id)) throw new Error('private provider failure');
    this.files.delete(id);
  }
}
async function fixture(settings = {}) {
  const sdk = settings.sdk ?? new ProviderMock();
  const { events, persistence } = hooks(settings.hooks);
  const engine = new AnthropicSandboxEngine(sdk, config(settings.config), persistence);
  const session = await engine.createSession({ id: 'job-1', userId: 'user-1', attempt: 1, promptVersion: EDITOR_PROMPT_VERSION });
  const file = settings.file ?? input();
  if (!settings.skipUpload) await engine.uploadInputs(session, [file]);
  return { engine, session, file, sdk, events, persistence };
}
function isCode(code) { return (error) => error.code === code && !error.message.includes('private'); }

test('an impossible plan produces an explicit unvalidated preservation bundle, never an edit-success claim', () => {
  const original = input();
  const plan = planFor(original);
  plan.notPossible.push({ request: 'Reflow a scan', reason: 'Scanned paragraph editing is outside phase 1.' });
  const bundle = createConservativeBundle([original], plan, 'planning', plan.notPossible.map(item => item.reason));
  assert.deepEqual(bundle.outputs[0].data, original.data);
  const result = JSON.parse(bundle.artifacts.find(item => item.kind === 'agent_result').data);
  assert.equal(result.outcome, 'not_possible');
  assert.deepEqual(result.editsApplied, []);
  assert.equal(result.selfCheck.openedOk, false);
  assert.equal(bundle.artifacts.some(item => item.kind === 'validation_report'), false);
});

test('execution refusal preserves the frozen plan and exposes not_possible without an edit-success claim', async () => {
  const { engine, session, sdk, file } = await fixture();
  const plan = planFor(file, [{ kind: 'text', id: 'e1', inputId: file.id, part: '$document', locator: 'text', before: file.data.toString(), after: 'Requested replacement' }]);
  sdk.bundleMutator = (bundle, payload) => {
    bundle.find(item => item.kind === 'edit_plan').data = Buffer.from(JSON.stringify(plan));
    if (payload.stage !== 'edit') return;
    const result = bundle.find(item => item.kind === 'agent_result');
    result.data = Buffer.from(JSON.stringify({ ...JSON.parse(result.data), outcome: 'not_possible',
      editsApplied: [], editsFailed: ['e1'], warnings: ['Mixed formatting has no unambiguous mapping.'] }));
  };
  try {
    const planning = await engine.run(session, request(), () => {});
    const frozen = JSON.stringify(planning.editPlan);
    const refusal = await engine.run(session, request('edit', planning.editPlan), () => {});
    assert.equal(refusal.status, 'not_possible');
    assert.equal(refusal.agentResult.outcome, 'not_possible');
    assert.equal(JSON.stringify(refusal.editPlan), frozen);
    assert.deepEqual(refusal.agentResult.editsApplied, []);
    assert.equal(sdk.messages.length, 2);
  } finally { await engine.destroy(session); }
});

test('execution refusal cannot replace the frozen plan or claim partial edits', async () => {
  for (const violation of ['plan-rewrite', 'partial-edits', 'missing-reason']) {
    const { engine, session, sdk, file } = await fixture();
    const plan = planFor(file, [{ kind: 'text', id: 'e1', inputId: file.id, part: '$document', locator: 'text', before: file.data.toString(), after: 'Replacement' }]);
    sdk.bundleMutator = (bundle, payload) => {
      bundle.find(item => item.kind === 'edit_plan').data = Buffer.from(JSON.stringify(plan));
      if (payload.stage !== 'edit') return;
      if (violation === 'plan-rewrite') bundle.find(item => item.kind === 'edit_plan').data = Buffer.from(JSON.stringify({ ...plan, edits: [], notPossible: [{ request: 'edit', reason: 'impossible' }] }));
      const result = bundle.find(item => item.kind === 'agent_result');
      result.data = Buffer.from(JSON.stringify({ ...JSON.parse(result.data), outcome: 'not_possible',
        editsApplied: violation === 'partial-edits' ? ['e1'] : [], editsFailed: ['e1'],
        warnings: violation === 'missing-reason' ? [] : ['Cannot preserve the layout.'] }));
    };
    try {
      const planning = await engine.run(session, request(), () => {});
      await assert.rejects(engine.run(session, request('edit', planning.editPlan), () => {}), isCode('E_VALIDATION'));
      assert.equal((await engine.downloadOutputs(session)).filter(item => item.kind === 'output').length, 0);
    } finally { await engine.destroy(session); }
  }
});

test('versioned prompt is original, preserve-only, separates stages and requires recipe export', () => {
  const prompt = loadEditorPrompt();
  assert.equal(prompt.version, EDITOR_PROMPT_VERSION);
  assert.equal(prompt.sha256, sha256(Buffer.from(prompt.text)));
  for (const word of ['immutable', 'recipe.zip', '$OUTPUT_DIR', 'not_possible', 'macros', 'Never collapse mixed-style runs']) assert.ok(prompt.text.includes(word));
});

test('hosted skills are stable, deduplicated and pinned; plain documents need none', () => {
  assert.deepEqual(hostedSkillsForFormats(['pptx', 'docx', 'pdf', 'docx'], config().skillVersions).map((skill) => skill.skill_id), ['docx', 'pdf', 'pptx']);
  assert.deepEqual(hostedSkillsForFormats(['txt', 'md', 'csv', 'json', 'html'], {}), []);
  assert.throws(() => hostedSkillsForFormats(['docx'], { docx: 'latest' }));
  assert.throws(() => hostedSkillsForFormats(['docx'], {}));
  assert.throws(() => hostedSkillsForFormats(['xlsm'], config().skillVersions));
});

test('token/cache costs aggregate and execution estimates are never labelled exact', () => {
  const usage = calculateUsage({ input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 }, prices, 1000, true);
  assert.equal(usage.costExact, false);
  assert.ok(Math.abs(usage.costUsd - (0.0003 + 0.0006 + 0.000015 + 0.000075 + 300 * 0.05 / 3600)) < 1e-10);
  assert.equal(totalTokens(usage), 210);
  assert.equal(addUsage(usage, usage).inputTokens, 200);
  assert.equal(addUsage(usage, { ...emptyUsage(), costUsd: null, costExact: false }).costUsd, null);
  assert.equal(calculateUsage({ input_tokens: 10 }, prices, 0, true).costUsd, null);
  assert.throws(() => assertPriceTable({ ...prices, inputPerMillionUsd: -1 }));
});

for (const name of ['../doc.txt', 'a/b.txt', 'a\\b.txt', 'a\u0000.txt', '..', 'CON', 'NUL.txt', 'a.txt.', 'a.txt ', ' a.txt', 'a:b.txt']) {
  test(`reject unsafe export filename ${JSON.stringify(name)}`, () => assert.equal(isSafeFilename(name), false));
}
test('unicode original filenames are retained', () => assert.equal(isSafeFilename('Tesis año 2026.docx'), true));
test('queued model selection cannot be replaced by a new model in the same configured tier', async () => {
  const { engine, session, sdk, events } = await fixture();
  await assert.rejects(engine.run(session, request('plan', undefined, { requestedModel: 'previous-selected-model' }), () => {}),
    isCode('E_NOT_READY'));
  assert.equal(sdk.messages.length, 0, 'model mismatch must reject before a provider request');
  assert.equal(events.some(([name]) => name === 'reserve'), false, 'model mismatch must not reserve a paid turn');
  await engine.destroy(session);
});
test('bounded JSON refuses malformed encoding and huge artifacts', () => {
  assert.throws(() => parseJsonArtifact(Buffer.from([0xff])));
  assert.throws(() => parseJsonArtifact(Buffer.from('x')));
  assert.throws(() => parseJsonArtifact(Buffer.from('{}'), 1));
});
test('file references only come from generated tool blocks, not prose or container uploads', () => {
  assert.deepEqual(extractGeneratedFileIds([{ type: 'text', text: 'file_otherTenant' }, { type: 'container_upload', file_id: 'file_otherTenant' }]), []);
  assert.deepEqual(extractGeneratedFileIds(new ProviderMock().response(['file_a', 'file_a']).content), ['file_a']);
});
test('valid tool envelopes reject malformed generated file references rather than accepting a partial list', () => {
  const malformed = [undefined, null, 123, {}, '', 'file_', 'other_a', 'file-a',
    '../file_a', 'file_a/child', 'file_a\u0000', 'file_a\n', `file_${'a'.repeat(181)}`];
  for (const family of ['bash_code_execution', 'code_execution']) {
    const envelope = (fileIds) => [{ type: `${family}_tool_result`, content: {
      type: `${family}_result`, content: fileIds.map(file_id => ({ type: `${family}_output`, file_id })),
    } }];
    const longestAllowed = `file_${'a'.repeat(180)}`;
    assert.deepEqual(extractGeneratedFileIds(envelope([longestAllowed])), [longestAllowed]);
    for (const value of malformed) {
      assert.throws(() => extractGeneratedFileIds(envelope(['file_valid', value])),
        { message: 'DOC_ENGINE_INVALID_FILE_REFERENCE' });
    }
  }
});
test('streaming download enforces actual bytes and header limits', async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await readBoundedResponse(new Response('abc'), 3, signal), new Uint8Array(Buffer.from('abc')));
  await assert.rejects(readBoundedResponse(new Response('abcd'), 3, signal));
  await assert.rejects(readBoundedResponse(new Response('a', { headers: { 'content-length': '100' } }), 3, signal));
  await assert.rejects(readBoundedResponse(new Response('abc', { status: 500 }), 3, signal));
});

for (const status of [403, 500]) {
  test(`rejected HTTP ${status} artifact cancels its body without consuming it`, async () => {
    const controller = new AbortController();
    let pulls = 0;
    let cancellations = 0;
    const stream = new ReadableStream({
      pull() { pulls++; },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    await assert.rejects(readBoundedResponse(new Response(stream, { status }), 16, controller.signal),
      { message: 'DOC_ENGINE_DOWNLOAD_FAILED' });
    assert.equal(cancellations, 1);
    assert.equal(pulls, 0, 'an HTTP error body must not be read as document content');
    assert.equal(stream.locked, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const boundary of ['http-error', 'declared-size', 'actual-size', 'pre-cancelled', 'pending-cancel']) {
  test(`artifact ${boundary} retains its primary error when transport cancellation rejects`, async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic-user-cancellation');
    const transportError = new Error('synthetic-transport-cancellation-failure');
    let cancellations = 0;
    const stream = new ReadableStream({
      start(source) {
        if (boundary === 'actual-size') source.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() { cancellations++; return Promise.reject(transportError); },
    });
    const response = new Response(stream, {
      status: boundary === 'http-error' ? 500 : 200,
      headers: boundary === 'declared-size' ? { 'content-length': '4' } : {},
    });
    if (boundary === 'pre-cancelled') controller.abort(reason);
    const reading = readBoundedResponse(response, 3, controller.signal);
    if (boundary === 'pending-cancel') controller.abort(reason);
    if (boundary === 'pre-cancelled' || boundary === 'pending-cancel') {
      await assert.rejects(reading, error => error === reason);
    } else {
      await assert.rejects(reading, { message: boundary === 'http-error'
        ? 'DOC_ENGINE_DOWNLOAD_FAILED' : 'DOC_ENGINE_OUTPUT_TOO_LARGE' });
    }
    assert.equal(cancellations, 1);
    assert.equal(stream.locked, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const boundary of ['http-error', 'declared-size', 'actual-size', 'pre-cancelled']) {
  test(`artifact ${boundary} releases local resources without waiting for transport cancellation`, async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic-user-cancellation');
    let completeCancellation;
    const cancellation = new Promise(resolve => { completeCancellation = resolve; });
    let cancellations = 0;
    const stream = new ReadableStream({
      start(source) {
        if (boundary === 'actual-size') source.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() { cancellations++; return cancellation; },
    });
    const response = new Response(stream, {
      status: boundary === 'http-error' ? 500 : 200,
      headers: boundary === 'declared-size' ? { 'content-length': '4' } : {},
    });
    if (boundary === 'pre-cancelled') controller.abort(reason);
    const observed = readBoundedResponse(response, 3, controller.signal)
      .then(value => ({ value }), error => ({ error }));
    try {
      // A real event-loop boundary, not an arbitrary latency target. The local
      // rejection must settle while the transport cleanup is still pending.
      const outcome = await Promise.race([observed, nextImmediate().then(() => null)]);
      assert.notEqual(outcome, null, 'transport cleanup must not hold the document request open');
      if (boundary === 'pre-cancelled') assert.equal(outcome.error, reason);
      else assert.equal(outcome.error?.message, boundary === 'http-error'
        ? 'DOC_ENGINE_DOWNLOAD_FAILED' : 'DOC_ENGINE_OUTPUT_TOO_LARGE');
      assert.equal(cancellations, 1);
      assert.equal(stream.locked, false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      completeCancellation();
      await observed;
    }
  });
}

test('pre-cancelled artifact download cancels its actual stream before reading', async () => {
  const controller = new AbortController();
  const reason = new Error('synthetic-cancel');
  controller.abort(reason);
  let cancellations = 0;
  const stream = new ReadableStream({ cancel() { cancellations++; } });
  await assert.rejects(readBoundedResponse(new Response(stream), 16, controller.signal), error => error === reason);
  assert.equal(cancellations, 1);
  assert.equal(stream.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling a pending artifact read releases the stream and abort subscription', async () => {
  const controller = new AbortController();
  const reason = new Error('synthetic-pending-cancel');
  let cancellations = 0;
  const stream = new ReadableStream({ cancel() { cancellations++; } });
  const reading = readBoundedResponse(new Response(stream), 16, controller.signal);
  assert.equal(stream.locked, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason);
  await assert.rejects(reading, error => error === reason);
  assert.equal(cancellations, 1);
  assert.equal(stream.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('artifact reader rejects malformed length declarations and a bodyless success', async () => {
  const controller = new AbortController();
  for (const length of ['-1', '1.5', 'NaN', '1e3', '9007199254740992']) {
    let cancellations = 0;
    const stream = new ReadableStream({ cancel() { cancellations++; } });
    await assert.rejects(readBoundedResponse(new Response(stream, { headers: { 'content-length': length } }), 16, controller.signal),
      { message: 'DOC_ENGINE_OUTPUT_TOO_LARGE' });
    assert.equal(cancellations, 1);
    assert.equal(stream.locked, false);
  }
  await assert.rejects(readBoundedResponse(new Response(null, { status: 204 }), 16, controller.signal),
    { message: 'DOC_ENGINE_DOWNLOAD_FAILED' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an actual stream error cannot return a truncated document and always releases its lock', async () => {
  const controller = new AbortController();
  const failure = new Error('synthetic-stream-error');
  let transport;
  const stream = new ReadableStream({ start(value) { transport = value; } });
  transport.enqueue(new Uint8Array([1, 2, 3]));
  const reading = readBoundedResponse(new Response(stream), 16, controller.signal);
  transport.error(failure);
  await assert.rejects(reading, error => error === failure);
  assert.equal(stream.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('plan and edit export complete original-name no-op; edit never reuses inspection container', async () => {
  const { engine, session, file, sdk, events } = await fixture();
  const plan = await engine.run(session, request(), () => {});
  assert.equal(plan.status, 'planned');
  assert.equal((await engine.downloadOutputs(session)).some((artifact) => artifact.kind === 'output'), false);
  const result = await engine.run(session, request('edit', plan.editPlan), () => {});
  assert.equal(result.status, 'edited');
  const artifacts = await engine.downloadOutputs(session);
  const output = artifacts.find((artifact) => artifact.kind === 'output');
  assert.equal(output.name, file.name);
  assert.equal(output.sha256, file.sha256);
  assert.deepEqual(output.data, file.data);
  assert.ok(artifacts.some((artifact) => artifact.kind === 'recipe'));
  assert.ok(artifacts.some((artifact) => artifact.kind === 'transcript'));
  assert.equal(sdk.messages[0].params.container.id, undefined);
  assert.equal(sdk.messages[1].params.container.id, undefined);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(sdk.messages[0].params.model, 'test-selected-model');
  assert.equal(sdk.messages[0].params.tools[0].type, 'code_execution_20260120');
  assert.equal(sdk.uploads[0].name, 'input-0.txt');
  assert.ok(events.filter(([name]) => name === 'fileChanged').length > 5);
  await engine.destroy(session);
  assert.equal(sdk.files.size, 0);
  assert.ok(sdk.deletions.every((call) => !call.options.signal.aborted));
});

test('an input named edit_plan.json cannot collide with the transport manifest', async () => {
  const file = input('edit_plan.json', '{"original":true}\n', 'input-1', 'json');
  const { engine, session } = await fixture({ file });
  const parameters = { formats: ['json'] };
  const plan = await engine.run(session, request('plan', undefined, parameters), () => {});
  await engine.run(session, request('edit', plan.editPlan, parameters), () => {});
  const artifact = (await engine.downloadOutputs(session)).find((entry) => entry.kind === 'output');
  assert.equal(artifact.name, 'edit_plan.json'); assert.deepEqual(artifact.data, file.data);
  await engine.destroy(session);
});

test('pause_turn replays unchanged assistant content in the same container and counts every turn', async () => {
  const { engine, session, sdk, events } = await fixture();
  let calls = 0;
  sdk.messageOverride = async (params, options, self) => {
    calls += 1;
    if (calls === 1) return self.response([], 'container-pause', 'pause_turn');
    assert.equal(params.container.id, 'container-pause');
    assert.deepEqual(params.messages[1].content, self.response([], 'container-pause', 'pause_turn').content);
    self.messageOverride = undefined;
    const response = await ProviderMock.prototype.message.call(self, params, options);
    response.container.id = 'container-pause';
    response.container.expires_at = '2026-10-05T00:00:00Z';
    return response;
  };
  const observedBefore = Date.now();
  const result = await engine.run(session, request(), () => {});
  assert.equal(result.usage.inputTokens, 200);
  const retention = events.filter(([name]) => name === 'containerCreated').map(([, , ref]) => Date.parse(ref.expiresAt));
  assert.equal(retention.length, 2);
  assert.ok(retention.every(value => value >= observedBefore + 30 * 24 * 60 * 60 * 1000));
  assert.ok(retention[1] >= retention[0]);
  assert.ok(retention[1] >= Date.parse('2026-10-05T00:00:00Z'));
  await engine.destroy(session);
});

test('checkpoint expiry never certifies provider data deletion before its 30-day retention window', () => {
  const observed = Date.parse('2026-09-05T16:00:00Z');
  for (const reported of ['2026-09-05T16:05:00Z', '2026-08-01T00:00:00Z', undefined, null, 'invalid']) {
    assert.equal(providerContainerRetentionDeadline(reported, observed), '2026-10-05T16:00:00.000Z');
  }
  assert.equal(providerContainerRetentionDeadline('2026-11-01T00:00:00Z', observed), '2026-11-01T00:00:00.000Z');
});

test('an unexpected replacement container is durably tracked before rejection', async () => {
  const { engine, session, sdk, events } = await fixture();
  let calls = 0;
  sdk.messageOverride = async () => sdk.response([], ++calls === 1 ? 'container-first' : 'container-unexpected', 'pause_turn');
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_PROVIDER'));
  assert.deepEqual(events.filter(([name]) => name === 'containerCreated').map(([, , ref]) => ref.id),
    ['container-first', 'container-unexpected']);
  await engine.destroy(session);
});

test('pause_turn cannot loop beyond maxTurns and all known files are cleaned', async () => {
  const { engine, session, sdk } = await fixture();
  sdk.messageOverride = async () => sdk.response([], 'container-1', 'pause_turn');
  await assert.rejects(engine.run(session, request('plan', undefined, { budget: { ...request().budget, maxTurns: 2 } }), () => {}), isCode('E_QUOTA'));
  assert.equal(sdk.messages.length, 2);
  await engine.destroy(session); assert.equal(sdk.files.size, 0);
});

test('budget reservation is persisted before provider request; insufficient funds makes no call', async () => {
  const { engine, session, sdk } = await fixture({ hooks: { reserve: async () => { throw new Error('private ledger rejected'); } } });
  await assert.rejects(engine.run(session, request(), () => {}));
  assert.equal(sdk.messages.length, 0);
  await engine.destroy(session);
});

test('uncertain provider errors retain reservation and redact raw messages', async () => {
  const { engine, session, sdk, events } = await fixture();
  sdk.messageOverride = async () => { throw new Error('private document and bearer credentials'); };
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_PROVIDER'));
  const settlement = events.find(([name]) => name === 'settle')[2];
  assert.equal(settlement.uncertain, true); assert.equal(settlement.usage.costUsd, null);
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_QUOTA'));
  assert.equal(sdk.messages.length, 1);
  await engine.destroy(session);
});

test('usage over budget fails closed but still persists generated file IDs for cleanup', async () => {
  const { engine, session, sdk } = await fixture();
  sdk.messageOverride = async (params, options, self) => {
    self.messageOverride = undefined;
    const response = await ProviderMock.prototype.message.call(self, params, options);
    response.usage.output_tokens = 1_000_000;
    return response;
  };
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_QUOTA'));
  await engine.destroy(session); assert.equal(sdk.files.size, 0);
});

for (const condition of ['missing-recipe', 'bad-output-id', 'wrong-plan', 'invalid-json', 'bad-recipe']) {
  test(`invalid edit bundle fails closed: ${condition}`, async () => {
    const { engine, session, sdk, file } = await fixture();
    sdk.bundleMutator = (bundle) => {
      if (condition === 'missing-recipe') bundle.splice(bundle.findIndex((file) => file.kind === 'recipe'), 1);
      if (condition === 'bad-output-id') bundle.find((file) => file.kind === 'output').inputId = 'other-user';
      if (condition === 'wrong-plan') bundle[0].data = Buffer.from(JSON.stringify({ ...planFor(file), outputName: 'changed.txt' }));
      if (condition === 'invalid-json') bundle[0].data = Buffer.from('{ broken');
      if (condition === 'bad-recipe') bundle.find((file) => file.kind === 'recipe').data = Buffer.from('not a zip');
    };
    await assert.rejects(engine.run(session, request('edit', planFor(file)), () => {}));
    await assert.rejects(engine.downloadOutputs(session));
    await engine.destroy(session); assert.equal(sdk.files.size, 0);
  });
}

test('provider filename traversal is rejected without writing to disk', async () => {
  const { engine, session, sdk } = await fixture();
  sdk.metadataOverride = async (id, self) => ({ ...self.files.get(id), filename: '../../evil' });
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_PROVIDER'));
  assert.equal(sdk.downloads.length, 0);
  await engine.destroy(session);
});

test('download failure is not silently omitted', async () => {
  const { engine, session, sdk } = await fixture();
  sdk.downloadOverride = async () => new Response('private', { status: 503 });
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_PROVIDER'));
  await engine.destroy(session);
});

test('mutating the caller plan in flight cannot widen the frozen plan', async () => {
  const { engine, session, sdk, file } = await fixture();
  const approvedPlan = planFor(file);
  sdk.messageOverride = async (params, options, self) => {
    approvedPlan.outputName = 'attacker.txt';
    self.messageOverride = undefined;
    return ProviderMock.prototype.message.call(self, params, options);
  };
  const result = await engine.run(session, request('edit', approvedPlan), () => {});
  assert.equal(result.editPlan.outputName, file.name);
  await engine.destroy(session);
});

test('forged session handles, input hashes and duplicate inputs are refused', async () => {
  const { engine, session, file } = await fixture({ skipUpload: true });
  await assert.rejects(engine.uploadInputs({ ...session }, [file]), isCode('E_FORBIDDEN'));
  await assert.rejects(engine.uploadInputs(session, [{ ...file, sha256: '0'.repeat(64) }]), isCode('E_PARAMS'));
  await assert.rejects(engine.uploadInputs(session, [file, file]), isCode('E_PARAMS'));
  await engine.destroy(session);
});

test('mode, skills, model tier and budget changes cannot silently alter an existing job', async () => {
  const { engine, session } = await fixture();
  const result = await engine.run(session, request(), () => {});
  await assert.rejects(engine.run(session, request('edit', result.editPlan, { modelTier: 'academic' }), () => {}), isCode('E_PARAMS'));
  await assert.rejects(engine.run(session, request('edit', result.editPlan, { budget: { ...request().budget, maxCostUsd: 10 } }), () => {}), isCode('E_PARAMS'));
  await assert.rejects(engine.run(session, request('edit', result.editPlan, { skills: ['docx'] }), () => {}), isCode('E_PARAMS'));
  await engine.destroy(session);
});

test('aborting stops the provider call and cleanup still has a fresh live signal', async () => {
  const { engine, session, sdk } = await fixture();
  const controller = new AbortController();
  sdk.messageOverride = (params, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private aborted')), { once: true });
    controller.abort();
  });
  await assert.rejects(engine.run(session, request('plan', undefined, { signal: controller.signal }), () => {}), isCode('E_CANCELLED'));
  await engine.destroy(session);
  assert.equal(sdk.files.size, 0);
  assert.ok(sdk.deletions.every((entry) => !entry.options.signal.aborted));
});

test('cancellation propagates to input upload and never starts a model call', async () => {
  const { engine, session, sdk, file } = await fixture({ skipUpload: true });
  const controller = new AbortController();
  sdk.upload = (_bytes, _name, _mime, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private upload aborted')), { once: true });
    controller.abort();
  });
  await assert.rejects(engine.uploadInputs(session, [file], controller.signal), isCode('E_CANCELLED'));
  assert.equal(sdk.messages.length, 0);
  await engine.destroy(session);
});

test('a late uploaded file after cancellation is tracked for deletion before returning', async () => {
  const { engine, session, sdk, file, events } = await fixture({ skipUpload: true });
  const controller = new AbortController();
  sdk.upload = async (bytes, name, mime, options) => {
    const response = await ProviderMock.prototype.upload.call(sdk, bytes, name, mime, options);
    controller.abort();
    return response;
  };
  await assert.rejects(engine.uploadInputs(session, [file], controller.signal), isCode('E_CANCELLED'));
  assert.ok(events.some(([name, , ref]) => name === 'fileChanged' && ref.state === 'known'));
  await engine.destroy(session);
  assert.equal(sdk.files.size, 0);
});

test('hard request timeout is passed to SDK and returns a typed timeout', async () => {
  const { engine, session, sdk } = await fixture({ config: { apiTimeoutMs: 10 } });
  sdk.messageOverride = (params, options) => new Promise((resolve, reject) => {
    assert.ok(options.timeoutMs <= 10);
    options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true });
  });
  await assert.rejects(engine.run(session, request(), () => {}), isCode('E_TIMEOUT'));
  await engine.destroy(session);
});

test('failed cleanup remains recorded and retry deletes all original and generated IDs', async () => {
  const { engine, session, sdk, events } = await fixture();
  await engine.run(session, request(), () => {});
  sdk.deleteFailure = () => true;
  await assert.rejects(engine.destroy(session), isCode('E_PROVIDER'));
  assert.ok(events.some(([name, , reference]) => name === 'fileChanged' && reference.state === 'delete_failed'));
  sdk.deleteFailure = undefined;
  await engine.destroy(session);
  assert.equal(sdk.files.size, 0);
  await engine.destroy(session); // idempotent
});

test('persisting a new file reference fails closed and immediately attempts remote deletion', async () => {
  const { engine, session, file, sdk } = await fixture({ skipUpload: true, hooks: { fileChanged: async (session, file) => {
    if (file.state === 'known') throw new Error('private DB error');
  } } });
  await assert.rejects(engine.uploadInputs(session, [file]), isCode('E_PROVIDER'));
  assert.equal(sdk.files.size, 0);
  await engine.destroy(session);
});

test('a late response after cancellation registers and deletes every new remote file', async () => {
  const { engine, session, sdk } = await fixture();
  let resolveResponse;
  const pending = new Promise((resolve) => { resolveResponse = resolve; });
  sdk.messageOverride = () => pending;
  const running = engine.run(session, request(), () => {});
  // Wait for SDK entry, not a clock-dependent sleep.
  while (sdk.messages.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(engine.destroy(session), isCode('E_PROVIDER'));
  const lateId = sdk.add('late.json', Buffer.from('{}'));
  resolveResponse(sdk.response([lateId]));
  await assert.rejects(running, isCode('E_CANCELLED'));
  await engine.destroy(session);
  assert.equal(sdk.files.size, 0);
  assert.ok(sdk.deletions.some((entry) => entry.id === lateId));
});

test('reported upload size mismatch cannot orphan the known uploaded file', async () => {
  const sdk = new ProviderMock();
  sdk.upload = async (bytes, name, mime, options) => {
    const result = await ProviderMock.prototype.upload.call(sdk, bytes, name, mime, options);
    return { ...result, size_bytes: result.size_bytes + 1 };
  };
  const { engine, session, file } = await fixture({ sdk, skipUpload: true });
  await assert.rejects(engine.uploadInputs(session, [file]), isCode('E_PROVIDER'));
  await engine.destroy(session);
  assert.equal(sdk.files.size, 0);
});

test('real SDK adapter serializes binary uploads as multipart and disables hidden retries', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    // SDK upload shim probes FormData support using a local data URL.
    if (String(url) === 'data:,') return new Response('');
    const http = new Request(url, init);
    requests.push(http);
    return new Response(JSON.stringify({ id: 'file_adapter1', filename: 'document.txt', mime_type: 'text/plain', size_bytes: 3,
      type: 'file', downloadable: false, created_at: '2026-09-04T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new AnthropicDocumentProviderClient('unit-test-placeholder');
    await client.upload(Buffer.from('abc'), 'document.txt', 'text/plain', { signal: new AbortController().signal, timeoutMs: 1000 });
    assert.equal(requests.length, 1);
    assert.match(requests[0].headers.get('content-type'), /^multipart\/form-data; boundary=/);
    const form = await requests[0].formData();
    assert.equal(await form.get('file').text(), 'abc');
    assert.equal(form.get('file').name, 'document.txt');
  } finally { global.fetch = originalFetch; }
});

test('real SDK adapter forwards message, metadata, download and idempotent delete without network', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const http = new Request(url, options);
    calls.push({ method: http.method, path: new URL(http.url).pathname });
    if (http.method === 'DELETE') return new Response(JSON.stringify({ error: { type: 'not_found_error', message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (http.url.includes('/content')) return new Response('document bytes');
    if (http.url.includes('/messages')) return new Response(JSON.stringify(new ProviderMock().response()), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'file_adapter2', filename: 'doc.txt', size_bytes: 14, mime_type: 'text/plain', downloadable: true }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new AnthropicDocumentProviderClient('unit-test-placeholder');
    const options = { signal: new AbortController().signal, timeoutMs: 1000 };
    assert.equal((await client.message({ model: 'test-model', messages: [{ role: 'user', content: 'test' }], max_tokens: 10 }, options)).stop_reason, 'end_turn');
    assert.equal((await client.metadata('file_adapter2', options)).filename, 'doc.txt');
    assert.equal(await (await client.download('file_adapter2', options)).text(), 'document bytes');
    await client.delete('file_adapter2', options);
    assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET', 'DELETE']);
  } finally { global.fetch = originalFetch; }
});

test('real SDK DELETE propagates non-404 failures and never retries or reports successful deletion', async () => {
  const originalFetch = global.fetch;
  try {
    for (const [status, type] of [[403, 'permission_error'], [429, 'rate_limit_error'], [503, 'api_error']]) {
      const calls = [];
      // Only the SDK transport is doubled; Request, Response and SDK error
      // classification are real. No database, storage or validator is replaced.
      global.fetch = async (url, options) => {
        const request = new Request(url, options);
        calls.push({ method: request.method, path: new URL(request.url).pathname });
        return new Response(JSON.stringify({ error: { type, message: 'Synthetic cleanup rejection' } }),
          { status, headers: { 'content-type': 'application/json' } });
      };
      const client = new AnthropicDocumentProviderClient('unit-test-placeholder');
      await assert.rejects(client.delete('file_cleanup_contract', {
        signal: new AbortController().signal, timeoutMs: 1000,
      }), error => error instanceof APIError && error.status === status);
      assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/files/file_cleanup_contract' }]);
    }
  } finally { global.fetch = originalFetch; }
});

test('the real SDK does not retry a failed billable request implicitly', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { type: 'api_error', message: 'private error' } }),
    { status: 503, headers: { 'content-type': 'application/json' } }); };
  try {
    const client = new AnthropicDocumentProviderClient('unit-test-placeholder');
    await assert.rejects(client.message({ model: 'test-model', messages: [{ role: 'user', content: 'test' }], max_tokens: 10 },
      { signal: new AbortController().signal, timeoutMs: 1000 }));
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});
