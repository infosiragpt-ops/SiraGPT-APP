#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/siragpt}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-frontend}"
PM2_APP="${PM2_APP:-siraGPT-api}"
DEPLOY_AUTO_STASH_LOCAL_CHANGES="${DEPLOY_AUTO_STASH_LOCAL_CHANGES:-1}"

FRONTEND_URL="${FRONTEND_URL:-https://siragpt.com/auth/login}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.siragpt.com/health}"
GOOGLE_AUTH_URL="${GOOGLE_AUTH_URL:-https://api.siragpt.com/api/auth/google}"
EXPECTED_GOOGLE_REDIRECT_URI="${EXPECTED_GOOGLE_REDIRECT_URI:-https://api.siragpt.com/api/auth/google/callback}"
AUTH_CSRF_URL="${AUTH_CSRF_URL:-https://api.siragpt.com/api/auth/csrf-token}"
AUTH_LOGIN_URL="${AUTH_LOGIN_URL:-https://api.siragpt.com/api/auth/login}"

export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://api.siragpt.com/api}"
export NEXT_PUBLIC_URL="${NEXT_PUBLIC_URL:-https://siragpt.com}"

log() {
  printf '[deploy-production] %s\n' "$*"
}

fail() {
  printf '[deploy-production] ERROR: %s\n' "$*" >&2
  exit 1
}

run_bounded_prisma() {
  (
    cd "${APP_DIR}/backend"
    node -e '
      const boot = require("./scripts/start-with-migrations");
      boot.runPrisma(process.argv.slice(1))
        .then((result) => {
          process.exitCode = boot.prismaCommandExitStatus(result);
        })
        .catch((error) => {
          process.stderr.write(`${error && error.code ? error.code : "MIGRATION_COMMAND_FAILED"}\n`);
          process.exitCode = 1;
        });
    ' "$@"
  )
}

run_bounded_prisma_with_stdin() {
  (
    cd "${APP_DIR}/backend"
    node -e '
      const fs = require("node:fs");
      const boot = require("./scripts/start-with-migrations");
      const input = fs.readFileSync(0);
      boot.runPrisma(process.argv.slice(1), { input })
        .then((result) => {
          process.exitCode = boot.prismaCommandExitStatus(result);
        })
        .catch((error) => {
          process.stderr.write(`${error && error.code ? error.code : "MIGRATION_COMMAND_FAILED"}\n`);
          process.exitCode = 1;
        });
    ' "$@"
  )
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

cleanup_docker_space() {
  if [[ "${DEPLOY_PRUNE_DOCKER:-1}" != "1" ]]; then
    log "Skipping Docker prune because DEPLOY_PRUNE_DOCKER is disabled"
    return 0
  fi

  log "Docker disk usage before cleanup"
  df -h / /var/lib/docker 2>/dev/null || df -h / || true
  docker system df || true

  log "Pruning Docker build cache, unused images, and stopped containers"
  docker builder prune -af || true
  docker image prune -af || true
  docker container prune -f || true

  log "Docker disk usage after cleanup"
  docker system df || true
  df -h / /var/lib/docker 2>/dev/null || df -h / || true
}

cleanup_frontend_container_conflicts() {
  local ids
  log "Removing stale frontend containers before recreate"

  # Compose can leave a stale/recreated frontend container behind after
  # interrupted deploys. When that happens, `docker compose up` fails with
  # "container name is already in use" even though the new image built fine.
  docker compose -f "$COMPOSE_FILE" rm -sf "$FRONTEND_SERVICE" >/dev/null 2>&1 || true
  docker rm -f siragpt-frontend-1 >/dev/null 2>&1 || true

  ids="$(
    docker ps -aq \
      --filter "label=com.docker.compose.service=${FRONTEND_SERVICE}" \
      --filter "name=siragpt-frontend-1" 2>/dev/null || true
  )"
  if [[ -n "$ids" ]]; then
    docker rm -f $ids >/dev/null 2>&1 || true
  fi

  # Some interrupted deploys leave the frontend container attached to a
  # different Compose project label, so the label/name filter above can miss
  # the exact name Docker later refuses to recreate.
  if docker ps -aq --filter "name=^/siragpt-frontend-1$" | grep -q .; then
    docker rm -f siragpt-frontend-1 >/dev/null 2>&1 || true
  fi

  if docker ps -aq --filter "name=^/siragpt-frontend-1$" | grep -q .; then
    fail "Unable to remove existing siragpt-frontend-1 container before recreate"
  fi
}

handle_local_tracked_changes() {
  if git diff --quiet && git diff --cached --quiet; then
    return 0
  fi

  if [[ "$DEPLOY_AUTO_STASH_LOCAL_CHANGES" != "1" ]]; then
    fail "Git worktree has local tracked changes. Commit, stash, or discard them before deploy."
  fi

  local stash_name
  stash_name="deploy-production auto-stash before ${BRANCH} update $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "Git worktree has local tracked changes; saving recoverable stash: ${stash_name}"
  git status --short
  git stash push --message "$stash_name"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Git worktree still has local tracked changes after auto-stash."
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local attempts="${3:-30}"
  local delay="${4:-2}"
  local status=""

  for ((i = 1; i <= attempts; i += 1)); do
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
    if [[ "$status" == 2* || "$status" == 3* ]]; then
      log "$name is healthy ($status): $url"
      return 0
    fi
    sleep "$delay"
  done

  fail "$name did not become healthy after $((attempts * delay))s: $url (last status: ${status:-none})"
}

pm2_app_exists() {
  pm2 describe "$1" >/dev/null 2>&1
}

resolve_pm2_app() {
  local candidate detected
  local candidates="${PM2_APP_CANDIDATES:-${PM2_APP},siraGPT-api,sira-api,sira-api-backend,siragpt-api,siragpt-backend,backend}"

  IFS=',' read -r -a candidate_list <<< "$candidates"
  for candidate in "${candidate_list[@]}"; do
    candidate="$(printf '%s' "$candidate" | xargs)"
    [[ -n "$candidate" ]] || continue
    if pm2_app_exists "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  detected="$(
    pm2 jlist 2>/dev/null | node -e '
      const fs = require("fs");
      let list = [];
      try {
        const input = fs.readFileSync(0, "utf8").trim();
        list = input ? JSON.parse(input) : [];
      } catch {
        list = [];
      }
      const text = (p) => [
        p && p.name,
        p && p.pm2_env && p.pm2_env.pm_cwd,
        p && p.pm2_env && p.pm2_env.cwd,
        p && p.pm2_env && p.pm2_env.pm_exec_path,
        p && p.pm2_env && p.pm2_env.script
      ].filter(Boolean).join(" ");
      const preferred = list.find((p) => /siragpt|sira|backend|api/i.test(text(p)) && /siraGPT|siraNew|backend/i.test(text(p)));
      const fallback = list.find((p) => /siragpt|sira|backend|api/i.test(text(p)));
      const found = preferred || fallback;
      if (found && found.name) process.stdout.write(found.name);
    '
  )"

  if [[ -n "$detected" ]] && pm2_app_exists "$detected"; then
    printf '%s\n' "$detected"
    return 0
  fi

  return 1
}

restart_pm2_backend() {
  local resolved_pm2_app
  if ! resolved_pm2_app="$(resolve_pm2_app)"; then
    fail "PM2 backend process not found. Set PM2_APP to the active backend process name."
  fi

  if [[ "$resolved_pm2_app" != "$PM2_APP" ]]; then
    log "PM2 backend default '$PM2_APP' not found; using detected process: $resolved_pm2_app"
  fi

  log "Restarting PM2 backend: $resolved_pm2_app"
  pm2 restart "$resolved_pm2_app" --update-env
}

read_google_redirect_uri() {
  local location
  location="$(curl -fsS -o /dev/null -w '%{redirect_url}' "$GOOGLE_AUTH_URL")"
  [[ -n "$location" ]] || fail "Google auth endpoint did not return a redirect URL"

  node -e '
    const location = process.argv[1];
    const parsed = new URL(location);
    process.stdout.write(parsed.searchParams.get("redirect_uri") || "");
  ' "$location"
}

verify_auth_login_path() {
  local cookie_jar csrf_payload csrf_token login_payload status

  cookie_jar="$(mktemp)"
  trap 'rm -f "$cookie_jar"' RETURN

  csrf_payload="$(curl -fsS -c "$cookie_jar" "$AUTH_CSRF_URL")" \
    || fail "Auth CSRF endpoint failed: $AUTH_CSRF_URL"

  csrf_token="$(
    node -e '
      try {
        const payload = JSON.parse(process.argv[1] || "{}");
        process.stdout.write(payload.csrfToken || "");
      } catch (_) {
        process.exit(1);
      }
    ' "$csrf_payload"
  )" || fail "Auth CSRF endpoint returned invalid JSON"

  [[ -n "$csrf_token" ]] || fail "Auth CSRF endpoint did not return csrfToken"

  login_payload="$(
    node -e '
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      process.stdout.write(JSON.stringify({
        email: `deploy-smoke-${suffix}@example.invalid`,
        password: `definitely-not-a-real-password-${suffix}`
      }));
    '
  )"

  status="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -b "$cookie_jar" -c "$cookie_jar" \
      -H "Content-Type: application/json" \
      -H "X-CSRF-Token: $csrf_token" \
      --data "$login_payload" \
      "$AUTH_LOGIN_URL" || true
  )"

  rm -f "$cookie_jar"
  trap - RETURN

  if [[ "$status" != "401" ]]; then
    fail "Auth login smoke expected 401 for invalid credentials, got ${status:-none}: $AUTH_LOGIN_URL"
  fi

  log "Auth login smoke is correct (invalid credentials return 401)"
}

resolve_prisma_migration_applied() {
  local migration_name="$1"

  run_bounded_prisma migrate resolve --schema prisma/schema.prisma --applied "${migration_name}"
}

repair_model_sync_migration() {
  local migration_name="20241125_add_model_sync_fields"

  log "Repairing Prisma migration state: ${migration_name}"
  log "Applying idempotent SQL for ${migration_name} before marking it applied"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
ALTER TABLE "ai_models"
  ADD COLUMN IF NOT EXISTS "lastSynced" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "syncSource" TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "contextLength" INTEGER,
  ADD COLUMN IF NOT EXISTS "pricing" JSONB,
  ADD COLUMN IF NOT EXISTS "tags" TEXT[];
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_init_baseline_migration() {
  local migration_name="20250919203029_init"

  log "Repairing Prisma baseline migration state: ${migration_name}"
  log "Verifying baseline schema objects exist before marking ${migration_name} applied"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProviderType') THEN
    RAISE EXCEPTION 'ProviderType enum is missing; cannot baseline init migration safely';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ModelType') THEN
    RAISE EXCEPTION 'ModelType enum is missing; cannot baseline init migration safely';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users table is missing; cannot baseline init migration safely';
  END IF;
  IF to_regclass('public.ai_models') IS NULL THEN
    RAISE EXCEPTION 'ai_models table is missing; cannot baseline init migration safely';
  END IF;
  IF to_regclass('public.sessions') IS NULL THEN
    RAISE EXCEPTION 'sessions table is missing; cannot baseline init migration safely';
  END IF;
  IF to_regclass('public.chats') IS NULL THEN
    RAISE EXCEPTION 'chats table is missing; cannot baseline init migration safely';
  END IF;
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'messages table is missing; cannot baseline init migration safely';
  END IF;
  IF to_regclass('public.files') IS NULL THEN
    RAISE EXCEPTION 'files table is missing; cannot baseline init migration safely';
  END IF;
END $$;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_stripe_integration_migration() {
  local migration_name="20250928102318_add_stripe_integration"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripePriceId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT,
  ADD COLUMN IF NOT EXISTS "subscriptionEndDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripeSessionId_key" ON "payments"("stripeSessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeCustomerId_key" ON "users"("stripeCustomerId");
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeSubscriptionId_key" ON "users"("stripeSubscriptionId");
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_stripe_enhancement_migration() {
  local migration_name="20251001184158_stripe_enahcement"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "usage_alerts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "alertType" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "subscription_events" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "previousPlan" TEXT,
  "newPlan" TEXT,
  "eventData" JSONB,
  "stripeEventId" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_events_stripeEventId_key"
  ON "subscription_events"("stripeEventId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'usage_alerts_userId_fkey') THEN
    ALTER TABLE "usage_alerts" ADD CONSTRAINT "usage_alerts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'notifications_userId_fkey') THEN
    ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'subscription_events_userId_fkey') THEN
    ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_monthly_limit_default_migration() {
  local migration_name="20251001211311_limit_set_monthly"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
ALTER TABLE "users" ALTER COLUMN "monthlyLimit" SET DEFAULT 1000;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_gmail_integration_migration() {
  local migration_name="20251021064736_add_gmail_integration"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gmailTokens" TEXT;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_optional_pgvector_migration() {
  local migration_name="$1"
  local feature_name="$2"

  log "Repairing optional pgvector migration state: ${migration_name}"
  log "${feature_name} requires the Postgres vector extension, which is optional for this deployment"
  log "Marking ${migration_name} applied so core auth/schema migrations can continue"
  (
    cd backend
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_user_memories_schema_migration() {
  local migration_name="20260520200000_add_user_memories"

  log "Repairing Prisma migration state without pgvector: ${migration_name}"
  log "Creating Prisma-compatible user memory tables with BYTEA embeddings"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "user_memories" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "category" TEXT,
  "importance_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "last_accessed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "access_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "user_memories_user_id_category_idx"
  ON "user_memories"("user_id", "category");

CREATE INDEX IF NOT EXISTS "user_memories_user_id_importance_score_idx"
  ON "user_memories"("user_id", "importance_score" DESC);

CREATE TABLE IF NOT EXISTS "user_memory_embeddings" (
  "id" TEXT NOT NULL,
  "memory_id" TEXT NOT NULL,
  "embedding" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_memory_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "user_memory_embeddings_memory_id_idx"
  ON "user_memory_embeddings"("memory_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'user_memories_user_id_fkey') THEN
    ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'user_memory_embeddings_memory_id_fkey') THEN
    ALTER TABLE "user_memory_embeddings" ADD CONSTRAINT "user_memory_embeddings_memory_id_fkey"
      FOREIGN KEY ("memory_id") REFERENCES "user_memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_universal_search_brain_migration() {
  local migration_name="20260427000000_universal_search_brain"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "universal_search_cache" (
  "id" TEXT NOT NULL,
  "queryHash" TEXT NOT NULL,
  "intentCategories" TEXT[] NOT NULL,
  "region" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "embeddingJson" JSONB,
  "metadata" JSONB,
  "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ttlSeconds" INTEGER NOT NULL,
  CONSTRAINT "universal_search_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "universal_search_cache_queryHash_provider_key"
  ON "universal_search_cache"("queryHash", "provider");

CREATE INDEX IF NOT EXISTS "universal_search_cache_queryHash_idx"
  ON "universal_search_cache"("queryHash");

CREATE INDEX IF NOT EXISTS "universal_search_cache_provider_cachedAt_idx"
  ON "universal_search_cache"("provider", "cachedAt");

CREATE TABLE IF NOT EXISTS "search_brain_settings" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "region" TEXT NOT NULL DEFAULT 'global',
  "mode" TEXT NOT NULL DEFAULT 'local',
  "userEmail" TEXT,
  "keys" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "search_brain_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "search_brain_settings_userId_key"
  ON "search_brain_settings"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'search_brain_settings_userId_fkey') THEN
    ALTER TABLE "search_brain_settings" ADD CONSTRAINT "search_brain_settings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_agentic_task_queue_migration() {
  local migration_name="20260427040000_add_agentic_task_queue"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "agent_tasks" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT,
  "jobId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "goal" TEXT NOT NULL,
  "model" TEXT,
  "traceId" TEXT,
  "documentPolicy" JSONB,
  "state" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "agent_task_events" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_task_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "generated_artifacts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "taskId" TEXT,
  "chatId" TEXT,
  "messageId" TEXT,
  "filename" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "path" TEXT,
  "sizeBytes" INTEGER NOT NULL,
  "previewHtml" TEXT,
  "validation" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generated_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_jobId_key" ON "agent_tasks"("jobId");
CREATE INDEX IF NOT EXISTS "agent_tasks_userId_updatedAt_idx" ON "agent_tasks"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "agent_tasks_status_updatedAt_idx" ON "agent_tasks"("status", "updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_task_events_taskId_seq_key" ON "agent_task_events"("taskId", "seq");
CREATE INDEX IF NOT EXISTS "agent_task_events_taskId_createdAt_idx" ON "agent_task_events"("taskId", "createdAt");
CREATE INDEX IF NOT EXISTS "generated_artifacts_userId_createdAt_idx" ON "generated_artifacts"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "generated_artifacts_taskId_createdAt_idx" ON "generated_artifacts"("taskId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'agent_tasks_userId_fkey') THEN
    ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'agent_tasks_chatId_fkey') THEN
    ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_chatId_fkey"
      FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'agent_task_events_taskId_fkey') THEN
    ALTER TABLE "agent_task_events" ADD CONSTRAINT "agent_task_events_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'generated_artifacts_userId_fkey') THEN
    ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'generated_artifacts_taskId_fkey') THEN
    ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'generated_artifacts_chatId_fkey') THEN
    ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_chatId_fkey"
      FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'generated_artifacts_messageId_fkey') THEN
    ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_scheduler_jobs_migration() {
  local migration_name="20260508000000_add_scheduler_jobs"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "scheduler_jobs" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "schedule" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "state" TEXT NOT NULL DEFAULT 'idle',
  "nextRunAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lastError" TEXT,
  "runCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lockedBy" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduler_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scheduler_jobs_nextRunAt_idx" ON "scheduler_jobs"("nextRunAt");
CREATE INDEX IF NOT EXISTS "scheduler_jobs_state_idx" ON "scheduler_jobs"("state");
CREATE INDEX IF NOT EXISTS "scheduler_jobs_lockedUntil_idx" ON "scheduler_jobs"("lockedUntil");

CREATE TABLE IF NOT EXISTS "scheduler_runs" (
  "runId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "durationMs" INTEGER,
  CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX IF NOT EXISTS "scheduler_runs_jobId_idx" ON "scheduler_runs"("jobId");
CREATE INDEX IF NOT EXISTS "scheduler_runs_startedAt_idx" ON "scheduler_runs"("startedAt");
CREATE INDEX IF NOT EXISTS "scheduler_runs_status_idx" ON "scheduler_runs"("status");
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_audit_log_migration() {
  local migration_name="20260508120000_add_audit_log"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "actorName" TEXT,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "action" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "diff" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_log_actorType_actorId_createdAt_idx"
  ON "audit_log"("actorType", "actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_log_resourceType_resourceId_createdAt_idx"
  ON "audit_log"("resourceType", "resourceId", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_log_action_createdAt_idx"
  ON "audit_log"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_log_createdAt_idx"
  ON "audit_log"("createdAt");
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_document_index_migration() {
  local migration_name="20260508130000_add_document_index"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "document_index" (
  "contentHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "chunks" JSONB NOT NULL,
  "embeddings" JSONB NOT NULL,
  "pageHashes" JSONB,
  "hierarchyRootId" TEXT,
  "bytesSize" INTEGER NOT NULL DEFAULT 0,
  "embedTokens" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "document_index_pkey" PRIMARY KEY ("contentHash")
);

CREATE INDEX IF NOT EXISTS "document_index_accessedAt_idx" ON "document_index"("accessedAt");
CREATE INDEX IF NOT EXISTS "document_index_createdAt_idx" ON "document_index"("createdAt");
CREATE INDEX IF NOT EXISTS "document_index_hierarchyRootId_idx" ON "document_index"("hierarchyRootId");
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_document_nodes_migration() {
  local migration_name="20260508140000_add_document_nodes"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "document_nodes" (
  "id" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "analysisId" TEXT,
  "parentId" TEXT,
  "level" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "heading" TEXT,
  "text" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '',
  "embedding" JSONB,
  "metadata" JSONB,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_nodes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "document_nodes_fileId_ordinal_idx"
  ON "document_nodes"("fileId", "ordinal");
CREATE INDEX IF NOT EXISTS "document_nodes_fileId_level_idx"
  ON "document_nodes"("fileId", "level");
CREATE INDEX IF NOT EXISTS "document_nodes_parentId_idx"
  ON "document_nodes"("parentId");
CREATE INDEX IF NOT EXISTS "document_nodes_analysisId_idx"
  ON "document_nodes"("analysisId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'document_nodes_fileId_fkey') THEN
    ALTER TABLE "document_nodes" ADD CONSTRAINT "document_nodes_fileId_fkey"
      FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'document_nodes_analysisId_fkey') THEN
    ALTER TABLE "document_nodes" ADD CONSTRAINT "document_nodes_analysisId_fkey"
      FOREIGN KEY ("analysisId") REFERENCES "document_analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'document_nodes_parentId_fkey') THEN
    ALTER TABLE "document_nodes" ADD CONSTRAINT "document_nodes_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "document_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_admin_connections_migration() {
  local migration_name="20260515220000_add_admin_connections"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
CREATE TABLE IF NOT EXISTS "admin_connections" (
  "id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "providerLabel" TEXT,
  "apiKey" TEXT,
  "authType" TEXT NOT NULL DEFAULT 'Bearer',
  "apiType" TEXT NOT NULL DEFAULT 'chat_completions',
  "headers" JSONB,
  "prefixId" TEXT,
  "modelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSyncedAt" TIMESTAMP(3),
  "lastSyncOk" BOOLEAN NOT NULL DEFAULT false,
  "lastSyncError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_connections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_connections_providerKey_idx" ON "admin_connections"("providerKey");
CREATE INDEX IF NOT EXISTS "admin_connections_enabled_idx" ON "admin_connections"("enabled");
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

repair_session_fingerprint_migration() {
  local migration_name="20260519020000_add_session_fingerprint"

  log "Repairing Prisma migration state: ${migration_name}"
  (
    cd backend
    run_bounded_prisma_with_stdin db execute --schema prisma/schema.prisma --stdin <<'SQL'
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "fingerprint" TEXT;
SQL
    resolve_prisma_migration_applied "${migration_name}"
  )
}

extract_prisma_migration_name() {
  node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    const explicit = input.match(/Migration name:\s*([^\s]+)/);
    const p3009 = input.match(/The `([^`]+)` migration/);
    process.stdout.write((explicit && explicit[1]) || (p3009 && p3009[1]) || "");
  '
}

repair_known_prisma_migration() {
  local migration_name="$1"

  case "$migration_name" in
    20241125_add_model_sync_fields)
      repair_model_sync_migration
      ;;
    20250919203029_init)
      repair_init_baseline_migration
      ;;
    20250928102318_add_stripe_integration)
      repair_stripe_integration_migration
      ;;
    20251001184158_stripe_enahcement)
      repair_stripe_enhancement_migration
      ;;
    20251001211311_limit_set_monthly)
      repair_monthly_limit_default_migration
      ;;
    20251021064736_add_gmail_integration)
      repair_gmail_integration_migration
      ;;
    20260427000000_universal_search_brain)
      repair_universal_search_brain_migration
      ;;
    20260427040000_add_agentic_task_queue)
      repair_agentic_task_queue_migration
      ;;
    20260508000000_add_scheduler_jobs)
      repair_scheduler_jobs_migration
      ;;
    20260508120000_add_audit_log)
      repair_audit_log_migration
      ;;
    20260508130000_add_document_index)
      repair_document_index_migration
      ;;
    20260508140000_add_document_nodes)
      repair_document_nodes_migration
      ;;
    20260515220000_add_admin_connections)
      repair_admin_connections_migration
      ;;
    20260519020000_add_session_fingerprint)
      repair_session_fingerprint_migration
      ;;
    20260420000000_rag_store)
      repair_optional_pgvector_migration "$migration_name" "Persistent RAG storage"
      ;;
    20260520180000_add_user_memories_pgvector)
      repair_optional_pgvector_migration "$migration_name" "Pgvector user memory"
      ;;
    20260520200000_add_user_memories)
      repair_user_memories_schema_migration
      ;;
    *)
      return 1
      ;;
  esac
}

run_prisma_migrations() {
  log "Generating Prisma client and applying migrations through the bounded boot lifecycle"
  (
    cd backend
    node scripts/start-with-migrations.js --migrate-only
  )
}

require_command git
require_command docker
require_command pm2
require_command curl
require_command node

cd "$APP_DIR"

[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $APP_DIR/$COMPOSE_FILE"

handle_local_tracked_changes

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  log "Switching branch: $current_branch -> $BRANCH"
  git checkout "$BRANCH"
fi

log "Updating $BRANCH from origin"
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

cleanup_docker_space

# Backend deps. The backend runs under PM2 on the host (not inside
# Docker), so new dependencies in backend/package.json aren't picked up
# unless we install them here. Without this step, adding a runtime dep
# (e.g. connect-redis) causes the backend to crash-loop on next restart
# with MODULE_NOT_FOUND. `npm install --omit=dev` is used (not `npm ci`)
# because the project historically allows lockfile drift; switch to
# `npm ci --omit=dev` once that's been audited.
log "Installing backend production dependencies"
(cd backend && npm install --omit=dev --no-audit --no-fund)

run_prisma_migrations

log "Building frontend Docker image with NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL"
docker compose -f "$COMPOSE_FILE" build "$FRONTEND_SERVICE"

log "Starting frontend container without backend dependencies"
cleanup_frontend_container_conflicts
docker compose -f "$COMPOSE_FILE" up -d --no-deps "$FRONTEND_SERVICE"

restart_pm2_backend

wait_for_http "API health" "$API_HEALTH_URL" 30 2
wait_for_http "Frontend login" "$FRONTEND_URL" 30 2
verify_auth_login_path

actual_redirect_uri="$(read_google_redirect_uri)"
if [[ "$actual_redirect_uri" != "$EXPECTED_GOOGLE_REDIRECT_URI" ]]; then
  fail "Google redirect_uri mismatch. Expected $EXPECTED_GOOGLE_REDIRECT_URI, got ${actual_redirect_uri:-empty}"
fi
log "Google OAuth redirect_uri is correct: $actual_redirect_uri"

log "Deployment complete at commit $(git rev-parse --short HEAD)"
