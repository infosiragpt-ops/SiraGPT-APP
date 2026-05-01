# CTO Roadmap: Commercial AI Ecosystem

Date: 2026-05-01
Baseline reviewed: `main` after Phase 6D + 7A/7B/7C (`92d9c11`)

This document is the current CTO-level audit for turning SiraGPT into a commercial AI ecosystem comparable in scope to ChatGPT, Gemini, Claude, Codex, Claude Code and Cursor. It is intentionally dependency-first and risk-controlled: no GitHub repository is copied into the product, no GPL/AGPL package is approved for the commercial core, and every new dependency must pass license, maintenance, vulnerability and compatibility checks before installation.

## Executive Diagnosis

SiraGPT already has a broad product surface:

| Area | Current state | Commercial gap |
|---|---|---|
| Frontend/chat | Next.js 14, React 18, Radix/Tailwind, advanced chat composer, file attachments, document preview, Markdown/KaTeX/Shiki, Codex page and SWR cache for GitHub Codex | Chat state is still concentrated in large components; more flows need shared server-state caching, deterministic streaming contracts and UI-level e2e coverage |
| Backend/API gateway | Express API with route modules for auth, chats, files, AI, RAG, agents, payments, admin, enterprise, connectors and observability | CORS is permissive, many route contracts are implicit, and API/tool schemas need machine-readable OpenAPI/JSON Schema output |
| Authentication | JWT/session based auth, Google OAuth, admin guard, agent keys and account routes | Needs production OAuth hardening, token vault policy, connector-scoped permissions, MFA/session risk controls and tenant-level entitlement checks |
| Database/storage | Prisma/Postgres models for users, chats, messages, files, payments, projects, agent tasks/events and pgvector RAG migrations | Needs stronger migration discipline, data retention policy, tenant isolation review and object storage strategy for uploaded/generated files |
| Chat/streaming | SSE routes, stop-stream, pending stream recovery, agent task event stream, durable task events | Needs one canonical streaming envelope across chat, agent, artifact and Codex flows, with reconnect semantics and contract tests |
| Model routing | OpenAI-compatible adapters for OpenAI/OpenRouter/Gemini/DeepSeek plus catalog/plan gating | Claude should use the official Anthropic SDK instead of OpenAI-compatible compatibility mode where direct Claude behavior matters |
| Files/documents | MIME/extension policy, ExcelJS, Mammoth, PDF/PPTX validators, OCR, document generation and preview sanitization | Needs malware scanning, storage quarantine, background processing queues, larger-file chunking and full preview fidelity tests |
| RAG/OCR | Hybrid retrieval, BM25/MMR/reranking, pgvector option, GitHub repo RAG, code chunking and citations | Needs incremental indexing, dedup by content hash, per-source freshness, repo diff ingestion, citation quality gates and retrieval eval dashboards |
| Agents/code | BullMQ durable agent tasks, task tools, document generation through sandboxed Python, code review/generation agents and Codex GitHub context | Needs stronger process/container isolation, resource quotas, audit logs, patch application workflow and secure secret boundaries |
| Connectors | Gmail/Google, Spotify, Figma, GitHub Codex and enterprise/tool registry surfaces | Needs MCP hub, connector manifest standard, OAuth token vault, connector marketplace and per-tool approval/audit trail |
| Payments/plans | Stripe, PayPal, MercadoPago, usage and subscription routes | Needs central entitlement service, usage-meter events, plan enforcement at every expensive tool and billing reconciliation jobs |
| Observability | Pino, request IDs, Prometheus metrics, OpenTelemetry opt-in, Sentry opt-in, Bull Board admin dashboard and health probes | Needs SLO dashboards, span coverage inside RAG/agents/providers, alert policy and trace-to-user/task correlation in admin UI |
| CI/CD/security | npm audit critical gate, license gate, SBOM, frontend build/type/lint, backend boot smoke and targeted agent/RAG/document tests | Needs required e2e promotion, dependency update policy, deployment rollout runbook and branch protection confirmation after each merge |

## Gap Map vs ChatGPT + Gemini + Claude + Codex + Cursor

| Capability | Target behavior | Current status | Priority |
|---|---|---|---|
| ChatGPT/Gemini-class chat | Fast streaming, model selector, files, memory, multimodal previews, share/history and stable retries | Mostly present; needs unified streaming protocol and more cache coverage | P0 |
| Claude-class reasoning/docs | Long context, citations, document analysis, artifact-quality responses and safe tool use | Strong internal document and agent pipeline; needs better provider-native Claude SDK path | P1 |
| Codex/Cursor-class repo work | GitHub context, code RAG, issue/PR/action context, patch suggestions and test feedback | GitHub context/RAG present; needs retry/throttle, diff-aware ingestion and patch workflow | P0 |
| Claude Code-style agents | Long-running tasks, tool calls, checkpoints, artifacts, approvals and repair loops | Durable agent tasks present; needs sandbox hardening and tool schema export | P0 |
| Commercial SaaS controls | Plans, usage, payments, admin, audit, monitoring, tenant isolation and compliance evidence | Partially present; entitlement/usage metering needs centralization | P1 |
| Enterprise integrations | OAuth connectors, MCP tools, external APIs, token vault, per-tool approvals | Several bespoke connectors present; needs standard MCP/manifest layer | P1 |

## Dependency Audit Snapshot

The candidates below were checked on 2026-05-01 using npm registry metadata, npm download statistics and OSV package queries. OSV returned no known vulnerabilities for the exact candidate versions listed. These are candidates for the next integration phases; they are not installed by this document.

| Phase | Dependency | URL | Recommended version | License | Last npm modification | Last-month npm downloads | Purpose | Benefit | Risk | Files likely touched | Alternatives | Selection reason |
|---|---|---|---:|---|---|---:|---|---|---|---|---|---|
| 8A | `@octokit/plugin-throttling` | https://github.com/octokit/plugin-throttling.js | `11.0.3` | MIT | 2025-10-31 | 30.2M | GitHub API rate-limit handling | Makes Codex/GitHub RAG resilient under real use | ESM + Octokit composition change | `backend/src/services/github-codex-connector.js`, tests | Custom retry headers | Official Octokit plugin that implements GitHub's recommended throttling behavior |
| 8A | `@octokit/plugin-retry` | https://github.com/octokit/plugin-retry.js | `8.1.0` | MIT | 2026-02-18 | 33.2M | Retry transient GitHub failures | Fewer failed repo analyses/ingests | Must avoid retrying 401/403/validation errors | `backend/src/services/github-codex-connector.js`, tests | Manual retry wrapper | Official plugin, small scope, compatible with existing `octokit` dependency |
| 8B | `@modelcontextprotocol/sdk` | https://github.com/modelcontextprotocol/typescript-sdk | `1.29.0` | MIT | 2026-03-30 | 140M | MCP client/server contracts | Standardizes external tools/connectors like modern AI IDEs | New protocol surface; needs allowlist and auth policy | `backend/src/services/connectors/*`, `backend/src/routes/enterprise.js`, docs/tests | Bespoke connector registry only | Official SDK, permissive license and high ecosystem adoption |
| 8C | `zod-to-json-schema` | https://github.com/StefanTerdell/zod-to-json-schema | `3.25.2` | ISC | 2026-03-27 | 167M | Export tool schemas | Keeps agent/tool validation and documentation in sync | Zod v3/v4 compatibility needs tests | tool registry, enterprise schema routes, docs | Manual JSON Schema | Low-risk bridge from existing `zod` usage to tool manifests |
| 8C | `@asteasolutions/zod-to-openapi` | https://github.com/asteasolutions/zod-to-openapi | `8.5.0` | MIT | 2026-03-20 | 9M | Generate OpenAPI specs | Makes API gateway contracts professional and testable | Route-by-route migration effort | `backend/src/routes/*`, new `openapi` service/tests | `swagger-jsdoc` | Uses source-of-truth schemas rather than comment parsing |
| 8D | `supertest` | https://github.com/ladjs/supertest | `7.2.2` | MIT | 2026-01-06 | 54M | Express HTTP integration tests | Tests auth/route behavior without booting full server | Dev-only dependency | `backend/tests/*`, `backend/package.json` | Native `fetch` against app server | Mature Express testing tool, direct fit for current backend |
| 8D | `msw` | https://github.com/mswjs/msw | `2.14.2` | MIT | 2026-04-29 | 64M | Mock external APIs in tests | Stable frontend/service tests for GitHub/OpenAI/Stripe-like flows | Setup overhead | `tests/*`, `e2e/*`, service tests | Manual fetch mocks | Strong ecosystem, browser + Node mocking |
| 8E | `quick-lru` | https://github.com/sindresorhus/quick-lru | `7.3.0` | MIT | 2025-10-10 | 155M | Bounded in-memory cache | Safer model catalog/GitHub metadata/RAG manifest cache | ESM-only; not distributed cache | backend services, frontend services | `lru-cache` | MIT alternative to `lru-cache` which declares BlueOak |
| 8E | `p-limit` | https://github.com/sindresorhus/p-limit | `7.3.0` | MIT | 2026-02-03 | 1.0B | Promise concurrency control | Prevents bursts in RAG/OCR/GitHub fetches | ESM-only; backend CommonJS adapters needed | RAG/OCR/GitHub ingestion | Existing `bottleneck` | Use only where a small local limiter is better than global Bottleneck |
| 8F | `@anthropic-ai/sdk` | https://github.com/anthropics/anthropic-sdk-typescript | `0.92.0` | MIT | 2026-04-30 | 63M | Native Claude provider | Better Claude messages/tool-use behavior than compatibility routing | Provider-specific streaming adapter work | provider service/model adapter/tests | OpenRouter/OpenAI-compatible Anthropic route | Official SDK and commercial-compatible |
| 8G | `jose` | https://github.com/panva/jose | `6.2.3` | MIT | 2026-04-27 | 283M | JWT/JWE/JWK primitives | Token vault encryption/signing for connectors | Crypto misuse risk; needs narrow wrappers | auth/connectors token vault | `jsonwebtoken` only | Modern WebCrypto-compatible primitive set for secure connector tokens |
| 8H | `clamscan` | https://github.com/kylefarris/clamscan | `2.4.0` | MIT | 2024-10-21 | 1.0M | ClamAV integration | Malware scan before document/RAG ingestion | Requires external ClamAV/clamd operationally | upload pipeline, workers, docs | Cloud malware scanning service | MIT wrapper; keep optional and disabled unless infrastructure exists |

Rejected or isolated candidates:

| Dependency | Reason |
|---|---|
| `lru-cache@11.3.5` | Mature and active but declares `BlueOak-1.0.0`; use `quick-lru` MIT in the commercial core unless legal explicitly approves BlueOak |
| `vm2@3.10.5` | MIT and OSV-clean at the checked version, but in-process untrusted-code execution has a high escape blast radius; prefer out-of-process/container sandboxing or provider-managed sandboxes |
| GPL/AGPL/LGPL packages | Not allowed in the commercial core without explicit approval, legal review and replaceable technical isolation |

## Phase Plan

### Phase 8A: Harden GitHub Codex/Cursor Connector

Problem solved: repo analysis and GitHub RAG currently work, but production usage needs GitHub-aware retry/throttle behavior to survive secondary rate limits, transient 5xx responses and bursty user workflows.

Dependencies: `@octokit/plugin-throttling@11.0.3`, `@octokit/plugin-retry@8.1.0`.

Implementation scope:

- Compose Octokit with retry/throttle plugins inside `backend/src/services/github-codex-connector.js`.
- Add environment controls for max retries, retry-after cap and GitHub request concurrency.
- Add tests that simulate 403 secondary rate limits, 5xx retries and non-retryable auth failures.

Validation:

```bash
cd backend
node --test tests/github-codex-connector.test.js
npm audit --omit=dev --audit-level=critical
cd ..
npm run licenses:check
```

### Phase 8B: MCP Connector Hub

Problem solved: the platform already has bespoke connectors, but an ecosystem like Claude/Cursor needs a standard tool protocol. MCP gives a maintained contract for tool discovery, invocation and future external integrations.

Dependency: `@modelcontextprotocol/sdk@1.29.0`.

Implementation scope:

- Add an internal MCP registry service that exposes only approved SiraGPT tools.
- Start with read-only tool manifests for GitHub Codex, RAG retrieve, project memory and document preview.
- Require auth, tenant scope and tool allowlists before any invocation.
- Do not expose browser-provided tokens or arbitrary MCP servers in Phase 8B.

Validation:

```bash
cd backend
node --test tests/mcp-tool-registry.test.js tests/sira-production-wiring.test.js
cd ..
npm run licenses:check
```

### Phase 8C: Tool Contracts and OpenAPI

Problem solved: many routes and tools are real but implicit. Commercial SDKs, agents and CI need machine-readable contracts.

Dependencies: `zod-to-json-schema@3.25.2`, optional `@asteasolutions/zod-to-openapi@8.5.0`.

Implementation scope:

- Create a small schema registry for high-value routes first: `/api/codex/github/*`, `/api/agent/task`, `/api/files/upload`, `/api/rag/*`.
- Export JSON Schema for agent tools and OpenAPI for selected routes.
- Add drift tests so request validators and exported contracts stay aligned.

Validation:

```bash
cd backend
node --test tests/tool-schema-export.test.js tests/openapi-contracts.test.js
```

### Phase 8D: HTTP Integration Testing

Problem solved: current tests cover many pure services, but API gateway behavior needs route-level auth, validation and error contract tests.

Dependencies: `supertest@7.2.2`, optional `msw@2.14.2` for external HTTP mocks.

Implementation scope:

- Export the Express app without forcing network bind in tests where practical.
- Add Supertest coverage for GitHub Codex, queues, health, upload policy and agent task status.
- Use MSW only for service tests that need realistic external HTTP behavior.

Validation:

```bash
cd backend
node --test tests/http-codex.test.js tests/http-upload.test.js tests/http-agent-task.test.js
```

### Phase 8E: Incremental RAG and Cache Controls

Problem solved: GitHub RAG currently ingests selected files, but production repos need incremental refresh, cache bounds and content-hash dedup.

Dependencies: prefer existing `bottleneck`; add `quick-lru@7.3.0` only where bounded local cache is needed. Add `p-limit@7.3.0` only if local promise limiting is simpler than Bottleneck for a specific loop.

Implementation scope:

- Hash repo file content and skip unchanged files.
- Store `repo`, `branch`, `path`, `sha`, `bytes`, `indexedAt` metadata per chunk.
- Add a manifest endpoint showing freshness and skipped files.

Validation:

```bash
cd backend
node --test tests/github-codex-connector.test.js tests/rag-service.hybrid.test.js tests/sira-hybrid-retrieval-migration.test.js
```

### Phase 8F: Native Claude Provider

Problem solved: Claude-class behavior, especially tool use and streaming semantics, should use the official provider SDK where direct Anthropic calls are configured.

Dependency: `@anthropic-ai/sdk@0.92.0`.

Implementation scope:

- Add a provider adapter behind the existing model router.
- Keep OpenRouter fallback intact.
- Add streaming contract tests against mocked provider responses.

Validation:

```bash
cd backend
node --test tests/model-provider-anthropic.test.js tests/sira-model-adapter-instrumentation.test.js
```

### Phase 8G: Connector Token Vault

Problem solved: connectors need consistent storage, encryption, rotation and scope reporting before the product can support a marketplace-like experience.

Dependency: `jose@6.2.3` only if the existing token encryption model is not sufficient.

Implementation scope:

- Centralize OAuth token envelope format.
- Record provider, scopes, expiration, refresh status and owner/tenant.
- Add audit events for connect, refresh, revoke and failed refresh.

Validation:

```bash
cd backend
node --test tests/connector-token-vault.test.js tests/auth-token-policy.test.js
```

### Phase 8H: Upload Malware Scanning

Problem solved: MIME and preview sanitization reduce content risks, but commercial file ingestion needs malware/quarantine controls before OCR, RAG and document parsing.

Dependency: `clamscan@2.4.0`, optional and infrastructure-gated.

Implementation scope:

- Add a `FILE_SCAN_ENABLED=false` default.
- Scan uploaded files before text extraction or RAG ingestion when `clamd` is configured.
- Quarantine failed/suspicious files and expose status in file processing state.

Validation:

```bash
cd backend
node --test tests/upload-security-policy.test.js tests/file-processing-status.test.js tests/file-scan-policy.test.js
```

## Production Controls Before Every Phase

1. Re-check npm metadata, license, deprecation, download activity and OSV for the exact version.
2. Install only through npm lockfiles; never copy repository code.
3. Update `THIRD_PARTY_LICENSES.md` with `npm run licenses:report`.
4. Run `npm run licenses:check` and `npm audit --omit=dev --audit-level=critical` in affected workspaces.
5. Add focused tests before expanding UI.
6. Commit one small reversible phase at a time.
7. Push to `sira-org main` only after local validation, then watch GitHub Actions until `CI - required checks passed` is green.

## Recommended Next Integration

Proceed with **Phase 8A** first. It is the best next step because the GitHub Codex/RAG surface is already user-visible, already integrated into the UI, and currently lacks official GitHub retry/throttle behavior. The dependency delta is small, MIT-licensed, official Octokit-maintained and directly improves professional reliability without changing product architecture.
