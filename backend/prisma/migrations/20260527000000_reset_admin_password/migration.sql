-- Reset / ensure admin account with a known password.
-- Email: admin@gmail.com  Password: Admin@SiraGPT2024

DO $$
DECLARE
  admin_email TEXT := 'admin@gmail.com';
  admin_id TEXT := 'prod_admin_admin_gmail_com';
  admin_password_hash TEXT := '$2b$12$T/Tx4e1oAmSoaH3V/hIhQeWhvJeCS8AHFXwH4/tzJlue7McS3GDau';
  superadmin_role_id TEXT;
BEGIN
  INSERT INTO "users" (
    "id", "email", "name", "password", "plan",
    "isAdmin", "apiUsage", "monthlyCallLimit", "monthlyLimit",
    "createdAt", "updatedAt"
  )
  VALUES (
    admin_id, admin_email, 'Administrador', admin_password_hash, 'ENTERPRISE',
    TRUE, 0, 999999, 999999, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("email") DO UPDATE
    SET "password"         = EXCLUDED."password",
        "plan"             = 'ENTERPRISE',
        "isAdmin"          = TRUE,
        "monthlyCallLimit" = GREATEST("users"."monthlyCallLimit", 999999),
        "monthlyLimit"     = GREATEST("users"."monthlyLimit", 999999),
        "updatedAt"        = CURRENT_TIMESTAMP;

  -- isSuperAdmin (if column exists)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='isSuperAdmin') THEN
    UPDATE "users" SET "isSuperAdmin" = TRUE, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "email" = admin_email;
  END IF;

  -- deletedAt guard
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='deletedAt') THEN
    UPDATE "users" SET "deletedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "email" = admin_email;
  END IF;

  -- emailVerifiedAt
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='emailVerifiedAt') THEN
    UPDATE "users" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
    WHERE "email" = admin_email;
  END IF;

  -- twoFactor / totp off
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='twoFactorEnabled') THEN
    UPDATE "users" SET "twoFactorEnabled" = FALSE, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "email" = admin_email;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='totpEnabled') THEN
    UPDATE "users" SET "totpEnabled" = FALSE, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "email" = admin_email;
  END IF;

  -- SUPERADMIN role
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='roles')
     AND EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='user_roles') THEN
    SELECT "id" INTO superadmin_role_id FROM "roles" WHERE "code" = 'SUPERADMIN' LIMIT 1;
    IF superadmin_role_id IS NOT NULL THEN
      INSERT INTO "user_roles" ("id","userId","roleId","scope","scopeId","assignedBy","assignedAt")
      SELECT 'ur_prod_admin_superadmin', u."id", superadmin_role_id, 'GLOBAL', NULL, NULL, CURRENT_TIMESTAMP
      FROM "users" u WHERE u."email" = admin_email
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END
$$;
