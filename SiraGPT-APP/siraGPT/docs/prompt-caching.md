# Prompt Caching in siraGPT

This document describes provider-side prompt caching usage, where it
already exists in the codebase, and best practices for new code paths.

## TL;DR

| Provider | Cache mechanism | Used in siraGPT? |
|----------|-----------------|------------------|
| Anthropic | `cache_control: { type: 'ephemeral' }` on a content block | Yes — RAG contextual chunking |
| OpenAI | Automatic on prompts >= 1024 tokens (gpt-4o family, gpt-4.1, etc.) | Yes — implicit; no client opt-in needed |
| Gemini | `cached_content` resources | No (planned) |
| DeepSeek | Automatic on identical prefixes | Yes — implicit |
| OpenRouter | Provider-dependent | Yes — passes through automatically |

## Existing implementations

### `backend/src/services/rag/contextual-chunking.js`
Uses Anthropic's `cache_control: { type: 'ephemeral' }` annotation on
the system block so the long source document only counts as
cache-creation cost on the first chunk and as cache-read cost on every
subsequent chunk. Returns a `usage` envelope with
`cache_read_input_tokens` and `cache_creation_input_tokens` so the
caller can verify the cache is being hit.

### `backend/src/services/cache/llm-response-cache.js`
*Not* a provider prompt cache — it's an exact-match prompt -> response
cache local to siraGPT, useful for deterministic prompts (e.g. fixed
classifier templates). Read-through with TTL eviction. Hits skip the
provider entirely.

### `backend/src/services/rag-service.js`
Aggregates the contextual-chunking cache usage into the ingest envelope
so downstream observability can report cache effectiveness alongside
ingest cost.

## Anthropic prompt cache (recommended for long system prompts)

```js
const resp = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  system: [
    {
      type: 'text',
      text: LONG_PROMPT,                       // >= 1024 tokens
      cache_control: { type: 'ephemeral' },    // 5-minute TTL
    },
  ],
  messages: [{ role: 'user', content: query }],
});

console.log('cache read =',     resp.usage.cache_read_input_tokens);
console.log('cache creation =', resp.usage.cache_creation_input_tokens);
console.log('uncached =',       resp.usage.input_tokens);
```

Constraints (Anthropic):
- Minimum 1024 tokens for sonnet/opus, 2048 for haiku.
- TTL is 5 minutes by default; gets refreshed on each cache hit.
- Up to 4 cache breakpoints per request (annotate up to 4 blocks).
- Each unique cache_control breakpoint gets its own cache key.

## OpenAI prompt cache

Automatic on supported models (gpt-4o, gpt-4o-mini, gpt-4.1, o1-*) for
prompts >= 1024 tokens. No client-side opt-in needed; the API silently
caches the longest common prefix shared with a recent request from the
same organization.

Visible in `completion.usage.prompt_tokens_details.cached_tokens`.

```js
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: LONG_SYSTEM_PROMPT },  // > 1024 tok
    { role: 'user', content: query },
  ],
});

console.log('cached =', completion.usage.prompt_tokens_details?.cached_tokens || 0);
```

Best practice: keep the system prompt and any large tool definitions
at the *top* of the messages array and append the dynamic user message
last. The cache is prefix-based, so any change before the user message
invalidates the cached prefix.

## Best practices for new code

1. **Stable prefix, variable suffix.** Put deterministic content
   (system prompt, tool schemas, RAG context) first. Append the
   user-specific portion last.
2. **Don't interleave dynamic data with the stable prefix.** A
   timestamp inserted between the system prompt and the tool schemas
   will bust the cache on every request.
3. **Measure cache hit rate.** Log `cache_read_input_tokens` (Anthropic)
   or `cached_tokens` (OpenAI) and surface it in `cost-tracker` for
   trend analysis. A healthy chat flow should see > 60% cache reads
   after the first user message.
4. **Long-lived system prompts only.** For Anthropic, the prompt must
   exceed the model's minimum cacheable size (1024 / 2048 tok).
   Shorter prompts get no benefit.
5. **Pricing.** Cache reads are ~10% of normal input price (Anthropic),
   ~50% of normal input price (OpenAI gpt-4o). Cache creation is at
   normal input price (OpenAI) or 1.25× input price (Anthropic).

## Upgrade path

- Wire `cache_control` into every long system-prompt call site in
  `backend/src/routes/ai.js`. Today only `rag/contextual-chunking.js`
  uses it.
- Surface `cached_tokens` in `cost-tracker.track()` so the admin
  cost report can show effective spend after caching.
- Add a Gemini `cached_content` integration for the chat path when we
  ship Gemini long-context generations.
