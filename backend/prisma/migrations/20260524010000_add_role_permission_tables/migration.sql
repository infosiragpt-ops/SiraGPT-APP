-- F1 PR2 — RBAC catalog tables + system seed (Spec §11, §13).
--
-- Adds the declarative RBAC tables (`roles`, `permissions`,
-- `role_permissions`, `user_roles`) and seeds the six canonical roles
-- + the system permission catalog + their default mappings. No user
-- data is touched here; PR4 backfills `user_roles` from existing
-- `User.isSuperAdmin` flags and `OrgMembership` rows.
--
-- The `Plan` and `OrgRole` enums stay intact for back-compat; the new
-- tables are the future source of truth for permission checks via the
-- `requirePermission()` middleware introduced in F2.
--
-- Idempotent: CREATE ... IF NOT EXISTS + INSERT ... ON CONFLICT DO
-- NOTHING throughout. Re-running this migration is a no-op.

-- ── Scope enum ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RoleScope') THEN
    CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'ORG');
  END IF;
END
$$;

-- ── Tables ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "roles" (
  "id"          TEXT PRIMARY KEY,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "isSystem"    BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "roles_code_key" ON "roles"("code");

CREATE TABLE IF NOT EXISTS "permissions" (
  "id"          TEXT PRIMARY KEY,
  "code"        TEXT NOT NULL,
  "description" TEXT,
  "isSystem"    BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "permissions_code_key" ON "permissions"("code");

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id"           TEXT PRIMARY KEY,
  "roleId"       TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_roleId_permissionId_key"
  ON "role_permissions"("roleId", "permissionId");
CREATE INDEX IF NOT EXISTS "role_permissions_permissionId_idx"
  ON "role_permissions"("permissionId");

CREATE TABLE IF NOT EXISTS "user_roles" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "roleId"     TEXT NOT NULL,
  "scope"      "RoleScope" NOT NULL DEFAULT 'GLOBAL',
  "scopeId"    TEXT,
  "assignedBy" TEXT,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- COALESCE-style unique: NULL scopeId is treated as the empty string so
-- the (userId, roleId, scope, scopeId) tuple is reliably unique even
-- when scopeId is omitted (GLOBAL assignments).
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_userId_roleId_scope_scopeId_key"
  ON "user_roles"("userId", "roleId", "scope", (COALESCE("scopeId", '')));
CREATE INDEX IF NOT EXISTS "user_roles_userId_scope_idx"
  ON "user_roles"("userId", "scope");
CREATE INDEX IF NOT EXISTS "user_roles_roleId_idx"
  ON "user_roles"("roleId");

-- ── Foreign keys (deferred, idempotent) ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_roleId_fkey') THEN
    ALTER TABLE "role_permissions"
      ADD CONSTRAINT "role_permissions_roleId_fkey"
      FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_permissionId_fkey') THEN
    ALTER TABLE "role_permissions"
      ADD CONSTRAINT "role_permissions_permissionId_fkey"
      FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_userId_fkey') THEN
    ALTER TABLE "user_roles"
      ADD CONSTRAINT "user_roles_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_roleId_fkey') THEN
    ALTER TABLE "user_roles"
      ADD CONSTRAINT "user_roles_roleId_fkey"
      FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── Seed: six system roles ─────────────────────────────────────────
INSERT INTO "roles" ("id", "code", "name", "description", "isSystem") VALUES
  ('role_superadmin', 'SUPERADMIN', 'Super Admin',  'Acceso total al sistema, incluida impersonación e infraestructura.', TRUE),
  ('role_org_owner',  'ORG_OWNER',  'Org Owner',    'Propietario de organización: billing, miembros, configuración.',     TRUE),
  ('role_org_admin',  'ORG_ADMIN',  'Org Admin',    'Administración de organización sin acceso a facturación.',           TRUE),
  ('role_org_member', 'ORG_MEMBER', 'Org Member',   'Miembro activo de una organización con permisos de producción.',     TRUE),
  ('role_org_viewer', 'ORG_VIEWER', 'Org Viewer',   'Acceso de solo lectura a contenidos compartidos en la organización.',TRUE),
  ('role_user',       'USER',       'User',         'Usuario individual sin organización; permisos personales por defecto.', TRUE)
ON CONFLICT ("code") DO NOTHING;

-- ── Seed: system permission catalog ────────────────────────────────
-- Format: `resource.action`. Adding a new permission later is purely
-- additive: append the row + map it to roles via role_permissions.
INSERT INTO "permissions" ("id", "code", "description", "isSystem") VALUES
  -- users
  ('perm_users_read',         'users.read',          'Leer perfiles de usuario',                   TRUE),
  ('perm_users_list',         'users.list',          'Listar usuarios',                            TRUE),
  ('perm_users_update',       'users.update',        'Actualizar perfiles de usuario',             TRUE),
  ('perm_users_impersonate',  'users.impersonate',   'Impersonar usuarios (super admin only)',     TRUE),
  ('perm_users_delete',       'users.delete',        'Eliminar usuarios (soft delete)',            TRUE),
  -- admin panel
  ('perm_admin_users_read',   'admin.users.read',    'Ver panel de usuarios admin',                TRUE),
  ('perm_admin_metrics_read', 'admin.metrics.read',  'Ver métricas operacionales',                 TRUE),
  ('perm_admin_connections',  'admin.connections.manage','Gestionar integraciones / conectores',   TRUE),
  ('perm_admin_models',       'admin.models.manage', 'Gestionar catálogo de modelos IA',           TRUE),
  -- credits
  ('perm_credits_read',       'credits.read',        'Ver balance y transacciones de créditos',    TRUE),
  ('perm_credits_adjust',     'credits.adjust',      'Otorgar / top-up de créditos manualmente',   TRUE),
  ('perm_credits_refund',     'credits.refund',      'Reembolsar créditos a usuarios',             TRUE),
  -- orgs
  ('perm_org_read',           'org.read',            'Leer datos de la organización',              TRUE),
  ('perm_org_update',         'org.update',          'Actualizar datos básicos de la organización',TRUE),
  ('perm_org_delete',         'org.delete',          'Eliminar la organización',                   TRUE),
  ('perm_org_billing',        'org.billing.manage',  'Gestionar facturación de la organización',   TRUE),
  ('perm_org_invite',         'org.members.invite',  'Invitar miembros',                           TRUE),
  ('perm_org_remove',         'org.members.remove',  'Remover miembros',                           TRUE),
  ('perm_org_role_update',    'org.members.role.update','Cambiar el rol de un miembro',           TRUE),
  ('perm_org_audit',          'org.audit.read',      'Leer la auditoría de la organización',       TRUE),
  ('perm_org_settings',       'org.settings.update', 'Actualizar la configuración de la organización',TRUE),
  -- images
  ('perm_images_generate',    'images.generate',     'Generar imágenes con IA',                    TRUE),
  ('perm_images_upscale',     'images.upscale',      'Hacer upscale 2x/4x de imágenes',            TRUE),
  ('perm_images_moderate',    'images.moderate',     'Moderar imágenes generadas',                 TRUE),
  ('perm_images_read',        'images.read',         'Ver historial de imágenes propio',           TRUE),
  ('perm_images_delete',      'images.delete',       'Borrar imágenes generadas (soft delete)',    TRUE),
  -- video
  ('perm_video_generate',     'video.generate',      'Generar videos con IA',                      TRUE),
  ('perm_video_read',         'video.read',          'Ver historial de videos propio',             TRUE),
  -- paraphrase
  ('perm_paraphrase_use',     'paraphrase.use',      'Usar el módulo de parafraseo',               TRUE),
  -- chat
  ('perm_chat_read',          'chat.read',           'Leer chats',                                 TRUE),
  ('perm_chat_create',        'chat.create',         'Crear chats nuevos',                         TRUE),
  ('perm_chat_update',        'chat.update',         'Editar chats (título, pin, archive)',        TRUE),
  ('perm_chat_delete',        'chat.delete',         'Borrar chats (soft delete)',                 TRUE),
  ('perm_chat_share',         'chat.share',          'Compartir mensajes / chats',                 TRUE),
  -- gpts
  ('perm_gpt_create',         'gpt.create',          'Crear GPTs personalizados',                  TRUE),
  ('perm_gpt_update',         'gpt.update',          'Editar GPTs propios',                        TRUE),
  ('perm_gpt_delete',         'gpt.delete',          'Eliminar GPTs propios',                      TRUE),
  ('perm_gpt_publish',        'gpt.publish',         'Publicar un GPT al store',                   TRUE),
  -- projects
  ('perm_project_create',     'project.create',      'Crear proyectos',                            TRUE),
  ('perm_project_read',       'project.read',        'Leer proyectos propios o compartidos',       TRUE),
  ('perm_project_update',     'project.update',      'Editar proyectos',                           TRUE),
  ('perm_project_delete',     'project.delete',      'Eliminar proyectos',                         TRUE),
  ('perm_project_share',      'project.share',       'Compartir proyectos / invitar colaboradores',TRUE),
  -- thesis
  ('perm_thesis_use',         'thesis.use',          'Usar el generador de tesis',                 TRUE),
  -- platform
  ('perm_rbac_manage',        'rbac.manage',         'Gestionar roles, permisos y asignaciones',   TRUE),
  ('perm_plans_manage',       'plans.manage',        'Editar el catálogo de plans',                TRUE),
  ('perm_metrics_read',       'metrics.read',        'Leer métricas operacionales del sistema',    TRUE),
  ('perm_audit_read',         'audit.read',          'Leer logs de auditoría',                     TRUE),
  ('perm_audit_export',       'audit.export',        'Exportar logs de auditoría (CSV)',           TRUE),
  ('perm_webhooks_manage',    'webhooks.manage',     'Gestionar webhooks de usuario',              TRUE),
  ('perm_search_semantic',    'search.semantic',     'Usar la búsqueda semántica avanzada',        TRUE),
  ('perm_embeddings_manage',  'embeddings.manage',   'Gestionar jobs de embeddings (backfill)',    TRUE)
ON CONFLICT ("code") DO NOTHING;

-- ── Seed: role_permissions mappings ────────────────────────────────
-- SUPERADMIN → all system permissions (cartesian join, easy to extend).
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT
  'rp_superadmin_' || REPLACE(p."code", '.', '_'),
  r."id",
  p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'SUPERADMIN' AND p."isSystem" = TRUE
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ORG_OWNER → full org control + production features + audit read.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT
  'rp_org_owner_' || REPLACE(p."code", '.', '_'),
  r."id",
  p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'org.read','org.update','org.billing.manage','org.members.invite','org.members.remove',
  'org.members.role.update','org.audit.read','org.settings.update',
  'users.read','users.list','credits.read',
  'chat.read','chat.create','chat.update','chat.delete','chat.share',
  'gpt.create','gpt.update','gpt.delete','gpt.publish',
  'project.create','project.read','project.update','project.delete','project.share',
  'images.generate','images.upscale','images.read','images.delete',
  'video.generate','video.read','paraphrase.use','thesis.use','search.semantic'
)
WHERE r."code" = 'ORG_OWNER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ORG_ADMIN → like owner but NO billing.manage and NO org.delete.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT
  'rp_org_admin_' || REPLACE(p."code", '.', '_'),
  r."id",
  p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'org.read','org.update','org.members.invite','org.members.remove',
  'org.members.role.update','org.audit.read','org.settings.update',
  'users.read','users.list','credits.read',
  'chat.read','chat.create','chat.update','chat.delete','chat.share',
  'gpt.create','gpt.update','gpt.delete','gpt.publish',
  'project.create','project.read','project.update','project.delete','project.share',
  'images.generate','images.upscale','images.read','images.delete',
  'video.generate','video.read','paraphrase.use','thesis.use','search.semantic'
)
WHERE r."code" = 'ORG_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ORG_MEMBER → production features (no admin), can read own credits.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT
  'rp_org_member_' || REPLACE(p."code", '.', '_'),
  r."id",
  p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'org.read','credits.read',
  'chat.read','chat.create','chat.update','chat.delete','chat.share',
  'gpt.create','gpt.update','gpt.delete',
  'project.create','project.read','project.update','project.delete','project.share',
  'images.generate','images.read','images.delete',
  'video.generate','video.read','paraphrase.use','thesis.use','search.semantic'
)
WHERE r."code" = 'ORG_MEMBER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ORG_VIEWER → strict read-only inside the org.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT
  'rp_org_viewer_' || REPLACE(p."code", '.', '_'),
  r."id",
  p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'org.read','chat.read','project.read','images.read','video.read'
)
WHERE r."code" = 'ORG_VIEWER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- USER → solo-user defaults (no org context).
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT
  'rp_user_' || REPLACE(p."code", '.', '_'),
  r."id",
  p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'credits.read',
  'chat.read','chat.create','chat.update','chat.delete','chat.share',
  'gpt.create','gpt.update','gpt.delete',
  'project.create','project.read','project.update','project.delete','project.share',
  'images.generate','images.read','images.delete',
  'video.generate','video.read','paraphrase.use','thesis.use'
)
WHERE r."code" = 'USER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
