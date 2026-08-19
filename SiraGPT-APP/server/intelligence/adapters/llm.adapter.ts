/**
 * server/intelligence/adapters/llm.adapter.ts
 *
 * The one true IO seam: an LlmClient backed by the OpenAI-compatible SDK,
 * pointed at the right provider base URL exactly as the backend does. Provider
 * resolution reuses the backend's `inferProviderFromModelId` so a bare model id
 * (e.g. `anthropic/claude-…`) routes to the correct endpoint.
 *
 * Streaming maps `choices[0].delta.content` chunks to the port's `onChunk`.
 * Provider-side prompt caching is enabled by sending the stable system prefix
 * as the first system message (providers that support automatic caching, like
 * OpenRouter/Anthropic, benefit without any extra wiring).
 *
 * Dependency-injectable (`OpenAICtor`, `env`, `inferProvider`) so it is fully
 * unit-testable without any network. Fail-closed on *use* (throws) but the
 * composition root only wires it when a key is configured, otherwise the echo
 * client is used.
 */

import type { ChatMessage } from '../ports/common';
import type { LlmChunk, LlmClient, LlmRequest, LlmResult, TokenUsage } from '../ports';
import { loadBackendModule, loadNodeModule } from './backend-bridge';

/** Minimal structural type of the `openai` SDK client we use. */
export interface OpenAILike {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ): Promise<AsyncIterable<OpenAIStreamChunk> | OpenAICompletion>;
    };
  };
}

export type OpenAICtor = new (config: Record<string, unknown>) => OpenAILike;

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
}

interface OpenAICompletion {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface ProviderInferenceModuleLike {
  inferProviderFromModelId?: (id: string) => string;
}

interface ProviderConfig {
  baseURL?: string;
  apiKey: string | undefined;
  defaultHeaders?: Record<string, string>;
}

export interface BackendLlmDeps {
  readonly OpenAICtor?: OpenAICtor | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly inferProvider?: (id: string) => string;
}

function providerConfig(provider: string, env: NodeJS.ProcessEnv): ProviderConfig {
  const p = provider.toLowerCase();
  switch (p) {
    case 'openrouter':
    case 'anthropic':
    case 'groq':
    case 'mistral':
      return {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY,
        defaultHeaders: {
          'HTTP-Referer': env.NEXT_PUBLIC_URL || env.FRONTEND_URL || 'https://siragpt.com',
          'X-Title': 'SiraGPT',
        },
      };
    case 'gemini':
    case 'google':
      return {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_AI_API_KEY,
      };
    case 'deepseek':
      return { baseURL: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY };
    case 'cerebras':
      return { baseURL: env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1', apiKey: env.CEREBRAS_API_KEY };
    case 'openai':
    default:
      return { apiKey: env.OPENAI_API_KEY };
  }
}

function toApiMessages(messages: ReadonlyArray<ChatMessage>): Array<{ role: string; content: string }> {
  return messages
    .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<OpenAIStreamChunk> {
  return value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

export class LlmNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`no API key configured for provider "${provider}"`);
    this.name = 'LlmNotConfiguredError';
  }
}

export function createBackendLlmClient(deps: BackendLlmDeps = {}): LlmClient {
  const env = deps.env ?? process.env;
  const OpenAICtor =
    deps.OpenAICtor ?? loadNodeModule<{ default?: OpenAICtor } | OpenAICtor>('openai');
  const inferProvider =
    deps.inferProvider ??
    loadBackendModule<ProviderInferenceModuleLike>(
      'backend/src/services/ai/provider-inference'
    )?.inferProviderFromModelId;

  function resolveCtor(): OpenAICtor {
    const ctor = (OpenAICtor as { default?: OpenAICtor })?.default ?? (OpenAICtor as OpenAICtor);
    if (typeof ctor !== 'function') {
      throw new Error('openai SDK is not available');
    }
    return ctor;
  }

  function clientFor(req: LlmRequest): { client: OpenAILike; provider: string } {
    let provider = req.provider && req.provider !== 'unknown' ? req.provider : '';
    if (!provider && inferProvider) {
      try {
        provider = inferProvider(req.model) || 'OpenAI';
      } catch {
        provider = 'OpenAI';
      }
    }
    if (!provider) provider = 'OpenAI';

    const cfg = providerConfig(provider, env);
    if (!cfg.apiKey) throw new LlmNotConfiguredError(provider);
    const Ctor = resolveCtor();
    const client = new Ctor({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
    });
    return { client, provider };
  }

  function buildBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toApiMessages(req.messages),
      stream,
    };
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;
    return body;
  }

  function usageFrom(completion: OpenAICompletion | undefined, fallbackOut: number, fallbackIn: number): TokenUsage {
    const u = completion?.usage;
    const inputTokens = u?.prompt_tokens ?? fallbackIn;
    const outputTokens = u?.completion_tokens ?? fallbackOut;
    return {
      inputTokens,
      outputTokens,
      totalTokens: u?.total_tokens ?? inputTokens + outputTokens,
    };
  }

  async function complete(req: LlmRequest): Promise<LlmResult> {
    const { client } = clientFor(req);
    const res = (await client.chat.completions.create(buildBody(req, false), {
      signal: req.signal,
    })) as OpenAICompletion;
    const content = res.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: req.model,
      finishReason: res.choices?.[0]?.finish_reason ?? 'stop',
      usage: usageFrom(res, content.length / 4, 0),
    };
  }

  async function stream(
    req: LlmRequest,
    onChunk: (chunk: LlmChunk) => void | Promise<void>
  ): Promise<LlmResult> {
    const { client } = clientFor(req);
    const out = await client.chat.completions.create(buildBody(req, true), {
      signal: req.signal,
    });

    let content = '';
    let finishReason = 'stop';
    if (isAsyncIterable(out)) {
      for await (const chunk of out) {
        if (req.signal?.aborted) break;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason as string;
        if (delta) {
          content += delta;
          await onChunk({ content: delta });
        }
      }
      await onChunk({ done: true });
    } else {
      // Provider ignored stream flag — treat as a single completion.
      const completion = out as OpenAICompletion;
      content = completion.choices?.[0]?.message?.content ?? '';
      if (content) await onChunk({ content });
      await onChunk({ done: true });
    }

    return {
      content,
      model: req.model,
      finishReason,
      usage: { inputTokens: 0, outputTokens: Math.ceil(content.length / 4) },
    };
  }

  return { complete, stream };
}
