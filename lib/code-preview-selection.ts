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
  selectionMethod?: "dom" | "region"
  tagName?: string
  id?: string
  className?: string
  text?: string
  parent?: {
    selector?: string
    tagName?: string
    className?: string
    text?: string
  } | null
  role?: string
  ariaLabel?: string
  href?: string
  src?: string
  rect?: CodePreviewSelectionRect
  relativePoint?: {
    x: number
    y: number
    percentX: number
    percentY: number
  }
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
