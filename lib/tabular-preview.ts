export type StatisticalPreview = {
  format: "sav" | "zsav" | "por"
  filename: string
  rowCount: number | null
  rowCountKnown: boolean
  columnCount: number
  columns: Array<{ name: string; label: string | null; type: string; valueLabels: Record<string, string>; missingValues: unknown }>
  rows: Array<Array<string | number | null>>
  offset: number
  limit: number
  hasMore: boolean
  truncated: { rows: boolean; columns: boolean; values: boolean }
}

/** Build only an application-owned route. Never send document data to arbitrary URLs. */
export function statisticalPreviewPath(source: { artifactId?: string | null; fileId?: string | null; url?: string | null }): string | null {
  const safeId = (id: string | null | undefined) => id && /^[a-z\d_-]{1,100}$/i.test(id) ? encodeURIComponent(id) : null
  if (safeId(source.artifactId)) return `/api/agent/artifact/${safeId(source.artifactId)}/preview.data`
  if (safeId(source.fileId)) return `/api/files/${safeId(source.fileId)}/preview.data`
  const path = source.url?.split(/[?#]/)[0].match(/\/api\/(agent\/artifact|files)\/([a-z\d_-]{1,100})(?:\/download)?$/i)
  return path ? `/api/${path[1]}/${path[2]}/preview.data` : null
}

export function assertStatisticalPreview(value: unknown): asserts value is StatisticalPreview {
  const data = value as StatisticalPreview | null
  if (!data || !["sav", "zsav", "por"].includes(data.format) || !Array.isArray(data.columns) || !Array.isArray(data.rows)
    || !data.columns.length || data.columns.length > 100 || data.rows.length > 500 || !Number.isInteger(data.offset) || data.offset < 0
    || typeof data.filename !== "string" || !Number.isInteger(data.columnCount) || data.columnCount < data.columns.length
    || (data.rowCount !== null && (!Number.isSafeInteger(data.rowCount) || data.rowCount < 0))
    || data.rowCountKnown !== (data.rowCount !== null) || typeof data.hasMore !== "boolean"
    || !data.truncated || ["rows", "columns", "values"].some((key) => typeof data.truncated[key as keyof typeof data.truncated] !== "boolean")
    || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 500
    || data.rows.length > data.limit
    || !data.rows.every((row) => Array.isArray(row) && row.length === data.columns.length && row.every((cell) => cell === null || typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell))))
    || !data.columns.every((column) => column && typeof column.name === "string" && column.name.length > 0
      && (column.label === null || typeof column.label === "string") && ["numeric", "string"].includes(column.type)
      && column.valueLabels && typeof column.valueLabels === "object" && !Array.isArray(column.valueLabels)
      && Object.values(column.valueLabels).every((label) => typeof label === "string") && Array.isArray(column.missingValues))) {
    throw new Error("El archivo no devolvió una vista de datos válida.")
  }
}

export async function readStatisticalPreviewResponse(response: Response): Promise<unknown> {
  if (response.ok) return response.json()
  const body = await response.json().catch(() => null) as { code?: string; error?: string } | null
  if (body?.code?.startsWith("PREVIEW_") && typeof body.error === "string" && body.error.length <= 300) throw new Error(body.error)
  if (response.status === 401 || response.status === 403) throw new Error("Tu sesión no tiene acceso a este archivo. Vuelve a iniciar sesión.")
  if (response.status === 404) throw new Error("El archivo ya no está disponible.")
  throw new Error(`No se pudo leer el archivo (HTTP ${response.status}).`)
}

export function statisticalCellText(value: string | number | null, labels: Record<string, string>, useLabels: boolean): string {
  if (value === null) return "·"
  const key = String(value)
  return useLabels && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key
}
