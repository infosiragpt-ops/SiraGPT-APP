import assert from "node:assert/strict"
import test from "node:test"

import { resolveBackendAssetUrl } from "../lib/attachment-url"

/**
 * The base attachment-url suite covers resolveImageAttachmentUrl and
 * normalizeBackendAssetUrl. resolveBackendAssetUrl is exported but
 * tested only indirectly; this file pins the lower-level rules:
 *
 *   - Pass-through for http(s):, data:, blob: schemes
 *   - Trim + return "" for empty / nullish input
 *   - Cleans trailing slash on the base URL
 *   - Adds missing leading `/` to the relative path
 *   - Default base when no baseUrl supplied
 */

test("resolveBackendAssetUrl returns '' for empty / nullish / whitespace", () => {
  assert.equal(resolveBackendAssetUrl(""), "")
  assert.equal(resolveBackendAssetUrl(undefined), "")
  assert.equal(resolveBackendAssetUrl(null), "")
  assert.equal(resolveBackendAssetUrl("   "), "")
})

test("resolveBackendAssetUrl preserves absolute http/https URLs unchanged", () => {
  assert.equal(
    resolveBackendAssetUrl("https://cdn.example.com/img.png"),
    "https://cdn.example.com/img.png",
  )
  assert.equal(
    resolveBackendAssetUrl("http://insecure.example.com/img.png"),
    "http://insecure.example.com/img.png",
  )
})

test("resolveBackendAssetUrl preserves data: and blob: URLs unchanged", () => {
  assert.equal(
    resolveBackendAssetUrl("data:image/png;base64,iVBORw0K..."),
    "data:image/png;base64,iVBORw0K...",
  )
  assert.equal(
    resolveBackendAssetUrl("blob:https://example.com/abc-123"),
    "blob:https://example.com/abc-123",
  )
})

test("resolveBackendAssetUrl uses the default base when none is supplied", () => {
  assert.equal(
    resolveBackendAssetUrl("/uploads/user/photo.png"),
    "http://localhost:5000/uploads/user/photo.png",
  )
})

test("resolveBackendAssetUrl prepends the supplied base on absolute paths", () => {
  assert.equal(
    resolveBackendAssetUrl("/api/images/abc.png", "https://api.siragpt.dev"),
    "https://api.siragpt.dev/api/images/abc.png",
  )
})

test("resolveBackendAssetUrl strips trailing slashes on the supplied base", () => {
  assert.equal(
    resolveBackendAssetUrl("/uploads/x.png", "https://api.siragpt.dev/"),
    "https://api.siragpt.dev/uploads/x.png",
  )
  assert.equal(
    resolveBackendAssetUrl("/uploads/x.png", "https://api.siragpt.dev///"),
    "https://api.siragpt.dev/uploads/x.png",
  )
})

test("resolveBackendAssetUrl injects a leading '/' when the path doesn't have one", () => {
  assert.equal(
    resolveBackendAssetUrl("uploads/photo.png", "https://api.siragpt.dev"),
    "https://api.siragpt.dev/uploads/photo.png",
  )
})

test("resolveBackendAssetUrl trims surrounding whitespace on the input path", () => {
  assert.equal(
    resolveBackendAssetUrl("   /uploads/x.png   "),
    "http://localhost:5000/uploads/x.png",
  )
})
