const DEFAULT_BACKEND_ASSET_BASE_URL = "http://localhost:5000";

function stripApiSuffix(value: string) {
  return value.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function getBrowserOrigin() {
  if (typeof window === "undefined") return "";
  return window.location?.origin || "";
}

function getRuntimeAssetBaseUrl() {
  const configured =
    process.env.NEXT_PUBLIC_IMAGE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "";
  return configured || getBrowserOrigin() || DEFAULT_BACKEND_ASSET_BASE_URL;
}

function hasRuntimeAssetBase(baseUrl?: string | null) {
  return Boolean(
    (typeof baseUrl === "string" && baseUrl.trim()) ||
    process.env.NEXT_PUBLIC_IMAGE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    getBrowserOrigin(),
  );
}

function cleanBaseUrl(baseUrl?: string | null) {
  return stripApiSuffix(String(baseUrl || getRuntimeAssetBaseUrl()));
}

function looksLikeBase64Image(value: string) {
  if (value.length < 120) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

export function resolveBackendAssetUrl(pathOrUrl: unknown, baseUrl?: string | null) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "";
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;

  const base = cleanBaseUrl(baseUrl);
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

/**
 * Rewrite the origin of an absolute URL that points at `/uploads/*`
 * so the browser fetches from the frontend-known backend host
 * (`baseUrl` / NEXT_PUBLIC_IMAGE_URL) instead of whatever BASE_URL
 * the backend baked in. Critical for production deploys where
 * BASE_URL on the server is internal-only or where mixed-content
 * blocks an http:// absolute on an https:// page. Pass-through for
 * data:, blob:, and non-/uploads URLs.
 */
export function normalizeBackendAssetUrl(url: unknown, baseUrl?: string | null) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^(data:|blob:)/i.test(raw)) return raw;
  // The rewrite only fires when the caller explicitly hands us a
  // baseUrl. Without it we don't know where the frontend thinks the
  // backend lives, so silently bouncing to the localhost default
  // would risk pointing the browser at the user's own machine.
  const explicitBase = hasRuntimeAssetBase(baseUrl);
  if (/^https?:/i.test(raw)) {
    if (!explicitBase) return raw;
    const base = cleanBaseUrl(baseUrl);
    try {
      const parsed = new URL(raw);
      if (parsed.pathname.startsWith("/uploads/")) {
        return `${base}${parsed.pathname}${parsed.search || ""}`;
      }
    } catch {
      /* malformed URL — fall through and let the caller surface it */
    }
    return raw;
  }
  // Relative path: keep the legacy "fall back to the local default
  // when no base is given" behaviour — every other call site relies
  // on it to render images against http://localhost:5000 in dev.
  const base = cleanBaseUrl(baseUrl);
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

export function resolveImageAttachmentUrl(file: any, baseUrl?: string | null) {
  const raw = String(
    file?.imageUrl ||
    file?.preview ||
    file?.objectUrl ||
    file?.url ||
    file?.thumbnailUrl ||
    file?.base64 ||
    "",
  ).trim();

  if (raw) {
    if (/^(https?:|data:image|blob:)/i.test(raw)) return raw;
    if (raw.startsWith("/uploads") || raw.startsWith("/api/images")) {
      return resolveBackendAssetUrl(raw, baseUrl);
    }
    if (looksLikeBase64Image(raw)) {
      return `data:${file?.mimeType || file?.type || "image/jpeg"};base64,${raw.replace(/\s/g, "")}`;
    }
    return resolveBackendAssetUrl(raw, baseUrl);
  }

  if (file?.path) {
    const normalizedPath = String(file.path).replace(/\\/g, "/");
    const relativePath = normalizedPath.split("uploads/")[1];
    if (relativePath) {
      return resolveBackendAssetUrl(`/uploads/${relativePath}`, baseUrl);
    }
  }

  return "";
}

/**
 * @deprecated Session JWTs must never be copied into URLs. Same-origin upload
 * requests authenticate with the HttpOnly cookie. A caller that cannot use
 * that cookie must request a path-scoped capability from
 * POST /api/files/media-token and use the URL returned by that endpoint.
 */
export function appendUploadAuthToken(url: unknown, _token?: string | null) {
  return String(url || "").trim();
}
