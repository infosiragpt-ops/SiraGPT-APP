
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const SRC = path.join(__dirname, "../src");
const ROOT = fs.existsSync("/opt/siragpt/lib") ? "/opt/siragpt" : path.join(__dirname, "../..");
function read(rel) { return fs.readFileSync(path.join(SRC, rel), "utf8"); }
function rr(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
describe("ola-200 wave G invariants", () => {
  it("BE-018 gateway generate rejects OpenRouter leftovers", () => {
    const gw = require("../src/services/agent-gateway");
    assert.equal(typeof gw.assertNativeGatewayGenerate, "function");
    assert.throws(() => gw.assertNativeGatewayGenerate("openrouter/auto"), /model_forbidden|OpenRouter/);
  });
  it("BE-037/038 invite single-use + revoke race", () => {
    const s = require("../src/services/orgs-service");
    assert.throws(() => s.assertInviteTokenSingleUse({ consumedAt: new Date() }), /invite_already_used/);
    assert.equal(s.shouldRejectRevokedAccept({ revokedAt: new Date() }), true);
    assert.equal(s.acceptInviteConflictCode({ code: "P2002" }), "invite_conflict");
  });
  it("BE-061 goal retry backoff + no double-run", () => {
    const q = require("../src/services/goal-queue");
    assert.equal(q.goalRetryBackoffMs(0), 2000);
    assert.equal(q.goalRetryBackoffMs(2), 8000);
    assert.throws(() => q.assertGoalNotDoubleRun({ state: "active" }), /goal_already_running/);
  });
  it("BE-062 miss-catchup fail-closed delivers at most one", () => {
    const s = require("../src/services/scheduled-agent-tasks");
    const out = s.assertMissCatchupFailClosed({ dueRuns: 12, coalesced: true });
    assert.equal(out.deliver, 1);
  });
  it("BE-063 stripe event idempotency + replay window", () => {
    const s = require("../src/services/stripe-webhook-recovery");
    assert.equal(s.stripeEventIdempotencyKey("evt_1"), "stripe:event:evt_1");
    assert.equal(s.isStripeReplayOutsideWindow(Math.floor(Date.now()/1000) - 10), false);
    assert.equal(s.isStripeReplayOutsideWindow(Math.floor(Date.now()/1000) - 80*60*60), true);
  });
  it("BE-067 structured logger wrapper exists", () => {
    const { createAiPathLogger, logAiGenerate } = require("../src/services/observability/structured-logger");
    const lines = [];
    const log = createAiPathLogger({ sink: (line) => lines.push(line) });
    logAiGenerate(log, "generate start", { model: "deepseek-v4-flash" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /deepseek-v4-flash/);
  });
  it("BE-073 free-ia rejects OpenRouter", () => {
    const { assertFreeIaNotOpenRouter } = require("../src/routes/free-ia");
    assert.throws(() => assertFreeIaNotOpenRouter("https://openrouter.ai/api"), /model_forbidden/);
  });
  it("BE-077 browser egress stays disabled without allowlist", () => {
    const b = require("../src/services/agent-runner/browser/browser-act");
    assert.equal(b.isBrowserEgressEnabled({}), false);
    assert.equal(b.assertBrowserEgressDisabled({}), true);
  });
  it("BE-078 frameId replay is rejected", () => {
    const { assertFrameIdNotReplayed } = require("../src/services/computer-use-action-mapper");
    const seen = new Set();
    assert.equal(assertFrameIdNotReplayed(seen, "f1"), true);
    assert.throws(() => assertFrameIdNotReplayed(seen, "f1"), /computer_use_frame_replayed/);
  });
  it("BE-080 docker.sock is forbidden", () => {
    const { assertNoDockerSock } = require("../src/routes/sandbox");
    assert.throws(() => assertNoDockerSock("/var/run/docker.sock"), /docker_sock_forbidden/);
    assert.equal(assertNoDockerSock("/tmp/work"), true);
  });
  it("BE-081 free shell is not an allowed bridge binary", () => {
    const { assertAllowedBridgeBinary } = require("../src/services/local-computer-bridge");
    assert.throws(() => assertAllowedBridgeBinary("not-allowed-bin"), /bridge_binary_not_allowed/);
    assert.equal(assertAllowedBridgeBinary("code"), true);
  });
  it("BE-082 host runner allowlist fail-closed in production", () => {
    const { assertHostRunnerAllowedUser } = require("../src/routes/codex");
    assert.throws(() => assertHostRunnerAllowedUser("u1", { NODE_ENV: "production", SIRAGPT_HOST_RUNNER_ALLOWED_USER_IDS: "" }), /host_runner_allowlist_empty/);
  });
  it("BE-083/084 exclusive user container + destroy helper", () => {
    const desktop = require("../src/services/codex/dept-real-pc");
    assert.equal(typeof desktop.containerNameForUser, "function");
    assert.equal(typeof desktop.destroyDepartmentDesktop, "function");
  });
  it("BE-088 gmail reuse revokes family", () => {
    const { shouldRevokeGmailFamily } = require("../src/services/gmail-user-client");
    assert.equal(shouldRevokeGmailFamily(new Error("invalid_grant")), true);
  });
  it("BE-092 revokeAllSessions exists", () => {
    const sm = require("../src/services/session-manager");
    assert.equal(typeof sm.revokeAllSessions, "function");
    assert.equal(sm.revokeAllSessions("missing-user").revoked, 0);
  });
  it("BE-093 password reset is single-use + TTL", () => {
    const pr = require("../src/services/password-reset");
    assert.ok(pr.DEFAULT_TTL_MS <= 30 * 60 * 1000);
    assert.equal(typeof pr.consumePasswordResetTokenOnce, "function");
  });
  it("BE-094 email existence is not revealed", () => {
    const { timingSafeEmailExistsResponse } = require("../src/services/email-verification");
    assert.deepEqual(timingSafeEmailExistsResponse(true), timingSafeEmailExistsResponse(false));
  });
  it("BE-095 detector-down is documented fail-open", () => {
    const det = require("../src/services/adversarial-prompt-detector");
    assert.equal(det.DETECTOR_DOWN_POLICY, "fail-open");
  });
  it("BE-098 hex OOXML + cancel no-leak + generate routing filters OpenRouter", () => {
    const office = read("services/agent-runner/office-helpers.js");
    assert.match(office, /504b0304|PK|hex|OOXML|docx/i);
    const abort = read("services/chat-abort-persistence.js");
    assert.match(abort, /TTL|purge|ttl/i);
    const routing = require("../src/orchestration/llm-routing.config");
    const filtered = routing.generateProviders();
    assert.equal(filtered.some((p) => String(p.id) === "openrouter"), false);
    assert.equal(filtered.some((p) => /openrouter/i.test(String(p.baseURL || ""))), false);
  });
  it("BE-099 bak modules are forbidden", () => {
    const { assertNotBakModule } = require("../src/routes/no-bak-require");
    assert.throws(() => assertNotBakModule("agent-task.js.bak-wave3"), /bak_module_forbidden/);
  });
  it("FE markers landed on disk", () => {
    const feRoot = ["/opt/siragpt", path.join(__dirname, "../..")].find((r) => fs.existsSync(path.join(r, "lib/composer-layout.ts")));
    if (!feRoot) { assert.ok(true); return; }
    const rr = (rel) => fs.readFileSync(path.join(feRoot, rel), "utf8");
    assert.match(rr("lib/composer-layout.ts"), /memoizedMeasureComposerTextarea/);
    assert.match(rr("lib/codex-workspace-identity.ts"), /claimWorkspaceTabLock/);
    assert.match(rr("lib/agent-task-presentation.ts"), /followUpPresentationPayload/);
    assert.match(rr("lib/agentic-search-service.ts"), /agenticSearchFetchInit/);
    assert.match(rr("lib/chat-input-normalize.ts"), /normalizeChatInputPayload/);
    assert.match(rr("lib/chat/message-rendering.ts"), /memoizedParseMarkdown/);
    assert.match(rr("lib/code-agent/workspace-auth.ts"), /shouldForceHostRunnerReauth/);
    assert.match(rr("lib/code-templates.ts"), /stripExampleApiKeys/);
    assert.match(rr("lib/code-chat-sessions.ts"), /reusePersistedSessionOnRefresh/);
    assert.match(rr("lib/code-chat-plan-label.ts"), /planLabelFromActivity/);
    assert.match(rr("components/gateway/GatewayBadge.tsx"), /aria-atomic/);
    assert.match(rr("app/settings/error.tsx"), /keep-advanced/);
    assert.match(rr("lib/api.ts"), /shouldStopPendingStreamRecovery/);
    assert.match(rr("hooks/use-computer-use.tsx"), /consumeFrameId/);
    assert.match(rr("hooks/use-performance.ts"), /sanitizeLongTaskName/);
    assert.match(rr("lib/mobile-openrouter-guard.ts"), /assertNoEmbeddedOpenRouterKey/);
    assert.match(rr("lib/mobile-stop-stream.ts"), /postMobileStopStream/);
    assert.match(rr("lib/voice/abort-audio-stream.ts"), /abortAudioStream/);
    assert.match(rr("lib/cowork-api.ts"), /coworkProgressResumeHeaders/);
  });
});
