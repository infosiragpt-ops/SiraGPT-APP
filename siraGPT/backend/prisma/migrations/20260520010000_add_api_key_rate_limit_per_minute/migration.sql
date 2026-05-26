-- Ratchet 45 — optional per-key rate-limit override on ApiKey.
--
-- When non-null, this column overrides the plan-derived default
-- (env SIRAGPT_API_KEY_DEFAULT_RPM, fallback 60) applied by the
-- authenticated-request rate limiter. Stored as requests-per-minute
-- to keep operator math trivial; window length is always 60_000 ms.
-- Nullable so existing rows continue to use the plan default.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rateLimitPerMinute" INTEGER;
