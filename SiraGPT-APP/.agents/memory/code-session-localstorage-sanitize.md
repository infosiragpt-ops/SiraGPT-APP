---
name: /code localStorage session sanitization
description: Why persisted code-chat sessions must be deep-sanitized on load, and what to do when adding a rendered field.
---

# /code persisted sessions are untrusted — deep-sanitize on load

`lib/code-chat-sessions.ts` `loadStore()` reads code-chat sessions from
`localStorage`. Entries can be written by an OLDER build and be malformed
(null array elements, missing `kind`, object-valued `phase.detail`). The
render code (`ai-code-chat-panel.tsx`: `ChatActionLog`, `CodeAgentProgress`)
assumes well-formed arrays, so a single bad entry throws and the WHOLE /code
page crashes to the route error boundary ("Algo salió mal").

**Rule:** any field of a persisted turn/phase/action that gets RENDERED must be
validated/coerced in `sanitizeTurn`/`sanitizeSession`. Rebuild clean objects
(don't passthrough raw): coerce `content`/`phase.detail` to string-or-drop,
validate `role`/`status`, keep unknown action `kind` (glyphForAction falls back
to ">_"). Invalid turns/sessions are dropped, not crashed on.

**Why:** localStorage is a trust boundary the same way a network payload is;
"it was valid when we wrote it" is false across builds.

**How to apply:** when you add a new rendered field to `CodeChatTurn`,
`CodeAgentPhase`, or `CodeChatAction`, extend the sanitizer in lockstep.
Defense in depth: each `<ChatBubble>` is also wrapped in
`components/code/code-chat-error-boundary.tsx` (per-turn boundary), and route
render crashes are reported to `/api/telemetry/error` via `reportClientLog`
(see `lib/client-logs.ts`) — error.tsx otherwise recorded nothing.
