-- Ratchet 45, Task 2 — per-endpoint usage histogram on ApiKey.
--
-- Stores a sampled JSON aggregate of which Express route templates each
-- API key has actually hit, populated fire-and-forget every 50th
-- successful requireScope() call (same sampler that fills usedScopes).
-- Shape:
--   { "<METHOD> <pathPattern>": <int> }
-- Nullable so existing rows remain valid; readers must tolerate null.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "usedEndpoints" JSONB;
