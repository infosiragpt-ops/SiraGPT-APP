INSERT INTO "ai_models" (
  "id", "name", "displayName", "provider", "type", "icon", "description",
  "isActive", "syncSource", "tags", "createdAt", "updatedAt"
)
VALUES
  (
    'meta-muse-spark-1-2', 'muse-spark-1.2', 'Meta Muse Spark 1.2', 'Meta', 'TEXT', 'MetaLogo',
    'Meta Muse Spark 1.2 direct API for agents, coding, tools, and long-context work.',
    true, 'static_manifest', ARRAY['meta', 'muse', 'text', 'reasoning'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'meta-muse-spark-1-1', 'muse-spark-1.1', 'Meta Muse Spark 1.1', 'Meta', 'TEXT', 'MetaLogo',
    'Meta Muse Spark 1.1 direct API for multimodal chat and agentic work.',
    true, 'static_manifest', ARRAY['meta', 'muse', 'text', 'reasoning'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
ON CONFLICT ("name") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "provider" = EXCLUDED."provider",
  "type" = EXCLUDED."type",
  "icon" = EXCLUDED."icon",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "syncSource" = EXCLUDED."syncSource",
  "tags" = EXCLUDED."tags",
  "updatedAt" = CURRENT_TIMESTAMP;
