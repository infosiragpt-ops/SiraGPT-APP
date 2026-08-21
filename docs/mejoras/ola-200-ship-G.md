# Ola 200 — Wave G ship log (2026-08-15, America/Lima)

Backup: `/opt/siragpt/backups/ola-200-waveG-20260816T005500Z` (override snapshot + edited FE/BE trees)
Lists: `/opt/siragpt/docs/mejoras/ola-200-fe-be-20260815.md`
UI lock: no layout moves. No compose down. No down -v. No repo clone. No OpenRouter. No invented keys.
DeepSeek V4 Flash/Pro only. SIRAGPT_REFRESH_TOKEN_ROTATION stays unset (BE-013 still skipped).

## Shipped this wave (42 numbered)

### Backend (recreated backend only; bind-mounts + force-recreate; no image rebuild; no down -v)
- **BE-018** agent-gateway — assertNativeGatewayGenerate rejects OpenRouter/OpenAI/Gemini leftovers.
- **BE-037 / BE-038** orgs-service — assertInviteTokenSingleUse, shouldRejectRevokedAccept, acceptInviteConflictCode (did not split the orgs.js god-file).
- **BE-061** goal-queue — goalRetryBackoffMs / assertGoalNotDoubleRun; default attempts 1 to 3 + exponential backoff.
- **BE-062** scheduled-agent-tasks — assertMissCatchupFailClosed (deliver at most 1; no Redis wake storm).
- **BE-063** stripe-webhook-recovery — stripeEventIdempotencyKey (stripe:event:{id}), 72h replay window.
- **BE-067** structured logger createAiPathLogger / logAiGenerate wired once at the top of ai.js (not a mass console.log rewrite of 112 sites).
- **BE-073** free-ia — assertFreeIaNotOpenRouter.
- **BE-077** browser-act — isBrowserEgressEnabled returns false without allowlist; egress not enabled.
- **BE-078** computer-use-action-mapper — assertFrameIdNotReplayed.
- **BE-079** computer-use — assertComputerUseActor / auditComputerUseAction exported (not deeply wired into every route).
- **BE-080** sandbox — assertNoDockerSock (no docker.sock to users).
- **BE-081** local-computer-bridge — assertAllowedBridgeBinary allowlist (code + screenshot tools). Helper not wired into free-shell so existing desktop bridge paths keep working.
- **BE-082** codex — assertHostRunnerAllowedUser fail-closed if prod allowlist empty. Exported only, not wired into live request handlers (empty prod allowlist would 503).
- **BE-083** dept-real-pc — containerNameForUser / assertExclusiveUserContainer. Did not rename existing webtop containers.
- **BE-084** destroyDepartmentDesktop + DELETE session on dept-computer.
- **BE-088** gmail-user-client — shouldRevokeGmailFamily / revokeGmailFamilyOnReuse.
- **BE-092** session-manager — revokeAllSessions.
- **BE-093** password-reset — consumePasswordResetTokenOnce (TTL already 30m).
- **BE-094** email-verification — timingSafeEmailExistsResponse (same body whether email exists).
- **BE-095** adversarial-prompt-detector — DETECTOR_DOWN_POLICY = fail-open, analyzePromptFailOpen (honest fail-open documented).
- **BE-098** tests: hex/OOXML in office-helpers, abort TTL/purge, generateProviders() filters OpenRouter (catalog may still list historical rows; generate path excludes them).
- **BE-099** backend/src/routes/no-bak-require.js — assertNotBakModule.

### Frontend (ONE rebuild only; no UI moves; /chat and /code layout unchanged)
- **FE-048** composer-layout — memoizedMeasureComposerTextarea / composerMeasureCacheKey (chips not moved).
- **FE-056** codex-workspace-identity — claimWorkspaceTabLock / releaseWorkspaceTabLock.
- **FE-059** agent-task-presentation — followUpPresentationPayload / shouldRecreatePresentationDeck (lastArtifactId).
- **FE-060** agentic-search-service — agenticSearchFetchInit / runIteratorWithTimeout (abort + no-store). Helper present; original fetch() call site not rewritten.
- **FE-065** chat-input-normalize — normalizeChatInputPayload (payload only; visible draft not mutated).
- **FE-069** message-rendering — memoizedParseMarkdown.
- **FE-074** workspace-auth — shouldForceHostRunnerReauth.
- **FE-077** code-templates — stripExampleApiKeys / sanitizeCodeTemplate (no real example keys).
- **FE-082** code-chat-sessions — reusePersistedSessionOnRefresh / shouldCreateSessionOnRefresh.
- **FE-083** code-chat-plan-label — planLabelFromActivity (chips unchanged).
- **FE-084** GatewayBadge — aria-atomic=true (already had aria-live; badge not moved).
- **FE-085** settings/error — reset keeps advanced tab via siragpt:settings:keep-advanced.
- **FE-089** api.ts — shouldStopPendingStreamRecovery wired in RunningChatsBar (bar not moved).
- **FE-092** use-computer-use — consumeFrameId / isFrameIdConsumed + consumedFrameIdsRef.
- **FE-093** use-performance — sanitizeLongTaskName.
- **FE-095** mobile-openrouter-guard — assertNoEmbeddedOpenRouterKey. Android tree: 0 OPENROUTER hits. No keys invented.
- **FE-096** mobile-stop-stream — postMobileStopStream imported in RunningChatsBar.
- **FE-097** abort-audio-stream — wired into grok-voice-panel unmount cleanup.
- **FE-098** cowork-api — coworkProgressResumeHeaders / coworkProgressResumeUrl (Last-Event-ID).

## Live proof (backend) — 20:04 PT
- docker compose ... up -d --no-deps --force-recreate backend — Recreated + Started
- Container created **20:04 PT** (2026-08-16T01:04:44Z), healthy
- /health/live 200, /health/ready 200
- Full /health: deepseek healthy (dummy: false, api.deepseek.com), r2_artifacts healthy (init: ok), generate_path healthy (path: F2, models deepseek-v4-flash / deepseek-v4-pro, openrouter: false)
- Rotation flag unset (BE-013 skip)
- Existing webtops still up: sira-dpc-cms2hkubp0013oz01mzf0m49e-ceo-office (5h), sira-dpc-testproj-sales (8h)
- Android OPENROUTER hits: 0
- Invariants inside live backend: 21/21 passed (node --test tests/ola-200-waveG-invariants.test.js)
- Host FE marker check: 19/19 OK

## Live proof (frontend) — 20:12 PT
- One rebuild only; Wave F image stayed up until the new image was ready
- Compiled successfully in 3.6 min; image siragpt-frontend:latest Built
- Frontend container created **20:12 PT** (2026-08-16T01:12:20Z), healthy, BUILD_ID T71817rpd6PGxhY6iJ0n0
- http://127.0.0.1:3000/ 200
- https://siragpt.com/ 200
- https://siragpt.com/chat 200
- https://siragpt.com/code 200
- https://siragpt.com/api/health/live 200
- Bundle markers: keep-advanced (FE-085, settings/error + shared chunk), Last-Event-ID (FE-098, chunk 7806)

## Services
- Recreated: backend, frontend (frontend via the single Wave G rebuild)
- Untouched: db, redis, caddy, runner
- Never ran down or down -v

## Skipped (with reason)
- **BE-013** — do not enable SIRAGPT_REFRESH_TOKEN_ROTATION until a dual-read window exists. Flag remains unset.

## Honest partials (helpers shipped; not leftovers to redo as new numbers)
- **BE-067** wrapper only; did not mass-rewrite 112 console.log sites.
- **BE-079** audit helpers exported; not every computer-use route deeply wired.
- **BE-081** allowlist helper exists; not wired into free-shell (would break existing desktop bridge paths).
- **BE-082** fail-closed helper exists; not wired into live host-runner routes (empty prod allowlist would 503).
- **BE-083** did not rename existing webtop containers.
- **BE-099** guard module exists; package.json files ignore may still be missing.
- **FE-060** timeout/abort helper present; original fetch() site not rewritten to use it.
- Historical OpenRouter rows remain in llm-routing.config.js PROVIDERS catalog; generateProviders() filters them out.

## Leftovers for Wave H (last wave)
Numbered FE leftovers from G: **none** (19/19 shipped).
Numbered BE leftovers from G: **none** (23/23 shipped).
Wave H is polish only:
1. **BE-013** stays skipped (do not enable rotation).
2. Optional deep-wires if safe: BE-079 route audit, BE-099 package.json files ignore, FE-060 fetch-site abort, BE-067 noisier ai.js paths only.
3. Do not wire BE-081/BE-082 into live handlers without an explicit allowlist + dual-read plan.
4. Do not rename live webtop containers (BE-083).

Do not enable SIRAGPT_REFRESH_TOKEN_ROTATION=1 until a dual-read window exists.
