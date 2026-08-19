-- Ratchet 44 — OrgPendingTransfer (cycle 76).
--
-- Pending ownership-transfer requests. Created when the org has
-- `settings.transfer.requireApprovalDays > 0` and the current OWNER
-- initiates a transfer. The new owner must accept the request within
-- the configured window; the current OWNER may cancel before then.
CREATE TABLE IF NOT EXISTS "org_pending_transfers" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "fromOwnerId" TEXT NOT NULL,
  "toOwnerId" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  CONSTRAINT "org_pending_transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "org_pending_transfers_orgId_acceptedAt_idx"
  ON "org_pending_transfers"("orgId", "acceptedAt");
CREATE INDEX IF NOT EXISTS "org_pending_transfers_toOwnerId_acceptedAt_idx"
  ON "org_pending_transfers"("toOwnerId", "acceptedAt");
CREATE INDEX IF NOT EXISTS "org_pending_transfers_expiresAt_idx"
  ON "org_pending_transfers"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'org_pending_transfers_orgId_fkey'
      AND conrelid = '"org_pending_transfers"'::regclass
  ) THEN
    ALTER TABLE "org_pending_transfers"
      ADD CONSTRAINT "org_pending_transfers_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'org_pending_transfers_fromOwnerId_fkey'
      AND conrelid = '"org_pending_transfers"'::regclass
  ) THEN
    ALTER TABLE "org_pending_transfers"
      ADD CONSTRAINT "org_pending_transfers_fromOwnerId_fkey"
      FOREIGN KEY ("fromOwnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'org_pending_transfers_toOwnerId_fkey'
      AND conrelid = '"org_pending_transfers"'::regclass
  ) THEN
    ALTER TABLE "org_pending_transfers"
      ADD CONSTRAINT "org_pending_transfers_toOwnerId_fkey"
      FOREIGN KEY ("toOwnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
