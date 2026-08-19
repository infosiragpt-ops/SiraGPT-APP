-- Cycle 27: Organization / team multi-tenant scaffolding.
--
-- Adds three tables (organizations, org_memberships, org_invitations) and
-- one role enum, plus two columns on chats so chats can be shared into
-- an org workspace. All operations are idempotent (`IF NOT EXISTS`) so the
-- migration is safe to re-run against partially-applied environments.

-- ─── OrgRole enum ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgRole') THEN
    CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
  END IF;
END
$$;

-- ─── organizations table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "organizations" (
  "id"             TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "slug"           TEXT NOT NULL,
  "billingPlan"    "Plan" NOT NULL DEFAULT 'FREE',
  "ownerId"        TEXT NOT NULL,
  "monthlyQuota"   BIGINT NOT NULL DEFAULT 10000,
  "usedThisMonth"  BIGINT NOT NULL DEFAULT 0,
  "quotaResetAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key"
  ON "organizations"("slug");
CREATE INDEX IF NOT EXISTS "organizations_ownerId_idx"
  ON "organizations"("ownerId");
CREATE INDEX IF NOT EXISTS "organizations_slug_idx"
  ON "organizations"("slug");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_ownerId_fkey'
  ) THEN
    ALTER TABLE "organizations"
      ADD CONSTRAINT "organizations_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ─── org_memberships table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "org_memberships" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "role"      "OrgRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_memberships_orgId_userId_key"
  ON "org_memberships"("orgId", "userId");
CREATE INDEX IF NOT EXISTS "org_memberships_userId_idx"
  ON "org_memberships"("userId");
CREATE INDEX IF NOT EXISTS "org_memberships_orgId_role_idx"
  ON "org_memberships"("orgId", "role");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_memberships_orgId_fkey'
  ) THEN
    ALTER TABLE "org_memberships"
      ADD CONSTRAINT "org_memberships_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_memberships_userId_fkey'
  ) THEN
    ALTER TABLE "org_memberships"
      ADD CONSTRAINT "org_memberships_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ─── org_invitations table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "org_invitations" (
  "id"         TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "role"       "OrgRole" NOT NULL DEFAULT 'MEMBER',
  "token"      TEXT NOT NULL,
  "invitedBy"  TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_invitations_token_key"
  ON "org_invitations"("token");
CREATE INDEX IF NOT EXISTS "org_invitations_orgId_email_idx"
  ON "org_invitations"("orgId", "email");
CREATE INDEX IF NOT EXISTS "org_invitations_email_idx"
  ON "org_invitations"("email");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_orgId_fkey'
  ) THEN
    ALTER TABLE "org_invitations"
      ADD CONSTRAINT "org_invitations_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_invitedBy_fkey'
  ) THEN
    ALTER TABLE "org_invitations"
      ADD CONSTRAINT "org_invitations_invitedBy_fkey"
      FOREIGN KEY ("invitedBy") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ─── chats.organizationId / chats.sharedAt ──────────────────────────
ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "sharedAt"       TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "chats_organizationId_sharedAt_idx"
  ON "chats"("organizationId", "sharedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chats_organizationId_fkey'
  ) THEN
    ALTER TABLE "chats"
      ADD CONSTRAINT "chats_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
