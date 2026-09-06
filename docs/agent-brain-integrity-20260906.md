# Agent brain integrity: native integration, 2026-09-06

Base: `production-main` at `845e0c48128634179b60e3dd67622412d2b42a52`.
Scope: the existing `agentic-chat-stream` → ReAct → tool dispatcher path.
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
- Read-safety classification still uses the existing name-based classifier.
  Cancellation of already-running tools remains cooperative. The older
  finalization breaker can still return degraded answers; this patch does not
  establish universal successful completion or exactly-once execution.

## Verification

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

## OpenClaw attribution and boundary

OpenClaw is used as an architectural reference under MIT. Its [license](https://github.com/openclaw/openclaw/blob/615e964314e41ab7f255c31999537c6a5c85b3c3/LICENSE)
is retained in `docs/upstream/OPENCLAW-LICENSE` and attributed in
`THIRD_PARTY_NOTICES.md`.

Sources inspected at upstream revision
`615e964314e41ab7f255c31999537c6a5c85b3c3`:

- [No-progress tool-loop detection](https://github.com/openclaw/openclaw/blob/615e964314e41ab7f255c31999537c6a5c85b3c3/src/agents/tool-loop-detection.ts).
- [Replay-safe tool identity and pairing](https://github.com/openclaw/openclaw/blob/615e964314e41ab7f255c31999537c6a5c85b3c3/src/agents/tool-call-id.ts).

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

No benchmark in this increment establishes the throughput, security or
production suitability of these candidates. Each future activation needs its
own compatibility, ownership, permission, failure-recovery and rollout proof.
