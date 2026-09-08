-- One-time production state requested by the administrator: start with every
-- model unpublished, then allow explicit activation from Admin > Modelos IA.
-- Future syncs/seeds preserve that choice and create new rows inactive.
UPDATE "ai_models"
SET "isActive" = false,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "isActive" = true;
