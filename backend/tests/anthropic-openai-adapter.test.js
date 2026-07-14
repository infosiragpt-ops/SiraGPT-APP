'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createAnthropicOpenAIAdapter,
  toAnthropicTranscript,
  toAnthropicTools,
  toOpenAICompletion,
} = require('../src/services/providers/anthropic-openai-adapter');
const reactAgent = require('../src/services/react-agent');

test('translates system, assistant tool calls and paired tool results', () => {
  const out = toAnthropicTranscript([
    { role: 'system', content: 'Use evidence.' },
    { role: 'user', content: 'Find papers.' },
    {
      role: 'assistant',
      content: 'I will search.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_skill', arguments: '{"skillId":"openalex_search"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"items":[1,2]}' },
    { role: 'tool', tool_call_id: 'call_2', content: 'second result' },
  ]);

  assert.equal(out.system, 'Use evidence.');
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[1].content[1].type, 'tool_use');
  assert.deepEqual(out.messages[1].content[1].input, { skillId: 'openalex_search' });
  assert.equal(out.messages[2].role, 'user');
  assert.equal(out.messages[2].content.length, 2, 'consecutive tool results are coalesced');
  assert.equal(out.messages[2].content[0].type, 'tool_result');
  assert.equal(out.messages[2].content[0].tool_use_id, 'call_1');
});

test('projects OpenAI tools to Anthropic input schemas', () => {
  const tools = toAnthropicTools([{
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Create a file',
      parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
    },
  }]);
  assert.equal(tools[0].name, 'create_document');
  assert.equal(tools[0].input_schema.required[0], 'filename');
});

test('maps native tool_use blocks and token usage to OpenAI completion shape', () => {
  const out = toOpenAICompletion({
    id: 'msg_123',
    model: 'claude-fable-5',
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Searching.' },
      { type: 'tool_use', id: 'tu_1', name: 'run_skill', input: { skillId: 'crossref_verify' } },
    ],
    usage: { input_tokens: 120, output_tokens: 30 },
  }, 'claude-fable-5');

  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'run_skill');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"skillId":"crossref_verify"}');
  assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
});

test('adapter calls Anthropic with native forced tool choice and preserves abort signal', async () => {
  let capturedRequest = null;
  let capturedOptions = null;
  const client = {
    messages: {
      create: async (request, options) => {
        capturedRequest = request;
        capturedOptions = options;
        return {
          id: 'msg_done', model: request.model, stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 4, output_tokens: 2 },
        };
      },
    },
  };
  const adapter = createAnthropicOpenAIAdapter({ client, maxTokens: 777 });
  const signal = new AbortController().signal;
  const result = await adapter.chat.completions.create({
    model: 'claude-fable-5',
    messages: [{ role: 'system', content: 'Agent.' }, { role: 'user', content: 'Research.' }],
    tools: [{ type: 'function', function: { name: 'run_skill', parameters: { type: 'object', properties: {} } } }],
    tool_choice: { type: 'function', function: { name: 'run_skill' } },
    parallel_tool_calls: true,
    temperature: 0.3,
  }, { signal });

  assert.equal(capturedRequest.model, 'claude-fable-5');
  assert.equal(capturedRequest.max_tokens, 777);
  assert.equal(capturedRequest.tool_choice.type, 'tool');
  assert.equal(capturedRequest.tool_choice.name, 'run_skill');
  assert.equal(capturedRequest.tool_choice.disable_parallel_tool_use, true);
  assert.equal('temperature' in capturedRequest, false, 'Claude 5 rejects temperature');
  assert.equal(capturedOptions.signal, signal);
  assert.equal(result.choices[0].message.content, 'Done.');
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('adapter retries once without temperature when Anthropic deprecates it for a new alias', async () => {
  const requests = [];
  const client = {
    messages: {
      create: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          const error = new Error('`temperature` is deprecated for this model.');
          error.status = 400;
          throw error;
        }
        return {
          id: 'msg_retry', model: request.model, stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Recovered.' }], usage: {},
        };
      },
    },
  };
  const adapter = createAnthropicOpenAIAdapter({ client });

  const result = await adapter.chat.completions.create({
    model: 'claude-future-reasoner',
    messages: [{ role: 'user', content: 'Continue.' }],
    temperature: 0.2,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].temperature, 0.2);
  assert.equal('temperature' in requests[1], false);
  assert.equal(result.choices[0].message.content, 'Recovered.');
});

test('native Claude adapter drives a multi-step skill and multi-artifact ReAct run', async () => {
  const requests = [];
  let turn = 0;
  const client = {
    messages: {
      create: async (request) => {
        requests.push(request);
        turn += 1;
        if (turn === 1) {
          return {
            id: 'm1', model: request.model, stop_reason: 'tool_use', usage: {},
            content: [{ type: 'tool_use', id: 'skill_1', name: 'run_skill', input: { skillId: 'openalex_search' } }],
          };
        }
        if (turn === 2) {
          return {
            id: 'm2', model: request.model, stop_reason: 'tool_use', usage: {},
            content: [
              { type: 'tool_use', id: 'doc_1', name: 'create_document', input: { filename: 'report.docx' } },
              { type: 'tool_use', id: 'doc_2', name: 'create_document', input: { filename: 'report.pdf' } },
            ],
          };
        }
        return {
          id: 'm3', model: request.model, stop_reason: 'tool_use', usage: {},
          content: [{ type: 'tool_use', id: 'done_1', name: 'finalize', input: { answer: 'Two verified files are ready.' } }],
        };
      },
    },
  };
  const adapter = createAnthropicOpenAIAdapter({ client });
  const executed = [];
  const tools = [
    {
      name: 'run_skill', description: 'Run a skill',
      parameters: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] },
      execute: async (args) => { executed.push(['run_skill', args.skillId]); return { ok: true, papers: 2 }; },
    },
    {
      name: 'create_document', description: 'Create an artifact',
      parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
      execute: async (args) => { executed.push(['create_document', args.filename]); return { ok: true, id: args.filename }; },
    },
  ];

  const result = await reactAgent.run(adapter, {
    query: 'Research and create Word and PDF files.',
    tools,
    model: 'claude-fable-5',
    maxSteps: 4,
    initialToolChoice: 'run_skill',
    toolCallMode: 'native',
    parallelToolCalls: true,
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Two verified files are ready.');
  assert.deepEqual(executed, [
    ['run_skill', 'openalex_search'],
    ['create_document', 'report.docx'],
    ['create_document', 'report.pdf'],
  ]);
  assert.equal(requests[0].tool_choice.name, 'run_skill');
  assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, 'skill_1');
  assert.equal(requests[2].messages.at(-1).content.length, 2, 'both artifact results return in one Anthropic user turn');
});

test('ai route wires direct Anthropic through the native adapter', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(route, /provider === ["']Anthropic["'][\s\S]{0,240}createAnthropicOpenAIAdapter/);
  assert.match(route, /const agenticToolOpenAI = actualProvider === 'Anthropic'/);
});
