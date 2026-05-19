-- Audit log: add (actorId, createdAt) covering index.
--
-- The audit-query DSL `byUser(userId)` filter constrains only `actorId`
-- (no `actorType` predicate). The existing composite index
-- `(actorType, actorId, createdAt)` therefore can't be used as a prefix
-- for those queries, leading to seq scans on large audit_log tables.
-- Adding a dedicated (actorId, createdAt) index lets byUser + order-by-
-- createdAt run as an index scan.
--
-- `byAction` and `byResource` filters are already covered by
-- (action, createdAt) and (resourceType, resourceId, createdAt).
CREATE INDEX IF NOT EXISTS "audit_log_actorId_createdAt_idx"
  ON "audit_log" ("actorId", "createdAt");
