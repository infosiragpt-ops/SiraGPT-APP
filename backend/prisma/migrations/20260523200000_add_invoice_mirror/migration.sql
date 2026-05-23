-- Spec §8 — local Invoice mirror.
--
-- Adds `invoices`, a webhook-fed mirror of Stripe invoice objects so the
-- billing UI can render history without a network round-trip per request
-- and survive Stripe outages. Aditiva. Webhook handlers upsert; the
-- existing `payments` table is left as-is (different semantics — payments
-- track checkout sessions, invoices track recurring billing periods).
--
-- Status is stored as an enum mirroring Stripe values:
--   DRAFT | OPEN | PAID | UNCOLLECTIBLE | VOID
--
-- Amounts persist in cents (Int) instead of Float to match Stripe's wire
-- format and avoid floating-point drift over many invoices.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InvoiceStatus') THEN
    CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "invoices" (
  "id"                    TEXT PRIMARY KEY,
  "userId"                TEXT NOT NULL,
  "stripeInvoiceId"       TEXT NOT NULL,
  "stripeCustomerId"      TEXT,
  "stripeSubscriptionId"  TEXT,
  "number"                TEXT,
  "status"                "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "amountDueCents"        INTEGER NOT NULL DEFAULT 0,
  "amountPaidCents"       INTEGER NOT NULL DEFAULT 0,
  "amountRemainingCents"  INTEGER NOT NULL DEFAULT 0,
  "subtotalCents"         INTEGER NOT NULL DEFAULT 0,
  "totalCents"            INTEGER NOT NULL DEFAULT 0,
  "currency"              TEXT NOT NULL DEFAULT 'usd',
  "periodStart"           TIMESTAMP(3),
  "periodEnd"             TIMESTAMP(3),
  "hostedInvoiceUrl"      TEXT,
  "invoicePdfUrl"         TEXT,
  "lines"                 JSONB,
  "issuedAt"              TIMESTAMP(3),
  "paidAt"                TIMESTAMP(3),
  "dueDate"               TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_stripeInvoiceId_key"
  ON "invoices"("stripeInvoiceId");
CREATE INDEX IF NOT EXISTS "invoices_userId_createdAt_idx"
  ON "invoices"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "invoices_status_createdAt_idx"
  ON "invoices"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "invoices_stripeSubscriptionId_idx"
  ON "invoices"("stripeSubscriptionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_userId_fkey'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
