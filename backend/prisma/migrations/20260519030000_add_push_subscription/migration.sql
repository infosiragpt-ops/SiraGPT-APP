-- Add push_subscriptions table (FCM / APNs / Web Push device tokens).
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "token"       TEXT NOT NULL,
  "platform"    TEXT NOT NULL,
  "endpoint"    TEXT,
  "p256dh"      TEXT,
  "auth"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_token_key" ON "push_subscriptions"("token");
CREATE INDEX IF NOT EXISTS "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_userId_fkey'
  ) THEN
    ALTER TABLE "push_subscriptions"
      ADD CONSTRAINT "push_subscriptions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
