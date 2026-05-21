const DEFAULT_BACKEND_ASSET_BASE_URL = "http://localhost:5000";

function cleanBaseUrl(baseUrl?: string | null) {
  return String(baseUrl || DEFAULT_BACKEND_ASSET_BASE_URL).replace(/\/+$/, "");
}

function looksLikeBase64Image(value: string) {
  if (value.length < 120) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

/**
 * For paths that hit the authenticated `/uploads/*` static route, append
 * the auth token from localStorage as a `?token=` query parameter. Plain
 * `<img>` elements cannot set the `Authorization: Bearer ...` header,
 * and our deployed setup serves the frontend and backend from different
 * origins, so the cookie issued at login is not sent automatically.
 * Backend `upload-static-access.js` accepts the same token via query.
 */
function isTrustedBackendOrigin(absoluteUrl: string): boolean {
  // Same-origin as the current page is always trusted (Next.js rewrites
  // `/uploads/*` to our backend, so `siragpt.com/uploads/...` is ours).
  // For absolute URLs, only attach the token when the host matches the
  // explicitly configured backend (`NEXT_PUBLIC_API_URL` /
  // `NEXT_PUBLIC_IMAGE_URL`). Never leak the JWT to arbitrary hosts
  // that happen to have `/uploads/` in their path.
  try {
    const parsed = new URL(absoluteUrl, window.location.href);
    if (parsed.origin === window.location.origin) return true;
    const candidates = [
      process.env.NEXT_PUBLIC_API_URL,
      process.env.NEXT_PUBLIC_IMAGE_URL,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const backend = new URL(candidate);
        if (backend.origin === parsed.origin) return true;
      } catch {
        /* malformed env value — ignore */
      }
    }
  } catch {
    /* malformed URL — treat as untrusted */
  }
  return false;
}

function maybeAttachAuthQueryParam(url: string): string {
  if (typeof window === "undefined") return url;
  if (!url) return url;
  // Only attach for paths that we know are protected by the
  // upload-static-access guard. Public assets (audio/, images/,
  // presentations/) work without it but tolerate the extra param.
  if (!/\/uploads\//.test(url)) return url;
  // If a token is already present, don't double-attach.
  if (/[?&]token=/.test(url)) return url;
  // Defense-in-depth: never attach the JWT to a host we don't own.
  // Relative URLs (no scheme) resolve same-origin so are always safe.
  if (/^https?:/i.test(url) && !isTrustedBackendOrigin(url)) return url;
  try {
    const token = window.localStorage.getItem("auth-token");
    if (!token) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  } catch {
    return url;
  }
}

export function resolveBackendAssetUrl(pathOrUrl: unknown, baseUrl?: string | null) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "";
  if (/^(https?:|data:|blob:)/i.test(raw)) return maybeAttachAuthQueryParam(raw);

  const base = cleanBaseUrl(baseUrl);
  return maybeAttachAuthQueryParam(`${base}${raw.startsWith("/") ? "" : "/"}${raw}`);
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
  const explicitBase = typeof baseUrl === "string" && baseUrl.trim() !== "";
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
  const raw = String(file?.imageUrl || file?.url || file?.base64 || "").trim();

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
