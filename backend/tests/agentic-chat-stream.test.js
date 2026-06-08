/**
 * Tests for services/agentic-chat-stream.js.
 *
 * We don't hit a real LLM here — we inject a fake OpenAI client that
 * returns a scripted sequence of tool calls so we can verify:
 *   - The wrapper emits a `replace` sentinel after each step transition.
 *   - The final answer is appended below the sentinel.
 *   - A tool error doesn't hang the loop.
 *   - The model-capability gate works.
 *   - The feature flag is read at runtime.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const agenticStream = require('../src/services/agentic-chat-stream');

// Minimal Response stand-in: collects everything written so we can
// inspect the SSE frames after the run completes.
function makeFakeRes() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', c => chunks.push(c.toString('utf-8')));
  stream.flushHeaders = () => {};
  stream.setHeader = () => {};
  return {
    res: stream,
    body: () => chunks.join(''),
    frames: () => chunks.join('').split('\n\n').filter(Boolean).map(line => {
      if (!line.startsWith('data: ')) return null;
      const payload = line.slice(6);
      if (payload === '[DONE]') return { done: true };
      try { return JSON.parse(payload); } catch { return null; }
    }).filter(Boolean),
  };
}

// Scripted fake OpenAI client. Each call to chat.completions.create
// returns the next response in the queue. Each response is plain JSON
// matching the OpenAI tool-calling shape react-agent expects.
function makeFakeOpenAI(scriptedResponses) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const next = scriptedResponses[i++] || { choices: [{ message: { role: 'assistant', content: 'fin' } }] };
          return next;
        },
      },
    },
  };
}

function toolCallMessage(toolName, args, id = `call_${Math.random().toString(36).slice(2,8)}`) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function finalizeMessage(text) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_finalize',
          type: 'function',
          function: { name: 'finalize', arguments: JSON.stringify({ answer: text }) },
        }],
      },
    }],
  };
}

test('isEnabled defaults on and reads runtime opt-out flags', () => {
  const prev = process.env.AGENTIC_TOOLS_IN_CHAT;
  const prevNew = process.env.SIRAGPT_AGENTIC_CHAT_ENABLED;
  delete process.env.SIRAGPT_AGENTIC_CHAT_ENABLED;
  process.env.AGENTIC_TOOLS_IN_CHAT = '';
  assert.equal(agenticStream.isEnabled(), true);
  process.env.AGENTIC_TOOLS_IN_CHAT = '1';
  assert.equal(agenticStream.isEnabled(), true);
  process.env.AGENTIC_TOOLS_IN_CHAT = 'true';
  assert.equal(agenticStream.isEnabled(), true);
  process.env.AGENTIC_TOOLS_IN_CHAT = 'no';
  assert.equal(agenticStream.isEnabled(), false);
  process.env.SIRAGPT_AGENTIC_CHAT_ENABLED = 'off';
  process.env.AGENTIC_TOOLS_IN_CHAT = '1';
  assert.equal(agenticStream.isEnabled(), false);
  if (prev === undefined) delete process.env.AGENTIC_TOOLS_IN_CHAT;
  else process.env.AGENTIC_TOOLS_IN_CHAT = prev;
  if (prevNew === undefined) delete process.env.SIRAGPT_AGENTIC_CHAT_ENABLED;
  else process.env.SIRAGPT_AGENTIC_CHAT_ENABLED = prevNew;
});

test('modelSupportsFunctionCalling allowlist', () => {
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'gpt-4o-mini'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'gpt-4.1'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'gpt-5'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Gemini', 'gemini-2.5-pro'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Gemini', 'gemini-3-pro'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('DeepSeek', 'deepseek-v4-pro'), true);
  // Kimi K2.6 (via OpenRouter) emits its native tool-call token format; the
  // react-agent parser (parseNativeToolCalls) normalises it, so it reaches the
  // agentic loop. Claude + Grok via OpenRouter expose OpenAI-normalised tools.
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenRouter', 'moonshotai/kimi-k2.6'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenRouter', 'anthropic/claude-opus-4.7'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenRouter', 'x-ai/grok-4.20'), true);
  // Cerebras (default free model "FlashGPT" / llama-3.1-8b) is OpenAI
  // tool-compatible — it MUST reach the agentic loop or most users get
  // plain chat.
  assert.equal(agenticStream.modelSupportsFunctionCalling('Cerebras', 'llama-3.1-8b'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Cerebras', 'qwen-3-32b'), true);
  // Family-based: tool-capable OSS models reach the loop even when the
  // provider label is the generic fallback (the default-free-model case).
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'llama-3.1-8b'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Groq', 'gpt-oss-120b'), true);
  // ...but the family check must not over-match a non-tool OpenAI SKU.
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'davinci-002'), false);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Anthropic', 'claude-3-opus'), false);
});

test('shouldUseAgenticChat skips greetings and simple chat', () => {
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'hola' }), false);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'gracias!' }), false);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: '¿Puedes explicarme qué es una API?' }), false);
});

test('shouldUseAgenticChat keeps tool-heavy and follow-up repair turns agentic', () => {
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'SiraGPT.com no funciona ChatGPT' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'investiga esto y cita fuentes recientes' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'deseo qeu mejoremos todo el cerebro de la IA de forma profesional y minimalista' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'optimiza el contexto y razonamiento del agente' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({
    prompt: 'sigue con eso',
    history: [{ role: 'user', content: 'Arregla el deploy del repositorio en GitHub' }],
  }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({
    prompt: 'resume este archivo',
    files: [{ id: 'file_1' }],
  }), true);
});

test('shouldUseAgenticChat routes visual + document create requests through the agent', () => {
  // These previously slipped past AGENTIC_PROMPT_HINT and answered as
  // plain text instead of producing the artifact the user asked for.
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'genera una imagen de un gato astronauta' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'hazme un organigrama de mi empresa' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'créame una gráfica de ventas por trimestre' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'create a bar chart of revenue' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'diseña una presentación en powerpoint' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'haz un video corto del producto' }), true);
  // Casual factual chat still skips the agentic loop.
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: '¿cuál es la capital de Francia?' }), false);
});

test('shouldUseAgenticChat auto-routes freshness / live-data questions to web search', () => {
  // Core fix: questions that need real-time / fresh info must reach the
  // agentic loop (which owns web_search) even without an explicit search verb.
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: '¿Quién ganó las elecciones en Perú este año?' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: '¿Cuál es el precio actual del bitcoin?' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'dame el clima de hoy en Lima' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: '¿Qué pasó con OpenAI esta semana?' }), true);
  // Creative writing and pure math must stay on the cheaper plain path.
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'escríbeme un poema sobre el mar' }), false);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: '¿cuánto es 2+2?' }), false);
});

test('shouldUseAgenticChat routes session search and browser automation requests', () => {
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'busca en mis conversaciones pasadas lo de la tesis' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'haz scraping de esta web y extrae precios' }), true);
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'abre el navegador, haz click y baja con scroll' }), true);
});

test('serializeSentinel produces a fenced agent-task-state block', () => {
  const { serializeSentinel, freshState } = agenticStream._internal;
  const out = serializeSentinel(freshState());
  assert.match(out, /^```agent-task-state\n/);
  assert.match(out, /```$/);
  const json = JSON.parse(out.slice('```agent-task-state\n'.length, -4));
  assert.ok(Array.isArray(json.steps));
  assert.ok(Array.isArray(json.meta.tools));
});

test('default toolset includes chat, document and verification tools', () => {
  const { buildDefaultTools } = agenticStream._internal;
  const names = buildDefaultTools().map(tool => tool.name);
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('read_url'));
  assert.ok(names.includes('web_extract'));
  assert.ok(names.includes('session_search'));
  assert.ok(names.includes('browser_navigate'));
  assert.ok(names.includes('browser_click'));
  assert.ok(names.includes('browser_type'));
  assert.ok(names.includes('browser_scroll'));
  assert.ok(names.includes('memory_recall'));
  assert.ok(names.includes('rag_retrieve'));
  assert.ok(names.includes('python_exec'));
  assert.ok(names.includes('run_tests'));
  assert.ok(names.includes('clone_project'));
  assert.ok(names.includes('host_bash'));
  assert.ok(names.includes('host_file'));
  assert.ok(names.includes('check_ci_status'));
  assert.ok(names.includes('monitor_ci'));
});

test('default toolset stays lean (no media tools) when the turn is not a create request', () => {
  const { buildDefaultTools } = agenticStream._internal;
  const names = buildDefaultTools({ userQuery: '¿cuál es la capital de Francia?' }).map(tool => tool.name);
  assert.ok(names.includes('web_search'));
  assert.ok(!names.includes('generate_image'));
  assert.ok(!names.includes('generate_music'));
});

test('default toolset adds image/video/audio/music tools for a create request', () => {
  const { buildDefaultTools } = agenticStream._internal;
  const names = buildDefaultTools({ userQuery: 'créame una imagen de un gato astronauta' }).map(tool => tool.name);
  // base tools still present
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('create_document'));
  // media creation tools now available so the agent can actually produce them
  assert.ok(names.includes('generate_image'), 'generate_image should be available');
  assert.ok(names.includes('generate_video'), 'generate_video should be available');
  assert.ok(names.includes('generate_speech'), 'generate_speech should be available');
  assert.ok(names.includes('generate_music'), 'generate_music should be available');
  assert.ok(names.includes('create_chart'), 'create_chart should be available');
  // no duplicate tool names
  assert.equal(names.length, new Set(names).size);
});

test('media tools also load for explicit audio/music requests', () => {
  const { buildDefaultTools } = agenticStream._internal;
  const music = buildDefaultTools({ userQuery: 'genérame una canción de 3 minutos' }).map(t => t.name);
  assert.ok(music.includes('generate_music'));
  const audio = buildDefaultTools({ userQuery: 'hazme un audio narrando este texto' }).map(t => t.name);
  assert.ok(audio.includes('generate_speech'));
});

test('runAgenticChat injects a media-intent directive naming the tool + specs', async () => {
  let firstArgs = null;
  let calls = 0;
  const openai = {
    chat: {
      completions: {
        create: async (a) => {
          calls += 1;
          if (!firstArgs) firstArgs = a;
          if (calls === 1) return toolCallMessage('generate_music', { prompt: 'canción lofi', durationSeconds: 180 });
          return finalizeMessage('Listo.');
        },
      },
    },
  };
  const { res } = makeFakeRes();
  await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'genérame una canción de 3 minutos estilo lofi',
    history: [],
    res,
    toolsOverride: [{
      name: 'generate_music',
      description: 'generate music',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, durationSeconds: { type: 'integer' } },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: async () => ({ ok: true, status: 'queued' }),
    }],
  });
  const system = firstArgs.messages.find(m => m.role === 'system')?.content || '';
  assert.match(system, /generate_music/);
  assert.match(system, /180/);
});

test('runAgenticChat auto-selects generate_video first for "crea un video"', async () => {
  let firstCreateArgs = null;
  let createCalls = 0;
  let videoCalls = 0;
  const openai = {
    chat: {
      completions: {
        create: async (args) => {
          createCalls += 1;
          if (!firstCreateArgs) firstCreateArgs = args;
          if (createCalls === 1) {
            return toolCallMessage('generate_video', { prompt: 'crea un video' }, 'call_video');
          }
          return finalizeMessage('Video iniciado.');
        },
      },
    },
  };
  const { res } = makeFakeRes();

  const result = await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'crea un video',
    history: [],
    res,
    maxSteps: 4,
    toolsOverride: [{
      name: 'generate_video',
      description: 'generate a video',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: async (args) => {
        videoCalls += 1;
        assert.equal(args.prompt, 'crea un video');
        return { ok: true, status: 'queued', operationId: 'vid_1' };
      },
    }],
  });

  assert.deepEqual(firstCreateArgs.tool_choice, { type: 'function', function: { name: 'generate_video' } });
  const system = firstCreateArgs.messages.find(m => m.role === 'system')?.content || '';
  assert.match(system, /veo-fast/);
  assert.match(system, /duration: 8/);
  assert.equal(videoCalls, 1);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Video iniciado.');
});

test('runAgenticChat does not force generate_video for video learning questions', async () => {
  let firstCreateArgs = null;
  let videoCalls = 0;
  const openai = {
    chat: {
      completions: {
        create: async (args) => {
          if (!firstCreateArgs) firstCreateArgs = args;
          return finalizeMessage('Para crear un video, empieza por un guion breve.');
        },
      },
    },
  };
  const { res } = makeFakeRes();

  const result = await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: '¿cómo crear un video?',
    history: [],
    res,
    maxSteps: 3,
    toolsOverride: [{
      name: 'generate_video',
      description: 'generate a video',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: async () => {
        videoCalls += 1;
        return { ok: true };
      },
    }],
  });

  assert.equal(firstCreateArgs.tool_choice, 'auto');
  const system = firstCreateArgs.messages.find(m => m.role === 'system')?.content || '';
  assert.doesNotMatch(system, /Activación automática de herramienta multimedia/);
  assert.doesNotMatch(system, /DEBES usar la herramienta `generate_video`/);
  assert.equal(videoCalls, 0);
  assert.equal(result.stoppedReason, 'finalized');
  assert.match(result.finalAnswer, /guion breve/);
});

test('runAgenticChat surfaces tool file_artifact events into state.artifacts', async () => {
  const openai = makeFakeOpenAI([
    toolCallMessage('fake_media', {}),
    finalizeMessage('Imagen lista.'),
  ]);
  const { res, frames } = makeFakeRes();

  await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'créame una imagen de prueba',
    history: [],
    res,
    toolsOverride: [{
      name: 'fake_media',
      description: 'emits an artifact like the media tools do',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, ctx) => {
        if (ctx && typeof ctx.onEvent === 'function') {
          ctx.onEvent({
            type: 'file_artifact',
            artifact: {
              id: 'art1', filename: 'gato.png', format: 'png', mime: 'image/png',
              sizeBytes: 2048, downloadUrl: '/api/agent/artifact/art1?name=gato.png',
            },
          });
        }
        return { ok: true, downloadUrl: '/api/agent/artifact/art1?name=gato.png' };
      },
    }],
  });

  const last = frames().filter(f => f.replace).pop();
  assert.ok(last, 'expected a final replace frame');
  const open = '```agent-task-state\n';
  const jsonPart = last.content.slice(last.content.indexOf(open) + open.length, last.content.indexOf('\n```'));
  const state = JSON.parse(jsonPart);
  assert.ok(Array.isArray(state.artifacts));
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0].filename, 'gato.png');
  assert.equal(state.artifacts[0].downloadUrl, '/api/agent/artifact/art1?name=gato.png');
  assert.equal(state.artifacts[0].mime, 'image/png');
});

test('buildThreadWorkContext preserves standing user goals from prior turns', () => {
  const { buildThreadWorkContext } = agenticStream._internal;
  const context = buildThreadWorkContext([
    { role: 'user', content: 'Quiero que cada chat sea un agente autónomo.' },
    { role: 'assistant', content: 'Voy a revisar el backend.' },
    { role: 'user', content: 'Necesito que pueda trabajar como Claude Code con repos.' },
  ], 'Aun no funciona, no entiende todo el hilo.');

  assert.match(context, /ongoing autonomous work session/);
  assert.match(context, /Professional minimal cognition profile/);
  assert.match(context, /direct answer or next action first/);
  assert.match(context, /cada chat sea un agente/);
  assert.match(context, /Claude Code/);
  assert.match(context, /Recent thread context/);
});

test('buildThreadWorkContext hardens broad AI-brain upgrade requests', () => {
  const { buildThreadWorkContext } = agenticStream._internal;
  const context = buildThreadWorkContext([], 'deseo qeu mejoremos todo el cerebro de la IA de forma profesional y minimalista');

  assert.match(context, /Normalize noisy Spanish\/English internally/);
  assert.match(context, /runtime behavior hardening/);
  assert.match(context, /small verifiable change/);
  assert.match(context, /avoid broad rewrites/);
});

test('runAgenticChat sends expanded thread context to the model', async () => {
  let firstCreateArgs = null;
  const openai = {
    chat: {
      completions: {
        create: async (args) => {
          firstCreateArgs = args;
          return finalizeMessage('Listo.');
        },
      },
    },
  };
  const { res } = makeFakeRes();

  await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'continua con eso',
    history: [
      { role: 'user', content: 'Quiero que cada hilo recuerde la meta completa.' },
      { role: 'assistant', content: 'Entendido.' },
    ],
    res,
  });

  const system = firstCreateArgs.messages.find(m => m.role === 'system')?.content || '';
  assert.match(system, /OpenClaw-Level Runtime Policy/);
  assert.match(system, /Capability Contract/);
  assert.match(system, /ongoing autonomous work session/);
  assert.match(system, /Professional minimal cognition profile/);
  assert.match(system, /cada hilo recuerde la meta completa/);
});

test('runAgenticChat emits sentinel + final answer with a stub tool', async () => {
  const openai = makeFakeOpenAI([
    toolCallMessage('echo', { text: 'hola' }),
    finalizeMessage('La respuesta final, con [fuente](https://ex.com).'),
  ]);
  const { res, frames } = makeFakeRes();

  await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: '¿Hola?',
    history: [],
    res,
    toolsOverride: [{
      name: 'echo',
      description: 'echo back',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (args) => ({ ok: true, echoed: args.text }),
    }],
  });

  const fs = frames();
  // At least one initial sentinel + one final replace.
  const replaces = fs.filter(f => f.replace);
  assert.ok(replaces.length >= 2, `expected ≥2 replace frames, got ${replaces.length}`);
  // Final replace must include the answer text appended after the sentinel.
  const last = replaces[replaces.length - 1];
  assert.match(last.content, /agent-task-state/);
  assert.match(last.content, /La respuesta final/);
});

test('runAgenticChat blocks research finalization until required web_search succeeds', async () => {
  const openai = makeFakeOpenAI([
    finalizeMessage('Respuesta sin buscar.'),
    toolCallMessage('web_search', { query: 'fuentes recientes IA', maxResults: 2 }),
    finalizeMessage('Respuesta con evidencia web.'),
  ]);
  const { res } = makeFakeRes();
  let searchCount = 0;

  const result = await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'Investiga fuentes recientes sobre IA y cita evidencia',
    history: [],
    res,
    maxSteps: 5,
    toolsOverride: [{
      name: 'web_search',
      description: 'search the web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, maxResults: { type: 'integer' } },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async () => {
        searchCount += 1;
        return { ok: true, results: [{ title: 'Fuente', url: 'https://example.com' }] };
      },
    }],
  });

  assert.equal(searchCount, 1);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Respuesta con evidencia web.');
  assert.equal(result.steps[0].actions[0].tool, 'finalize');
  assert.equal(result.steps[0].actions[0].observation.error, 'finalize_guard_failed');
  assert.deepEqual(result.steps[0].actions[0].observation.missingTools, ['web_search']);
});

test('runAgenticChat does not require run_tests for simple test/prueba prompts', async () => {
  const openai = makeFakeOpenAI([
    finalizeMessage('Respuesta simple.'),
  ]);
  const { res } = makeFakeRes();
  let runTestsCount = 0;

  const result = await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'test',
    history: [],
    res,
    maxSteps: 3,
    toolsOverride: [{
      name: 'run_tests',
      description: 'run tests',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        runTestsCount += 1;
        return { ok: true };
      },
    }],
  });

  assert.equal(runTestsCount, 0);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Respuesta simple.');
  assert.notEqual(result.steps[0].actions[0].observation.error, 'finalize_guard_failed');
});

test('runAgenticChat passes request toolContext into tool execution', async () => {
  let seenCtx = null;
  const openai = makeFakeOpenAI([
    toolCallMessage('capture_ctx', {}),
    finalizeMessage('Contexto recibido.'),
  ]);
  const { res } = makeFakeRes();

  await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'usa contexto',
    history: [],
    res,
    toolContext: { userId: 'user-1', chatId: 'chat-1', fileIds: ['file-1'] },
    toolsOverride: [{
      name: 'capture_ctx',
      description: 'capture ctx',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, ctx) => {
        seenCtx = ctx;
        return { ok: true };
      },
    }],
  });

  assert.equal(seenCtx.userId, 'user-1');
  assert.equal(seenCtx.chatId, 'chat-1');
  assert.deepEqual(seenCtx.fileIds, ['file-1']);
  assert.ok('signal' in seenCtx);
});

test('runAgenticChat does not hang when a tool errors', async () => {
  const openai = makeFakeOpenAI([
    toolCallMessage('broken', {}),
    finalizeMessage('Lo intenté pero la herramienta falló.'),
  ]);
  const { res, frames } = makeFakeRes();

  const result = await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'falla?',
    history: [],
    res,
    toolsOverride: [{
      name: 'broken',
      description: 'always throws',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { throw new Error('boom'); },
    }],
  });

  assert.match(result.finalAnswer, /Lo intenté/);
  const fs = frames();
  const last = fs.filter(f => f.replace).pop();
  assert.ok(last, 'expected at least one replace frame');
  assert.match(last.content, /Lo intenté/);
});

test('runAgenticChat caps iterations at maxSteps', async () => {
  // Reply with a tool call forever — runner must stop at maxSteps.
  const infiniteScript = Array.from({ length: 50 }, () =>
    toolCallMessage('echo', { text: 'again' }));
  const openai = makeFakeOpenAI(infiniteScript);
  const { res } = makeFakeRes();

  const t0 = Date.now();
  const result = await agenticStream.runAgenticChat({
    openai,
    model: 'gpt-4o-mini',
    userQuery: 'loop',
    history: [],
    res,
    maxSteps: 3,
    toolsOverride: [{
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async () => ({ ok: true }),
    }],
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 10000, `expected fast cap, took ${elapsed}ms`);
  // Loop ended without an explicit finalize → fallback final answer is set.
  assert.ok(typeof result.finalAnswer === 'string' && result.finalAnswer.length > 0);
});
