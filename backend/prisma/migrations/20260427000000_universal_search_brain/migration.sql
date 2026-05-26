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

ALTER TABLE "search_brain_settings"
  ADD CONSTRAINT "search_brain_settings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
