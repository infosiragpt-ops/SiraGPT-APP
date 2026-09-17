-- Sira Voz — VoiceStudio (open source, AGPL-3.0) running as a private container
-- on the production host: voice cloning, dubbing, transcription, audiobooks.
-- Additive only.

CREATE TABLE "voice_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'clone',
    "sampleName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_profiles_providerId_key" ON "voice_profiles"("providerId");
CREATE INDEX "voice_profiles_userId_createdAt_idx" ON "voice_profiles"("userId", "createdAt");

ALTER TABLE "voice_profiles"
  ADD CONSTRAINT "voice_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "voice_studio_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT,
    "input" JSONB,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "voice_studio_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "voice_studio_jobs_userId_createdAt_idx" ON "voice_studio_jobs"("userId", "createdAt");
CREATE INDEX "voice_studio_jobs_status_createdAt_idx" ON "voice_studio_jobs"("status", "createdAt");

ALTER TABLE "voice_studio_jobs"
  ADD CONSTRAINT "voice_studio_jobs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Publish the "Sira Voz" option in the Voz picker (AUDIO row). Explicitly
-- requested: the local studio is free for every plan, so it ships active.
INSERT INTO "ai_models" (
  "id", "name", "displayName", "provider", "type", "icon", "description",
  "isActive", "syncSource", "tags", "createdAt", "updatedAt"
)
VALUES (
  'sira-voz-voicestudio', 'sira-voz', 'Sira Voz', 'VoiceStudio', 'AUDIO', NULL,
  'Sira Voz: clona voces, dobla vídeos, transcribe y crea audiolibros. 100 % local, gratis, +600 idiomas (VoiceStudio, open source).',
  true, 'static_manifest',
  ARRAY['voicestudio', 'local', 'free', 'audio', 'text-to-speech', 'voice-clone', 'dubbing', 'audiobook', 'multilingual'],
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "provider" = EXCLUDED."provider",
  "type" = EXCLUDED."type",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "syncSource" = EXCLUDED."syncSource",
  "tags" = EXCLUDED."tags",
  "updatedAt" = CURRENT_TIMESTAMP;
