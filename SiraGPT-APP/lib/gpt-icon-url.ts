import { appendUploadAuthToken, normalizeBackendAssetUrl } from "./attachment-url"

function isPublicGptIconUrl(url: string) {
  try {
    const parsed = new URL(url, "https://siragpt.local")
    return parsed.pathname.startsWith("/uploads/gpt-icons/")
  } catch {
    return url.startsWith("/uploads/gpt-icons/") || url.startsWith("uploads/gpt-icons/")
  }
}

export function resolveGptIconImageUrl(
  iconUrl: unknown,
  options: { token?: string | null; baseUrl?: string | null } = {},
) {
  const raw = String(iconUrl || "").trim()
  if (!raw) return null
  if (/^(data:|blob:)/i.test(raw)) return raw

  const isBackendAsset =
    /^https?:/i.test(raw) ||
    raw.startsWith("/uploads") ||
    raw.startsWith("uploads/") ||
    raw.startsWith("/upload") ||
    raw.startsWith("upload/")

  if (isBackendAsset) {
    const assetUrl = normalizeBackendAssetUrl(
      raw,
      options.baseUrl ?? process.env.NEXT_PUBLIC_IMAGE_URL ?? process.env.NEXT_PUBLIC_API_URL,
    )
    if (isPublicGptIconUrl(assetUrl)) return assetUrl
    return appendUploadAuthToken(assetUrl, options.token)
  }

  if (raw.startsWith("/")) return raw
  return null
}
