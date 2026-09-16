-- Additive: optional rich-feedback reason code on preference_events.
-- Old rows stay valid (NULL). Free-text notes already exist.

ALTER TABLE "preference_events"
  ADD COLUMN IF NOT EXISTS "reason_code" TEXT;
