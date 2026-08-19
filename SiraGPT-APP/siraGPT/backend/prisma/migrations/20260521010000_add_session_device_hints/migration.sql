-- Task 15 — Mostrar desde qué navegador/IP se vinculó cada dispositivo Appshots.
--
-- Adds three nullable columns to `sessions` so /api/appshots/pair can record
-- enough breadcrumbs for the settings UI to distinguish multiple linked
-- devices and for the user to rename them.
--
--   userAgent — raw User-Agent header captured at pair time (truncated to
--               512 chars in the route to bound row width).
--   ipHint    — /24 (IPv4) or /64 (IPv6) network prefix derived via
--               reduceIp(). Never the full address, so the UI can't be
--               used to leak precise IPs back to a logged-in attacker.
--   label     — user-editable nickname (e.g. "Portátil del trabajo").
--
-- All nullable so existing rows and non-appshots sessions stay valid.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ipHint" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "label" TEXT;
