# Phase 9A: SSE Stream Parser Hardening

Date: 2026-05-01

## CTO Diagnosis

SiraGPT already has a broad commercial AI surface: chat, model routing, uploads, document preview/generation, RAG, agent tasks, GitHub Codex context, payments, admin, observability and CI gates. The highest-value low-risk gap found in this pass was not a missing product feature, but a reliability seam in several client-side streaming adapters.

Multiple frontend services parsed Server-Sent Events with local string splitting. That works for ideal `data: {...}\n\n` chunks, but it is fragile under real network behavior:

- JSON frames split across TCP chunks.
- SSE comments/heartbeats.
- Multiline `data:` fields.
- `[DONE]` terminal frames.
- Repeated custom parser drift across chat/search/agent/document flows.

For a ChatGPT/Gemini/Claude/Codex/Cursor-class product, streaming must be treated as a shared transport contract.

## Dependency Validation

| Field | Result |
|---|---|
| Package | `eventsource-parser` |
| URL | https://github.com/rexxars/eventsource-parser |
| Version | `3.0.8` |
| License | MIT |
| Runtime dependencies | None |
| Node compatibility | `>=18.0.0` |
| Repository status | Not archived; default branch `main` |
| Recent activity | npm modified 2026-04-19; GitHub pushed 2026-04-28 |
| Popularity | 38,287,252 npm downloads in the last week checked |
| Open issues sample | `0` open issues returned by `gh issue list --limit 1` |
| Lock-in risk | Low; it only parses the SSE wire format and can be replaced by a small adapter |
| License risk | Low; permissive MIT, compatible with commercial core |
| Vulnerability impact | No new critical audit finding introduced; root audit remains at zero critical production vulnerabilities |

Rejected alternatives:

- `EventSource`: cannot send POST bodies or custom Authorization headers, both required by current routes.
- Keeping local split/parsing code: lower dependency count, but higher production failure risk and repeated drift.
- Larger realtime frameworks: unnecessary surface area for the current POST + SSE contract.

## Implementation

Added a shared SSE JSON parser:

- `lib/sse-client.ts`: wraps `eventsource-parser`, emits typed JSON events, ignores malformed frames by default, supports `[DONE]`, abort signals and chunk callbacks.
- `tests/sse-client.test.ts`: covers split chunks, comments, multiline data, malformed JSON recovery and `[DONE]` stop behavior.

Refactored the most exposed client streams to use the shared parser:

- `lib/agent-task-service.ts`
- `lib/agentic-search-service.ts`
- `lib/design-service.ts`
- `lib/marco-teorico-service.ts`
- `lib/api.ts` for web search and web-dev generation streams

No public API route changed. No browser-provided tokens or request-body secrets were introduced.

## Direct Benefit

- More reliable chat/agent streaming under intermittent networks and chunk boundaries.
- Less duplicated transport code across product modules.
- Cleaner future path toward a canonical streaming envelope for chat, agents, artifacts and Codex.
- Better tests around a high-frequency user-facing behavior.

## Risk

Technical risk is low. The parser changes transport framing only; event payload shapes, API endpoints and UI callbacks remain unchanged. The main regression risk is in streams that relied on non-standard malformed frames. The new parser intentionally skips malformed JSON, matching the previous behavior.

## Local Validation

```bash
npm test
npm audit --omit=dev --audit-level=critical
npm run licenses:check
npm run licenses:report
git diff --check
```

Full validation before deploy:

```bash
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
```

Manual smoke:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
open http://127.0.0.1:3000/chat
open http://127.0.0.1:3000/codex
```

## Production Validation

After merge to `main`:

- Confirm GitHub Actions required checks are green.
- Confirm `/chat` streams normal responses without stalls.
- Confirm agent task progress cards keep updating and surface timeout errors if backend goes idle.
- Confirm web search and design/marco generation streams still emit final states.
- Confirm `THIRD_PARTY_LICENSES.md` remains in sync.

## Next Recommended Phase

Phase 9B should standardize the backend streaming envelope across chat, agent, artifact and Codex routes, then add HTTP integration tests for each stream type. That should happen before larger UX changes, because it gives every advanced feature a predictable transport contract.
