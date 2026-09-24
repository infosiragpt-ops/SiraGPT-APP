/**
 * Attachment kinds for composer chips — a readable Spanish label per format
 * family plus whether SiraGPT can read text out of it.
 *
 * Every format is accepted (see lib/attachment-ingest.ts); this table only
 * decides how a chip describes the file. `readable: false` families are
 * stored intact and described to the model by name, type and size, so the
 * chip says so ("sin vista de texto") instead of implying it was read.
 */

export type AttachmentFamily =
  | "pdf" | "word" | "spreadsheet" | "presentation" | "text" | "code" | "data"
  | "image" | "audio" | "video" | "archive" | "ebook" | "email" | "calendar"
  | "contact" | "subtitle" | "cad" | "model3d" | "design" | "font" | "database"
  | "executable" | "disk-image" | "other"

export interface AttachmentKind {
  family: AttachmentFamily
  /** Short Spanish label shown on the chip ("Hoja de cálculo"). */
  label: string
  /** True when the backend extracts readable text/transcript from it. */
  readable: boolean
}

const FAMILY_EXTENSIONS: Array<[AttachmentFamily, string, boolean, string[]]> = [
  ["pdf", "PDF", true, ["pdf", "xps", "oxps"]],
  ["word", "Documento", true, [
    "doc", "docx", "docm", "dot", "dotx", "dotm", "odt", "ott", "fodt", "rtf", "pages", "wpd", "wps",
    "lwp", "abw", "hwp", "sxw", "wri", "tex", "latex",
  ]],
  ["spreadsheet", "Hoja de cálculo", true, [
    "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "ods", "ots", "fods", "numbers", "csv", "tsv",
    "dbf", "wk1", "wks", "123", "qpw", "slk", "dif",
  ]],
  ["presentation", "Presentación", true, [
    "ppt", "pptx", "pptm", "pps", "ppsx", "ppsm", "pot", "potx", "potm", "odp", "otp", "fodp", "key", "sxi",
  ]],
  ["ebook", "Libro electrónico", true, ["epub", "mobi", "azw", "azw3", "prc", "fb2"]],
  ["email", "Correo", true, ["eml", "msg", "oft", "mbox", "emlx"]],
  ["calendar", "Calendario", true, ["ics", "ical", "ifb"]],
  ["contact", "Contacto", true, ["vcf", "vcard"]],
  ["subtitle", "Subtítulos", true, ["srt", "vtt", "ass", "ssa", "sub", "sbv"]],
  ["text", "Texto", true, ["txt", "text", "md", "markdown", "rst", "adoc", "org", "log", "nfo"]],
  ["data", "Datos", true, [
    "json", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
    "geojson", "kml", "gpx", "ipynb", "sql", "graphql", "proto", "bib",
  ]],
  ["code", "Código", true, [
    "js", "jsx", "mjs", "cjs", "ts", "mts", "cts", "tsx", "py", "java", "c", "cc", "cpp", "cxx", "h", "hpp", "cs", "go",
    "rs", "rb", "php", "swift", "kt", "kts", "scala", "r", "jl", "lua", "pl", "sh", "bash", "zsh", "ps1",
    "bat", "cmd", "css", "scss", "sass", "less", "vue", "svelte", "html", "htm", "dart", "ex", "exs", "erl",
    "hs", "clj", "ml", "fs", "vb", "asm", "s", "sol", "tf", "hcl", "gradle", "cmake", "dockerfile", "makefile",
  ]],
  ["image", "Imagen", true, [
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "svg", "heic", "heif", "avif", "ico", "jfif",
  ]],
  // Stored intact; the server has no RAR / Zstandard / lzip decoder.
  ["archive", "Archivo comprimido", false, ["rar", "cbr", "r00", "zst", "tzst", "lz"]],
  ["archive", "Archivo comprimido", true, [
    "zip", "7z", "tar", "tgz", "gz", "gzip", "bz2", "tbz", "tbz2", "xz", "txz", "cab", "arj", "lzh", "lha",
    "wim", "cpio", "lzma", "z", "cb7", "cbz",
  ]],
  ["cad", "Dibujo CAD", false, ["dwg", "dxf", "dwf", "dgn", "step", "stp", "iges", "igs", "sldprt", "sldasm", "ipt", "iam", "3dm", "skp"]],
  ["model3d", "Modelo 3D", false, ["stl", "obj", "fbx", "gltf", "glb", "3ds", "blend", "dae", "ply", "usdz", "3mf", "max", "c4d"]],
  ["design", "Diseño", false, ["psd", "psb", "ai", "eps", "indd", "idml", "sketch", "fig", "xd", "cdr", "afdesign", "afphoto", "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "exr", "hdr", "dds", "tga"]],
  ["font", "Fuente tipográfica", false, ["ttf", "otf", "woff", "woff2", "eot", "pfb", "fon"]],
  ["database", "Base de datos", false, ["sqlite", "sqlite3", "db", "mdb", "accdb", "parquet", "feather", "arrow", "avro", "orc", "h5", "hdf5", "npy", "npz", "pkl", "pickle", "mat", "sav", "dta", "rds", "rdata"]],
  ["executable", "Programa", false, ["exe", "msi", "dll", "apk", "aab", "ipa", "app", "deb", "rpm", "jar", "war", "appimage", "bin", "run", "so", "dylib", "wasm", "com", "scr"]],
  ["disk-image", "Imagen de disco", true, ["iso", "img", "dmg", "vhd", "vhdx", "vmdk", "qcow2"]],
]

const EXTENSION_INDEX = new Map<string, AttachmentKind>()
for (const [family, label, readable, exts] of FAMILY_EXTENSIONS) {
  for (const ext of exts) if (!EXTENSION_INDEX.has(ext)) EXTENSION_INDEX.set(ext, { family, label, readable })
}

const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "ogg", "oga", "opus", "m4a", "m4b", "aac", "flac", "aif", "aiff", "caf", "amr", "wma",
  "weba", "mka", "ac3", "mid", "midi",
])
const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "qt", "webm", "mkv", "avi", "wmv", "asf", "flv", "mpeg", "mpg",
  "m2ts", "ogv", "3gp", "3g2", "vob",
])

function extensionOf(name: string): string {
  const lower = String(name || "").toLowerCase()
  if (/\.tar\.(gz|bz2|xz|zst)$/.test(lower)) return "tar"
  const base = lower.split(/[\\/]/).pop() || ""
  if (base === "dockerfile" || base === "makefile") return base
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1) : ""
}

/** Describe an attachment for its chip. Never throws. */
export function describeAttachmentKind(file: { name?: string | null; type?: string | null; size?: number | null } | null | undefined): AttachmentKind {
  const name = String(file?.name || "")
  const mime = String(file?.type || "").toLowerCase()
  const ext = extensionOf(name)
  // TypeScript first: browsers label .ts sources video/mp2t. A 16 MB+ `.ts`
  // is an MPEG-TS recording.
  if (ext === "ts" || ext === "mts" || ext === "cts") {
    const size = Number(file?.size)
    if (!(Number.isFinite(size) && size >= 16 * 1024 * 1024)) return { family: "code", label: "Código", readable: true }
    return { family: "video", label: "Video", readable: true }
  }
  if (AUDIO_EXTENSIONS.has(ext) || mime.startsWith("audio/")) return { family: "audio", label: "Audio", readable: true }
  if (VIDEO_EXTENSIONS.has(ext) || mime.startsWith("video/")) return { family: "video", label: "Video", readable: true }
  const byExt = EXTENSION_INDEX.get(ext)
  if (byExt) return byExt
  if (mime.startsWith("image/")) return { family: "image", label: "Imagen", readable: true }
  if (mime === "application/pdf") return { family: "pdf", label: "PDF", readable: true }
  if (mime.startsWith("text/") || /json|xml|yaml|javascript/.test(mime)) return { family: "text", label: "Texto", readable: true }
  // Unknown format: stored and handed to the model by name/type/size. Text
  // files without a known extension are still read server-side (byte sniff),
  // so the label stays neutral rather than claiming there is no text.
  return { family: "other", label: ext ? `Archivo .${ext}` : "Archivo", readable: true }
}
