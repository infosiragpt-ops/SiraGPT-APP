export const COMPUTER_USE_VIEWPORT = { width: 1024, height: 768 } as const

export type BrowserControllerAction = {
  id: string
  label: string
  timestamp: number
  manual?: boolean
}

export function mapContainedImageClick(
  event: { clientX: number; clientY: number },
  container: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number } = COMPUTER_USE_VIEWPORT,
): { x: number; y: number } | null {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null
  }
  const scale = Math.min(container.width / image.width, container.height / image.height)
  const drawnW = image.width * scale
  const drawnH = image.height * scale
  const offsetX = container.left + (container.width - drawnW) / 2
  const offsetY = container.top + (container.height - drawnH) / 2
  const x = Math.round((event.clientX - offsetX) / scale)
  const y = Math.round((event.clientY - offsetY) / scale)
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null
  return { x, y }
}

export function normalizeBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function collectActionLabels(data: {
  labels?: unknown
  actions?: unknown
  action?: unknown
} = {}): string[] {
  if (Array.isArray(data.labels)) {
    return data.labels.map((label) => String(label || "").trim()).filter(Boolean)
  }
  if (Array.isArray(data.actions)) {
    return data.actions
      .map((action) => {
        if (typeof action === "string") return action
        if (action && typeof action === "object" && "type" in action) {
          return String((action as { type?: string }).type || "")
        }
        return ""
      })
      .map((label) => label.trim())
      .filter(Boolean)
  }
  if (typeof data.action === "string" && data.action.trim()) {
    return [data.action.trim()]
  }
  return []
}
