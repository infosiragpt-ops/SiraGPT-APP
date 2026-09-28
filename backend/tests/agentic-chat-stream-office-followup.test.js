'use strict';

/**
 * Chat path of a follow-up edit on an Office document generated earlier in
 * the chat (incident 2026-09-28: «en la misma ppt ## …pptx puede agregarle un
 * poco mas de diseño» was answered with an .html preview + a .py script).
 *
 * Pins, with the AgentRunner and the quick editor stubbed:
 *   - the incident prompt with no upload and a prior artifact is served by
 *     the AgentRunner; the quick editor never runs on a design upgrade;
 *   - a failed runner on a design upgrade is an honest error — the LLM loop
 *     never runs;
 *   - a quick editor that returns nothing on a generated file hands the turn
 *     to the AgentRunner; when that fails too, the turn stops honestly;
 *   - on Office edit turns the loop never offers create_artifact (nor
 *     create_document);
 *   - an Office edit turn that ends with only .html/.py substitutes gets an
 *     honest answer and the substitutes are dropped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { PassThrough } = require('node:stream');

const agentRunner = require('../src/services/agent-runner');

const INCIDENT = 'en la misma ppt ## gestion-administrativa-sostenibilidad.pptx puede agregarle un poco mas de diseño';
const STREAM_PATH = '../src/services/agentic-chat-stream';

function fakeRes() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c.toString('utf-8')));
  stream.flushHeaders = () => {};
  stream.setHeader = () => {};
  return { res: stream, chunks };
}

function finalizingClient({ toolCalls = [] } = {}) {
  const calls = [];
  const script = [...toolCalls.map((call) => ({ call })), { finalize: true }];
  let i = 0;
  return {
    calls,
    chat: {
      completions: {
        create: async (opts) => {
          calls.push((opts.tools || []).map((tool) => tool && tool.function && tool.function.name).filter(Boolean));
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          const fn = step.finalize
            ? { name: 'finalize', arguments: JSON.stringify({ answer: 'Listo: aquí tienes la vista previa HTML y el script para generar la presentación.' }) }
            : { name: step.call.name, arguments: JSON.stringify(step.call.args || {}) };
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: `call_${i}`, type: 'function', function: fn }],
              },
            }],
          };
        },
      },
    },
  };
}

/**
 * Loads a fresh agentic-chat-stream with the AgentRunner / quick editor
 * stubbed. Returns { run, spies, restore }.
 */
function loadStream({ runner = {}, editor = {} } = {}) {
  const spies = { runnerCalls: [], editorCalls: 0 };
  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === './agent-runner' || request.endsWith('/agent-runner')) {
      return {
        ...agentRunner,
        hasConversationArtifacts: async () => true,
        // The chat's latest artifact is the deck generated in turn 1.
        getConversationArtifactFormat: async () => 'pptx',
        ...runner,
        executeAgentRunnerTurn: async (params) => {
          spies.runnerCalls.push(params);
          return runner.executeAgentRunnerTurn
            ? runner.executeAgentRunnerTurn(params)
            : { ok: false, skipped: false, summary: '', artifacts: [], steps: [], stoppedReason: 'no_output', errorMessage: null };
        },
      };
    }
    if (request === './source-preserving-document-edit' || request.endsWith('/source-preserving-document-edit')) {
      return {
        requestWantsProfessionalEditing: editor.requestWantsProfessionalEditing || (() => false),
        isSourcePreservingEditRequest: editor.isSourcePreservingEditRequest || (() => true),
        tryGenerateSourcePreservingDocumentEdit: async (...args) => {
          spies.editorCalls += 1;
          return editor.tryGenerateSourcePreservingDocumentEdit ? editor.tryGenerateSourcePreservingDocumentEdit(...args) : null;
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(STREAM_PATH)];
  const fresh = require(STREAM_PATH);
  return {
    fresh,
    spies,
    restore() {
      Module._load = originalLoad;
      delete require.cache[require.resolve(STREAM_PATH)];
    },
  };
}

const RUNNER_OK = {
  ok: true,
  summary: 'Listo. Rediseñé la presentación: gestion-administrativa-sostenibilidad-v2.pptx.',
  artifacts: [{
    id: 'a1b2c3d4e5f60718',
    filename: 'gestion-administrativa-sostenibilidad-v2.pptx',
    format: 'pptx',
    downloadUrl: '/api/agent/artifact/a1b2c3d4e5f60718',
  }],
  steps: [],
  stoppedReason: 'agent_runner',
};

test('incident: the design follow-up with no upload is served by the AgentRunner, never the quick editor', async () => {
  const { fresh, spies, restore } = loadStream({ runner: { executeAgentRunnerTurn: async () => RUNNER_OK } });
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: INCIDENT,
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
    });
    assert.equal(result.stoppedReason, 'agent_runner');
    assert.equal(spies.runnerCalls.length, 1);
    assert.equal(spies.runnerCalls[0].instruction, INCIDENT);
    assert.deepEqual(spies.runnerCalls[0].fileIds, []);
    assert.equal(spies.editorCalls, 0, 'the quick editor cannot redesign — it must not run');
    assert.equal(openai.calls.length, 0, 'no LLM loop');
    assert.equal(result.artifacts[0].filename, 'gestion-administrativa-sostenibilidad-v2.pptx');
  } finally {
    restore();
  }
});

test('incident: a failed AgentRunner on a design upgrade is an honest error — no loop, no substitutes', async () => {
  const { fresh, spies, restore } = loadStream();
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: INCIDENT,
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
    });
    assert.equal(result.stoppedReason, 'agent_runner_failed');
    assert.match(result.finalAnswer, /^No pude generar el documento/);
    assert.equal(spies.runnerCalls.length, 1);
    assert.equal(spies.editorCalls, 0);
    assert.equal(openai.calls.length, 0, 'the chat loop never runs');
    assert.deepEqual(result.artifacts, []);
    assert.equal(fresh.isHandledAgenticChatResult(result), true, 'the route persists the honest answer');
  } finally {
    restore();
  }
});

test('generated file: the quick editor finds nothing → the AgentRunner edits it', async () => {
  const { fresh, spies, restore } = loadStream({
    runner: {
      shouldRunAgentRunner: () => false,
      executeAgentRunnerTurn: async () => ({ ...RUNNER_OK, summary: 'Listo. Reemplacé el texto.' }),
    },
  });
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'en la misma ppt reemplaza «Hola» por «Adiós»',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
    });
    assert.equal(spies.editorCalls, 1, 'the quick editor tried first');
    assert.equal(spies.runnerCalls.length, 1, 'then the AgentRunner, which can load the generated file');
    assert.equal(result.stoppedReason, 'agent_runner');
    assert.equal(openai.calls.length, 0);
  } finally {
    restore();
  }
});

test('generated file: quick editor and AgentRunner both fail → honest stop, never the tool-less loop', async () => {
  const { fresh, spies, restore } = loadStream({ runner: { shouldRunAgentRunner: () => false } });
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'en la misma ppt reemplaza «Hola» por «Adiós»',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
    });
    assert.equal(spies.editorCalls, 1);
    assert.equal(spies.runnerCalls.length, 1);
    assert.equal(result.stoppedReason, 'agent_runner_failed');
    assert.match(result.finalAnswer, /^No pude generar el documento/);
    assert.equal(openai.calls.length, 0, 'no loop without a document editor');
    assert.equal(fresh.isHandledAgenticChatResult(result), true);
  } finally {
    restore();
  }
});

test('generated file: without a runner failure reason the stop still explains it honestly', async () => {
  const { fresh, restore } = loadStream({
    runner: {
      shouldRunAgentRunner: () => false,
      executeAgentRunnerTurn: async () => { throw new Error('sandbox unreachable'); },
    },
  });
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai: finalizingClient(),
      model: 'gpt-4o-mini',
      userQuery: 'en la misma ppt reemplaza «Hola» por «Adiós»',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
    });
    assert.equal(result.stoppedReason, 'agent_runner_failed');
    assert.match(result.finalAnswer, /error inesperado/);
    assert.doesNotMatch(result.finalAnswer, /html|\.py/i);
  } finally {
    restore();
  }
});

function officeEditTools(extra = []) {
  return [
    {
      name: 'create_document',
      description: 'create a NEW generic document',
      parameters: { type: 'object', properties: { filename: { type: 'string' } } },
      execute: async () => { throw new Error('create_document must be unreachable'); },
    },
    {
      name: 'create_artifact',
      description: 'create an html / code artifact',
      parameters: { type: 'object', properties: { title: { type: 'string' } } },
      execute: async () => { throw new Error('create_artifact must be unreachable on Office edits'); },
    },
    {
      name: 'document_edit',
      description: 'edit attached document',
      parameters: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'] },
      execute: async () => ({ ok: true }),
    },
    ...extra,
  ];
}

test('Office edit turn: the loop is offered neither create_artifact nor create_document', async () => {
  const { fresh, restore } = loadStream({
    runner: { shouldRunAgentRunner: () => false, hasConversationArtifacts: async () => false, getConversationArtifactFormat: async () => null },
    editor: { isSourcePreservingEditRequest: () => false },
  });
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'edita la ppt adjunta: cambia el título a Informe Final',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma: {} },
      toolsOverride: officeEditTools(),
    });
    const offered = new Set(openai.calls.flat());
    assert.ok(openai.calls.length > 0, 'the loop ran');
    assert.equal(offered.has('create_artifact'), false, 'create_artifact never stands in for a PPTX');
    assert.equal(offered.has('create_document'), false);
    assert.equal(offered.has('document_edit'), true, 'the surgical editor stays available');
  } finally {
    restore();
  }
});

test('Office edit turn ending with only an .html substitute → honest answer, substitute dropped', async () => {
  const { fresh, restore } = loadStream({
    runner: { shouldRunAgentRunner: () => false, hasConversationArtifacts: async () => false, getConversationArtifactFormat: async () => null },
    editor: { isSourcePreservingEditRequest: () => false },
  });
  const preview = {
    name: 'make_preview',
    description: 'writes an html preview',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      ctx.onEvent({
        type: 'file_artifact',
        artifact: {
          id: 'f0e1d2c3b4a59687',
          filename: 'gestion-diseno-v2-preview.html',
          format: 'html',
          downloadUrl: '/api/agent/artifact/f0e1d2c3b4a59687',
        },
      });
      return { ok: true };
    },
  };
  const openai = finalizingClient({ toolCalls: [{ name: 'make_preview', args: {} }] });
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'edita la ppt adjunta: cambia el título a Informe Final',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma: {} },
      toolsOverride: officeEditTools([preview]),
    });
    assert.match(result.finalAnswer, /^No pude editar la presentación/);
    assert.doesNotMatch(result.finalAnswer, /aquí tienes la vista previa/);
    assert.equal(result.stoppedReason, 'source_preserving_document_edit_failed');
    assert.equal((result.artifacts || []).some((a) => /\.html$/.test(a.filename)), false, 'the html substitute is not delivered');
    assert.equal(fresh.isHandledAgenticChatResult(result), true);
  } finally {
    restore();
  }
});

// ── Review regressions: non-Office targets, questions, derived outputs ────

function fileArtifactTool(name, filename, format) {
  return {
    name,
    description: `writes ${filename}`,
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      ctx.onEvent({
        type: 'file_artifact',
        artifact: { id: 'a0b1c2d3e4f50617', filename, format, downloadUrl: '/api/agent/artifact/a0b1c2d3e4f50617' },
      });
      return { ok: true };
    },
  };
}

test('a prior html page is not an Office target: design words keep the chat loop', async () => {
  for (const userQuery of ['hazla más bonita', 'reescribe esta carta y hazla más profesional', 'hazlo más visual con ejemplos']) {
    const { fresh, spies, restore } = loadStream({
      runner: { getConversationArtifactFormat: async () => 'html' },
      editor: { isSourcePreservingEditRequest: () => false },
    });
    const openai = finalizingClient();
    try {
      const { res } = fakeRes();
      const result = await fresh.runAgenticChat({
        openai,
        model: 'gpt-4o-mini',
        userQuery,
        history: [],
        res,
        toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
      });
      assert.equal(spies.runnerCalls.length, 0, `no runner claim: ${userQuery}`);
      assert.ok(openai.calls.length > 0, `the loop answers: ${userQuery}`);
      assert.notEqual(result.stoppedReason, 'agent_runner_failed', userQuery);
    } finally {
      restore();
    }
  }
});

test('a follow-up on a generated html page / script never hits the generated-document hard stop', async () => {
  for (const [userQuery, format] of [
    ['agrega un botón de contacto a la misma página', 'html'],
    ['en el mismo archivo agrega una función que sume', 'py'],
  ]) {
    const { fresh, restore } = loadStream({
      runner: { shouldRunAgentRunner: () => false, getConversationArtifactFormat: async () => format },
    });
    const openai = finalizingClient();
    try {
      const { res } = fakeRes();
      const result = await fresh.runAgenticChat({
        openai,
        model: 'gpt-4o-mini',
        userQuery,
        history: [],
        res,
        toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
      });
      assert.notEqual(result.stoppedReason, 'agent_runner_failed', userQuery);
      assert.ok(openai.calls.length > 0, `the loop edits the ${format}: ${userQuery}`);
    } finally {
      restore();
    }
  }
});

test('a read-only question about the generated deck is answered in the chat, not a hard stop', async () => {
  const { fresh, restore } = loadStream({ runner: { shouldRunAgentRunner: () => false } });
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'revisa el documento y dime qué corregir',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
    });
    assert.notEqual(result.stoppedReason, 'agent_runner_failed');
    assert.ok(openai.calls.length > 0, 'the loop answers the question');
  } finally {
    restore();
  }
});

test('«haz un dashboard html con los datos del excel» keeps create_artifact and delivers the html', async () => {
  const { fresh, restore } = loadStream({
    runner: { shouldRunAgentRunner: () => false, hasConversationArtifacts: async () => false, getConversationArtifactFormat: async () => null },
    editor: { isSourcePreservingEditRequest: () => false },
  });
  const openai = finalizingClient({ toolCalls: [{ name: 'make_dashboard', args: {} }] });
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'haz un dashboard html con los datos del excel',
      history: [],
      res,
      toolContext: {
        userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma: {},
        fileMetadata: [{ id: 'f1', name: 'ventas.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
      },
      toolsOverride: officeEditTools([fileArtifactTool('make_dashboard', 'dashboard-ventas.html', 'html')]),
    });
    assert.notEqual(result.stoppedReason, 'source_preserving_document_edit_failed');
    assert.doesNotMatch(String(result.finalAnswer || ''), /^No pude editar/);
    assert.ok((result.artifacts || []).some((a) => a.filename === 'dashboard-ventas.html'), 'the dashboard is delivered');
  } finally {
    restore();
  }
});

test('design turn with a prior generated Word: create_artifact is removed even without an Office noun', async () => {
  const { fresh, restore } = loadStream({
    runner: { shouldRunAgentRunner: () => false, getConversationArtifactFormat: async () => 'docx' },
    editor: { isSourcePreservingEditRequest: () => false },
  });
  const openai = finalizingClient();
  try {
    const { res } = fakeRes();
    await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'mejóralo con más diseño',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: {} },
      toolsOverride: officeEditTools(),
    });
    const offered = new Set(openai.calls.flat());
    assert.equal(offered.has('create_artifact'), false);
  } finally {
    restore();
  }
});

test('a content rewrite of an attached Word keeps the quick editor (professional_edit), never the design path', async () => {
  for (const userQuery of [
    'mejora la redacción del documento y hazlo más profesional',
    'Edita profesionalmente este documento, mejora el contenido y hazlo más interesante.',
  ]) {
    const { fresh, spies, restore } = loadStream({
      runner: { hasConversationArtifacts: async () => false, getConversationArtifactFormat: async () => null },
      editor: { requestWantsProfessionalEditing: () => true },
    });
    try {
      const { res } = fakeRes();
      await fresh.runAgenticChat({
        openai: finalizingClient(),
        model: 'gpt-4o-mini',
        userQuery,
        history: [],
        res,
        toolContext: {
          userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma: {},
          fileMetadata: [{ id: 'f1', name: 'informe.docx' }],
        },
      });
      assert.equal(spies.editorCalls, 1, `the quick editor serves it: ${userQuery}`);
    } finally {
      restore();
    }
  }
});
