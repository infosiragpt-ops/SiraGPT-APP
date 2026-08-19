/**
 * Shared preview slot for the desktop agent-company surfaces.
 *
 * AgentCompanyPanel owns the company runtime state while PreviewPane owns the
 * visible canvas. A portal keeps those responsibilities separate without
 * duplicating API requests or moving the CEO Office chat out of its column.
 */

type SlotListener = (element: HTMLElement | null) => void

let slotElement: HTMLElement | null = null
const listeners = new Set<SlotListener>()

export function registerAgentCompanyPreviewSlot(element: HTMLElement | null): void {
  slotElement = element
  for (const listener of listeners) listener(slotElement)
}

export function subscribeAgentCompanyPreviewSlot(listener: SlotListener): () => void {
  listeners.add(listener)
  listener(slotElement)
  return () => {
    listeners.delete(listener)
  }
}
