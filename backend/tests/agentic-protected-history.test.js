'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runAgenticChat } = require('../src/services/agentic-chat-stream');
const { retainRows, retentionMessages, validRetention } = require('../src/services/conversation-retention');

function retainedHistory() {
  const rows = [];
  for (let index = 0; index < 4; index += 1) {
    rows.push({
      id: `retained-user-${index}`, role: 'USER',
      timestamp: `2026-10-22T10:0${index}:00.000Z`,
      content: `INSTRUCCION_ORIGINAL_${index}:\n` + 'Conservar las celdas y sus fórmulas. '.repeat(240)
        + `\nFIN_INSTRUCCION_${index}: no publicar el archivo.`,
      files: [{ id: `source-workbook-${index}`, name: `fuente-${index}.xlsx` }],
    });
    rows.push({
      id: `retained-assistant-${index}`, role: 'ASSISTANT',
      timestamp: `2026-10-22T10:0${index}:30.000Z`,
      content: 'Esta respuesta narrativa se puede resumir.',
      files: [{ id: `output-workbook-${index}`, name: `resultado-${index}.xlsx` }],
    });
  }
  const result = retainRows(rows);
  assert.equal(result.ok, true, 'the fixture must be a valid retained ledger');
  assert.equal(validRetention(result.retention), true);
  const protectedMessages = retentionMessages(result.retention);
  assert.ok(protectedMessages.reduce((total, message) => total + message.content.length, 0) > 24_000,
    'the actual replay must exceed the legacy agentic history limit');
  const history = [
    { role: 'system', content: 'Resumen previo: seguir revisando el libro de cálculo.' },
    ...protectedMessages,
    { role: 'user', content: 'Contexto opcional reciente. '.repeat(400) },
    { role: 'assistant', content: 'Notas opcionales de la revisión. '.repeat(340) },
  ];
  return { history, protectedMessages, messageIds: result.retention.entries.map((entry) => entry.messageId) };
}

function scriptedProvider(toolCallMode, requests) {
  return { chat: { completions: { create: async (request) => {
    requests.push(structuredClone(request));
    const args = { answer: 'Contexto revisado.' };
    const message = toolCallMode === 'prompted'
      ? { role: 'assistant', content: '```tool_call\n' + JSON.stringify({ tool: 'finalize', args }) + '\n```' }
      : { role: 'assistant', content: null, tool_calls: [{
        id: `protected-history-finalize-${requests.length}`, type: 'function',
        function: { name: 'finalize', arguments: JSON.stringify(args) },
      }] };
    return { choices: [{ message }] };
  } } } };
}

async function runWithCapturedRequests({ toolCallMode, model = 'gpt-4o', fixture, requests }) {
  const res = new PassThrough();
  res.resume();
  res.setHeader = () => {};
  try {
    return await runAgenticChat({
      openai: scriptedProvider(toolCallMode, requests),
      model, toolCallMode, history: fixture.history,
      protectedMessages: fixture.protectedMessages,
      userQuery: 'CONTINUACION_ACTUAL: revisa las instrucciones y las fuentes originales.',
      res, toolsOverride: [], maxSteps: 2,
    });
  } finally {
    res.destroy();
  }
}

for (const toolCallMode of ['native', 'prompted']) {
  test(`${toolCallMode}: a retained ledger larger than 24 KB reaches the provider once with original roles and order`, async () => {
    const fixture = retainedHistory();
    const originalHistory = structuredClone(fixture.history);
    const requests = [];
    await runWithCapturedRequests({ toolCallMode, fixture, requests });

    assert.ok(requests.length > 0, 'the test must inspect an actual provider request');
    for (const request of requests) {
      let previousIndex = -1;
      fixture.protectedMessages.forEach((expected, index) => {
        const matches = request.messages.flatMap((message, messageIndex) => (
          message.role === expected.role && message.content === expected.content ? [messageIndex] : []
        ));
        assert.equal(matches.length, 1, `${fixture.messageIds[index]} must keep its original role and exact text`);
        assert.ok(matches[0] > previousIndex, 'retained messages must preserve chronology');
        previousIndex = matches[0];

        const occurrences = request.messages.reduce((count, message) => (
          count + String(message.content || '').split(fixture.messageIds[index]).length - 1
        ), 0);
        assert.equal(occurrences, 1, 'retained provenance must not also be copied into extraSystem');
        assert.ok(request.messages.filter((message) => message.role === 'system')
          .every((message) => !String(message.content || '').includes(fixture.messageIds[index])),
        'historical user/assistant content must not become a system instruction');
      });
      const currentIndex = request.messages.findIndex((message) => message.role === 'user'
        && message.content === 'CONTINUACION_ACTUAL: revisa las instrucciones y las fuentes originales.');
      assert.ok(currentIndex > previousIndex, 'the current user turn must follow retained history');
    }
    assert.deepEqual(fixture.history, originalHistory, 'fitting must not mutate caller-owned history');
  });

  test(`${toolCallMode}: retained history that cannot fit the selected model fails with E_PARAMS before any request`, async () => {
    const fixture = retainedHistory();
    const requests = [];
    await assert.rejects(
      runWithCapturedRequests({ toolCallMode, model: 'sira-mini', fixture, requests }),
      (error) => error?.code === 'E_PARAMS',
      'protected instructions must never be silently shortened to fit the model',
    );
    assert.equal(requests.length, 0, 'an impossible retained context must not reach the provider');
  });
}

const reactAgent = require('../src/services/react-agent');
const DIRECT_QUERY = 'PIN_CURRENT_QUERY: termina la revisión sin cambiar las fuentes.';
const PREFIX_MARKERS = ['PIN_USER_BEGIN', 'PIN_ASSISTANT_SOURCE', 'PIN_CORRECTION_END', 'PIN_CURRENT_QUERY'];

function directContext(repetitions = 600) {
  return [
    { role: 'user', content: 'PIN_USER_BEGIN:\n' + 'Detalle protegido. '.repeat(repetitions) + '\nConserva todo el texto.' },
    { role: 'assistant', content: [
      { type: 'text', text: '  Archivo producido en la revisión anterior.\n' },
      { type: 'text', text: 'PIN_ASSISTANT_SOURCE: {"fileId":"historical-workbook","messageId":"previous-answer"}\n  ' },
    ] },
    { role: 'user', content: '  Corrección: conserva las fórmulas originales.\nPIN_CORRECTION_END\n  ' },
  ];
}

function recordingLoopProvider(toolCallMode, revisions, requests, idPrefix) {
  let index = 0;
  return { chat: { completions: { create: async (request) => {
    requests.push(structuredClone(request));
    const revision = revisions[index];
    const tool = revision === undefined ? 'finalize' : 'inspect_fixture';
    const args = revision === undefined ? { answer: 'Revisión completa.' } : { revision };
    index += 1;
    return { choices: [{ message: toolCallMode === 'prompted'
      ? { role: 'assistant', content: '```tool_call\n' + JSON.stringify({ tool, args }) + '\n```' }
      : { role: 'assistant', content: 'Revisando una fuente.', tool_calls: [{
        id: `${idPrefix}-${index}`, type: 'function',
        function: { name: tool, arguments: JSON.stringify(args) },
      }] },
    }] };
  } } } };
}

function fixtureTool(executed, outputChars = 6000) {
  return {
    name: 'inspect_fixture', description: 'Inspect a synthetic in-memory fixture.',
    parameters: {
      type: 'object', properties: { revision: { type: 'integer' } },
      required: ['revision'], additionalProperties: false,
    },
    execute: async ({ revision }) => {
      executed.push(revision);
      return { ok: true, revision, content: `OBSERVACION_${revision}:` + 'D'.repeat(outputChars) };
    },
  };
}

function assertNativePairing(messages) {
  const seen = new Set();
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.equal(pending.delete(message.tool_call_id), true, 'each tool result must answer a pending call exactly once');
      continue;
    }
    assert.equal(pending.size, 0, 'a complete tool round must precede the next conversational message');
    for (const call of message.tool_calls || []) {
      assert.equal(seen.has(call.id), false, 'tool-call identities must be unique within the payload');
      seen.add(call.id);
      pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0, 'every outgoing tool call must have its result');
}

function assertDirectRequests(requests, contextMessages, toolCallMode) {
  assert.ok(requests.length > 0, 'inspect actual provider requests');
  for (const request of requests) {
    assert.equal(request.messages[0].role, 'system');
    assert.deepEqual(request.messages.slice(1, contextMessages.length + 1), contextMessages,
      'compaction and transport conversion must preserve the entire retained prefix, including content arrays');
    assert.deepEqual(request.messages[contextMessages.length + 1], { role: 'user', content: DIRECT_QUERY },
      'the current query must remain immediately after retained context');
    const serialized = JSON.stringify(request.messages);
    assert.ok(!serialized.includes('[object Object]'), 'structured retained content must never be coerced to text');
    for (const marker of PREFIX_MARKERS) {
      assert.equal(serialized.split(marker).length - 1, 1, `${marker} must occur exactly once after compaction or resume`);
    }
    if (toolCallMode === 'native') {
      assertNativePairing(request.messages);
    } else {
      assert.equal('tools' in request, false);
      assert.equal('tool_choice' in request, false);
      assert.ok(request.messages.every((message) => message.role !== 'tool' && !message.tool_calls),
        'prompted transport must retain its provider-safe tool representation');
    }
  }
}

for (const toolCallMode of ['native', 'prompted']) {
  test(`${toolCallMode}: repeated ReAct compaction preserves protected text, structured assistant sources and the current query`, async () => {
    const contextMessages = directContext();
    const originalContext = structuredClone(contextMessages);
    const requests = [];
    const executed = [];
    const compactEvents = [];
    const result = await reactAgent.run(recordingLoopProvider(toolCallMode, [1, 2, 3, 4, 5, 6], requests, 'compact'), {
      model: 'gpt-4o', query: DIRECT_QUERY, contextMessages, toolCallMode,
      tools: [fixtureTool(executed)], maxSteps: 10,
      compactMaxChars: 2000, compactTailRounds: 1,
      onCompact: (event) => compactEvents.push(event),
    });

    assert.equal(result.stoppedReason, 'finalized');
    assert.deepEqual(executed, [1, 2, 3, 4, 5, 6], 'distinct tool arguments must exercise actual dispatch, not cached observations');
    assert.equal(requests.length, 7);
    assert.ok(compactEvents.length >= 2, 'the protected prefix must survive multiple actual compactions');
    assert.ok(requests.some((request) => request.messages.some((message) =>
      typeof message.content === 'string' && message.content.includes('[CONTEXTO COMPACTADO]'))));
    assertDirectRequests(requests, originalContext, toolCallMode);
    assert.deepEqual(contextMessages, originalContext, 'the caller-owned structured context must remain unchanged');
  });

  test(`${toolCallMode}: serialized checkpoint resume restores the protected prefix once and keeps compacting safely`, async () => {
    const contextMessages = directContext();
    const originalContext = structuredClone(contextMessages);
    const controller = new AbortController();
    const firstRequests = [];
    const resumedRequests = [];
    const executed = [];
    const resumedCompactions = [];
    let checkpoint;
    const first = await reactAgent.run(recordingLoopProvider(toolCallMode, [1, 2, 3, 4], firstRequests, 'before-resume'), {
      model: 'gpt-4o', query: DIRECT_QUERY, contextMessages, toolCallMode,
      tools: [fixtureTool(executed)], maxSteps: 10,
      compactMaxChars: 2000, compactTailRounds: 1, ctx: { signal: controller.signal },
      onCheckpoint: (snapshot) => {
        checkpoint = JSON.parse(JSON.stringify(snapshot));
        if (snapshot.stepsCompleted === 4) controller.abort();
      },
    });
    assert.equal(first.stoppedReason, 'aborted');
    assert.ok(checkpoint, 'the engine must produce the checkpoint used for resume');
    assert.equal(checkpoint.stepsCompleted, 4);
    assert.equal(checkpoint.protectedPrefixLength, contextMessages.length + 1);
    assert.deepEqual(checkpoint.messages.slice(0, contextMessages.length), originalContext);
    const originalCheckpoint = structuredClone(checkpoint);
    // A fresh worker has new objects, so protection cannot rely on identity
    // from the first run or on re-appending context to the restored trace.
    const restoredContext = JSON.parse(JSON.stringify(contextMessages));
    const resumed = await reactAgent.run(recordingLoopProvider(toolCallMode, [5, 6], resumedRequests, 'after-resume'), {
      model: 'gpt-4o', query: DIRECT_QUERY, contextMessages: restoredContext, toolCallMode,
      tools: [fixtureTool(executed)], maxSteps: 10, resumeCheckpoint: checkpoint,
      compactMaxChars: 2000, compactTailRounds: 1,
      onCompact: (event) => resumedCompactions.push(event),
    });

    assert.equal(resumed.stoppedReason, 'finalized');
    assert.deepEqual(executed, [1, 2, 3, 4, 5, 6], 'resume must continue instead of replaying prior calls');
    assert.equal(firstRequests.length, 4);
    assert.equal(resumedRequests.length, 3);
    assert.ok(resumedCompactions.length > 0, 'resumed history must cross the compaction boundary again');
    assertDirectRequests([...firstRequests, ...resumedRequests], originalContext, toolCallMode);
    assert.deepEqual(checkpoint, originalCheckpoint, 'resume must not mutate its serialized checkpoint');
    assert.deepEqual(restoredContext, originalContext);
    assert.deepEqual(contextMessages, originalContext);
  });

  test(`${toolCallMode}: a large tool result that exhausts the model window stops before another provider request`, async () => {
    const contextMessages = directContext(150);
    const requests = [];
    const executed = [];
    await assert.rejects(reactAgent.run(recordingLoopProvider(toolCallMode, [1], requests, 'budget'), {
      model: 'sira-mini', query: DIRECT_QUERY, contextMessages, toolCallMode,
      tools: [fixtureTool(executed, 20_000)], maxSteps: 4,
      compactMaxChars: 2000, compactTailRounds: 1,
    }), (error) => error?.code === 'E_PARAMS');

    assert.deepEqual(executed, [1], 'the initial retained context must fit and execute the tool');
    assert.equal(requests.length, 1, 'overflow caused by the observation must block the next model call');
    assertDirectRequests(requests, contextMessages, toolCallMode);
  });
}


test('coding transport reserves its actual 4096 output tokens before accepting retained context', async () => {
  const contextMessages = directContext();
  const options = {
    query: DIRECT_QUERY, contextMessages, toolCallMode: 'native', tools: [], maxSteps: 2,
    now: Date.parse('2026-10-22T12:00:00.000Z'),
    ctx: { provider: 'xai', codingWorkspace: { projectId: 'synthetic-reserve-project' } },
  };
  // Capture the real coding transport in a roomy model first. This verifies
  // that the fixture lies between the old 2048 reserve and the actual 4096
  // reserve, without reconstructing the system prompt or tool schema here.
  const roomyRequests = [];
  const roomy = await reactAgent.run(recordingLoopProvider('native', [], roomyRequests, 'roomy-reserve'), {
    ...options, model: 'gpt-4o',
  });
  assert.equal(roomy.stoppedReason, 'finalized');
  assert.equal(roomyRequests.length, 1);
  const codingRequest = roomyRequests[0];
  assert.equal(Math.max(codingRequest.max_tokens || 0, codingRequest.max_completion_tokens || 0), 4096);
  assert.equal(codingRequest.stream, true);
  const smallModelRequest = { ...codingRequest, model: 'sira-mini' };
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(smallModelRequest), 'utf8') / 4);
  assert.ok(inputTokens > 2457 && inputTokens <= 4505,
    'the fixture must fit an 8192 window with a 2048 reserve, but not with the coding transport reserve of 4096');

  const requests = [];
  await assert.rejects(reactAgent.run(recordingLoopProvider('native', [], requests, 'small-reserve'), {
    ...options, model: 'sira-mini',
    ctx: { provider: 'xai', codingWorkspace: { projectId: 'synthetic-reserve-project' } },
  }), (error) => error?.code === 'E_PARAMS');
  assert.equal(requests.length, 0, 'the coding output reserve must be checked before sending retained context');
});

for (const toolCallMode of ['native', 'prompted']) {
  for (const base64Chars of [512 * 1024, 768 * 1024]) {
    test(`${toolCallMode}: a retained ${base64Chars / 1024} KB image preserves its data URL without charging base64 as text`, async () => {
      // No image decoding or network is involved: the long base64 body tests
      // accounting and byte-for-byte transport of a retained multimodal part.
      const dataUrl = 'data:image/png;base64,' + 'A'.repeat(base64Chars);
      const contextMessages = [{ role: 'user', content: [
        { type: 'text', text: 'PROTECTED_IMAGE_TEXT: revisa esta fuente visual sin sustituirla.' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
      ] }];
      const originalContext = structuredClone(contextMessages);
      const requests = [];
      const result = await reactAgent.run(recordingLoopProvider(toolCallMode, [], requests, 'large-image'), {
        model: 'gpt-4o', query: 'IMAGE_QUERY: continúa con la imagen original.',
        contextMessages, toolCallMode, tools: [], maxSteps: 2,
        compactMaxChars: 2000, compactTailRounds: 1,
      });

      assert.equal(result.stoppedReason, 'finalized');
      assert.equal(requests.length, 1, 'one image must fit even when its encoded body exceeds the text budget');
      const messages = requests[0].messages;
      assert.deepEqual(messages[1], originalContext[0], 'both the text and the image part must retain their original role and content');
      assert.equal(messages[1].content[1].image_url.url, dataUrl, 'image bytes must reach the provider intact');
      assert.deepEqual(messages[2], { role: 'user', content: 'IMAGE_QUERY: continúa con la imagen original.' });
      assert.equal(JSON.stringify(messages).split(dataUrl).length - 1, 1, 'the retained image must not be duplicated into system context');
      assert.deepEqual(contextMessages, originalContext, 'accounting must not replace or mutate the encoded image');
    });
  }

  test(`${toolCallMode}: multiple retained images have a nonzero context cost and reject before calling a small model`, async () => {
    const contextMessages = [{ role: 'user', content: [
      { type: 'text', text: 'PROTECTED_MANY_IMAGES: compara estas veinte fuentes visuales.' },
      ...Array.from({ length: 20 }, () => ({
        type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(64), detail: 'auto' },
      })),
    ] }];
    const originalContext = structuredClone(contextMessages);
    const requests = [];
    await assert.rejects(reactAgent.run(recordingLoopProvider(toolCallMode, [], requests, 'many-images'), {
      model: 'sira-mini', query: 'Revisa todas las imágenes originales.',
      contextMessages, toolCallMode, tools: [], maxSteps: 2,
    }), (error) => error?.code === 'E_PARAMS');

    assert.equal(requests.length, 0, 'small encoded bodies do not make twenty images free in the context window');
    assert.deepEqual(contextMessages, originalContext);
  });
}

for (const { model, provider, contextLimit, expectedOutputLimit } of [
  { model: 'gpt-4', provider: 'OpenAI', contextLimit: 8192, expectedOutputLimit: 2048 },
  { model: 'deepseek/deepseek-r1', provider: 'OpenRouter', contextLimit: 65000, expectedOutputLimit: 16250 },
]) {
  test(`${model}: an oversized advertised completion limit does not block a small retained conversation`, async () => {
    const contextMessages = [
      { role: 'user', content: 'SMALL_RETAINED_REQUEST: conserva las fuentes originales.' },
      { role: 'assistant', content: 'SMALL_RETAINED_SOURCE: archivo original del mensaje anterior.' },
    ];
    const requests = [];
    const result = await reactAgent.run(recordingLoopProvider('native', [], requests, 'effective-output-cap'), {
      model, query: 'Continúa con la revisión.', contextMessages,
      toolCallMode: 'native', tools: [], maxSteps: 2, ctx: { provider },
    });

    assert.equal(result.stoppedReason, 'finalized');
    assert.equal(requests.length, 1, 'a small retained conversation must reach the selected model');
    const request = requests[0];
    const outputLimit = Math.max(request.max_tokens || 0, request.max_completion_tokens || 0);
    assert.equal(outputLimit, expectedOutputLimit, 'the default output cap must respect one quarter of the selected context window');
    const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(request), 'utf8') / 4);
    assert.ok(inputTokens + outputLimit <= Math.floor(contextLimit * 0.8),
      'the effective output cap and actual request must fit the safe model context together');
    assert.deepEqual(request.messages.slice(1, 3), contextMessages);
    assert.equal(request.model, model, 'repairing the output budget must not switch the selected model');
  });
}
