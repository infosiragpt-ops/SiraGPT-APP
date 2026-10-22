-- Ensure the production admin account can recover access after the
-- auth/migration baseline repair. This is idempotent and only touches
-- the explicitly requested admin email.

DO $$
DECLARE
  admin_email TEXT := 'admin@gmail.com';
  admin_id TEXT := 'prod_admin_admin_gmail_com';
  admin_password_hash TEXT := '$2b$12$Ph7dfpuDBIs6ckAqcxsKKurTAC9rOMaCIO2ITH4vY0f3YGaTW9uH2';
  superadmin_role_id TEXT;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users table is missing; cannot ensure production admin account';
  END IF;

  INSERT INTO "users" (
    "id",
    "email",
    "name",
    "password",
    "plan",
    "isAdmin",
    "apiUsage",
    "monthlyCallLimit",
    "monthlyLimit",
    "createdAt",
    "updatedAt"
  )
  VALUES (
    admin_id,
    admin_email,
    'Administrador',
    admin_password_hash,
    'ENTERPRISE',
    TRUE,
    0,
    999999,
    999999,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("email") DO UPDATE
    SET
      "password" = EXCLUDED."password",
      "plan" = 'ENTERPRISE',
      "isAdmin" = TRUE,
      "monthlyCallLimit" = GREATEST("users"."monthlyCallLimit", 999999),
      "monthlyLimit" = GREATEST("users"."monthlyLimit", 999999),
      "updatedAt" = CURRENT_TIMESTAMP;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'isSuperAdmin'
  ) THEN
    UPDATE "users"
      SET "isSuperAdmin" = TRUE,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "email" = admin_email;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'deletedAt'
  ) THEN
    UPDATE "users"
      SET "deletedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "email" = admin_email;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'emailVerifiedAt'
  ) THEN
    UPDATE "users"
      SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", CURRENT_TIMESTAMP),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "email" = admin_email;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'twoFactorEnabled'
  ) THEN
    UPDATE "users"
      SET "twoFactorEnabled" = FALSE,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "email" = admin_email;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'totpEnabled'
  ) THEN
    UPDATE "users"
      SET "totpEnabled" = FALSE,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "email" = admin_email;
  END IF;

  IF to_regclass('public.roles') IS NOT NULL
     AND to_regclass('public.user_roles') IS NOT NULL THEN
    SELECT "id"
      INTO superadmin_role_id
      FROM "roles"
      WHERE "code" = 'SUPERADMIN'
      LIMIT 1;

    IF superadmin_role_id IS NOT NULL THEN
      INSERT INTO "user_roles" (
        "id",
        "userId",
        "roleId",
        "scope",
        "scopeId",
        "assignedBy",
        "assignedAt"
      )
      SELECT
        'ur_prod_admin_superadmin',
        u."id",
        superadmin_role_id,
        'GLOBAL',
        NULL,
        NULL,
        CURRENT_TIMESTAMP
      FROM "users" u
      WHERE u."email" = admin_email
      ON CONFLICT ("userId", "roleId", "scope", (COALESCE("scopeId", ''))) DO NOTHING;
    END IF;
  END IF;
END
$$;
