# Phase 8F.2: Wire Native Anthropic Provider into the Model Adapter

## Scope

Phase 8F.1 (`docs/phase-8f-anthropic-native.md`) installed
`@anthropic-ai/sdk@0.92.0` and exposed a feature-flagged provider
factory. Nothing in production actually used it yet — the
`backend/src/services/sira/model-adapter.js` adapter still defaulted to
the deterministic stubs from `createDefaultProviders()` whenever a
caller invoked `callUserSelectedModel(args)` without an explicit
`providers` map.

Phase 8F.2 closes the loop. A new `resolveProviders()` helper builds the
provider map from `createDefaultProviders()` and overlays the native
Anthropic implementation when (and only when) the env flag is on. The
default of `callUserSelectedModel` switches from `createDefaultProviders()`
to `resolveProviders()`. Callers that already pass a `providers` map are
not affected; tests that want pure-stub behavior pass
`createDefaultProviders()` explicitly.

## Dependency

No new dependencies. Reuses `@anthropic-ai/sdk@0.92.0` (MIT) introduced
in Phase 8F.1. `npm run licenses:check` re-validated: 1371 packages, all
permissive or allowlisted.

## Changes

- `backend/src/services/sira/model-adapter.js`:
  - Adds `resolveProviders()` which starts from `createDefaultProviders()`,
    then `require`s `../providers/anthropic-native` and overlays the
    native Anthropic provider when `createAnthropicProvider()` returns a
    function. Catches optional-integration load failures so a
    misconfigured host never breaks the adapter.
  - Switches the default of the `providers` argument inside
    `callUserSelectedModel` from `createDefaultProviders()` to
    `resolveProviders()`. Callers that pass `providers` explicitly are
    unaffected.
  - Exports `resolveProviders` alongside `createDefaultProviders`.
- `backend/tests/sira-platform.test.js`:
  - Hardens the existing `default stub dispatches by provider` test so
    it passes `createDefaultProviders()` explicitly. Without this
    override, a developer with `ANTHROPIC_API_KEY` exported in their
    shell would hit the live API. The behavior assertion is unchanged.
- `backend/tests/sira-model-adapter-anthropic-native.test.js` (new):
  six end-to-end wiring cases:
  - `resolveProviders()` falls back to stub when env is missing.
  - `resolveProviders()` swaps the Anthropic stub for the native impl
    when the env flag is set; other providers stay as stubs.
  - `resolveProviders()` keeps the stub when
    `ANTHROPIC_NATIVE_ENABLED=false` even with a key.
  - `callUserSelectedModel` routes through the native provider when env
    is set (asserted via the test seam in `anthropic-native`).
  - `callUserSelectedModel` still uses the stub when env is missing.
  - Explicit `providers` passed by the caller always win, even when the
    env flag is on.

The Anthropic SDK is never actually invoked by the suite. We use the
`_setClientForTests` seam exposed by `anthropic-native.js` to inject a
fake client.

## Behavior change summary

- When `ANTHROPIC_API_KEY` is set and `ANTHROPIC_NATIVE_ENABLED` is not
  `'false'`, calls to `modelAdapter.callUserSelectedModel({...
  selectedModel: { provider: 'anthropic', ...} ...})` without a
  `providers` argument now go to the official Anthropic SDK instead of
  the synthetic stub.
- When the env flag is missing or disabled, behavior is unchanged: the
  stub provider returns the deterministic `[anthropic:<modelId>] ...`
  string, exactly as before 8F.2.
- Other providers (`openai`, `google`, `deepseek`, `xai`, `openrouter`,
  `image_provider`, `video_provider`, `audio_provider`, `custom`) keep
  their stub behavior. Their native wiring is out of scope for this
  phase.
- Callers that pass an explicit `providers` map (notably the model-
  adapter unit tests in
  `backend/tests/sira-model-adapter-instrumentation.test.js` and the
  hardened test in `sira-platform.test.js`) are not affected.
- The chat surface in `backend/src/routes/ai.js` and the OpenRouter
  routing in `backend/src/services/ai-service.js` are untouched. Phase
  8F.3 will route real chat traffic through the native provider with
  streaming support.

## Validation

Local:

```bash
cd backend
node --test tests/sira-model-adapter-anthropic-native.test.js
node --test tests/sira-platform.test.js
node --test tests/sira-model-adapter-migration.test.js tests/sira-model-adapter-instrumentation.test.js tests/anthropic-native-provider.test.js
cd ..
npm run licenses:check
```

Manual smoke (requires a real Anthropic key):

```bash
cd backend
ANTHROPIC_API_KEY=sk-ant-... node -e "
  const adapter = require('./src/services/sira/model-adapter');
  adapter.callUserSelectedModel({
    selectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-6', modality: 'text' },
    systemPrompt: 'Be concise.',
    messages: [{ role: 'user', content: 'Say hi in Spanish.' }],
  }, { instrument: false }).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Production:

- Re-run `npm run licenses:check` and `npm audit --omit=dev
  --audit-level=critical` before merge.
- Confirm GitHub Actions `frontend`, `backend`, `licenses` and
  `CI · required checks passed` are green.
- Set `ANTHROPIC_NATIVE_ENABLED=false` to disable the wiring without
  removing the API key. This is the documented kill switch.

## Roadmap follow-ups

- Phase 8F.3 — extend the provider to support streaming via
  `messages.stream`, mapped onto the same SSE envelope already used by
  the chat router so tab-reload and pending-stream resume keep working.
- Phase 8F.4 — opt-in tool-use / structured-output mode mapped onto the
  internal `tools` payload.
- Phase 8F.5 — wire the chat path in `backend/src/services/ai-service.js`
  to the native provider for `provider === 'anthropic'` calls, replacing
  the OpenRouter compatibility hop. Behind a per-tenant gate.
