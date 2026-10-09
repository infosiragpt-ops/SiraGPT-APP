CREATE TABLE "webhook_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "endpoint_id" TEXT NOT NULL,
  "endpoint_user_id" TEXT NOT NULL,
  "publisher_user_id" TEXT,
  "organization_id" TEXT,
  "url" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 4,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', clock_timestamp()),
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3),
  "last_error" TEXT,
  "last_http_status" INTEGER,
  "duration_ms" INTEGER,
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', clock_timestamp()),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', clock_timestamp()),
  CONSTRAINT "webhook_delivery_endpoint_fk" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "webhook_delivery_status_check" CHECK ("status" IN ('pending','processing','delivered','failed')),
  CONSTRAINT "webhook_delivery_payload_bytes" CHECK (octet_length("payload") <= 262144)
);
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries"("endpoint_id", "created_at");
CREATE INDEX "webhook_deliveries_lease_idx" ON "webhook_deliveries"("status", "lease_until");
