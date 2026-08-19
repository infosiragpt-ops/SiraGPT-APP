# Phase 8F: Native Anthropic Provider

## Scope

Phase 8F installs the official `@anthropic-ai/sdk` and exposes it as a
provider compatible with the `providers.anthropic` slot of
`callUserSelectedModel`
(`backend/src/services/sira/model-adapter.js`).

Today the chat path routes Claude through OpenRouter's OpenAI-compatible
surface (see `backend/src/services/ai-service.js` line ~56). That works,
but it loses Claude-specific behavior such as the dedicated `system`
field, structured tool use and the official streaming envelope. This
phase builds the native pipe behind a feature flag so it can be wired
into production callers without touching the OpenRouter fallback.

## Dependency

| Package | Version | License | Notes |
|---|---|---|---|
| `@anthropic-ai/sdk` | `0.92.0` | MIT | Official Anthropic TypeScript SDK. Installed in `backend/`. ESM-only entrypoint; loaded from CommonJS via dynamic `import()`. Validated against npm registry metadata, GitHub Advisory DB and OSV on 2026-05-02. Last npm release ~2026-04-30. |

`@anthropic-ai/sdk` was already part of the Phase 8F plan in
`docs/cto-commercial-ai-ecosystem-roadmap.md`. No GPL/AGPL/LGPL packages
are introduced. `THIRD_PARTY_LICENSES.md` regenerated and now lists
`@anthropic-ai/sdk@0.92.0` under the MIT section (1371 packages, all
permissive or allowlisted).

## Changes

- `backend/src/services/providers/anthropic-native.js` (new): provider
  factory + helpers.
  - `isEnabled()` — returns `true` only when both `ANTHROPIC_API_KEY` is
    present and `ANTHROPIC_NATIVE_ENABLED` is not `'false'`.
  - `createAnthropicProvider()` — returns the call function when
    enabled; returns `null` when disabled so the model adapter falls
    back to the existing stub / OpenRouter path.
  - `callAnthropic(payload)` — provider implementation matching the
    `callUserSelectedModel` contract:
    `{ selectedModel, systemPrompt, messages, responseFormat }` →
    `{ text, parsed, usage, raw }`.
  - `toAnthropicMessages(messages)` — strips non `user`/`assistant`
    roles (Anthropic uses a separate `system` field) and serializes
    non-string content.
  - `extractText(content)` — concatenates `type: 'text'` content blocks
    only, ignoring tool-use blocks.
  - `_setClientForTests` / `_resetClientForTests` — test seams so the
    unit suite can inject a fake client without hitting the real API.
- `backend/.env.example`: documents `ANTHROPIC_NATIVE_ENABLED=true` and
  `ANTHROPIC_NATIVE_MAX_TOKENS=4096`.
- `backend/tests/anthropic-native-provider.test.js` (new): 12 cases
  covering env gating, factory return values, message/role
  translation, text extraction, JSON parsing for `responseFormat`,
  disabled-state error and SDK error propagation.
- `backend/package.json` + `backend/package-lock.json`: declares
  `@anthropic-ai/sdk@^0.92.0`.
- `THIRD_PARTY_LICENSES.md`: regenerated.

## Behavior change summary

- **Default behavior is unchanged.** `model-adapter.js` is not modified
  in this phase. The new module is a building block that production
  wiring can opt into by passing
  `providers: { ...createDefaultProviders(), anthropic:
  createAnthropicProvider() }` to `callUserSelectedModel` when the
  factory returns a non-null function.
- The OpenRouter compatibility path for Claude in `ai-service.js`
  remains the active surface for the chat UI. A follow-up phase will
  wire the native provider into the chat path with explicit
  observability and a circuit-breaker hook.
- Tool use, streaming and multimodal Claude calls are deliberately out
  of scope for 8F. The Phase 8F provider is text-only and synchronous;
  it returns the full assistant message in one call.

## Validation

Local:

```bash
cd backend
node --test tests/anthropic-native-provider.test.js
node -e "require('./src/services/providers/anthropic-native'); console.log('module loads OK')"
cd ..
npm run licenses:check
```

Manual smoke (requires a real Anthropic key):

```bash
ANTHROPIC_API_KEY=sk-ant-... node -e "
  const p = require('./backend/src/services/providers/anthropic-native');
  const fn = p.createAnthropicProvider();
  if (!fn) throw new Error('disabled');
  fn({
    selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    systemPrompt: 'Be concise.',
    messages: [{ role: 'user', content: 'Say hi in Spanish.' }],
  }).then(out => console.log(JSON.stringify(out, null, 2)));
"
```

Production:

- Re-run `npm run licenses:check` and `npm audit --omit=dev
  --audit-level=critical` before merge.
- Confirm GitHub Actions `frontend`, `backend`, `licenses` and
  `CI · required checks passed` are green.
- Setting `ANTHROPIC_API_KEY` alone does not change runtime behavior;
  callers must explicitly opt in to the new provider. The next phase
  will close that loop with a single wiring point in production.

## Roadmap follow-ups

- Phase 8F.2 — wire the native provider into the chat path behind a
  per-tenant or per-model gate, with the LiteLLM gateway recording
  metrics + circuit-breaker state for the `anthropic` provider.
- Phase 8F.3 — extend the provider to support streaming
  (`messages.stream`) + the same SSE envelope already used by the chat
  router so tab-reload / pending-stream resume keeps working.
- Phase 8F.4 — opt-in tool-use / structured-output mode mapped onto our
  internal `tools` payload.
