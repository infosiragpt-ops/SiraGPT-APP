/**
 * F3 — blob preview lifecycle for the composer's upload chips.
 *
 * Every image attachment chip gets a `blob:` objectURL preview created with
 * `URL.createObjectURL(file)` in the composer. Those URLs are NOT garbage
 * collected while alive: they pin the decoded image bytes until revoked, so a
 * long session that clears/replaces attachments without revoking leaks blobs
 * (verified as one of the top memory leaks of /code sessions).
 *
 * This helper is the single revoke path: it only ever touches strings that
 * start with `blob:` (previews this component created) and swallows errors so
 * cleanup can never break a user flow.
 */

/** Only blob: URLs are ours to revoke; http(s)/data:/server URLs never are. */
export function isBlobPreviewUrl(preview: unknown): preview is string {
  return typeof preview === "string" && preview.startsWith("blob:")
}

/**
 * Revoke every live blob preview in an uploaded-files snapshot. Pass the
 * snapshot taken BEFORE clearing the state array — once the chips are gone
 * there is no way back to their URLs.
 */
export function revokeUploadPreviews(files: readonly unknown[] | null | undefined): void {
  if (!Array.isArray(files)) return
  if (typeof window === "undefined") return
  const revoke = typeof URL !== "undefined" ? URL.revokeObjectURL : undefined
  if (typeof revoke !== "function") return
  files.forEach((f) => {
    const preview = (f as { preview?: unknown } | null | undefined)?.preview
    if (isBlobPreviewUrl(preview)) {
      try {
        revoke.call(URL, preview)
      } catch {
        /* best-effort: a revoked/detached URL must never break cleanup */
      }
    }
  })
}
