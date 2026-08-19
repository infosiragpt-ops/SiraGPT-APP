/**
 * code-agent · escaping / sanitisation helpers for generated code.
 *
 * Ported from `backend/src/services/builder/codegen.js` (jsStr/jsxText/kebabCase)
 * and `backend/src/services/builder/preview.js` (escapeHtml) — keep semantics in
 * sync with those CommonJS originals. The backend package sits outside the
 * frontend tsconfig scopes, so a cross-boundary import is not viable.
 *
 * Every user-controlled string that lands inside a generated file MUST pass
 * through exactly one of these guards (see vite-scaffold.ts / vite-app-template.ts).
 */

/** Safe to embed inside a JS/TS string literal (double-quoted via JSON, includes quotes). */
export function jsStr(value: unknown): string {
  return JSON.stringify(String(value == null ? "" : value))
}

/** Safe to embed as JSX text (no tag/expression injection). */
export function jsxText(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;")
}

/** Safe to embed as HTML text or inside a double-quoted HTML attribute. */
export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Extract a strict `#rrggbb` hex colour from free text, or null.
 * Whitelist-only: this is the ONLY way user input may influence generated CSS.
 */
export function pickAccentHex(text: string | undefined | null): string | null {
  if (!text) return null
  const m = String(text).match(/#[0-9a-fA-F]{6}\b/)
  return m ? m[0].toLowerCase() : null
}

/** kebab-case slug for package names / ids (charset-whitelisted). */
export function kebabCase(name: unknown): string {
  const base = String(name == null ? "" : name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents: "Café" → "cafe"
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("-")
  return base || "item"
}
