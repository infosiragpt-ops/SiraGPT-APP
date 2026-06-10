---
name: OpenRouter default max_tokens
description: OpenRouter uses the model's full context max (65536+) when max_tokens is absent; always send an explicit cap.
---

## Rule
`buildProviderChatPayload` in `litellm-gateway.js` calls `applyMaxTokens(payload, maxOutputTokens, runtime)`. When `maxOutputTokens` is `undefined` / `0`, the function skips the field entirely. OpenRouter then defaults to the model's theoretical max output (e.g. 65536 for glm-5.1/grok-4.20, 384000 for deepseek-v4-pro), which exhausts low-credit accounts and triggers 402 errors.

**Why:** OpenRouter charges per token generated; a missing max_tokens means the model can run to its full capacity even for short replies.

**How to apply:**
- In every call to `buildProviderChatPayload` in `ai-service.js`, always pass:
  ```js
  maxOutputTokens: Math.min(getCompletionLimit(model), 16384)
  ```
- Import `getCompletionLimit` from `./context-window`.
- 16384 is a safe per-turn ceiling — covers 99% of chat replies without wasteful reservation.
- If a specific feature genuinely needs longer output (e.g. document generation), pass a higher explicit cap at the call site.
