/**
 * workspace-assets — real asset inventory + upload routing for the /code
 * App Storage tool.
 *
 * Pure/deterministic helpers over the workspace file map (no network, no
 * mutation): group the project's actual files by asset kind with byte
 * estimates, and decide how an uploaded file can become part of the project
 * (text assets are written verbatim; small raster images are wrapped in a
 * portable SVG so they stay text — the runner writes files as utf-8).
 */

export type AssetKind = "image" | "style" | "code" | "data" | "doc" | "other"

export type AssetFile = { path: string; bytes: number }

export type AssetGroup = {
  kind: AssetKind
  label: string
  files: AssetFile[]
  bytes: number
}

type FileLike = { content?: string }

const KIND_LABELS: Record<AssetKind, string> = {
  image: "Imágenes",
  style: "Estilos",
  code: "Código",
  data: "Datos",
  doc: "Documentos",
  other: "Otros",
}

const KIND_ORDER: AssetKind[] = ["image", "code", "style", "data", "doc", "other"]

const EXT_KINDS: Record<string, AssetKind> = {
  svg: "image", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", ico: "image",
  css: "style", scss: "style", less: "style",
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code", html: "code", vue: "code", py: "code",
  json: "data", csv: "data", yml: "data", yaml: "data", xml: "data", prisma: "data", sql: "data",
  md: "doc", mdx: "doc", txt: "doc", pdf: "doc",
}

export function assetKindFor(path: string): AssetKind {
  const ext = path.split(".").pop()?.toLowerCase() || ""
  return EXT_KINDS[ext] || "other"
}

/** Group the workspace's real files by asset kind (empty groups omitted). */
export function groupWorkspaceAssets(
  files: Record<string, FileLike | string> | null | undefined,
): AssetGroup[] {
  if (!files || typeof files !== "object") return []
  const groups = new Map<AssetKind, AssetGroup>()
  for (const [path, file] of Object.entries(files)) {
    const content = typeof file === "string" ? file : file?.content
    if (typeof content !== "string") continue
    const kind = assetKindFor(path)
    const entry = groups.get(kind) || { kind, label: KIND_LABELS[kind], files: [], bytes: 0 }
    // char length ≈ bytes for the ascii-dominated sources we handle; good
    // enough for an inventory estimate without TextEncoder per file.
    const bytes = content.length
    entry.files.push({ path, bytes })
    entry.bytes += bytes
    groups.set(kind, entry)
  }
  const result = Array.from(groups.values())
  for (const group of result) group.files.sort((a, b) => b.bytes - a.bytes)
  result.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  return result
}

export function totalAssetBytes(groups: AssetGroup[]): number {
  return groups.reduce((sum, group) => sum + group.bytes, 0)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Upload routing
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  "svg", "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs", "html",
  "json", "csv", "yml", "yaml", "xml", "md", "mdx", "txt", "sql", "prisma", "env",
])

const WRAPPABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** Max raster size we embed as a data-URL SVG wrapper (persisted workspaces live in the browser). */
export const IMAGE_WRAP_MAX_BYTES = 200 * 1024

export type UploadPlan =
  | { action: "write-text"; path: string }
  | { action: "wrap-image"; path: string }
  | { action: "register-only"; reason: string }

/** Sanitised public/ destination for an uploaded asset (collision-safe). */
export function destPathForUpload(name: string, existingPaths: Iterable<string>): string {
  const clean =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+\./g, ".")
      .replace(/^-+|-+$/g, "") || "asset"
  const existing = new Set(Array.from(existingPaths))
  let candidate = `public/${clean}`
  let counter = 2
  while (existing.has(candidate)) {
    const dot = clean.lastIndexOf(".")
    candidate =
      dot > 0
        ? `public/${clean.slice(0, dot)}-${counter}${clean.slice(dot)}`
        : `public/${clean}-${counter}`
    counter += 1
  }
  return candidate
}

/** Decide how an uploaded file can join the project. */
export function planUpload(
  file: { name: string; type?: string; size: number },
  existingPaths: Iterable<string>,
): UploadPlan {
  const ext = file.name.split(".").pop()?.toLowerCase() || ""
  if (TEXT_EXTENSIONS.has(ext) || file.type?.startsWith("text/")) {
    return { action: "write-text", path: destPathForUpload(file.name, existingPaths) }
  }
  if (WRAPPABLE_IMAGE_TYPES.has(file.type || "")) {
    if (file.size > IMAGE_WRAP_MAX_BYTES) {
      return {
        action: "register-only",
        reason: `imagen > ${Math.round(IMAGE_WRAP_MAX_BYTES / 1024)} KB — solo registro local`,
      }
    }
    return { action: "wrap-image", path: `${destPathForUpload(file.name, existingPaths)}.svg` }
  }
  return { action: "register-only", reason: "formato binario — solo registro local" }
}

/**
 * Portable text wrapper for a small raster: an SVG embedding the data-URL.
 * Served from public/ it renders anywhere an <img> does, while staying utf-8
 * so the workspace/runner pipeline (text files) can carry it.
 */
export function imageWrapperSvg(dataUrl: string, width = 512, height = 512): string {
  const safe = dataUrl.replace(/"/g, "&quot;")
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <image href="${safe}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`,
    `</svg>`,
    ``,
  ].join("\n")
}
