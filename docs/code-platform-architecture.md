# SiraGPT Code: product architecture

Status: approved direction, July 2026. This document is the engineering contract
for turning `/code` into a real software delivery platform. It deliberately does
not vendor or merge whole coding-agent repositories.

## Product contract

A completed `/code` task must produce a runnable repository, not a screenshot or
an interface mock. Depending on the request, the repository includes frontend,
backend, PostgreSQL schema and migrations, seed data, authentication/authorization,
tests, health checks, container build metadata and a deployment record.

The platform may only call work complete after these gates pass with real output:

1. dependencies install from a pinned manifest/lockfile;
2. typecheck and unit/integration tests pass;
3. database migrations and seed run successfully against an isolated database;
4. the application boots and its health endpoint responds;
5. Playwright loads the preview and reports no fatal console/network errors;
6. an independent reviewer agent inspects the diff and test evidence;
7. a Git checkpoint is persisted and every action remains replayable.

Migration, seed, build or health failures are blocking. The platform must never
promote a deployment and merely log that one of those stages failed.

## Architecture decision: adapters, not repository fusion

SiraGPT owns authentication, policy, project/run state, budgets, approvals,
events and the stable `AgentAdapter`/`SandboxProvider` contracts. External open
source projects run as version-pinned workers behind those contracts. This keeps
upgrades and license audits possible and prevents several engines from mutating
the same checkout concurrently.

Recommended workers and boundaries:

| Component | License | Role |
| --- | --- | --- |
| Cline SDK | Apache-2.0 | primary implementation worker behind `AgentAdapter` |
| OpenCode | MIT | independent review/repair worker through its server API |
| OpenHands Software Agent SDK | MIT | optional remote/ACP worker |
| Aider | Apache-2.0 | repo-map/patch and lint-repair worker, invoked as a process |
| SWE-agent | MIT | benchmark/evaluation harness, never production control plane |
| OpenSandbox | Apache-2.0 | preferred sandbox lifecycle API, subject to load spike |
| gVisor or Kata | Apache-2.0 | hostile-code isolation boundary |
| Temporal | MIT | eventual single durable workflow authority for hour/day jobs |
| PostgreSQL/pgvector | PostgreSQL/Apache-2.0 | control state and isolated app databases |
| Playwright | Apache-2.0 | deterministic browser acceptance gate |

Do not embed archived Continue/Roo Code, AGPL Daytona in the closed SaaS, the
PolyForm OpenHands enterprise tree, community MCP servers without review, or
several schedulers as competing sources of truth. `THIRD_PARTY_LICENSES.md`, the
SBOM and pinned revisions are required for every adopted component.

## Target data and execution flow

```text
/code (Monaco, terminal, SSE timeline, isolated preview)
  -> Sira control plane (auth, policy, projects, quotas, approvals)
  -> one durable workflow per request
  -> AgentAdapter router
       -> implementer (Cline/native)
       -> reviewer/repairer (OpenCode)
       -> optional ACP workers (OpenHands/Goose)
  -> SandboxProvider (one isolated workspace per run/agent)
       -> Git worktree + command/filesystem API
       -> project-scoped PostgreSQL credentials
       -> build/test/Playwright
  -> signed artifacts, deployment and project database lifecycle
```

Planner, implementer and reviewer use separate Git worktrees. Parallel agents
never write the same filesystem. Only a reviewed patch is merged into the
project branch.

## Isolation requirements

The legacy shared Bun runner is a canary bridge, not a multi-tenant security
boundary. Public execution remains disabled while
`CODEX_SANDBOX_PROVIDER=shared-runner`. `CODEX_RUNNER_ISOLATION_MODE` is only an
operational label: access policy trusts the provider's immutable, validated
boot attestation and never treats an environment string as proof of isolation.

The production sandbox provider must supply, per workspace:

- a separate container sandbox or microVM with non-root UID, cgroups, PID/file/
  CPU/memory/disk/inode limits and read-only base image;
- no Docker socket, host mounts, production `.env`, control database or Redis;
- deny-by-default egress, with audited proxy access for package registries,
  source hosts and explicitly approved user targets;
- short-lived scoped credentials delivered at runtime, never committed or sent
  to the browser;
- an origin/subdomain, token and TTL unique to the preview;
- snapshots/checkpoints and idempotent resume after worker loss.

The interim runner must at minimum authenticate its control API, strip its own
environment before spawning untrusted code, use a distinct UID per project,
kill process groups on timeout, apply `prlimit`, live on a network without the
control PostgreSQL/Redis services and remain limited to trusted canaries.
Writer subagents stay serialized with `CODEX_PARALLEL_WRITE_SUBAGENTS=false`
until the provider assigns a separate Git worktree and sandbox to each writer.

## PostgreSQL contract

The Sira control database and user-created application databases are separate
blast radii. Each application receives its own database and login role (or an
equivalent provider branch), a strong scoped credential, connection limit,
backup/PITR policy and lifecycle record. PgBouncer sits in front of project
databases before broad rollout.

`DATABASE_URL` and `PRISMA_DATABASE_URL` are injected into the isolated sandbox
and deployed container only. They are encrypted at rest in the control plane,
redacted from events/logs and rotated/revoked when a project is deleted or
compromised. Database provisioning, `prisma migrate deploy`, seed and a CRUD
smoke test are idempotent and blocking.

## Rollout

1. **Containment:** canary-only `/code`, legacy host runner off, authenticated
   control API, network separation, resource limits and no inherited secrets.
2. **Sandbox provider:** put the current runner client behind
   `SandboxProvider`; validate OpenSandbox + gVisor on staging with hostile-code,
   restart/resume and load tests.
3. **Real project database:** extract the existing idempotent deployment
   provisioner into a project database service; add an encrypted 1:1 lifecycle
   record and a Prisma/PostgreSQL full-stack starter.
4. **Agent adapters:** pin Cline SDK as implementer, use the existing OpenCode
   bridge as reviewer, then add optional OpenHands/ACP workers.
5. **Durable hours-long workflows:** migrate run orchestration to Temporal with
   leases, checkpoints, retry, cancellation, human approval and budget policy.
6. **Real publishing:** immutable image, SBOM/scan/signature, isolated app
   network, migrations, health gate, domain/TLS, rollback and observability.
7. **General availability:** reopen public access only after adversarial sandbox,
   tenant-isolation, restore, cost-limit and incident-response gates pass.
