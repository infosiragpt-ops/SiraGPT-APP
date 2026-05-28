UPDATE "ai_models"
SET "isActive" = false
WHERE "isActive" = true;

INSERT INTO "system_settings" ("id", "key", "value")
VALUES (
  'sys_ai_models_default_inactive_v1',
  'ai_models_default_inactive_v1_applied',
  '{"reason":"admin_models_default_inactive","source":"migration"}'
)
ON CONFLICT ("key") DO NOTHING;
