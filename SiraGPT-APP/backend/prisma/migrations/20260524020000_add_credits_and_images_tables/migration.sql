-- F1 PR3 — Credits ledger + generated images table (Spec §8, §7.20).
--
-- Adds three new tables + two enums:
--
--   * `credits`              — per-user balance with reserved-amount
--                              field for pre-debit reservations.
--   * `credit_transactions`  — append-only ledger; every grant, spend,
--                              refund, refill or admin adjustment is
--                              one row. `idempotencyKey` enforces
--                              replay-safety for client retries.
--   * `generated_images`     — async image-generation job + history.
--                              Variations and upscales are linked back
--                              via `parentImageId` so the UI can show a
--                              tree.
--
--   * `CreditTransactionType` ENUM (GRANT|REFILL|SPEND|REFUND|ADMIN_ADJUSTMENT|EXPIRY)
--   * `ImageJobStatus`        ENUM (PENDING|RUNNING|READY|FAILED|MODERATED)
--
-- All-aditive: no DROPs, no ALTER on existing tables, idempotent
-- creation (IF NOT EXISTS + DO $$ blocks for enums/FKs). F2 wires the
-- credits endpoints + `chargeCredits` middleware; F4 wires the image
-- worker.

-- ── Enums ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditTransactionType') THEN
    CREATE TYPE "CreditTransactionType" AS ENUM (
      'GRANT',
      'REFILL',
      'SPEND',
      'REFUND',
      'ADMIN_ADJUSTMENT',
      'EXPIRY'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImageJobStatus') THEN
    CREATE TYPE "ImageJobStatus" AS ENUM (
      'PENDING',
      'RUNNING',
      'READY',
      'FAILED',
      'MODERATED'
    );
  END IF;
END
$$;

-- ── credits ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "credits" (
  "id"               TEXT PRIMARY KEY,
  "userId"           TEXT NOT NULL,
  "orgId"            TEXT,
  "balance"          BIGINT NOT NULL DEFAULT 0,
  "reservedBalance"  BIGINT NOT NULL DEFAULT 0,
  "lifetimeGranted"  BIGINT NOT NULL DEFAULT 0,
  "lifetimeSpent"    BIGINT NOT NULL DEFAULT 0,
  "lastRefillAt"     TIMESTAMP(3),
  "nextRefillAt"     TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "credits_userId_key" ON "credits"("userId");
CREATE INDEX IF NOT EXISTS "credits_orgId_idx" ON "credits"("orgId");
-- Performance check used by the SPEND path: the spend SQL uses
-- `UPDATE credits SET balance = balance - $amt WHERE userId=$u AND
-- balance >= $amt RETURNING balance` — the userId index covers it.

-- ── credit_transactions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "credit_transactions" (
  "id"             TEXT PRIMARY KEY,
  "userId"         TEXT NOT NULL,
  "orgId"          TEXT,
  "type"           "CreditTransactionType" NOT NULL,
  "amount"         BIGINT NOT NULL,
  "balanceAfter"   BIGINT NOT NULL,
  "reason"         TEXT NOT NULL,
  "metadata"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "idempotencyKey" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "credit_transactions_idempotencyKey_key"
  ON "credit_transactions"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "credit_transactions_userId_createdAt_idx"
  ON "credit_transactions"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "credit_transactions_orgId_createdAt_idx"
  ON "credit_transactions"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "credit_transactions_type_createdAt_idx"
  ON "credit_transactions"("type", "createdAt");

-- ── generated_images ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "generated_images" (
  "id"             TEXT PRIMARY KEY,
  "userId"         TEXT NOT NULL,
  "orgId"          TEXT,
  "chatId"         TEXT,
  "messageId"      TEXT,
  "prompt"         TEXT NOT NULL,
  "negativePrompt" TEXT,
  "provider"       TEXT NOT NULL DEFAULT 'openai',
  "model"          TEXT NOT NULL,
  "size"           TEXT NOT NULL DEFAULT '1024x1024',
  "n"              INTEGER NOT NULL DEFAULT 1,
  "seed"           BIGINT,
  "quality"        TEXT,
  "style"          TEXT,
  "status"         "ImageJobStatus" NOT NULL DEFAULT 'PENDING',
  "costCredits"    BIGINT NOT NULL DEFAULT 0,
  "errorMessage"   TEXT,
  "assetIds"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "parentImageId"  TEXT,
  "kind"           TEXT NOT NULL DEFAULT 'original',
  "deletedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "generated_images_userId_createdAt_idx"
  ON "generated_images"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "generated_images_status_createdAt_idx"
  ON "generated_images"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "generated_images_parentImageId_idx"
  ON "generated_images"("parentImageId");
CREATE INDEX IF NOT EXISTS "generated_images_chatId_idx"
  ON "generated_images"("chatId");

-- ── Foreign keys (idempotent) ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credits_userId_fkey') THEN
    ALTER TABLE "credits"
      ADD CONSTRAINT "credits_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_transactions_userId_fkey') THEN
    ALTER TABLE "credit_transactions"
      ADD CONSTRAINT "credit_transactions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_images_userId_fkey') THEN
    ALTER TABLE "generated_images"
      ADD CONSTRAINT "generated_images_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_images_parentImageId_fkey') THEN
    ALTER TABLE "generated_images"
      ADD CONSTRAINT "generated_images_parentImageId_fkey"
      FOREIGN KEY ("parentImageId") REFERENCES "generated_images"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
