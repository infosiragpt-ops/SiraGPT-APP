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
  "deletedAt" = COALESCE("deletedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'prod_admin_admin_gmail_com'
  AND "email" = 'admin@gmail.com';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'isSuperAdmin'
  ) THEN
    UPDATE "users"
    SET
      "isSuperAdmin" = FALSE,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'prod_admin_admin_gmail_com'
      AND "email" = 'admin@gmail.com';
  END IF;
END
$$;

COMMIT;
