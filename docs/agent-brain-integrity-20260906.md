# Agent brain integrity: native integration, 2026-09-06

Base: `production-main` at `845e0c48128634179b60e3dd67622412d2b42a52`.
Synchronized before PR validation with
`100d29bc2e76bf2fb6e875514112f5cae1e40025`: preserve its desktop changes and
new test entry unchanged. The published feature branch incorporates that base
with a merge commit rather than rewriting shared history with a force push.
Scope: the existing `agentic-chat-stream` → ReAct → tool dispatcher path,
plus its existing task worker, terminal status and persistence consumers.
No frontend, provider, credential, database schema, deployment configuration or
dependency changes. This document records a bounded implementation, not full
OpenClaw parity or proof of a production release.

## Runtime corrections

| Reproduced defect | Native correction | Regression evidence |
|---|---|---|
| A tool returning `error`, `ok: false` or MCP `isError: true` was counted as progress and could be cached as a successful read. | Recognize explicit returned failures, preserve their diagnostic payload, apply the existing weighted failure budget and do not cache them. Classify the original result rather than a synthetic error marker. | Structured and thrown failures, transient classification, failed-cache recovery, denied fallback, parallel peers and finalization-guard progress. |
| Prior instructions disappeared after 800/900 characters per message or 18 messages; the same transcript was inserted twice. | One bounded historical block, preserving complete exchanges when they fit and explicitly marking omissions otherwise. Current request remains separate. | Actual wrapper/ReAct prompt capture: long trailing constraints, older turns, no duplication, malformed entries, caller immutability, isolation and the 23,990-character boundary. |
| Duplicate provider tool IDs made independent parallel calls receive the same observation. A malformed group could execute a valid write before being rejected. | Validate the entire control envelope before dispatch, assign unique identities without mutating the input and reserve identities from resumed checkpoints. A malformed group stops without executing that group or claiming completion. | Same-batch duplicates, later-step collisions, resumed identities, atomic rejection before handlers and 21 normalizer unit cases. |
| Reads after a write were prefetched before it; later reads could reuse pre-write cache. | Only the leading contiguous read block may run concurrently. Writes/finalize are ordering barriers; invalidate the run-local read cache before a potentially mutating attempt, including uncertain failures. | Same-batch write/read ordering, successful and uncertain write followed by re-read, finalize barrier, unaffected duplicate-read caching. |

### Important contracts

- The historical block is capped at **24,000 characters**, including its labels,
  not 24,000 tokens or the entire model prompt. If all content fits, no omission
  marker space is reserved and nothing is dropped. An oversized newest exchange
  retains its beginning and end with an explicit middle-omission marker.
- Historical text is labeled untrusted evidence. This is a prompt defense, not
  an authorization boundary or a guarantee against prompt injection. The caller
  still owns conversation access control; no new cross-session retrieval exists.
- Only explicit top-level failure flags change result classification. Arrays,
  empty outputs, nested error fields and `error: null` remain legitimate data.
- Reported denials do not become thrown dispatch errors that trigger new
  alternates/retries. Existing argument parsing, schemas, permissions and budgets
  remain in the dispatcher. This change does not add automatic write replay.
- ID repair applies to new batches. Existing corrupt checkpoints are not
  retrospectively repaired. Provider-specific ID formats still belong to the
  existing provider adapters.
- Read safety now uses exact builtins and explicit trusted local policy, not
  name prefixes or remote MCP hints. Cancellation of already-running tools
  remains cooperative. The finalization breaker no longer approves a rejected
  draft. This does not establish universal success or exactly-once execution.

## First increment verification (head `07013ee7`)

The new suites drive the actual ReAct loop and chat wrapper with scripted model
responses and isolated tool handlers. They make no paid provider requests and do
not access production user data. They are **not** live browser/account E2E proof.

- `npm --prefix backend run test:agent-brain`: 182 tests, zero failures/skips.
- `npm --prefix backend run test:openclaw-native`: 230 tests, zero failures/skips.
- Five new test files contain 57 regression/unit cases, including defects
  demonstrated failing before the fixes. Both commands above include them; do
  not add their totals together as unique coverage.
- Backend test discovery includes the new files; the existing native CI gate
  also runs them. No test exclusions, skips, quarantines or CI thresholds added.
- TypeScript check, scoped ESLint (`--max-warnings 0`), secret-pattern check,
  whitespace check and UI lock pass locally. The secret-pattern check is a
  narrow credential-pattern backstop, not a comprehensive security audit.
- Repository frontend lint has 48 existing warnings and exits successfully
  under its configured ceiling of 50. This does not meet the aspirational
  45-warning skill target. No frontend warning cleanup is included because the
  requested interface is unchanged.
- Scoped coverage of the three modified runtime modules: lines/statements
  84.46%, branches 70.15%, functions 61.22%. It is not full-repository coverage
  and the function result is below 70%; no thresholds were weakened.

Production is a separate gate: current CI, reviewed integration, backup and safe
publish, public revision/health, then an authenticated representative agent flow.
No merge, rollout or live-flow success is asserted by these local tests.

## Second increment: execution and completion integrity

The continuation addresses reproduced runtime failures, without a second agent
framework or a wholesale upstream import:

| Boundary | Native implementation | Failure reproduction / proof |
|---|---|---|
| Completion evidence | Strict boolean approval; bounded rejection stops with `verification_failed`, never a rejected draft. No last-step override. Stop overrides a late positive verdict. | Real ReAct: native/prose, throwing and malformed guards, last step, provider failure, Stop, valid repair and valid success. |
| Answer judge | At most two calls per verifier instance; cached in-flight/verdict by full draft and non-finalize evidence digest. A changed draft/evidence cannot inherit approval. Real timeout race and abort cleanup; invalid/unavailable evidence fails closed. | Judge stub failures, invalid JSON/booleans, evidence beyond excerpt, bounded memory, concurrent budget, ignored SDK abort and late rejection. No paid calls. |
| Resume | Additive checkpoint v2 records actual tool attempts, weighted failure budget, elapsed runtime, rejection/repoll counters, force-finalize latch and bounded no-op hashes. Validate round pairing and counters; merge usage conservatively with caller context. Rejected prose checkpoints too. | Engine-emitted JSON-roundtrip snapshots; real manifest tool allowance; exhausted/reduced limits perform no new model/tool calls; malformed counters, orphaned calls, input immutability and no-op continuation. |
| Read ordering | Exact audited builtin names, with explicit local `readOnly:false` veto and `readOnly:true` opt-in. Separate `cacheable:false`. Ignore remote annotations as authority. Automatic read fallback also respects both tools' local read policy. | Prefix/case spoofing, mutating overrides, local new reads, fresh repeated reads, repeat requested writes and forbidden automatic alternate dispatch. |
| Progress | Only a repeated explicit top-level `ok:true, changed:false` result with same tool/result fingerprint fails to reset consecutive rejection. First evidence, changed revisions/identities, nested data and generic success remain valid. | Native handler fixtures, argument churn, alternating tools, genuine progress controls and checkpoint restore. |
| Task outcome | Central reason classifier, honest failed/cancelled terminal snapshots and metadata, recovery cannot override guards/Stop/budgets. Late events do not reopen a finished file snapshot; explicit new-job retry can reset it. Inline progress writes drain before terminal DB metadata. | Real temporary file store, actual worker with synthetic tools/attachments, DB adapter stubs, SSE closure and real inline persistence closures with fake timers/delayed DB. These are not live provider E2E. |

### Compatibility and unresolved boundaries

- Legacy checkpoints without attempt accounting are rejected when a per-task
  budget is enforced. They are not silently replayed or reconstructed from
  truncated observations. Complete legacy transcripts without that budget keep
  their compatibility path. Fresh tasks do not require a checkpoint.
- Checkpoints occur at completed step boundaries. A crash after an external
  write but before durable checkpoint commit can still repeat that effect.
  Exactly-once effects require operation IDs/idempotency and an atomic durable
  handoff; this increment does not claim to implement that transaction.
- The local terminal-event guard is not a distributed compare-and-swap or
  cross-worker attempt identity protocol. Existing cross-worker persistence
  races and database retry transitions need a separate isolated integration
  increment. Progress-drain completion depends on the DB client's timeout.
- The LLM judge is a bounded quality check, not proof of factual correctness or
  arbitrary external success. Its initial short-query/short-answer fast path
  and explicit existing disable setting remain; deterministic tool/artifact
  guards still supply the domain-specific completion requirements.
- Error states and honest incomplete text use existing UI contracts. No layout,
  composer, labels, permissions, credentials or public service configuration
  changed. No automatic privileged service or new dependency was enabled.

### Continuation validation

Final local runs: `test:agent-brain` **314/314**, `test:openclaw-native`
**362/362**, zero failures/skips in both. These commands overlap; their totals
are not additive unique coverage. They include all continuation regression
files in brain checks and the existing native CI gate; no exclusions or skips
were added. Native HTTP disconnect tests bind loopback only; they passed after
the sandbox permitted that local listener. TypeScript, zero-warning scoped
ESLint, credential-pattern backstop, whitespace and unchanged-UI lock pass.
Full frontend lint remains at the same 48 inherited warnings.

Late terminal events are discarded before file writes, event-log append and
database sync. A real SSE replay test confirms they cannot publish contradictory
successful text or artifacts after a failed done. Explicit new-job retries keep
their tested transition. Remote CI is a separate gate from these local results.

Scoped coverage of ReAct, chat wrapper, answer verifier and outcome classifier:
**88.02% lines/statements, 74.95% branches, 66.46% functions**. ReAct itself is
94.55% lines; verifier and classifier are 100% lines. This is not repository-wide
coverage; wrapper function coverage (50%) remains below the 70% aspirational
target, and the larger task route/worker are outside this scoped coverage figure.

The broader task store/route/queue/event/branch regression selection passes
97 tests. A separate historical document-fallback suite retains two failing
fixtures (`attachment_chat_fast_path` versus `attachment_runtime_recovery`, and
`attachment_empty_response_recovery` versus `thin_attachment_context`). Both were
reproduced identically by loading HEAD `07013ee7` status consumers in the same
isolated test context. They are not marked passing, skipped, or hidden by a
threshold change. Their fixture/routing correction remains separate work.

The first remote continuation run also found two legacy contract assertions:
an exhausted checkpoint was expected to restart, and a failed document runner
was expected to finish `completed`. Both were updated to the intentional safe
contract and strengthened with zero-effect, zero-fallback and preserved-state
assertions. Their full 17-case suites are now included in both local/native
gates. No checks were removed and the healthy resume/success cases remain.

## OpenClaw attribution and boundary

OpenClaw is used as an architectural reference under MIT. Its [license](https://github.com/openclaw/openclaw/blob/615e964314e41ab7f255c31999537c6a5c85b3c3/LICENSE)
is retained in `docs/upstream/OPENCLAW-LICENSE` and attributed in
`THIRD_PARTY_NOTICES.md`.

Sources inspected at upstream revision
`615e964314e41ab7f255c31999537c6a5c85b3c3`:

- [No-progress tool-loop detection](https://github.com/openclaw/openclaw/blob/615e964314e41ab7f255c31999537c6a5c85b3c3/src/agents/tool-loop-detection.ts).
- [Replay-safe tool identity and pairing](https://github.com/openclaw/openclaw/blob/615e964314e41ab7f255c31999537c6a5c85b3c3/src/agents/tool-call-id.ts).

For the continuation, no-progress and argument-churn source/tests were inspected
at `c8444424e0c3d3475f5e296bd81da734fceba70e`:
[loop detection](https://github.com/openclaw/openclaw/blob/c8444424e0c3d3475f5e296bd81da734fceba70e/src/agents/tool-loop-detection.ts),
[argument churn](https://github.com/openclaw/openclaw/blob/c8444424e0c3d3475f5e296bd81da734fceba70e/src/agents/tool-loop-argument-churn.ts),
and [MIT license](https://github.com/openclaw/openclaw/blob/c8444424e0c3d3475f5e296bd81da734fceba70e/LICENSE).
Upstream thresholds and its `{details,text}` result extraction are not copied;
native fingerprints use SiraGPT's full structured outcome and existing bounded
rejection counters. The other completion/resume fixes follow local defects.

For complete-turn history retention, the existing inactive local reference
`src/upstream/openclaw/agents/pi-embedded-runner/history.ts` was also inspected.
Its original upstream revision was not independently verified; it must not be
attributed to the pinned revision above. The bounded-character packer is a new
native implementation and does not import or execute that reference file.

The implementation fixes the observed SiraGPT defects under its own CommonJS
runtime, checkpoint and dispatcher contracts. It does not copy the full upstream
tree, activate its gateway, install its personal-device integrations, transfer
credentials, bypass permissions or replace the SiraGPT UI. No upstream install
script runs. Existing snapshots remain reference-only.

The playbook report's 36 covered workflows and 33 local skills are workflow
inventory, **not proof of all public OpenClaw capabilities**. Its zero public
skills in that report must not be reported as 100% functional parity.

## Other open-source candidates: evidence-led next increments

These repositories were reviewed, not silently installed or enabled:

| Candidate | Existing SiraGPT status | Useful next increment / gate |
|---|---|---|
| BullMQ (MIT) | Already used by `agents/agent-task-queue.js`; attempts=1 and task identity are present. | Test stalled-job recovery and ambiguous completion with idempotent effects. Attempts=1 is not exactly-once execution. Keep Pro/commercial features separate. |
| MCP TypeScript SDK (installed v1, MIT) | Already used by the hardened agent-harness MCP client. | Test revocation, reconnection and identity/policy isolation. Preserve pinned DNS, redirect and transport controls; upstream v2 is not a drop-in update and needs separate license/API review. |
| LangGraph JS checkpoint-postgres (MIT) | LangGraph and several persistence mechanisms already exist; some graph paths still use MemorySaver. | Select one owner-scoped durable path and test crash/resume before another backend is added. Adapter/core version compatibility and server-derived thread namespaces are gates. |
| Toxiproxy (MIT) | Not installed in this increment. | Highest-value new test-only candidate: inject Redis/Postgres latency and disconnections in isolated CI. Never attach fault injection to production or expose its admin port. |
| Open Policy Agent (Apache-2.0) | Found in integration catalog, not an active Rego authorization layer. | Reference for offline policy contract tests. Do not add latency to each message or replace existing RBAC without a separate reviewed design. |
| Promptfoo (MIT core) | Catalog entry and internal suite helper exist, but no actual CLI dependency is activated by this increment. | Useful next test-only candidate: offline deterministic output/trace assertions. Do not expose its unauthenticated community server, treat commercial features separately, and disable telemetry/update checks in isolated evaluation. |

Primary references checked:

- BullMQ [license](https://github.com/taskforcesh/bullmq/blob/25e6dc75e4649fbe10ae1164f365159ab2cab892/LICENSE),
  [stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs),
  [idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs).
- MCP [v1 license](https://github.com/modelcontextprotocol/typescript-sdk/blob/12b425678a76cd54b0452a2ccf1e5dc7740f73ef/LICENSE)
  and [newer API/transition](https://github.com/modelcontextprotocol/typescript-sdk/blob/5119ee7fd7790e335a3fb60ef36f85334e2a6326/README.md).
- LangGraph [Postgres checkpoint license](https://github.com/langchain-ai/langgraphjs/blob/bbbdb5aa8a50f7115bdfbb6e3cf020ee239e1842/libs/checkpoint-postgres/LICENSE).
- Toxiproxy [source and documentation](https://github.com/Shopify/toxiproxy/tree/40f7fd31bee529d824116bd2a11a9e3425e904ec)
  and [license](https://github.com/Shopify/toxiproxy/blob/40f7fd31bee529d824116bd2a11a9e3425e904ec/LICENSE).
- OPA [license](https://github.com/open-policy-agent/opa/blob/855776c6b19d2a0498b88566a2ef882ecfe1a2c8/LICENSE)
  and [policy testing](https://www.openpolicyagent.org/docs/policy-testing).
- Promptfoo at `6d0395a20520e19cf8889d572b879ec9c2831a52`:
  [license](https://github.com/promptfoo/promptfoo/blob/6d0395a20520e19cf8889d572b879ec9c2831a52/LICENSE),
  [JavaScript assertions](https://github.com/promptfoo/promptfoo/blob/6d0395a20520e19cf8889d572b879ec9c2831a52/site/docs/configuration/expected-outputs/javascript.md),
  [self hosting](https://github.com/promptfoo/promptfoo/blob/6d0395a20520e19cf8889d572b879ec9c2831a52/site/docs/usage/self-hosting.md)
  and [telemetry](https://github.com/promptfoo/promptfoo/blob/6d0395a20520e19cf8889d572b879ec9c2831a52/site/docs/configuration/telemetry.md).

No benchmark in this increment establishes the throughput, security or
production suitability of these candidates. Each future activation needs its
own compatibility, ownership, permission, failure-recovery and rollout proof.
