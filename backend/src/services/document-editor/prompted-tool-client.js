'use strict';

/**
 * Prompted tool-calling adapter for the document editor.
 *
 * The doc-agent loop speaks OpenAI `tools` / `tool_calls`. A few chat
 * transports in this backend do not carry that envelope end to end (see
 * agent-harness/model-capabilities `supportsNativeToolTransport`). This wraps
 * such a client so the SAME loop still runs on the model the user picked:
 * tools are described in the system prompt, the transcript is made
 * provider-safe, and fenced ```tool_call blocks are parsed back into
 * `tool_calls`. A `finalize` call becomes the loop's plain final answer.
 */

const {
  buildPromptedToolsBlock,
  parsePromptedToolCalls,
  toPromptedTranscript,
} = require('../agents/prompted-tool-calling');

const FINALIZE_TOOL = Object.freeze({
  name: 'finalize',
  description: 'Deliver the final answer once the edited file is saved in /workspace/outputs and verified.',
  parameters: {
    type: 'object',
    properties: { answer: { type: 'string', description: 'Short summary of the changes, in the user language' } },
    required: ['answer'],
  },
});

function toRegistry(tools) {
  const registry = (Array.isArray(tools) ? tools : [])
    .map((tool) => tool && tool.function)
    .filter((fn) => fn && fn.name)
    .map((fn) => ({ name: fn.name, description: fn.description || '', parameters: fn.parameters || {} }));
  return [...registry, FINALIZE_TOOL];
}

function withToolsBlock(messages, block) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  const index = out.findIndex((message) => message && message.role === 'system');
  if (index >= 0) {
    out[index] = { ...out[index], content: `${String(out[index].content || '')}\n\n${block}` };
  } else {
    out.unshift({ role: 'system', content: block });
  }
  return out;
}

function parseArguments(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function createPromptedToolClient(client) {
  if (!client?.chat?.completions?.create) throw new Error('createPromptedToolClient: client is required');
  return {
    chat: {
      completions: {
        async create(payload = {}, requestOptions) {
          const { tools, tool_choice: _toolChoice, messages, ...rest } = payload;
          const registry = toRegistry(tools);
          const names = new Set(registry.map((tool) => tool.name));
          const transcript = withToolsBlock(toPromptedTranscript(messages), buildPromptedToolsBlock(registry));
          const response = await client.chat.completions.create({ ...rest, messages: transcript }, requestOptions);
          const choice = response?.choices?.[0] || {};
          const content = String(choice.message?.content || '');
          const { toolCalls, cleanedContent } = parsePromptedToolCalls(content, names);
          const finalize = toolCalls.find((call) => call.function.name === 'finalize');
          const message = finalize
            ? { role: 'assistant', content: String(parseArguments(finalize.function.arguments).answer || cleanedContent || '') }
            : toolCalls.length
              ? { role: 'assistant', content: cleanedContent || null, tool_calls: toolCalls }
              : { role: 'assistant', content: cleanedContent };
          return { ...response, choices: [{ ...choice, message }] };
        },
      },
    },
  };
}

module.exports = { createPromptedToolClient, FINALIZE_TOOL };
