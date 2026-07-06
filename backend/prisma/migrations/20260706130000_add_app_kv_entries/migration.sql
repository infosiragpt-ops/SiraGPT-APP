-- Persistent key-value store for generated SiraGPT Apps (see model AppKvEntry).
-- Loose namespace (no FK to codex_projects): a capped public store the apps
-- reach via /api/apps-kv so previews/exported apps persist real data.

CREATE TABLE IF NOT EXISTS "app_kv_entries" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_kv_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_kv_entries_namespace_ownerKey_key_key"
  ON "app_kv_entries"("namespace", "ownerKey", "key");

CREATE INDEX IF NOT EXISTS "app_kv_entries_namespace_ownerKey_idx"
  ON "app_kv_entries"("namespace", "ownerKey");
