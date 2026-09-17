'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test("3H36-A-001 tool name allowlist rejects invented names", () => {
  const ok = ad.allowlistToolName("read_file");
  assert.equal(ok.ok, true);
  const bad = ad.allowlistToolName("hack_the_planet");
  assert.equal(bad.ok, false);
  assert.equal(bad.invented, true);
  assert.equal(bad.code, "unknown_tool");
  const extra = ad.allowlistToolName("custom_dept_tool", { extra: ["custom_dept_tool"] });
  assert.equal(extra.ok, true);
});

test("3H36-B-001 nested array/object type coerce parses JSON strings", () => {
  const out = ad.coerceNestedArrayObjectTypes({ paths: "[\"a.js\",\"b.js\"]", n: "2", flag: "true" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.paths, ["a.js", "b.js"]);
  assert.equal(out.value.n, 2);
  assert.equal(out.value.flag, true);
  const nested = ad.coerceNestedArrayObjectTypes({ items: [{ n: "3" }, { n: "4" }] }, { properties: { items: { items: { properties: { n: { type: "number" } } } } } });
  assert.equal(nested.ok, true);
  assert.equal(nested.value.items[1].n, 4);
  const reject = ad.coerceNestedArrayObjectTypes("not-json", { type: "array" });
  assert.equal(reject.ok, false);
  assert.equal(reject.code, "coercion_rejected");
});

test("3H36-C-001 create-if-missing vs refuse large overwrite without backup", () => {
  const created = ad.createIfMissingOrRefuseLargeOverwrite({ path: "new.js" });
  assert.equal(created.ok, true);
  assert.equal(created.action, "create");
  const refuse = ad.createIfMissingOrRefuseLargeOverwrite({ path: "big.js", existingBytes: 64 * 1024 });
  assert.equal(refuse.ok, false);
  assert.equal(refuse.code, "file_too_large");
  assert.equal(refuse.action, "refuse_overwrite");
  const backed = ad.createIfMissingOrRefuseLargeOverwrite({ path: "big.js", existingBytes: 64 * 1024, backupPath: "big.js.bak" });
  assert.equal(backed.ok, true);
  assert.equal(backed.action, "overwrite_with_backup");
});

test("3H36-D-001 sandbox net fail-closed when SANDBOX_NET_ALLOW unset", () => {
  const closed = ad.sandboxNetFailClosed({});
  assert.equal(closed.ok, false);
  assert.equal(closed.failClosed, true);
  assert.equal(closed.code, "network_denied");
  const empty = ad.sandboxNetFailClosed({ SIRAGPT_SANDBOX_NET_ALLOW: "   " });
  assert.equal(empty.ok, false);
  const open = ad.sandboxNetFailClosed({ SIRAGPT_SANDBOX_NET_ALLOW: "example.com, api.test" });
  assert.equal(open.ok, true);
  assert.ok(open.allow.includes("example.com"));
});

test("3H36-E-001 kill process group uses negative pid then falls back", () => {
  const seen = [];
  const group = ad.killProcessGroup(4242, { signal: "SIGTERM", killFn: (id, sig) => { seen.push([id, sig]); } });
  assert.equal(group.ok, true);
  assert.equal(group.group, true);
  assert.deepEqual(seen[0], [-4242, "SIGTERM"]);
  const seen2 = [];
  const fb = ad.killProcessGroup(7, {
    killFn: (id, sig) => {
      if (id < 0) throw new Error("no pgid");
      seen2.push([id, sig]);
    },
  });
  assert.equal(fb.ok, true);
  assert.equal(fb.fallback, true);
  assert.deepEqual(seen2[0], [7, "SIGTERM"]);
});

test("3H36-F-001 SSE retry field only on first event", () => {
  const first = ad.sseRetryFieldOnFirstEvent({ first: true, retryMs: 2500 });
  assert.equal(first.retry, 2500);
  assert.ok(first.retryLine.startsWith("retry: 2500"));
  const later = ad.sseRetryFieldOnFirstEvent({ first: false });
  assert.equal(later.retryLine, "");
  assert.equal(later.first, false);
});

test("3H36-G-001 do not settle credit hold if stream never opened", () => {
  ad.resetCreditHoldsByRequest();
  ad.holdThenSettleCredits("sess", { amount: 9, requestId: "r1", now: 1 });
  const never = ad.settleCreditHoldIfStreamOpened("sess", "r1", { streamOpened: false, usage: { total_tokens: 9 } });
  assert.equal(never.settled, false);
  assert.equal(never.code, "credit_no_usage");
  ad.holdThenSettleCredits("sess", { amount: 9, requestId: "r2", now: 2 });
  const opened = ad.settleCreditHoldIfStreamOpened("sess", "r2", { streamOpened: true, usage: { total_tokens: 9 }, now: 3 });
  assert.equal(opened.settled, true);
  assert.equal(opened.charged, true);
  ad.resetCreditHoldsByRequest();
});

test("3H36-H-001 drop duplicate system prompts keeps first", () => {
  const out = ad.dropDuplicateSystemPrompts([
    { role: "system", content: "base" },
    { role: "system", content: "base" },
    { role: "user", content: "hola" },
    { role: "system", content: "otro" },
  ]);
  assert.equal(out.dropped, 1);
  assert.equal(out.code, "pin_dedup");
  assert.equal(out.messages.filter((m) => m.role === "system").length, 2);
});

test("3H36-I-001 skip empty/whitespace memory facts", () => {
  const out = ad.skipEmptyWhitespaceMemoryFacts(["  ", "", { text: "\n" }, { text: "dato util" }, "ok"]);
  assert.equal(out.skipped, 3);
  assert.equal(out.facts.length, 2);
  assert.equal(out.code, "memory_fact_empty");
});

test("3H36-J-001 stop if assistant text looks final AND tools present", () => {
  const stop = ad.stopIfFinalTextWithTools({
    content: "Final answer: el archivo ya esta listo.",
    tool_calls: [{ id: "t1", function: { name: "read_file" } }],
  });
  assert.equal(stop.stop, true);
  assert.equal(stop.dropTools, true);
  assert.equal(stop.code, "final_with_tools");
  const keep = ad.stopIfFinalTextWithTools({
    content: "Voy a leer el archivo ahora.",
    tool_calls: [{ id: "t1", function: { name: "read_file" } }],
  });
  assert.equal(keep.stop, false);
});

test("3H36-K-001 gzip tool results over size", () => {
  const small = ad.gzipToolResultOverSize("hola", { maxBytes: 64 });
  assert.equal(small.gzipped, false);
  const big = ad.gzipToolResultOverSize("x".repeat(4000), { maxBytes: 64 });
  assert.equal(big.gzipped, true);
  assert.equal(big.code, "gzip_version");
  assert.ok(big.bytes < big.rawBytes);
  assert.ok(big.b64.length > 8);
});

test("3H36-L-001 redact URLs with credentials in query", () => {
  const out = ad.redactUrlsWithCredentials("see https://user:pass@api.example.com/v1?token=abc123&q=ok");
  assert.ok(out.redacted >= 2);
  assert.equal(out.text.includes("user:pass"), false);
  assert.equal(out.text.includes("abc123"), false);
  assert.ok(out.text.includes("[redacted]"));
  assert.equal(out.code, "secret_redact");
});

test("3H36-M-001 PATCH generate resume token issue and consume", () => {
  ad.resetGenerateResumeTokens();
  const issued = ad.patchGenerateResumeToken("sess-a");
  assert.equal(issued.ok, true);
  assert.ok(issued.resumeToken);
  assert.equal(issued.resumeId, issued.resumeToken);
  const hit = ad.patchGenerateResumeToken("sess-a", issued.resumeToken);
  assert.equal(hit.ok, true);
  assert.equal(hit.replay, true);
  const miss = ad.consumeGenerateResumeToken("nope", "sess-a");
  assert.equal(miss.ok, false);
  assert.equal(miss.code, "resume_conflict");
  const wrong = ad.consumeGenerateResumeToken(issued.resumeToken, "other-sess");
  assert.equal(wrong.ok, false);
  ad.resetGenerateResumeTokens();
});

test("3H36-N-001 map DeepSeek 429/402 to structured codes", () => {
  const r429 = ad.mapDeepSeekHttpError({ status: 429, message: "Too Many Requests" });
  assert.equal(r429.code, "rate_limited");
  assert.equal(r429.retryable, true);
  const r402 = ad.mapDeepSeekHttpError({ status: 402, message: "Payment Required" });
  assert.equal(r402.code, "credit_ceiling");
  assert.equal(r402.retryable, false);
  const other = ad.mapDeepSeekHttpError({ status: 500, message: "boom" });
  assert.equal(other.code, null);
});

test("3H36-O-001 snapshot exposes 3H35 plus 3H36 flags and DeepSeek lock", () => {
  const s = ad.adapterSnapshot();
  assert.ok(s.wave === "3H36" || s.wave === "3H37" || s.wave === "3H38" || s.wave === "3H39" || s.wave === "3H40");
  assert.equal(s.uniqueToolCallIds, true);
  assert.equal(s.creditHoldThenSettle, true);
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
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, "local");
});

test("3H36-P-001 live loop/queue/sse/gateway/sandbox import 3H36 helpers", () => {
  const loop = read("src/services/agent-runner/loop.js");
  assert.ok(loop.includes("allowlistToolName"));
  assert.ok(loop.includes("coerceNestedArrayObjectTypes"));
  assert.ok(loop.includes("createIfMissingOrRefuseLargeOverwrite"));
  assert.ok(loop.includes("settleCreditHoldIfStreamOpened"));
  assert.ok(loop.includes("dropDuplicateSystemPrompts"));
  assert.ok(loop.includes("skipEmptyWhitespaceMemoryFacts"));
  assert.ok(loop.includes("stopIfFinalTextWithTools"));
  assert.ok(loop.includes("gzipToolResultOverSize"));
  assert.ok(loop.includes("redactUrlsWithCredentials"));
  assert.ok(loop.includes("mapDeepSeekHttpError"));
  assert.ok(loop.includes("ensureUniqueToolCallIds"));
  const q = read("src/services/agent-gateway/queue.js");
  assert.ok(q.includes("consumeGenerateResumeToken"));
  assert.ok(q.includes("patchGenerateResume"));
  const sse = read("src/utils/sse-writer.js");
  assert.ok(sse.includes("sseRetryFieldOnFirstEvent"));
  const gw = read("src/services/agent-runner/engine-gateway.js");
  assert.ok(gw.includes("allowlistToolName"));
  assert.ok(gw.includes("mapDeepSeekHttpError"));
  const sb = read("src/services/sandbox/local-sandbox.js");
  assert.ok(sb.includes("sandboxNetFailClosed"));
  assert.ok(sb.includes("killProcessGroup"));
  const ra = read("src/services/react-agent.js");
  assert.ok(ra.includes("stopIfFinalTextWithTools"));
  assert.ok(ra.includes("allowlistToolName"));
  const acs = read("src/services/agentic-chat-stream.js");
  assert.ok(acs.includes("settleCreditHoldIfStreamOpened"));
});

test("3H36-Q-001 no OpenRouter generate path and 3H35 helpers intact", () => {
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: "1" }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel("deepseek-v4-flash").ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel("openrouter/gpt-4").ok, false);
  assert.equal(typeof ad.ensureUniqueToolCallIds, "function");
  assert.equal(typeof ad.applyUnifiedDiff, "function");
  assert.equal(typeof ad.holdThenSettleCredits, "function");
  assert.equal(typeof ad.rankPgvectorHits, "function");
});

test("3H36-R-001 error codes include 3H36 taxonomy", () => {
  const { CODES, isRetryable } = require("../src/services/error_codes");
  assert.equal(CODES.MEMORY_FACT_EMPTY, "memory_fact_empty");
  assert.equal(CODES.FINAL_WITH_TOOLS, "final_with_tools");
  assert.equal(CODES.DEEPSEEK_PAYMENT, "credit_ceiling");
  assert.equal(CODES.TOOL_NAME_INVENTED, "unknown_tool");
  assert.equal(isRetryable("rate_limited"), true);
  assert.equal(isRetryable("sse_resume"), true);
  assert.equal(isRetryable("credit_ceiling"), false);
});

test("3H36-S-001 public stream maps 429/402 and invented tool in ES", () => {
  const src = read("src/services/observability/public-stream-error.js");
  assert.ok(src.includes("code: 'unknown_tool'"));
  assert.ok(/catalogo/i.test(src));
  assert.ok(src.includes("code: 'credit_ceiling'"));
  assert.ok(/DeepSeek sin credito/i.test(src));
  assert.ok(src.includes("code: 'network_denied'"));
  assert.ok(/SANDBOX_NET_ALLOW/i.test(src));
});

test("3H36-T-001 compose binds 3H36 tests and wave is 3H36", () => {
  assert.ok(String(__filename || "").includes("ola-3h36-invariants.test.js"));
  const src = read("src/services/agent-runner/engine-adapter.js");
  assert.ok(src.indexOf("3H36") >= 0);
  assert.ok(ad.adapterSnapshot().wave === "3H36" || ad.adapterSnapshot().wave === "3H37" || ad.adapterSnapshot().wave === "3H38" || ad.adapterSnapshot().wave === "3H39" || ad.adapterSnapshot().wave === "3H40");
});

test("3H36-U-001 3H35 credit hold reuse still works after 3H36 settle helper", () => {
  ad.resetCreditHoldsByRequest();
  const a = ad.holdThenSettleCredits("sess", { amount: 10, requestId: "req1", now: 1 });
  assert.equal(a.ok, true);
  const settled = ad.settleCreditHoldIfStreamOpened("sess", "req1", { streamOpened: true, usage: { total_tokens: 10 }, now: 2 });
  assert.equal(settled.charged, true);
  const again = ad.holdThenSettleCredits("sess", { amount: 10, requestId: "req1", now: 3 });
  assert.equal(again.ok, false);
  assert.equal(again.code, "credit_hold_reuse");
  ad.resetCreditHoldsByRequest();
});
