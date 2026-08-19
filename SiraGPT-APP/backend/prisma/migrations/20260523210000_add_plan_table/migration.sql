-- F1 PR1 — Plans catalog table + seed (Spec §8, §11).
--
-- Adds `plans`, the catalog of billing tiers (FREE / PRO / PRO_MAX /
-- ENTERPRISE). Aditiva: the existing `User.plan` enum stays as the wire
-- format; this table is the new source of truth for pricing, monthly
-- credit allowance, displayable name/description, Stripe price IDs and a
-- declarative `features` JSON blob. F2 introduces `User.planId` FK that
-- references this table; until then the enum + this table coexist.
--
-- Seed rows match the four enum values. Prices default to 0 and are
-- overwritten by admin in F2; `monthlyCredits` ladder matches the roadmap
-- defaults (FREE 0, PRO 500, PRO_MAX 5000, ENTERPRISE 50000) — admins can
-- adjust without a migration.
--
-- Idempotent: re-running this migration is a no-op (CREATE ... IF NOT
-- EXISTS + INSERT ... ON CONFLICT DO NOTHING). Safe against partial
-- replay.

CREATE TABLE IF NOT EXISTS "plans" (
  "id"                    TEXT PRIMARY KEY,
  "code"                  TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "description"           TEXT,
  "priceMonthlyCents"     INTEGER NOT NULL DEFAULT 0,
  "priceYearlyCents"      INTEGER NOT NULL DEFAULT 0,
  "currency"              TEXT NOT NULL DEFAULT 'usd',
  "monthlyCredits"        BIGINT NOT NULL DEFAULT 0,
  "trialDays"             INTEGER NOT NULL DEFAULT 0,
  "features"              JSONB NOT NULL DEFAULT '[]'::jsonb,
  "stripePriceIdMonthly"  TEXT,
  "stripePriceIdYearly"   TEXT,
  "isActive"              BOOLEAN NOT NULL DEFAULT TRUE,
  "displayOrder"          INTEGER NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "plans_code_key"
  ON "plans"("code");
CREATE INDEX IF NOT EXISTS "plans_isActive_displayOrder_idx"
  ON "plans"("isActive", "displayOrder");

-- Seed the four canonical tiers. cuid-style IDs are stable across
-- environments so other migrations / app code can reference them by
-- `code` (the natural key) instead of the surrogate `id`.
INSERT INTO "plans" ("id", "code", "name", "description", "monthlyCredits", "displayOrder")
VALUES
  ('plan_free',       'FREE',       'Free',       'Acceso básico con cuotas limitadas. Modelo gratuito por defecto.', 0,     10),
  ('plan_pro',        'PRO',        'Pro',        'Mayor cuota mensual y acceso a modelos avanzados.',                500,   20),
  ('plan_pro_max',    'PRO_MAX',    'Pro Max',    'Cuota ampliada y herramientas premium para uso intensivo.',        5000,  30),
  ('plan_enterprise', 'ENTERPRISE', 'Enterprise', 'Pago por uso o créditos configurables; soporte avanzado.',          50000, 40)
ON CONFLICT ("code") DO NOTHING;
