-- Ratchet 45 — per-scope last-used aggregate on ApiKey.
--
-- Stores a sampled JSON aggregate of which scopes each API key has
-- actually exercised, populated fire-and-forget every 50th successful
-- requireScope() call. Shape:
--   { "<scope>": { "count": <int>, "lastUsedAt": "<ISOString>" } }
-- Nullable so existing rows remain valid; readers must tolerate null.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "usedScopes" JSONB;
