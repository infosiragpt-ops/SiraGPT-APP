-- Security DML: retire the legacy bootstrap identity created by historical
-- migrations that embedded a known credential. This migration is intentionally
-- narrow and idempotent. Normal administrator accounts are not affected.

BEGIN;

DELETE FROM "sessions"
WHERE "userId" IN (
  SELECT "id"
  FROM "users"
  WHERE "id" = 'prod_admin_admin_gmail_com'
    AND "email" = 'admin@gmail.com'
);

DELETE FROM "user_roles"
WHERE "userId" IN (
  SELECT "id"
  FROM "users"
  WHERE "id" = 'prod_admin_admin_gmail_com'
    AND "email" = 'admin@gmail.com'
);

UPDATE "users"
SET
  "isAdmin" = FALSE,
  "isSuperAdmin" = FALSE,
  "deletedAt" = COALESCE("deletedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'prod_admin_admin_gmail_com'
  AND "email" = 'admin@gmail.com';

COMMIT;
