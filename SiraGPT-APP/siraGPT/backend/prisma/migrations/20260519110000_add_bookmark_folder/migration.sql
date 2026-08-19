-- Bookmark folders — optional free-form grouping label so the UI can
-- bucket favourites into user-defined folders ("Prompts", "Bugs", …).
-- Nullable on purpose: existing rows stay "uncategorised" and renaming
-- a folder is a single UPDATE because there's no folders table.

ALTER TABLE "bookmarks" ADD COLUMN IF NOT EXISTS "folder" TEXT;

CREATE INDEX IF NOT EXISTS "bookmarks_userId_folder_idx"
  ON "bookmarks"("userId", "folder");
