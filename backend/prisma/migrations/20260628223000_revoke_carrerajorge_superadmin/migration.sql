-- Keep Carrerajorge874@gmail.com as a normal administrator, not a super admin.
-- This is idempotent and case-insensitive because OAuth/user storage may
-- normalize email casing differently than the UI request.

DO $$
DECLARE
  target_email TEXT := 'carrerajorge874@gmail.com';
  target_user_id TEXT;
  superadmin_role_id TEXT;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE 'users table is missing; skipping Carrera Jorge super admin cleanup';
    RETURN;
  END IF;

  SELECT "id"
    INTO target_user_id
    FROM "users"
    WHERE LOWER("email") = target_email
    LIMIT 1;

  IF target_user_id IS NULL THEN
    RAISE NOTICE 'User % was not found; skipping Carrera Jorge super admin cleanup', target_email;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'isSuperAdmin'
  ) THEN
    UPDATE "users"
      SET "isAdmin" = TRUE,
          "isSuperAdmin" = FALSE,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = target_user_id;
  ELSE
    UPDATE "users"
      SET "isAdmin" = TRUE,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = target_user_id;
  END IF;

  IF to_regclass('public.roles') IS NOT NULL
     AND to_regclass('public.user_roles') IS NOT NULL THEN
    SELECT "id"
      INTO superadmin_role_id
      FROM "roles"
      WHERE "code" = 'SUPERADMIN'
      LIMIT 1;

    IF superadmin_role_id IS NOT NULL THEN
      DELETE FROM "user_roles"
        WHERE "userId" = target_user_id
          AND "roleId" = superadmin_role_id;
    END IF;
  END IF;

  IF to_regclass('public.sessions') IS NOT NULL THEN
    DELETE FROM "sessions"
      WHERE "userId" = target_user_id;
  END IF;
END
$$;
