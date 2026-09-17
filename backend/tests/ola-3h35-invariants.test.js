'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test("3H35-A-001 unique tool_call ids assign missing and repair duplicates", () => {
  const out = ad.ensureUniqueToolCallIds([
    { id: "t1", function: { name: "read_file" } },
    { id: "t1", function: { name: "write_file" } },
    { function: { name: "glob" } },
  ]);
  assert.equal(out.duplicates, 1);
  assert.ok(out.assigned >= 2);
  const ids = out.calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(out.code, "tool_id_duplicate");
});

test("3H35-B-001 orphan tool_result drop keeps matching ids only", () => {
  const msgs = [
    { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
    { role: "tool", tool_call_id: "a", content: "ok-a" },
    { role: "tool", tool_call_id: "ghost", content: "nope" },
    { role: "user", content: "sigue" },
  ];
  const out = ad.dropOrphanToolResults(msgs);
  assert.equal(out.dropped, 1);
  assert.equal(out.code, "tool_result_orphan");
  assert.equal(out.messages.some((m) => m.tool_call_id === "ghost"), false);
  assert.equal(out.messages.some((m) => m.tool_call_id === "a"), true);
});

test("3H35-C-001 streaming JSON repair joins chunk boundaries", () => {
  const out = ad.repairStreamingJsonAcrossChunks(["{\"path\":", "\"src/a.js\",\"n\":", "2}"]);
  assert.equal(out.ok, true);
  assert.equal(out.value.path, "src/a.js");
  assert.equal(out.value.n, 2);
  const truncated = ad.repairStreamingJsonAcrossChunks(["{\"path\":\"x.js\",\"txt\":\"hel"]);
  assert.equal(truncated.ok, true);
  assert.equal(truncated.repaired, true);
  assert.equal(typeof truncated.value.txt, "string");
});

test("3H35-D-001 unified diff apply replaces hunk not only str_replace", () => {
  const src = "alpha\nbeta\ngamma\n";
  const diff = "--- a/f.js\n+++ b/f.js\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
  const out = ad.applyUnifiedDiff({ haystack: src, diff });
  assert.equal(out.ok, true);
  assert.equal(out.unified, true);
  assert.ok(out.text.includes("BETA"));
  assert.equal(out.text.includes("beta"), false);
  const miss = ad.applyUnifiedDiff({ haystack: src, diff: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-not-there\n+x\n" });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, "git_hunk_ambiguous");
});

test("3H35-E-001 sandbox ulimit nproc/nofile wraps spawn", () => {
  const spec = ad.sandboxUlimitSpec({ nproc: 64, nofile: 256 });
  assert.equal(spec.nproc, 64);
  assert.equal(spec.nofile, 256);
  assert.ok(spec.execPreamble.includes("ulimit -u 64"));
  assert.ok(spec.execPreamble.includes("ulimit -n 256"));
  const wrap = ad.wrapSandboxSpawnWithUlimit("/usr/bin/python3", ["-c", "print(1)"]);
  assert.equal(wrap.bin, "/bin/bash");
  assert.equal(wrap.argv[0], "-c");
  assert.ok(wrap.argv.includes("--"));
  assert.ok(wrap.argv.includes("/usr/bin/python3"));
});

test("3H35-F-001 stdout/stderr stay separate streams in tool result", () => {
  const out = ad.splitStdoutStderrToolResult({ stdout: "hello\n", stderr: "warn\n" });
  assert.equal(out.stdout, "hello\n");
  assert.equal(out.stderr, "warn\n");
  assert.equal(out.streams.stdout, "hello\n");
  assert.ok(out.text.includes("stdout:"));
  assert.ok(out.text.includes("stderr:"));
  const big = "x".repeat(200);
  const cap = ad.splitStdoutStderrToolResult({ stdout: big, stderr: "", maxBytes: 32 });
  assert.equal(cap.stdoutTruncated, true);
  assert.ok(cap.stdout.length <= 64);
});

test("3H35-G-001 credit hold then settle does not double-charge retry", () => {
  ad.resetCreditHoldsByRequest();
  const a = ad.holdThenSettleCredits("sess", { amount: 10, requestId: "req1", now: 1 });
  assert.equal(a.ok, true);
  assert.equal(a.reused, false);
  const retry = ad.holdThenSettleCredits("sess", { amount: 10, requestId: "req1", now: 2 });
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, true);
  assert.equal(retry.charged, false);
  const settled = ad.settleCreditHold("sess", "req1", { usage: { total_tokens: 10 }, now: 3 });
  assert.equal(settled.charged, true);
  const again = ad.holdThenSettleCredits("sess", { amount: 10, requestId: "req1", now: 4 });
  assert.equal(again.ok, false);
  assert.equal(again.code, "credit_hold_reuse");
  ad.resetCreditHoldsByRequest();
});

test("3H35-H-001 resume replays tool_results without re-exec", () => {
  const store = new Map();
  const msgs = [
    { role: "assistant", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "already-done", __args: { path: "a.js" } },
  ];
  const loaded = ad.replayToolResultsOnResume(store, msgs);
  assert.equal(loaded.replayed, 1);
  const hit = ad.replaySameCallId(store, { toolCallId: "c1", args: { path: "a.js" } });
  assert.equal(hit.replay, true);
  assert.equal(hit.result, "already-done");
});

test("3H35-J-001 gateway drops events from cancelled runId", () => {
  ad.resetCancelledRuns();
  ad.markRunCancelled("run_abc");
  const drop = ad.dropCancelledRunEvents({ type: "token", runId: "run_abc" });
  assert.equal(drop.drop, true);
  assert.equal(drop.code, "turn_cancelled");
  const keep = ad.dropCancelledRunEvents({ type: "token", runId: "run_other" });
  assert.equal(keep.drop, false);
  ad.resetCancelledRuns();
});

test("3H35-I-001 compact keeps pin and last user", () => {
  const pin = "SIRA" + "GPT.md pin";
  const msgs = [{role:"system",content:"base"},{role:"system",content:pin,__projectInstructions:true},{role:"assistant",content:"x".repeat(4000)},{role:"user",content:"ultima pregunta del usuario"}];
  const out = ad.compactKeepPinnedSiragptAndLastUser(msgs, { remaining: 200, keep: 1 });
  assert.equal(out.keptSiragpt, 1);
  assert.equal(out.keptLastUser, true);
  assert.equal(out.messages[out.messages.length-1].content, "ultima pregunta del usuario");
});

test("3H35-K-001 per-tool rate limit is independent of other tools", () => {
  ad.resetPerToolRateLimit();
  for (let i = 0; i < 20; i += 1) {
    const r = ad.perToolRateLimit("sess", "web_fetch", { now: 1000 + i, limit: 20 });
    assert.equal(r.ok, true);
  }
  const blocked = ad.perToolRateLimit("sess", "web_fetch", { now: 1020, limit: 20 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "rate_limited");
  const other = ad.perToolRateLimit("sess", "read_file", { now: 1020, limit: 20 });
  assert.equal(other.ok, true);
  ad.resetPerToolRateLimit();
});

test("3H35-L-001 image/pdf parts over cap are omitted", () => {
  const big = "data:image/png;base64," + "A".repeat(4000);
  const out = ad.capImagePdfInContext([
    { role: "user", content: [{ type: "text", text: "mira" }, { type: "image", data: big }] },
  ], { maxBytes: 512 });
  assert.equal(out.capped, 1);
  assert.equal(out.code, "file_too_large");
  assert.equal(out.messages[0].content[1].omitted, true);
});

test("3H35-M-001 max_tokens clamps to remaining context window", () => {
  const openTok = ad.clampMaxTokensToRemainingContext({ maxTokens: 1500, used: 100, contextWindow: 128000 });
  assert.equal(openTok.clamped, false);
  assert.equal(openTok.maxTokens, 1500);
  const tight = ad.clampMaxTokensToRemainingContext({ maxTokens: 1500, used: 127980, contextWindow: 128000, reserve: 10 });
  assert.equal(tight.clamped, true);
  assert.ok(tight.maxTokens < 1500);
  assert.ok(tight.maxTokens >= 16);
  assert.equal(tight.code, "token_budget");
});

test("3H35-N-001 clock-skew safe TTL rejects future issuedAt and delays expire", () => {
  const future = ad.clockSkewSafeTtl({ issuedAt: 10000, ttlMs: 1000, now: 1000, skewMs: 2000 });
  assert.equal(future.expired, true);
  assert.equal(future.code, "clock_skew");
  const still = ad.clockSkewSafeTtl({ issuedAt: 0, ttlMs: 1000, now: 2500, skewMs: 2000 });
  assert.equal(still.expired, false);
  const gone = ad.clockSkewSafeTtl({ issuedAt: 0, ttlMs: 1000, now: 3001, skewMs: 2000 });
  assert.equal(gone.expired, true);
  assert.equal(gone.code, "session_lock_stale");
});

test("3H35-O-001 idempotent generate by client requestId replays", () => {
  ad.resetGenerateByRequestId();
  const first = ad.idempotentGenerateByRequestId("sess", "client-9", { now: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  ad.rememberGenerateByRequestId("sess", "client-9", { ok: true, text: "cached" }, { now: 2 });
  const second = ad.idempotentGenerateByRequestId("sess", "client-9", { now: 3 });
  assert.equal(second.replay, true);
  assert.equal(second.result.text, "cached");
  assert.equal(second.code, "idempotency_replay");
  ad.resetGenerateByRequestId();
});

test("3H35-P-001 snapshot exposes 3H34 plus 3H35 flags and DeepSeek lock", () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === "3H35" || s.wave === "3H36" || s.wave === "3H37" || s.wave === "3H38" || s.wave === "3H39" || s.wave === "3H40");
  assert.equal(s.pgvectorRankHits, true);
  assert.equal(s.crossProcessFileLock, true);
  assert.equal(s.uniqueToolCallIds, true);
  assert.equal(s.orphanToolResultDrop, true);
  assert.equal(s.streamingJsonRepair, true);
  assert.equal(s.unifiedDiffApply, true);
  assert.equal(s.sandboxUlimitNprocNofile, true);
  assert.equal(s.stdoutStderrSplit, true);
  assert.equal(s.creditHoldThenSettle, true);
  assert.equal(s.resumeReplayToolResults, true);
  assert.equal(s.compactKeepSiragptLastUser, true);
  assert.equal(s.dropCancelledRunEvents, true);
  assert.equal(s.perToolRateLimit, true);
  assert.equal(s.imagePdfContextCap, true);
  assert.equal(s.maxTokensContextClamp, true);
  assert.equal(s.clockSkewSafeTtl, true);
  assert.equal(s.idempotentGenerateRequestId, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, "local");
});

test("3H35-Q-001 live loop/queue/sse/gateway/sandbox import 3H35 helpers", () => {
  const loop = read("src/services/agent-runner/loop.js");
  assert.ok(loop.includes("ensureUniqueToolCallIds"));
  assert.ok(loop.includes("applyUnifiedDiff"));
  assert.ok(loop.includes("compactKeepPinnedSiragptAndLastUser"));
  assert.ok(loop.includes("holdThenSettleCredits"));
  assert.ok(loop.includes("perToolRateLimit"));
  assert.ok(loop.includes("clampMaxTokensToRemainingContext"));
  assert.ok(loop.includes("rankPgvectorHits"));
  const q = read("src/services/agent-gateway/queue.js");
  assert.ok(q.includes("idempotentGenerateByRequestId"));
  assert.ok(q.includes("markRunCancelled"));
  const sse = read("src/utils/sse-writer.js");
  assert.ok(sse.includes("dropCancelledRunEvents"));
  const gw = read("src/services/agent-runner/engine-gateway.js");
  assert.ok(gw.includes("perToolRateLimit"));
  const sb = read("src/services/sandbox/local-sandbox.js");
  assert.ok(sb.includes("wrapSandboxSpawnWithUlimit"));
  assert.ok(sb.includes("splitStdoutStderrToolResult"));
  const ra = read("src/services/react-agent.js");
  assert.ok(ra.includes("ensureUniqueToolCallIds"));
  const acs = read("src/services/agentic-chat-stream.js");
  assert.ok(acs.includes("holdThenSettleCredits"));
});

test("3H35-R-001 no OpenRouter generate path and 3H34 helpers intact", () => {
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: "1" }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel("deepseek-v4-flash").ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel("openrouter/gpt-4").ok, false);
  assert.equal(typeof ad.rankPgvectorHits, "function");
  assert.equal(typeof ad.rollbackLastNFileEdits, "function");
  assert.equal(typeof ad.acquireFairGenerateLock, "function");
  assert.equal(typeof ad.formatReadWithLineNumbers, "function");
  assert.equal(typeof ad.compactUntilTokenBudget, "function");
});

test("3H35-S-001 error codes include 3H35 taxonomy", () => {
  const { CODES, isRetryable } = require("../src/services/error_codes");
  assert.equal(CODES.CLOCK_SKEW, "clock_skew");
  assert.equal(CODES.TOOL_ID_DUPLICATE, "tool_id_duplicate");
  assert.equal(CODES.TOOL_RESULT_ORPHAN, "tool_result_orphan");
  assert.equal(CODES.CREDIT_HOLD_REUSE, "credit_hold_reuse");
  assert.equal(isRetryable("clock_skew"), true);
  assert.equal(isRetryable("idempotency_replay"), true);
});

test("3H35-T-001 public stream maps clock_skew and unified diff in ES", () => {
  const src = read("src/services/observability/public-stream-error.js");
  assert.ok(src.includes("code: 'clock_skew'"));
  assert.ok(/reloj del cliente/i.test(src));
  assert.ok(src.includes("code: 'git_hunk_ambiguous'"));
  assert.ok(/diff unificado/i.test(src));
  assert.ok(src.includes("code: 'sandbox_resource_limit'"));
});

test("3H35-U-001 release credit hold on cancel does not settle", () => {
  ad.resetCreditHoldsByRequest();
  ad.holdThenSettleCredits("sess", { amount: 5, requestId: "cxl", now: 1 });
  const rel = ad.releaseCreditHold("sess", "cxl");
  assert.equal(rel.released, true);
  const settle = ad.settleCreditHold("sess", "cxl", { usage: { total_tokens: 5 } });
  assert.equal(settle.ok, false);
  ad.resetCreditHoldsByRequest();
});

test("3H35-V-001 compose binds 3H35 tests", () => {
  assert.ok(String(__filename || "").includes("ola-3h35-invariants.test.js"));
  const src = read("src/services/agent-runner/engine-adapter.js");
  assert.ok(src.indexOf("3H35") >= 0);
  assert.ok(ad.adapterSnapshot().wave === "3H35" || ad.adapterSnapshot().wave === "3H36" || ad.adapterSnapshot().wave === "3H37" || ad.adapterSnapshot().wave === "3H38" || ad.adapterSnapshot().wave === "3H39" || ad.adapterSnapshot().wave === "3H40");
});
