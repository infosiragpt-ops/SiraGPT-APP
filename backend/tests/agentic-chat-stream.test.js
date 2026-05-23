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

test('isEnabled reads AGENTIC_TOOLS_IN_CHAT at runtime', () => {
  const prev = process.env.AGENTIC_TOOLS_IN_CHAT;
  process.env.AGENTIC_TOOLS_IN_CHAT = '';
  assert.equal(agenticStream.isEnabled(), false);
  process.env.AGENTIC_TOOLS_IN_CHAT = '1';
  assert.equal(agenticStream.isEnabled(), true);
  process.env.AGENTIC_TOOLS_IN_CHAT = 'true';
  assert.equal(agenticStream.isEnabled(), true);
  process.env.AGENTIC_TOOLS_IN_CHAT = 'no';
  assert.equal(agenticStream.isEnabled(), false);
  if (prev === undefined) delete process.env.AGENTIC_TOOLS_IN_CHAT;
  else process.env.AGENTIC_TOOLS_IN_CHAT = prev;
});

test('modelSupportsFunctionCalling allowlist', () => {
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'gpt-4o-mini'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'gpt-4.1'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'gpt-5'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Gemini', 'gemini-2.5-pro'), true);
  assert.equal(agenticStream.modelSupportsFunctionCalling('OpenAI', 'davinci-002'), false);
  assert.equal(agenticStream.modelSupportsFunctionCalling('Anthropic', 'claude-3-opus'), false);
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
