const DEFAULT_BACKEND_ASSET_BASE_URL = "http://localhost:5000";

function cleanBaseUrl(baseUrl?: string | null) {
  return String(baseUrl || DEFAULT_BACKEND_ASSET_BASE_URL).replace(/\/+$/, "");
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
