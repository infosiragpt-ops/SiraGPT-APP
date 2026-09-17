# Document release: authenticated follow-up regression

The first publication of PR #563 was externally healthy at
`2ed317307bff5255b3ad8bcb88ec47fdee063520`. A subsequent authenticated test
on `/agentes` exposed a failure not covered by its direct-adapter Linux smoke.
This report deliberately separates publication health from functional evidence.

## Reproduction and boundaries

The test uploaded a synthetic 11-slide presentation and sent:

> En siragpt-release-pr563-original.pptx, cambia el título de la primera diapositiva a "Historia de los Dinosaurios de 1998".

The title parser treated the source/location comma as a second instruction,
declined the deterministic path, and invoked the expensive agent fallback.
The fallback ultimately searched for the literal `primera diapositiva` rather
than changing the title. It returned no edited artifact. The archive/renderer
smoke had passed, but did not exercise this complete request-routing boundary.

Reloading also exposed a separate UI recovery defect: both persisted sides of
the turn legitimately share `metadata.taskId`. Recovery matched the first one,
overwriting the USER bubble with task state while leaving ASSISTANT pending.
The actual component updater reproduced this without a database connection.
This is evidence of a frontend reconstruction bug, not database corruption.

## Correction and regression scope

- Distinguish the first command after a source prefix from a later mutation.
  Continue rejecting compound requests that the one-title fast path cannot
  fully fulfill. Source names and replacement values must not change scope.
- Keep ordinal slide locations scoped in the generic source-preserving planner.
  Explicit global replacements remain supported; multiple partial slide scopes
  are rejected instead of silently applying a deck-wide change.
- Recover only an assistant associated with the same task and chat. Reject
  conflicting identities and unsafe remembered-message fallbacks.
- Terminal success, error and cancellation take precedence over an older
  pending snapshot of the same task; a different task is not merged into it.
- Add recovery E2E to the existing required critical-path CI gate. No checks,
  branch protections, runtime isolation or permission boundaries are disabled.
- Constrain the transcript's Radix wrapper to the viewport. Its inline table
  layout previously expanded a 390-pixel screen to an 863-pixel inner width;
  the fix changes only the existing transcript wrapper, not the composer.

The new backend entry regression calls `executeAgentRunnerTurn` twice: through
an attached buffer and through an uploaded file ID loaded from a real temporary
file. The parser, routing, OOXML transform and delivery contract are real;
database/storage/provider are explicit fakes. Both must complete with zero LLM
or sandbox calls, change only `ppt/slides/slide1.xml`, retain all 11 slides and
leave the original unchanged. It is not an HTTP or paid-model acceptance test.

Browser recovery fixtures exercise the actual optimized UI with mocked auth,
task and chat HTTP responses. They cover desktop/mobile, two reloads, a stale
pending assistant, and both terminal forms: the actual `completed` + `done:true`
target-not-found state without `state.error`, and an ordinary failed task.
User text/attachment, terminal result, no spinner/duplicate bubble and usable
composer are required. Fixtures are loopback-only and prohibit chat/task writes.

## Local checks before publication

- Root Node tests: 12,407 passed; 533 suites; no failures or skips.
- Vitest: 734 passed across 93 files.
- Optimized standalone build, TypeScript, bundle budget and lint passed.
- UI lock intentionally updated for the three reviewed recovery files and
  the narrowly scoped transcript-width CSS correction.
- Chromium E2E: 19 passed with zero retries/omissions against the optimized
  build (8 composer, 5 chat/upload, 2 artifact/preview, 4 recovery cases).
  Screenshot review additionally caught mobile horizontal text clipping;
  functional DOM assertions alone did not establish mobile visual acceptance.
- Independent frontend recovery review: 54 focal tests and direct updater
  checks passed. Backend review additionally identified quoted-title/location
  and unsupported compound-mutation cases, which are included in the guards.
- Backend regression group: 188 passed across 19 suites, without omissions.
  The full filename/comma prompt, title text resembling a slide number, source
  names, compound edits and numeric/ordinal scopes are exercised. Twelve real
  scoped replacement variants change only `slide2.xml`; the actual chat-entry
  title tests retain the 11-slide package and change only `slide1.xml`.

Final browser/backend regression counts, exact CI SHAs and public acceptance
must be recorded from their completed runs. Until then this document does not
claim the correction is in production or that every document format is editable.

## Rollout

### Cold CI startup follow-up

PR #567 passed CI on `22a751d5d8c63a00db48f191177e712c164f1439`.
Its identical merged tree at `98d9317879ec50923bc05b69cbaca38bf10a0eb5`
failed main run `34001751709`: 18 cases passed, but the first recovery case
timed out waiting for its initial task event before testing recovery.
Publication was paused rather than overriding the gate.

The retry trace showed a successful page, authentication and chat-list request,
followed by the late client-only chat chunk. At the five-second timeout the UI
still displayed its loading shell; no individual chat, pending-stream or task
events request had been made. This was not evidence of a completed recovery.
The two terminal variants have identical running fixtures before that point.

The focused follow-up separates a bounded 30-second bootstrap readiness check
(chat loaded, original user prompt, mounted composer) from the existing
five-second event/recovery checks, including after both reloads. It does not
raise global assertion timeouts, add retries, skip a case, alter fixtures or
change application code. Repeated development-server runs and exact commit CI
must pass before publication resumes.

The focused next-dev repetition passed all 20 cases (four cases repeated five
times, one worker, zero retries) in 2.8 minutes. The cold first case included
a 25.9-second route compile; the 19 warm cases completed in 6.7–7.6 seconds
each, including both reloads and all assertions. TypeScript, focused lint and
UI-lock checks passed. The complete critical suite and exact CI are separate
release gates, not inferred from this repetition.

Normal protected-branch PR and exact merged-main CI, followed by the already
reviewed Lenovo publisher. Expected previous live SHA is `2ed317307bff5255b3ad8bcb88ec47fdee063520`.
No schema/migrations, dependencies, credentials, DNS, database/Redis/gateway or
Docker-daemon changes. Keep private backups and exact app-image rollback.
Repeat the exact authenticated prompt after publication, download the result,
verify slide contents and archive invariants, then reload the same chat.
