'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test("3H37-A-001 identical observation loop cut after 3 repeats", () => {
  const a = ad.identicalObservationLoopCut(["same", "same"]);
  assert.equal(a.cut, false);
  const b = ad.identicalObservationLoopCut(["same", "same", "same"]);
  assert.equal(b.cut, true);
  assert.equal(b.code, "identical_observation_loop");
  const mixed = ad.identicalObservationLoopCut(["a", "b", "a"]);
  assert.equal(mixed.cut, false);
  const factory = ad.createIdenticalObservationLoopCut({ limit: 3 });
  factory.see({ tool: "read_file", result: "x" });
  factory.see({ tool: "read_file", result: "x" });
  const third = factory.see({ tool: "read_file", result: "x" });
  assert.equal(third.cut, true);
});

test("3H37-B-001 abort siblings when parent cancelled", () => {
  const seen = [];
  const out = ad.abortSiblingsOnParentCancel({
    parentCancelled: true,
    siblingIds: ["s1", "s2"],
    abortFn: (id) => seen.push(id),
  });
  assert.deepEqual(out.aborted, ["s1", "s2"]);
  assert.deepEqual(seen, ["s1", "s2"]);
  const idle = ad.abortSiblingsOnParentCancel({ parentCancelled: false, siblingIds: ["s1"] });
  assert.deepEqual(idle.aborted, []);
});

test("3H37-C-001 validate enum args rejects unknown values", () => {
  const schema = { properties: { mode: { enum: ["read", "write"] } } };
  const ok = ad.validateEnumArgs({ mode: "read" }, schema);
  assert.equal(ok.ok, true);
  const bad = ad.validateEnumArgs({ mode: "drop" }, schema);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "enum_rejected");
});

test("3H37-D-001 truncate overlong arg strings keep prefix", () => {
  const small = ad.truncateOverlongArgStrings({ q: "hola" });
  assert.equal(small.truncated, false);
  const big = ad.truncateOverlongArgStrings({ blob: "x".repeat(9000) });
  assert.equal(big.truncated, true);
  assert.ok(big.args.blob.length < 9000);
  assert.ok(big.args.blob.startsWith("xxxx"));
});

test("3H37-E-001 cache identical tool call in the same turn", () => {
  const turn = {};
  ad.resetSameTurnToolCache(turn);
  const a = ad.cacheIdenticalToolCallSameTurn("read_file", { path: "a.js" }, { turn, result: "ok" });
  assert.equal(a.cacheHit, false);
  const b = ad.cacheIdenticalToolCallSameTurn("read_file", { path: "a.js" }, { turn });
  assert.equal(b.cacheHit, true);
  assert.equal(b.result, "ok");
  const c = ad.cacheIdenticalToolCallSameTurn("read_file", { path: "b.js" }, { turn, result: "other" });
  assert.equal(c.cacheHit, false);
});

test("3H37-F-001 detect DAG cycle", () => {
  const ok = ad.detectDagCycle({ a: ["b"], b: ["c"], c: [] });
  assert.equal(ok.ok, true);
  const cyc = ad.detectDagCycle({ a: ["b"], b: ["c"], c: ["a"] });
  assert.equal(cyc.ok, false);
  assert.equal(cyc.code, "dag_cycle");
});

test("3H37-G-001 remaining step budget reminder at <=3", () => {
  const quiet = ad.remainingStepBudgetReminder({ remaining: 8 });
  assert.equal(quiet.inject, false);
  const low = ad.remainingStepBudgetReminder({ remaining: 2 });
  assert.equal(low.inject, true);
  assert.ok(/2/.test(low.text));
});

test("3H37-H-001 compact keeps tool_call/tool_result pairs", () => {
  const msgs = [
    { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
    { role: "tool", tool_call_id: "a", content: "ok-a" },
    { role: "tool", tool_call_id: "ghost", content: "nope" },
    { role: "user", content: "sigue" },
  ];
  const out = ad.compactKeepToolCallResultPairs(msgs);
  assert.equal(out.messages.some((m) => m.tool_call_id === "ghost"), false);
  const assistant = out.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, "a");
  assert.equal(out.messages.some((m) => m.tool_call_id === "a"), true);
});

test("3H37-I-001 min score memory retrieve drops below 0.25", () => {
  const out = ad.minScoreMemoryRetrieve([
    { text: "low", score: 0.1 },
    { text: "ok", score: 0.8 },
    { text: "edge", score: 0.25 },
  ]);
  assert.equal(out.dropped, 1);
  assert.equal(out.facts.length, 2);
  assert.equal(out.facts[0].text, "ok");
});

test("3H37-J-001 checkpoint after successful write max 32", () => {
  let list = [];
  const one = ad.checkpointAfterSuccessfulWrite(list, { path: "a.js", content: "hello", verified: true });
  assert.equal(one.ok, true);
  assert.equal(one.checkpoint.path, "a.js");
  assert.equal(one.checkpoint.bytes, 5);
  assert.ok(one.checkpoint.sha256);
  list = one.checkpoints;
  for (let i = 0; i < 40; i += 1) {
    list = ad.checkpointAfterSuccessfulWrite(list, { path: `f${i}.js`, content: "x", verified: true }).checkpoints;
  }
  assert.equal(list.length, 32);
  const bad = ad.checkpointAfterSuccessfulWrite([], { path: "z.js", verified: false });
  assert.equal(bad.ok, false);
});

test("3H37-K-001 refuse binary file edit", () => {
  const text = ad.refuseBinaryFileEdit("hola mundo");
  assert.equal(text.ok, true);
  const nul = ad.refuseBinaryFileEdit(Buffer.from([65, 0, 66]));
  assert.equal(nul.ok, false);
  assert.equal(nul.code, "binary_file");
  const bin = ad.refuseBinaryFileEdit(Buffer.alloc(64, 1));
  assert.equal(bin.ok, false);
  assert.equal(bin.code, "binary_file");
});

test("3H37-L-001 normalize CRLF to LF before diff", () => {
  const changed = ad.normalizeLineEndingsBeforeDiff("a\r\nb\r\n");
  assert.equal(changed.changed, true);
  assert.equal(changed.text, "a\nb\n");
  const same = ad.normalizeLineEndingsBeforeDiff("a\nb\n");
  assert.equal(same.changed, false);
});

test("3H37-M-001 move file same volume refuses escape and cross-volume", () => {
  const ok = ad.moveFileSameVolume({
    from: "src/a.js",
    to: "src/b.js",
    root: "/ws",
    renameFn: () => {},
    sameVolumeFn: () => true,
  });
  assert.equal(ok.ok, true);
  const escape = ad.moveFileSameVolume({
    from: "src/a.js",
    to: "../etc/passwd",
    root: "/ws",
    renameFn: () => {},
  });
  assert.equal(escape.ok, false);
  assert.equal(escape.code, "path_traversal");
  const cross = ad.moveFileSameVolume({
    from: "src/a.js",
    to: "src/b.js",
    root: "/ws",
    sameVolumeFn: () => false,
  });
  assert.equal(cross.ok, false);
});

test("3H37-N-001 sandbox RSS CPU ulimit prefix", () => {
  const spec = ad.sandboxRssCpuUlimit({});
  assert.ok(spec.prefix.includes("ulimit -v "));
  assert.ok(spec.prefix.includes("ulimit -t "));
  assert.equal(spec.rssKb, 512 * 1024);
  assert.equal(spec.cpuSec, 30);
  const wrapped = ad.wrapSandboxSpawnWithRssCpu("python", ["-c", "print(1)"]);
  assert.equal(wrapped.bin, "/bin/bash");
  assert.ok(String(wrapped.argv[1]).includes("ulimit -v"));
});

test("3H37-O-001 scrub secrets from child env never prints values", () => {
  const out = ad.scrubSecretsFromChildEnv({
    PATH: "/bin",
    HOME: "/tmp",
    LANG: "C",
    TERM: "xterm",
    USER: "sira",
    DEEPSEEK_API_KEY: "sk-secret-value",
    WEBHOOK_TOKEN: "abc",
    NODE_ENV: "production",
  });
  assert.equal(out.env.PATH, "/bin");
  assert.equal(out.env.HOME, "/tmp");
  assert.equal(out.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(out.env.WEBHOOK_TOKEN, undefined);
  assert.equal(out.env.NODE_ENV, "production");
  assert.ok(out.stripped.includes("DEEPSEEK_API_KEY"));
  assert.equal(JSON.stringify(out).includes("sk-secret-value"), false);
  assert.equal(JSON.stringify(out).includes("abc"), false);
});

test("3H37-P-001 tmpdir cleanup finally even if body threw", () => {
  const seen = [];
  const ok = ad.tmpdirCleanupFinally("/tmp/x", () => 7, { rmFn: (p) => seen.push(p) });
  assert.equal(ok.cleaned, true);
  assert.equal(ok.result, 7);
  const boom = ad.tmpdirCleanupFinally("/tmp/y", () => { throw new Error("boom"); }, { rmFn: (p) => seen.push(p) });
  assert.equal(boom.cleaned, true);
  assert.equal(boom.threw, true);
  assert.ok(seen.includes("/tmp/x"));
  assert.ok(seen.includes("/tmp/y"));
});

test("3H37-Q-001 SSE max buffer disconnect over 1MiB", () => {
  const ok = ad.sseMaxBufferDisconnect({ bufferedBytes: 100 });
  assert.equal(ok.disconnect, false);
  const over = ad.sseMaxBufferDisconnect({ bufferedBytes: 1024 * 1024 + 1 });
  assert.equal(over.disconnect, true);
  assert.equal(over.code, "sse_buffer_overflow");
});

test("3H37-R-001 heartbeat jitter 15s +/-20% never under 8s", () => {
  const hi = ad.heartbeatJitter({ random: () => 1 });
  const lo = ad.heartbeatJitter({ random: () => 0 });
  const mid = ad.heartbeatJitter({ random: () => 0.5 });
  assert.ok(hi.delayMs <= 15000 * 1.20 + 1);
  assert.ok(lo.delayMs >= 8000);
  assert.ok(mid.delayMs >= 8000);
  for (let i = 0; i < 30; i += 1) {
    const j = ad.heartbeatJitter({ random: () => i / 29 });
    assert.ok(j.delayMs >= 8000);
  }
});

test("3H37-S-001 generate wait retry-after if over 20s", () => {
  const ok = ad.generateWaitRetryAfter({ waitMs: 5000 });
  assert.equal(ok.ok, true);
  const over = ad.generateWaitRetryAfter({ waitMs: 25000 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "generate_overloaded");
  assert.ok(over.retryAfterSec >= 1);
});

test("3H37-T-001 refund completion hold on cancel, no double refund", () => {
  ad.resetCompletionHoldRefunds();
  const miss = ad.refundPartialTokensOnCancel({ requestId: "r1", cancelled: false, promptTokens: 10, completionTokens: 0 });
  assert.equal(miss.refunded, null);
  const one = ad.refundPartialTokensOnCancel({ requestId: "r1", cancelled: true, promptTokens: 12, completionTokens: 0 });
  assert.equal(one.refunded, "completion_hold");
  const two = ad.refundPartialTokensOnCancel({ requestId: "r1", cancelled: true, promptTokens: 12, completionTokens: 0 });
  assert.equal(two.refunded, null);
  assert.equal(two.duplicate, true);
  ad.resetCompletionHoldRefunds();
});

test("3H37-U-001 classify net errors to public codes", () => {
  assert.equal(ad.classifyNetErrors({ code: "ECONNRESET" }).code, "net_reset");
  assert.equal(ad.classifyNetErrors({ code: "ETIMEDOUT" }).code, "net_timeout");
  assert.equal(ad.classifyNetErrors({ code: "ENOTFOUND" }).code, "net_dns");
  assert.equal(ad.classifyNetErrors({ code: "EAI_AGAIN" }).code, "net_dns");
  assert.equal(ad.classifyNetErrors({ code: "ECONNRESET" }).message.includes("ECONNRESET"), false);
  assert.equal(ad.classifyNetErrors(new Error("boom")).code, null);
});

test("3H37-V-001 skip compact if under 70% of window", () => {
  const skip = ad.skipCompactIfUnderBudget([{ role: "user", content: "hola" }], { windowTokens: 10000 });
  assert.equal(skip.skipped, true);
  const huge = "x".repeat(40000);
  const run = ad.skipCompactIfUnderBudget([{ role: "user", content: huge }], { windowTokens: 10000 });
  assert.equal(run.skipped, false);
});

test("3H37-W-001 snapshot exposes 3H36 plus 3H37 flags and DeepSeek lock", () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === "3H37" || s.wave === "3H38" || s.wave === "3H39" || s.wave === "3H40");
  assert.equal(s.toolNameAllowlist, true);
  assert.equal(s.nestedArrayObjectCoerce, true);
  assert.equal(s.createIfMissingLargeOverwrite, true);
  assert.equal(s.sandboxNetFailClosed, true);
  assert.equal(s.killProcessGroup, true);
  assert.equal(s.sseRetryFirstEvent, true);
  assert.equal(s.noSettleIfStreamNeverOpened, true);
  assert.equal(s.dropDuplicateSystemPrompts, true);
  assert.equal(s.skipEmptyMemoryFacts, true);
  assert.equal(s.stopIfFinalTextWithTools, true);
  assert.equal(s.gzipToolResultOverSize, true);
  assert.equal(s.redactUrlCredentials, true);
  assert.equal(s.generateResumeToken, true);
  assert.equal(s.deepseek429402Map, true);
  assert.equal(s.identicalObservationLoopCut, true);
  assert.equal(s.abortSiblingsOnParentCancel, true);
  assert.equal(s.validateEnumArgs, true);
  assert.equal(s.truncateOverlongArgStrings, true);
  assert.equal(s.cacheIdenticalToolCallSameTurn, true);
  assert.equal(s.detectDagCycle, true);
  assert.equal(s.remainingStepBudgetReminder, true);
  assert.equal(s.compactKeepToolCallResultPairs, true);
  assert.equal(s.minScoreMemoryRetrieve, true);
  assert.equal(s.checkpointAfterSuccessfulWrite, true);
  assert.equal(s.refuseBinaryFileEdit, true);
  assert.equal(s.normalizeLineEndingsBeforeDiff, true);
  assert.equal(s.moveFileSameVolume, true);
  assert.equal(s.sandboxRssCpuUlimit, true);
  assert.equal(s.scrubSecretsFromChildEnv, true);
  assert.equal(s.tmpdirCleanupFinally, true);
  assert.equal(s.sseMaxBufferDisconnect, true);
  assert.equal(s.heartbeatJitter, true);
  assert.equal(s.generateWaitRetryAfter, true);
  assert.equal(s.refundPartialTokensOnCancel, true);
  assert.equal(s.classifyNetErrors, true);
  assert.equal(s.skipCompactIfUnderBudget, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, "local");
});

test("3H37-X-001 live loop/queue/sse/gateway/sandbox import 3H37 helpers", () => {
  const loop = read("src/services/agent-runner/loop.js");
  assert.ok(loop.includes("identicalObservationLoopCut") || loop.includes("createIdenticalObservationLoopCut"));
  assert.ok(loop.includes("abortSiblingsOnParentCancel"));
  assert.ok(loop.includes("validateEnumArgs"));
  assert.ok(loop.includes("truncateOverlongArgStrings"));
  assert.ok(loop.includes("cacheIdenticalToolCallSameTurn"));
  assert.ok(loop.includes("detectDagCycle"));
  assert.ok(loop.includes("remainingStepBudgetReminder"));
  assert.ok(loop.includes("compactKeepToolCallResultPairs"));
  assert.ok(loop.includes("minScoreMemoryRetrieve"));
  assert.ok(loop.includes("checkpointAfterSuccessfulWrite"));
  assert.ok(loop.includes("refuseBinaryFileEdit"));
  assert.ok(loop.includes("normalizeLineEndingsBeforeDiff"));
  assert.ok(loop.includes("skipCompactIfUnderBudget"));
  assert.ok(loop.includes("refundPartialTokensOnCancel"));
  assert.ok(loop.includes("classifyNetErrors"));
  const q = read("src/services/agent-gateway/queue.js");
  assert.ok(q.includes("generateWaitRetryAfter"));
  const sse = read("src/utils/sse-writer.js");
  assert.ok(sse.includes("sseMaxBufferDisconnect"));
  assert.ok(sse.includes("heartbeatJitter"));
  const gw = read("src/services/agent-runner/engine-gateway.js");
  assert.ok(gw.includes("validateEnumArgs"));
  assert.ok(gw.includes("classifyNetErrors"));
  const sb = read("src/services/sandbox/local-sandbox.js");
  assert.ok(sb.includes("sandboxRssCpuUlimit") || sb.includes("wrapSandboxSpawnWithRssCpu"));
  assert.ok(sb.includes("scrubSecretsFromChildEnv"));
  assert.ok(sb.includes("tmpdirCleanupFinally"));
  const ra = read("src/services/react-agent.js");
  assert.ok(ra.includes("abortSiblingsOnParentCancel"));
  assert.ok(ra.includes("validateEnumArgs"));
  const acs = read("src/services/agentic-chat-stream.js");
  assert.ok(acs.includes("refundPartialTokensOnCancel"));
  assert.ok(acs.includes("classifyNetErrors"));
});

test("3H37-Y-001 no OpenRouter generate path and DeepSeek lock", () => {
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: "1" }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel("deepseek-v4-flash").ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel("deepseek-v4-pro").ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel("openrouter/gpt-4").ok, false);
  assert.equal(typeof ad.allowlistToolName, "function");
  assert.equal(typeof ad.holdThenSettleCredits, "function");
});

test("3H37-Z-001 error codes include 3H37 taxonomy", () => {
  const { CODES, isRetryable } = require("../src/services/error_codes");
  assert.equal(CODES.IDENTICAL_OBSERVATION_LOOP, "identical_observation_loop");
  assert.equal(CODES.ENUM_REJECTED, "enum_rejected");
  assert.equal(CODES.BINARY_FILE, "binary_file");
  assert.equal(CODES.SSE_BUFFER_OVERFLOW, "sse_buffer_overflow");
  assert.equal(CODES.GENERATE_OVERLOADED, "generate_overloaded");
  assert.equal(CODES.NET_RESET, "net_reset");
  assert.equal(CODES.NET_TIMEOUT, "net_timeout");
  assert.equal(CODES.NET_DNS, "net_dns");
  assert.equal(isRetryable("net_reset"), true);
  assert.equal(isRetryable("generate_overloaded"), true);
  assert.equal(isRetryable("enum_rejected"), false);
});

test("3H37-AA-001 public stream maps 3H37 codes in ES without traces", () => {
  const src = read("src/services/observability/public-stream-error.js");
  assert.ok(src.includes("code: 'identical_observation_loop'"));
  assert.ok(/mismo resultado/i.test(src));
  assert.ok(src.includes("code: 'enum_rejected'"));
  assert.ok(src.includes("code: 'binary_file'"));
  assert.ok(src.includes("code: 'sse_buffer_overflow'"));
  assert.ok(src.includes("code: 'generate_overloaded'"));
  assert.ok(src.includes("code: 'net_reset'"));
  assert.ok(src.includes("code: 'net_timeout'"));
  assert.ok(src.includes("code: 'net_dns'"));
  assert.equal(/sk-[a-zA-Z0-9]/.test(src), false);
  assert.equal(/at Object\./.test(src), false);
});

test("3H37-AB-001 compose binds 3H37 tests and wave is 3H37", () => {
  assert.ok(String(__filename || "").includes("ola-3h37-invariants.test.js"));
  const src = read("src/services/agent-runner/engine-adapter.js");
  assert.ok(src.indexOf("3H37") >= 0);
  assert.ok(ad.adapterSnapshot().wave === "3H37" || ad.adapterSnapshot().wave === "3H38" || ad.adapterSnapshot().wave === "3H39" || ad.adapterSnapshot().wave === "3H40");
});
