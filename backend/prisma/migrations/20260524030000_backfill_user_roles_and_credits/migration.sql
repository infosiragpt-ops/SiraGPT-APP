-- F1 PR4 — Backfill user_roles + credits from existing data.
--
-- Closes the gap between the pre-existing `users` / `org_memberships`
-- world and the new declarative RBAC + credits ledger introduced in
-- PR1/PR2/PR3. After this migration, every existing user has:
--
--   1. A `user_roles` (GLOBAL) row mapped from `users.isSuperAdmin`:
--        true  → SUPERADMIN
--        false → USER
--   2. One `user_roles` (ORG, scopeId=orgId) row per `OrgMembership`,
--      mapped from `OrgRole` → role code:
--        OWNER  → ORG_OWNER
--        ADMIN  → ORG_ADMIN
--        MEMBER → ORG_MEMBER
--        VIEWER → ORG_VIEWER
--   3. A `credits` row with balance = `plans.monthlyCredits` for the
--      user's `User.plan` enum value (falls back to 0 if the plan code
--      is missing from the catalog).
--
-- Strictly additive: WHERE NOT EXISTS guards on every INSERT make the
-- migration safe to replay. Existing user/membership data is read-only
-- here — no UPDATE, no DELETE.
--
-- Note for very large production tables: this runs as three single
-- INSERT statements. If the user count exceeds ~500k, batching via a
-- DO $$ LOOP would reduce lock pressure; for the current scale a single
-- pass is fine and much simpler to reason about.

-- ── 1. Global role assignment per user ─────────────────────────────
INSERT INTO "user_roles" ("id", "userId", "roleId", "scope", "scopeId", "assignedAt")
SELECT
  'ur_g_' || substr(md5(u.id), 1, 22),
  u.id,
  r.id,
  'GLOBAL'::"RoleScope",
  NULL,
  CURRENT_TIMESTAMP
FROM "users" u
JOIN "roles" r ON r.code = CASE WHEN u."isSuperAdmin" THEN 'SUPERADMIN' ELSE 'USER' END
WHERE NOT EXISTS (
  SELECT 1 FROM "user_roles" ur
  WHERE ur."userId" = u.id
    AND ur."roleId" = r.id
    AND ur."scope" = 'GLOBAL'::"RoleScope"
    AND ur."scopeId" IS NULL
);

-- ── 2. Org-scoped role assignment per OrgMembership ────────────────
INSERT INTO "user_roles" ("id", "userId", "roleId", "scope", "scopeId", "assignedAt")
SELECT
  'ur_o_' || substr(md5(om."userId" || ':' || om."orgId" || ':' || om.role::TEXT), 1, 22),
  om."userId",
  r.id,
  'ORG'::"RoleScope",
  om."orgId",
  COALESCE(om."createdAt", CURRENT_TIMESTAMP)
FROM "org_memberships" om
JOIN "roles" r ON r.code = CASE om.role::TEXT
  WHEN 'OWNER'  THEN 'ORG_OWNER'
  WHEN 'ADMIN'  THEN 'ORG_ADMIN'
  WHEN 'MEMBER' THEN 'ORG_MEMBER'
  WHEN 'VIEWER' THEN 'ORG_VIEWER'
  ELSE 'ORG_MEMBER' -- defensive fallback if a new enum value lands
END
WHERE NOT EXISTS (
  SELECT 1 FROM "user_roles" ur
  WHERE ur."userId" = om."userId"
    AND ur."roleId" = r.id
    AND ur."scope" = 'ORG'::"RoleScope"
    AND ur."scopeId" = om."orgId"
);

-- ── 3. Initial credit balance per user (one row per user) ──────────
-- Balance = plans.monthlyCredits for the matching plan code; if the
-- user's plan enum value isn't in the catalog (shouldn't happen post-
-- PR1) we fall back to 0 so the row still exists and other code can
-- update it atomically.
INSERT INTO "credits" ("id", "userId", "balance", "lifetimeGranted", "lastRefillAt", "nextRefillAt", "createdAt", "updatedAt")
SELECT
  'cr_' || substr(md5(u.id), 1, 24),
  u.id,
  COALESCE(p."monthlyCredits", 0),
  COALESCE(p."monthlyCredits", 0),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '1 month',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "users" u
LEFT JOIN "plans" p ON p.code = u.plan::TEXT
WHERE NOT EXISTS (
  SELECT 1 FROM "credits" c WHERE c."userId" = u.id
);
