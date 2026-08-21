# Catalog first-party DeepSeek — 2026-08-18 11:03 America/Lima (2026-08-18T16:03Z)

Import = remap + durable catalog. No git clone. No OpenRouter. No Anthropic/Claude models.
No new departments. No OpenClaw/Hermes. No Prisma schema migration (no catalog Agent table; only AgentTask/Step/Approval/Audit/Checkpoint).

## Remap
- builder, crm-builder, enterprise-builder, erp-builder, hr-builder → provider=deepseek name=deepseek-v4-pro
- code-reviewer, researcher → provider=deepseek name=deepseek-v4-flash

## Files patched (host /opt/siragpt)
- agents/builder.toml
- agents/code-reviewer.toml
- agents/crm-builder.toml
- agents/enterprise-builder.toml
- agents/erp-builder.toml
- agents/hr-builder.toml
- agents/researcher.toml
- server/agents/registry.ts (default deepseek / deepseek-v4-flash)
- components/enterprise/agents-list.tsx (labels DeepSeek V4 Pro / Flash; no restyle)
- Dockerfile (COPY agents into standalone runner so the catalog survives the image)

Backups: `*.bak-catalog-deepseek-20260818T155035Z`
Rollback image: `siragpt-frontend:pre-catalog-deepseek-20260818T155035Z`

## Service
- Recreated: frontend only (`siragpt-frontend:latest` 825b0135dd00, created 11:02 Lima / 16:02Z, healthy)
- Compose: `docker-compose.prod.yml` + `docker-compose.production.override.yml` --env-file .env
- Command: `build frontend` then `up -d --no-deps --force-recreate frontend`
- Untouched: backend, db, redis, caddy, runner, webtops
- Never `down` / `down -v`

## Live proof
- Host + container `agents/*.toml`: zero `claude-sonnet-4` / `provider = "anthropic"`
- Compiled registry default: `deepseek` / `deepseek-v4-flash`
- GET http://127.0.0.1:3000/api/agents count=7:
  - builder → deepseek-v4-pro
  - code-reviewer → deepseek-v4-flash
  - crm-builder → deepseek-v4-pro
  - enterprise-builder → deepseek-v4-pro
  - erp-builder → deepseek-v4-pro
  - hr-builder → deepseek-v4-pro
  - researcher → deepseek-v4-flash
- /chat 200 and /code 200 on 127.0.0.1:3000 and https://siragpt.com
