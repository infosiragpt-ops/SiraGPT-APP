-- Task 19 — Mostrar también el país/ciudad aproximada del dispositivo Appshots.
--
-- Adds a single nullable column to `sessions` so /api/appshots/pair can
-- cache a human-readable geo hint (e.g. "Madrid, ES") derived from the
-- caller's IP at pair time. Resolution is best-effort: when the lookup
-- fails or the IP is private the column stays NULL and the UI keeps
-- falling back to the existing /24 ipHint.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "geoHint" TEXT;
