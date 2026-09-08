/**
 * Shared center-column slot for desktop agent-company nav surfaces.
 *
 * Panel / Controlar / Archivos / Recursos replace the CEO chat column
 * (and cover the canvas) instead of opening as a skinny preview overlay.
 */

type SlotListener = (element: HTMLElement | null) => void

let slotElement: HTMLElement | null = null
const listeners = new Set<SlotListener>()

export const CODE_NAV_FULLSCREEN_EVENT = "siragpt:code-nav-fullscreen"

export function registerAgentCompanyCenterSlot(element: HTMLElement | null): void {
  slotElement = element
  for (const listener of listeners) listener(slotElement)
}

export function subscribeAgentCompanyCenterSlot(listener: SlotListener): () => void {
  listeners.add(listener)
  listener(slotElement)
  return () => {
    listeners.delete(listener)
  }
}
