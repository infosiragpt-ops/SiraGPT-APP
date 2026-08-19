-- User.phoneVerifiedAt + phone_verifications table (6-digit OTP, bcrypt hashed).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "phone_verifications" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "phone"      TEXT NOT NULL,
  "codeHash"   TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "phone_verifications_userId_idx" ON "phone_verifications"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'phone_verifications_userId_fkey'
  ) THEN
    ALTER TABLE "phone_verifications"
      ADD CONSTRAINT "phone_verifications_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
