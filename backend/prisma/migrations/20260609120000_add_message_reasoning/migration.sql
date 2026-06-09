-- Claude-style extended thinking persistence.
-- `reasoning`: human-readable chain-of-thought streamed by reasoning models.
-- `reasoning_details`: raw OpenRouter reasoning_details array, replayed
-- verbatim on later Anthropic tool-call turns (signed thinking chain).
-- Nullable, no defaults, IF NOT EXISTS → safe additive change anywhere.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "reasoning" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "reasoning_details" JSONB;
