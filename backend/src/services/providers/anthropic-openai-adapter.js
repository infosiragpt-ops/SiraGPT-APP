'use strict';

/**
 * OpenAI-compatible facade over Anthropic's native Messages API.
 *
 * The interactive ReAct loop speaks `chat.completions.create()` and persists
 * OpenAI-shaped assistant/tool messages. Direct Claude models cannot be sent
 * to api.openai.com, so this adapter translates the loop transcript and native
 * `tool_use` blocks in both directions while keeping the loop provider-agnostic.
 */

const DEFAULT_MAX_TOKENS = Number(process.env.ANTHROPIC_AGENT_MAX_TOKENS) || 16384;
const modelsWithoutTemperature = new Set();

let sdkClassPromise = null;

function safeJson(value, fallback = '') {
  try { return JSON.stringify(value); }
  catch { return fallback; }
}

function contentAsText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return safeJson(content, String(content));

  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { raw_arguments: raw };
  }
}

function appendTurn(turns, role, blocks) {
  const clean = (Array.isArray(blocks) ? blocks : []).filter(Boolean);
  if (clean.length === 0) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(...clean);
    return;
  }
  turns.push({ role, content: clean });
}

function textBlocks(content) {
  const text = contentAsText(content);
  return text ? [{ type: 'text', text }] : [];
}

/** Convert an OpenAI transcript into Anthropic's strict role/block format. */
function toAnthropicTranscript(messages) {
  const systemParts = [];
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system') {
      const text = contentAsText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === 'assistant') {
      const blocks = textBlocks(message.content);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call && call.function;
        if (!fn || !fn.name) continue;
        blocks.push({
          type: 'tool_use',
          id: String(call.id || `tool_${turns.length}_${blocks.length}`),
          name: String(fn.name),
          input: parseToolArguments(fn.arguments),
        });
      }
      appendTurn(turns, 'assistant', blocks);
      continue;
    }

    if (message.role === 'tool') {
      const toolUseId = String(message.tool_call_id || '').trim();
      const text = contentAsText(message.content);
      if (toolUseId) {
        appendTurn(turns, 'user', [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: text || 'Tool completed successfully with no textual output.',
        }]);
      } else if (text) {
        appendTurn(turns, 'user', [{ type: 'text', text: `[Tool result]\n${text}` }]);
      }
      continue;
    }

    if (message.role === 'user' || message.role === 'function') {
      appendTurn(turns, 'user', textBlocks(message.content));
    }
  }

  if (turns.length === 0 || turns[0].role !== 'user') {
    turns.unshift({ role: 'user', content: [{ type: 'text', text: 'Continua con la tarea solicitada.' }] });
  }

  return {
    system: systemParts.join('\n\n'),
    messages: turns,
  };
}

function toAnthropicTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const fn = tool && (tool.function || tool);
    if (!fn || !fn.name) return null;
    return {
      name: String(fn.name),
      description: typeof fn.description === 'string' ? fn.description : '',
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    };
  }).filter(Boolean);
}

function toAnthropicToolChoice(choice) {
  if (!choice || choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return null;
  if (typeof choice === 'object' && choice.type === 'function' && choice.function?.name) {
    return { type: 'tool', name: String(choice.function.name), disable_parallel_tool_use: true };
  }
  return { type: 'auto' };
}

function mapStopReason(reason, hasToolCalls) {
  if (hasToolCalls || reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'pause_turn') return 'stop';
  return reason || 'stop';
}

function modelRejectsTemperature(model) {
  const clean = String(model || '').trim().toLowerCase();
  if (!clean) return false;
  if (modelsWithoutTemperature.has(clean)) return true;
  // Claude 5 reasoning models reject sampling controls instead of ignoring
  // them. Keep aliases explicit so older Claude families still honour a
  // custom GPT's configured temperature.
  return /^claude-(?:fable|opus|sonnet|haiku)-5(?:[-.]|$)/.test(clean);
}

function isDeprecatedTemperatureError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || error?.error?.message || '');
  return status === 400
    && /temperature/i.test(message)
    && /deprecated|not supported|unsupported|not allowed/i.test(message);
}

/** Convert a native Anthropic message into an OpenAI chat completion. */
function toOpenAICompletion(response, requestedModel) {
  const text = [];
  const toolCalls = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block?.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: String(block.id || `call_${toolCalls.length}`),
        type: 'function',
        function: {
          name: String(block.name),
          arguments: safeJson(block.input && typeof block.input === 'object' ? block.input : {}, '{}'),
        },
      });
    }
  }

  const promptTokens = Number(response?.usage?.input_tokens) || 0;
  const completionTokens = Number(response?.usage?.output_tokens) || 0;
  return {
    id: response?.id || null,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response?.model || requestedModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text.join('\n').trim(),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapStopReason(response?.stop_reason, toolCalls.length > 0),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function loadSdkClass() {
  if (!sdkClassPromise) {
    sdkClassPromise = import('@anthropic-ai/sdk').then((mod) => {
      const Sdk = mod.default || mod.Anthropic;
      if (typeof Sdk !== 'function') throw new Error('@anthropic-ai/sdk did not export a constructor');
      return Sdk;
    });
  }
  return sdkClassPromise;
}

function createAnthropicOpenAIAdapter({
  apiKey = process.env.ANTHROPIC_API_KEY,
  client: injectedClient = null,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  let client = injectedClient;

  async function getClient() {
    if (client) return client;
    const cleanKey = String(apiKey || '').trim();
    if (!cleanKey) {
      const error = new Error('Anthropic provider is not configured');
      error.code = 'anthropic_api_key_missing';
      throw error;
    }
    const Sdk = await loadSdkClass();
    client = new Sdk({ apiKey: cleanKey });
    return client;
  }

  return {
    __siraProvider: 'Anthropic',
    chat: {
      completions: {
        async create(payload = {}, requestOptions = {}) {
          if (payload.stream) {
            const error = new Error('Anthropic agent adapter does not expose streaming completions');
            error.code = 'anthropic_agent_stream_unsupported';
            throw error;
          }

          const model = String(payload.model || '').trim();
          if (!model) throw new Error('Anthropic agent adapter requires a model');
          const transcript = toAnthropicTranscript(payload.messages);
          const tools = toAnthropicTools(payload.tools);
          const toolChoice = tools.length ? toAnthropicToolChoice(payload.tool_choice) : null;
          const request = {
            model,
            max_tokens: Number(payload.max_tokens) > 0 ? Number(payload.max_tokens) : maxTokens,
            messages: transcript.messages,
            ...(transcript.system ? { system: transcript.system } : {}),
            ...(tools.length ? { tools } : {}),
            ...(toolChoice ? { tool_choice: toolChoice } : {}),
            ...(!modelRejectsTemperature(model) && Number.isFinite(Number(payload.temperature))
              ? { temperature: Number(payload.temperature) }
              : {}),
            ...(Array.isArray(payload.stop) ? { stop_sequences: payload.stop } : {}),
          };

          const sdk = await getClient();
          const options = requestOptions?.signal ? { signal: requestOptions.signal } : undefined;
          let response;
          try {
            response = await sdk.messages.create(request, options);
          } catch (error) {
            // Anthropic can deprecate sampling controls per model before a
            // stable alias is known to this service. Retry once without the
            // rejected field, then remember the capability for this process.
            if (!Object.prototype.hasOwnProperty.call(request, 'temperature') || !isDeprecatedTemperatureError(error)) {
              throw error;
            }
            modelsWithoutTemperature.add(model.toLowerCase());
            const compatibleRequest = { ...request };
            delete compatibleRequest.temperature;
            response = await sdk.messages.create(compatibleRequest, options);
          }
          return toOpenAICompletion(response, model);
        },
      },
    },
  };
}

module.exports = {
  createAnthropicOpenAIAdapter,
  toAnthropicTranscript,
  toAnthropicTools,
  toAnthropicToolChoice,
  toOpenAICompletion,
  mapStopReason,
  modelRejectsTemperature,
  isDeprecatedTemperatureError,
};
