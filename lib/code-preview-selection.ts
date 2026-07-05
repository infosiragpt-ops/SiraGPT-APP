export const CODE_SELECT_TARGET_EVENT = "siragpt:code-select-target"
export const CODE_SELECTION_CAPTURED_EVENT = "siragpt:code-selection-captured"
export const CODE_SELECTION_CANCEL_EVENT = "siragpt:code-selection-cancel"

export type CodePreviewSelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

export type CodePreviewSelectionDetail = {
  selector?: string
  tagName?: string
  id?: string
  className?: string
  text?: string
  role?: string
  ariaLabel?: string
  href?: string
  src?: string
  rect?: CodePreviewSelectionRect
  pageUrl?: string
  pageTitle?: string
  previewKind?: string
  entry?: string | null
  activePath?: string | null
  activeFolderId?: string | null
  capturedAt?: string
}

export type CodePreviewSelectionCancelDetail = {
  reason?: string
  source?: "chat" | "preview"
}
